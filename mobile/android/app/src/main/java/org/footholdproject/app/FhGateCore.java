package org.footholdproject.app;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.ConnectException;
import java.net.HttpURLConnection;
import java.net.NoRouteToHostException;
import java.net.SocketException;
import java.net.SocketTimeoutException;
import java.net.URI;
import java.net.URL;
import java.net.UnknownHostException;
import java.nio.charset.StandardCharsets;
import java.security.cert.CertPathValidatorException;
import java.security.cert.CertificateException;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;
import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLException;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * B 연결 어댑터의 핵심(안드로이드 의존 없음 — JVM 단위 시험 대상). 계약: mobile/docs/FHGATE-CONTRACT.md
 *
 * 지키는 것
 *  - 세션 토큰은 이 객체와 Vault(네이티브 보안 저장소) 안에만. 결과 객체·예외 글에 넣지 않는다.
 *  - 요청은 설정된 관문 origin(https) 한 곳의 고정 경로만. 임의 URL·메서드 없음, redirect 따라가지 않음(3xx = 오류).
 *  - 연결 세대 gen: 로그아웃·주소 변경·401 때 +1. 시작 때 gen 과 끝날 때 gen 이 다르면 결과를 버린다(옛 로그인 토큰은 저장하지 않음).
 *  - 재시도 없음. TLS 는 플랫폼 기본 검사 그대로(신뢰·호스트 이름 검사 교체 없음).
 */
public final class FhGateCore {

    // ── 바깥과의 경계 두 개: 시험에서는 가짜, 앱에서는 HttpsTransport · 플러그인의 Keystore 저장소 ──
    public interface Transport {
        /** redirect 를 따라가지 않고 maxBytes 를 넘는 본문은 IOException("too_big"). */
        Resp send(String method, String url, Map<String, String> headers, byte[] body, int maxBytes) throws IOException;
    }

    public interface Vault {   // 세션 한 덩어리(JSON 글)를 암호화해 보관
        String load();
        void save(String json);
    }

    public static final class Resp {
        public final int status;
        public final String type;
        public final byte[] body;

        public Resp(int status, String type, byte[] body) {
            this.status = status;
            this.type = type == null ? "" : type;
            this.body = body == null ? new byte[0] : body;
        }

        public String text() { return new String(body, StandardCharsets.UTF_8); }
    }

    /** JS 로는 code 와 짧은 글만 간다. code 목록은 계약 문서와 같다. */
    public static final class GateError extends Exception {
        public final String code;

        GateError(String code, String msg) { super(msg); this.code = code; }
    }

    public static final class Login {
        public final String account, device6;
        public final double exp;
        public final long gen;

        Login(String account, String device6, double exp, long gen) {
            this.account = account; this.device6 = device6; this.exp = exp; this.gen = gen;
        }
    }

    public static final class Result {
        public final Resp resp;
        public final long gen;

        Result(Resp resp, long gen) { this.resp = resp; this.gen = gen; }
    }

    /** 로그아웃 뒤 서버에 알릴 재료 — 토큰은 플러그인이 곧바로 serverLogout 에만 넘긴다. */
    public static final class Ended {
        final String origin, token;
        public final long gen;

        Ended(String origin, String token, long gen) { this.origin = origin; this.token = token; this.gen = gen; }

        public boolean hadSession() { return token != null; }
    }

    // ── 고정 값 ──
    public static final int JSON_MAX = 1 << 20;            // ponytail: 1 MB·5 MB 는 임시 상한 — 실측(사진 크기·문서 크기) 뒤 조정
    public static final int PHOTO_MAX = 5 << 20;
    // 관문 v2_gate 의 사진 경로와 같은 모양. Java \w 는 ASCII 만이라 관문(유니코드 \w)보다 좁다 — 더 좁은 쪽은 안전
    static final Pattern PHOTO = Pattern.compile("^media/photos/\\d{8}/[\\w.-]+\\.jpg$");
    static final Pattern TOKEN = Pattern.compile("^[A-Za-z0-9_-]{16,256}$");
    static final Pattern TICKET = Pattern.compile("^[A-Za-z0-9_-]{16,128}$");

    static final class Op {
        final String method, path;
        final Set<Integer> pass;   // 이 상태 코드는 오류로 바꾸지 않고 본문과 함께 화면에 돌려준다(기존 계약 보존)

        Op(String method, String path, Set<Integer> pass) { this.method = method; this.path = path; this.pass = pass; }
    }

    // Set.of 는 Android API 30+ 라 minSdk 24 에서 못 쓴다
    static Set<Integer> codes(Integer... c) { return new HashSet<>(Arrays.asList(c)); }

    static final Map<String, Op> OPS = new HashMap<>();

    static {
        OPS.put("whoami", new Op("GET", "/api/app/whoami", codes(200)));
        OPS.put("docs.get", new Op("GET", "/api/app/docs", codes(200)));
        // 기존 /api/docs 쓰기가 화면까지 넘기던 코드(400·403·404·409 cur·500·503) 그대로. 409 는 «다른 사람이 먼저 고침» — 재시도 없음
        OPS.put("docs.post", new Op("POST", "/api/app/docs", codes(200, 400, 403, 404, 409, 500, 503)));
        OPS.put("media.list", new Op("GET", "/api/app/media", codes(200)));
    }

    private final Transport net;
    private final Vault vault;
    private final String appOrigin;   // Android https://localhost · iOS capacitor://localhost — 신원 근거 아님

    private String origin, token, device, account;
    private double exp;
    private long gen;

    public FhGateCore(Transport net, Vault vault, String appOrigin, double nowSec) {
        this.net = net; this.vault = vault; this.appOrigin = appOrigin;
        restore(nowSec);
    }

    // ── 관문 주소 규칙: mobile/scripts/gate-profile.mjs gateOrigin 과 같은 규칙 ──
    public static String gateOrigin(String raw) throws GateError {
        if (raw == null || raw.isEmpty() || raw.matches("(?s).*[\\s#@*\\\\].*")) throw bad("공백·#·@·*·\\ 가 든 주소는 받지 않는다");
        URI u;
        try { u = new URI(raw); } catch (Exception e) { throw bad("URL 형식 아님"); }
        if (!"https".equals(u.getScheme())) throw bad("https 만");
        if (u.getRawUserInfo() != null) throw bad("사용자정보 금지");
        String host = u.getHost();
        if (host == null) throw bad("호스트 없음");
        if (u.getRawQuery() != null || u.getRawFragment() != null || !(u.getRawPath() == null || u.getRawPath().isEmpty() || u.getRawPath().equals("/")))
            throw bad("경로·질의·조각 없이 origin 만");
        int port = u.getPort();
        String norm = "https://" + host + (port == -1 || port == 443 ? "" : ":" + port);
        String trimmed = raw.endsWith("/") ? raw.substring(0, raw.length() - 1) : raw;
        if (!trimmed.equals(norm) || !host.equals(host.toLowerCase(java.util.Locale.ROOT))) throw bad("정규화와 다른 주소(대소문자·기본 포트 표기 등)");
        if (host.equals("localhost") || host.endsWith(".localhost")) throw bad("localhost 금지 — 127.0.0.1 등 실제 주소");
        return norm;
    }

    // ── 상태 ──
    public synchronized long gen() { return gen; }

    public synchronized Map<String, Object> state() {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("origin", origin);
        m.put("loggedIn", token != null);
        m.put("account", token != null ? account : null);
        m.put("device6", token != null && device != null ? device.substring(0, Math.min(6, device.length())) : null);
        m.put("exp", token != null ? exp : null);
        m.put("gen", gen);
        return m;
    }

    /** 주소를 바꾸면 로컬 세션을 끝낸다(기기 값도 그 관문 것이라 지움). 서버 로그아웃 재료를 돌려준다. */
    public Ended setGate(String raw) throws GateError {
        String o = gateOrigin(raw);
        synchronized (this) {
            if (o.equals(origin)) return new Ended(null, null, gen);
            Ended e = endLocal();
            origin = o; device = null;
            persist();
            return e;
        }
    }

    /** 로그아웃·만료·주소 변경의 로컬 부분: gen+1, 토큰 폐기, 저장. 서버 응답을 기다리지 않는다. */
    public synchronized Ended endLocal() {
        Ended e = new Ended(origin, token, ++gen);
        token = null; account = null; exp = 0;
        persist();
        return e;
    }

    // ── 로그인 ──
    public Login login(String user, String pw, String label) throws GateError {
        if (user == null || pw == null || user.isEmpty() || user.length() > 64 || pw.isEmpty() || pw.length() > 256) throw bad("계정·비밀번호 형식");
        if (label != null && label.length() > 64) throw bad("기기 이름 64자 이하");
        long g; String o, dev;
        synchronized (this) {
            if (origin == null) throw new GateError("no_gate", "관문 주소 먼저");
            if (token != null) throw new GateError("bad_state", "이미 로그인 — 먼저 로그아웃");
            g = gen; o = origin; dev = device;
        }
        JSONObject b = new JSONObject();
        try {
            b.put("user", user).put("pw", pw);
            if (label != null) b.put("label", label);
            if (dev != null) b.put("device", dev);
        } catch (JSONException e) { throw bad("형식"); }
        Resp r = call("POST", o + "/api/app/login", null, b.toString().getBytes(StandardCharsets.UTF_8), JSON_MAX);
        if (r.status != 200) throw statusError(r.status);
        String tok, newDev, acc; double ex;
        try {
            JSONObject j = new JSONObject(r.text());
            tok = j.getString("token"); newDev = j.getString("device"); acc = j.getString("account"); ex = j.getDouble("exp");
        } catch (JSONException e) { throw new GateError("server", "로그인 응답 형식"); }
        if (!TOKEN.matcher(tok).matches() || !TOKEN.matcher(newDev).matches() || acc.isEmpty() || acc.length() > 64) throw new GateError("server", "로그인 응답 값");
        synchronized (this) {
            if (gen == g && o.equals(origin)) {
                token = tok; device = newDev; account = acc; exp = ex;
                persist();
                return new Login(acc, newDev.substring(0, 6), ex, gen);
            }
        }
        // 취소된 로그인: 토큰은 저장하지 않고, 서버에 생긴 그 세션도 한 번 끝내 둔다(실패해도 TTL 로 끝남)
        serverLogout(new Ended(o, tok, g));
        throw new GateError("stale", "취소된 로그인 — 응답 버림");
    }

    // ── 고정 op 요청 ──
    public Result request(String opName, String bodyJson) throws GateError {
        Op op = OPS.get(opName);
        if (op == null) throw bad("모르는 op");
        byte[] body = null;
        if (op.method.equals("POST")) {
            if (bodyJson == null) throw bad("본문 필요");
            body = bodyJson.getBytes(StandardCharsets.UTF_8);
            if (body.length > JSON_MAX) throw new GateError("too_big", "본문이 큼");
        }
        return authed(op.method, op.path, body, JSON_MAX, op.pass);
    }

    public Result photo(String path) throws GateError {
        if (path == null || !PHOTO.matcher(path).matches()) throw bad("사진 경로 아님");
        Result res = authed("GET", "/api/app/" + path, null, PHOTO_MAX, codes(200, 404));
        if (res.resp.status == 200 && !res.resp.type.toLowerCase(java.util.Locale.ROOT).startsWith("image/jpeg")) throw new GateError("bad_type", "jpeg 아님");
        return res;
    }

    /** 1회용 WS 표가 든 주소. 표 자체는 ≤30 s·1회라 JS 에 넘긴다(장수명 토큰은 아님). */
    public Result wsTicket() throws GateError {
        Result res = authed("POST", "/api/app/ws-ticket", new byte[0], JSON_MAX, codes(200));
        String t;
        try { t = new JSONObject(res.resp.text()).getString("ticket"); } catch (JSONException e) { throw new GateError("server", "표 응답 형식"); }
        if (!TICKET.matcher(t).matches()) throw new GateError("server", "표 값");
        String o;
        synchronized (this) { if (gen != res.gen) throw new GateError("stale", "취소된 연결 — 표 버림"); o = origin; }
        String url = "wss://" + o.substring("https://".length()) + "/api/app/ws?t=" + t;
        return new Result(new Resp(200, "text/plain", url.getBytes(StandardCharsets.UTF_8)), res.gen);
    }

    /** 로컬 폐기 뒤 백그라운드에서 한 번. 결과 "ok"·"failed"·"none" — 실패를 성공으로 바꾸지 않는다. */
    public String serverLogout(Ended e) {
        if (e.token == null || e.origin == null) return "none";
        Map<String, String> h = headers(e.token);
        try {
            Resp r = net.send("POST", e.origin + "/api/app/logout", h, new byte[0], JSON_MAX);
            return r.status == 200 || r.status == 401 ? "ok" : "failed";   // 401 = 서버에서 이미 끝난 세션
        } catch (IOException x) {
            return "failed";
        }
    }

    // ── 공통 ──
    private Result authed(String method, String path, byte[] body, int max, Set<Integer> pass) throws GateError {
        long g; String o, tok;
        synchronized (this) {
            if (origin == null) throw new GateError("no_gate", "관문 주소 먼저");
            if (token == null) throw new GateError("no_session", "로그인 필요");
            g = gen; o = origin; tok = token;
        }
        Resp r = call(method, o + path, tok, body, max);
        synchronized (this) {
            if (gen != g) throw new GateError("stale", "취소된 요청 — 응답 버림");
            if (r.status == 401) { endLocal(); throw new GateError("auth", "세션 끝남 — 다시 로그인"); }
        }
        if (!pass.contains(r.status)) throw statusError(r.status);
        return new Result(r, g);
    }

    private Resp call(String method, String url, String tok, byte[] body, int max) throws GateError {
        try {
            return net.send(method, url, headers(tok), body, max);
        } catch (IOException e) {
            if ("too_big".equals(e.getMessage())) throw new GateError("too_big", "응답이 상한보다 큼");
            String c = classify(e);
            throw new GateError(c, c.equals("tls") ? "관문 인증서를 믿을 수 없음 — 연결 안 함" : "관문에 닿지 않음");
        }
    }

    private Map<String, String> headers(String tok) {
        Map<String, String> h = new LinkedHashMap<>();
        h.put("Origin", appOrigin);                 // 네이티브 HTTP 는 Origin 을 자동으로 안 붙인다고 보고 명시
        h.put("Accept", "application/json");
        h.put("Content-Type", "application/json");
        if (tok != null) h.put("Authorization", "Bearer " + tok);
        return h;
    }

    static GateError statusError(int s) {
        if (s >= 300 && s < 400) return new GateError("redirect", "관문이 다른 곳으로 보냄 — 따라가지 않음");
        if (s == 400) return new GateError("bad_input", "형식");
        if (s == 401) return new GateError("auth", "계정 또는 비밀번호가 틀림");
        if (s == 403) return new GateError("origin", "관문이 이 앱 출처를 거부");
        if (s == 429) return new GateError("busy", "시도가 많음 — 잠시 뒤");
        return new GateError("server", "관문 응답 " + s);
    }

    /** 네이티브 예외 → 원인 종류. 모르는 것은 unknown(추측해서 tls·net 으로 바꾸지 않음). */
    public static String classify(Throwable e) {
        for (Throwable t = e; t != null; t = t.getCause()) {
            if (t instanceof SSLException || t instanceof CertPathValidatorException || t instanceof CertificateException) return "tls";
        }
        for (Throwable t = e; t != null; t = t.getCause()) {
            if (t instanceof UnknownHostException || t instanceof ConnectException || t instanceof NoRouteToHostException
                    || t instanceof SocketTimeoutException || t instanceof SocketException) return "net";
        }
        return "unknown";
    }

    private static GateError bad(String msg) { return new GateError("bad_input", msg); }

    // ── 보관: origin·device 는 로그아웃 뒤에도 남고, token·account·exp 는 로그아웃 때 지운다 ──
    private void persist() {
        JSONObject j = new JSONObject();
        try {
            j.put("origin", origin).put("device", device).put("token", token).put("account", account).put("exp", exp);
        } catch (JSONException e) { throw new IllegalStateException(e); }
        vault.save(j.toString());
    }

    private void restore(double now) {
        String s = vault.load();
        if (s == null) return;
        try {
            JSONObject j = new JSONObject(s);
            String o = str(j, "origin");
            origin = o == null ? null : gateOrigin(o);       // 보관본도 같은 규칙으로 다시 검사
            device = str(j, "device");
            String t = str(j, "token");
            double ex = j.optDouble("exp", 0);
            if (t != null && TOKEN.matcher(t).matches() && ex > now) { token = t; account = str(j, "account"); exp = ex; }
        } catch (JSONException | GateError e) {
            origin = null; device = null;      // 깨진 보관본은 버리고 처음부터
        }
        persist();                              // 만료 토큰은 여기서 지워진다
    }

    private static String str(JSONObject j, String k) throws JSONException { return j.has(k) && !j.isNull(k) ? j.getString(k) : null; }

    // ── 실제 HTTP: 플랫폼 기본 TLS 검사 그대로, redirect 안 따라감, 본문 상한 ──
    public static final class HttpsTransport implements Transport {
        @Override
        public Resp send(String method, String url, Map<String, String> headers, byte[] body, int maxBytes) throws IOException {
            if (!url.startsWith("https://")) throw new IOException("https 만");
            HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
            if (!(c instanceof HttpsURLConnection)) throw new IOException("https 연결 아님");
            try {
                c.setInstanceFollowRedirects(false);
                c.setUseCaches(false);
                c.setConnectTimeout(5000);
                c.setReadTimeout(10000);
                c.setRequestMethod(method);
                for (Map.Entry<String, String> e : headers.entrySet()) c.setRequestProperty(e.getKey(), e.getValue());
                if (body != null && method.equals("POST")) {
                    c.setDoOutput(true);
                    c.setFixedLengthStreamingMode(body.length);
                    try (OutputStream os = c.getOutputStream()) { os.write(body); }
                }
                int st = c.getResponseCode();
                InputStream in = st >= 400 ? c.getErrorStream() : c.getInputStream();
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                if (in != null) {
                    try (InputStream is = in) {
                        byte[] buf = new byte[16384];
                        for (int n; (n = is.read(buf)) != -1; ) {
                            if (out.size() + n > maxBytes) throw new IOException("too_big");
                            out.write(buf, 0, n);
                        }
                    }
                }
                return new Resp(st, c.getContentType(), out.toByteArray());
            } finally {
                c.disconnect();
            }
        }
    }
}
