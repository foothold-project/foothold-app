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
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.function.DoubleSupplier;
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
 *  - 호출 문맥 Ctx: 플러그인이 호출을 «받는 순간» gen·origin·token 을 고정한다. 실행 직전·응답 뒤에 현재와 대조해
 *    다르면 stale — 네트워크 0(실행 전) 또는 결과 버림(응답 뒤). 새 관문·새 세션으로 다시 해석하지 않는다.
 *  - gen 은 로그인 성공·로그아웃·주소 변경·401 때 +1. 오류·이벤트의 gen 은 그 사건이 속한 Ctx 의 gen(현재 값으로 고쳐 붙이지 않음).
 *  - 재시도 없음. TLS 는 플랫폼 기본 검사 그대로(신뢰·호스트 이름 검사 교체 없음).
 */
public final class FhGateCore {

    // ── 바깥과의 경계 두 개: 시험에서는 가짜, 앱에서는 HttpsTransport · 플러그인의 Keystore 저장소 ──
    public interface Transport {
        /** redirect 를 따라가지 않고 maxBytes 를 넘는 본문은 IOException("too_big"). */
        Resp send(String method, String url, Map<String, String> headers, byte[] body, int maxBytes) throws IOException;
    }

    public interface Vault {   // 세션 한 덩어리(JSON 글)를 암호화해 보관. 둘 다 «디스크에 반영됐을 때만» true
        String load();
        boolean save(String json);
        boolean clear();
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

    /** JS 로는 code·짧은 글·gen 만 간다. gen = 이 오류가 속한 호출 문맥의 gen. */
    public static final class GateError extends Exception {
        public final String code;
        public final long gen;
        public final boolean sessionEnded;   // 이 호출의 세션이 401 로 끝났다(로그인 401 = 비번 틀림과 구분)

        GateError(String code, String msg, long gen) { this(code, msg, gen, false); }

        GateError(String code, String msg, long gen, boolean sessionEnded) { super(msg); this.code = code; this.gen = gen; this.sessionEnded = sessionEnded; }
    }

    /** 호출 문맥 — 플러그인이 받는 순간 고정. token 은 네이티브 안에서만 쓰인다. */
    public static final class Ctx {
        final long gen;
        final String origin, token;

        Ctx(long gen, String origin, String token) { this.gen = gen; this.origin = origin; this.token = token; }

        public long gen() { return gen; }
    }

    public static final class Login {
        public final String account, device6;
        public final double exp;
        public final long gen;
        public final boolean stored;   // false = 메모리에만 — 앱을 다시 켜면 재로그인

        Login(String account, String device6, double exp, long gen, boolean stored) {
            this.account = account; this.device6 = device6; this.exp = exp; this.gen = gen; this.stored = stored;
        }
    }

    public static final class Result {
        public final Resp resp;
        public final long gen;

        Result(Resp resp, long gen) { this.resp = resp; this.gen = gen; }
    }

    /** 로컬 폐기 결과 + 서버에 알릴 재료(토큰은 플러그인이 serverLogout 에만 넘긴다). */
    public static final class Ended {
        final String origin, token;
        public final long gen;          // 폐기 뒤의 새 gen
        public final boolean wiped;     // 디스크에서도 지워졌나. false 면 locked — 로그인·요청 거부 유지

        Ended(String origin, String token, long gen, boolean wiped) { this.origin = origin; this.token = token; this.gen = gen; this.wiped = wiped; }

        public boolean hadSession() { return token != null; }
    }

    // ── 고정 값 ──
    public static final int JSON_MAX = 1 << 20;            // ponytail: 1 MB·5 MB 는 임시 상한 — 실측(사진 크기·문서 크기) 뒤 조정
    public static final int PHOTO_MAX = 5 << 20;
    static final double EXP_MAX_AHEAD = 31 * 86400;         // 관문 TTL(기본 12 h)보다 넉넉한 상한 — 이보다 먼 만료는 형식 오류로 본다
    static final int TICKET_TTL_MAX = 30;
    // v2_link 문서 검사(PHOTO: media/photos/\d{8}/[\w.-]{1,80}\.jpg + '..' 금지)와 같은 모양. Java \w 는 ASCII 만 — 더 좁은 쪽은 안전
    static final Pattern PHOTO = Pattern.compile("^media/photos/\\d{8}/[\\w.-]{1,80}\\.jpg$");
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
    private final DoubleSupplier now; // epoch 초

    private String origin, token, device, account;
    private double exp;
    private long gen;
    private long loginGen = -1;       // 진행 중 로그인이 시작된 gen. 같은 gen 에 두 번째 로그인은 busy
    private boolean closed;           // 인스턴스 수명 끝(Activity 파괴) — 이후 모든 호출 stale, 보관소 쓰기 없음
    private boolean stored = true;    // 현재 세션이 디스크에 있나
    private boolean locked;           // 로컬 폐기가 디스크에 반영 안 됨 — 로그인·요청 거부

    public FhGateCore(Transport net, Vault vault, String appOrigin, DoubleSupplier now) {
        this.net = net; this.vault = vault; this.appOrigin = appOrigin; this.now = now;
        restore();
    }

    // ── 관문 주소 규칙: mobile/scripts/gate-profile.mjs gateOrigin 과 같은 규칙 ──
    public static String gateOrigin(String raw) throws GateError {
        if (raw == null || raw.isEmpty() || raw.matches("(?s).*[\\s#@*\\\\].*")) throw bad("공백·#·@·*·\\ 가 든 주소는 받지 않는다", -1);
        URI u;
        try { u = new URI(raw); } catch (Exception e) { throw bad("URL 형식 아님", -1); }
        if (!"https".equals(u.getScheme())) throw bad("https 만", -1);
        if (u.getRawUserInfo() != null) throw bad("사용자정보 금지", -1);
        String host = u.getHost();
        if (host == null) throw bad("호스트 없음", -1);
        if (u.getRawQuery() != null || u.getRawFragment() != null || !(u.getRawPath() == null || u.getRawPath().isEmpty() || u.getRawPath().equals("/")))
            throw bad("경로·질의·조각 없이 origin 만", -1);
        int port = u.getPort();
        if (port > 65535) throw bad("포트 범위 밖", -1);   // JS new URL 도 65536 이상은 거부
        String norm = "https://" + host + (port == -1 || port == 443 ? "" : ":" + port);
        String trimmed = raw.endsWith("/") ? raw.substring(0, raw.length() - 1) : raw;
        if (!trimmed.equals(norm) || !host.equals(host.toLowerCase(Locale.ROOT))) throw bad("정규화와 다른 주소(대소문자·기본 포트 표기 등)", -1);
        if (host.equals("localhost") || host.endsWith(".localhost")) throw bad("localhost 금지 — 127.0.0.1 등 실제 주소", -1);
        return norm;
    }

    // ── 상태·문맥 ──
    public synchronized long gen() { return gen; }

    /** 플러그인이 호출을 받는 순간 부른다(io 스레드에 넘기기 전). */
    public synchronized Ctx ctx() { return new Ctx(gen, origin, token); }

    public synchronized boolean current(Ctx c) { return !closed && c.gen == gen; }

    public synchronized Map<String, Object> state() {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("origin", origin);
        m.put("loggedIn", token != null);
        m.put("account", token != null ? account : null);
        m.put("device6", token != null && device != null ? device.substring(0, 6) : null);
        m.put("exp", token != null ? exp : null);
        m.put("stored", token != null ? stored : null);
        m.put("locked", locked);
        m.put("gen", gen);
        return m;
    }

    /** 주소를 바꾸면 로컬 세션을 끝낸다(기기 값도 그 관문 것이라 지움). 서버 로그아웃 재료를 돌려준다. */
    public Ended setGate(String raw) throws GateError {
        String o = gateOrigin(raw);
        synchronized (this) {
            if (closed) throw new GateError("stale", "앱 화면이 다시 만들어짐", gen);
            if (o.equals(origin)) return new Ended(null, null, gen, !locked);
            String oldOrigin = origin, oldToken = token;
            origin = o; device = null;
            return endLocalWith(oldOrigin, oldToken);
        }
    }

    /** 로그아웃·만료의 로컬 부분: gen+1, 토큰 폐기, 디스크 반영. 서버 응답을 기다리지 않는다. */
    public synchronized Ended endLocal() {
        return endLocalWith(origin, token);
    }

    private Ended endLocalWith(String oldOrigin, String oldToken) {
        token = null; account = null; exp = 0;
        ++gen;
        boolean wiped = persist();
        return new Ended(oldOrigin, oldToken, gen, wiped);
    }

    /** Activity 파괴 — 이 인스턴스의 대기·진행 중 작업을 전부 무효로. 보관 세션은 그대로 둔다(사용자 로그아웃 아님). */
    public synchronized void close() { closed = true; }

    // ── 로그인 ──
    public Login login(Ctx c, String user, String pw, String label) throws GateError {
        if (user == null || pw == null || user.isEmpty() || user.length() > 64 || pw.isEmpty() || pw.length() > 256) throw bad("계정·비밀번호 형식", c.gen);
        if (label != null && label.length() > 64) throw bad("기기 이름 64자 이하", c.gen);
        String dev;
        synchronized (this) {
            live(c);
            if (c.origin == null) throw new GateError("no_gate", "관문 주소 먼저", c.gen);
            if (token != null) throw new GateError("bad_state", "이미 로그인 — 먼저 로그아웃", c.gen);
            if (loginGen == gen) throw new GateError("busy", "로그인 진행 중", c.gen);
            loginGen = gen;
            dev = device;
        }
        try {
            JSONObject b = new JSONObject();
            try {
                b.put("user", user).put("pw", pw);
                if (label != null) b.put("label", label);
                if (dev != null) b.put("device", dev);
            } catch (JSONException e) { throw bad("형식", c.gen); }
            Resp r = call(c, "POST", c.origin + "/api/app/login", null, b.toString().getBytes(StandardCharsets.UTF_8), JSON_MAX);
            if (r.status != 200) { staleCheck(c); throw statusError(r.status, c.gen); }
            JSONObject j; String tok;
            try {
                j = new JSONObject(r.text());
                tok = strictStr(j, "token");
            } catch (JSONException e) { staleCheck(c); throw new GateError("server", "로그인 응답 형식", c.gen); }
            if (!TOKEN.matcher(tok).matches()) { staleCheck(c); throw new GateError("server", "로그인 응답 값", c.gen); }
            // 쓸 수 있는 토큰은 받았으니, 여기부터 형식 오류·취소면 서버에 생긴 그 세션을 한 번 끝내 둔다
            String newDev = null, acc = null; double ex = Double.NaN;
            try { newDev = strictStr(j, "device"); acc = strictStr(j, "account"); ex = strictNum(j, "exp"); } catch (JSONException e) { /* 아래 검사에서 거부 */ }
            if (newDev == null || acc == null || !TOKEN.matcher(newDev).matches() || acc.isEmpty() || acc.length() > 64 || !validExp(ex)) {
                serverLogout(new Ended(c.origin, tok, c.gen, true));
                staleCheck(c);
                throw new GateError("server", "로그인 응답 값", c.gen);
            }
            synchronized (this) {
                if (!closed && gen == c.gen && token == null && c.origin.equals(origin) && !locked) {
                    token = tok; device = newDev; account = acc; exp = ex;   // 검사를 다 마친 값만 한꺼번에
                    ++gen;
                    boolean ok = persist();
                    return new Login(acc, newDev.substring(0, 6), ex, gen, ok);
                }
            }
            serverLogout(new Ended(c.origin, tok, c.gen, true));   // 취소된 로그인: 저장하지 않고 서버 세션도 정리(실패해도 TTL 로 끝남)
            throw new GateError("stale", "취소된 로그인 — 응답 버림", c.gen);
        } finally {
            synchronized (this) { if (loginGen == c.gen) loginGen = -1; }
        }
    }

    // ── 고정 op 요청 ──
    public Result request(Ctx c, String opName, String bodyJson) throws GateError {
        Op op = OPS.get(opName);
        if (op == null) throw bad("모르는 op", c.gen);
        byte[] body = null;
        if (op.method.equals("POST")) {
            if (bodyJson == null) throw bad("본문 필요", c.gen);
            body = bodyJson.getBytes(StandardCharsets.UTF_8);
            if (body.length > JSON_MAX) throw new GateError("too_big", "본문이 큼", c.gen);
        }
        return authed(c, op.method, op.path, body, JSON_MAX, op.pass);
    }

    public Result photo(Ctx c, String path) throws GateError {
        if (path == null || !PHOTO.matcher(path).matches() || path.contains("..")) throw bad("사진 경로 아님", c.gen);
        Result res = authed(c, "GET", "/api/app/" + path, null, PHOTO_MAX, codes(200, 404));
        if (res.resp.status == 200 && !res.resp.type.toLowerCase(Locale.ROOT).startsWith("image/jpeg")) throw new GateError("bad_type", "jpeg 아님", c.gen);
        return res;
    }

    /** 1회용 WS 표가 든 주소. 표 자체는 ≤30 s·1회라 JS 에 넘긴다(장수명 토큰은 아님). */
    public Result wsTicket(Ctx c) throws GateError {
        Result res = authed(c, "POST", "/api/app/ws-ticket", new byte[0], JSON_MAX, codes(200));
        String t; double ttl;
        try {
            JSONObject j = new JSONObject(res.resp.text());
            t = strictStr(j, "ticket"); ttl = strictNum(j, "ttl_s");
        } catch (JSONException e) { throw new GateError("server", "표 응답 형식", c.gen); }
        if (!TICKET.matcher(t).matches() || !(ttl > 0 && ttl <= TICKET_TTL_MAX)) throw new GateError("server", "표 값", c.gen);
        staleCheck(c);
        String url = "wss://" + c.origin.substring("https://".length()) + "/api/app/ws?t=" + t;
        return new Result(new Resp(200, "text/plain", url.getBytes(StandardCharsets.UTF_8)), c.gen);
    }

    /** 로컬 폐기 뒤 백그라운드에서 한 번. 결과 "ok"·"failed"·"none" — 실패를 성공으로 바꾸지 않는다. */
    public String serverLogout(Ended e) {
        if (e.token == null || e.origin == null) return "none";
        try {
            Resp r = net.send("POST", e.origin + "/api/app/logout", headers(e.token), new byte[0], JSON_MAX);
            return r.status == 200 || r.status == 401 ? "ok" : "failed";   // 401 = 서버에서 이미 끝난 세션
        } catch (IOException x) {
            return "failed";
        }
    }

    // ── 공통 ──
    private void live(Ctx c) throws GateError {   // synchronized 안에서만 부른다
        if (closed || c.gen != gen) throw new GateError("stale", "취소된 호출 — 보내지 않음", c.gen);
        if (locked) throw new GateError("storage", "기기 세션 폐기가 저장되지 않음 — 다시 로그아웃 필요", c.gen);
    }

    private synchronized void staleCheck(Ctx c) throws GateError {
        if (closed || c.gen != gen) throw new GateError("stale", "취소된 호출 — 응답 버림", c.gen);
    }

    private Result authed(Ctx c, String method, String path, byte[] body, int max, Set<Integer> pass) throws GateError {
        synchronized (this) {
            live(c);
            if (c.origin == null) throw new GateError("no_gate", "관문 주소 먼저", c.gen);
            if (c.token == null) throw new GateError("no_session", "로그인 필요", c.gen);
        }
        Resp r = call(c, method, c.origin + path, c.token, body, max);
        synchronized (this) {
            staleCheck(c);
            if (r.status == 401) { endLocal(); throw new GateError("auth", "세션 끝남 — 다시 로그인", c.gen, true); }
        }
        if (!pass.contains(r.status)) throw statusError(r.status, c.gen);
        return new Result(r, c.gen);
    }

    private Resp call(Ctx c, String method, String url, String tok, byte[] body, int max) throws GateError {
        try {
            return net.send(method, url, headers(tok), body, max);
        } catch (IOException e) {
            staleCheck(c);   // 옛 문맥의 IO 오류는 원인 대신 stale
            if ("too_big".equals(e.getMessage())) throw new GateError("too_big", "응답이 상한보다 큼", c.gen);
            String k = classify(e);
            throw new GateError(k, k.equals("tls") ? "관문 인증서를 믿을 수 없음 — 연결 안 함" : "관문에 닿지 않음", c.gen);
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

    static GateError statusError(int s, long g) {
        if (s >= 300 && s < 400) return new GateError("redirect", "관문이 다른 곳으로 보냄 — 따라가지 않음", g);
        if (s == 400) return new GateError("bad_input", "형식", g);
        if (s == 401) return new GateError("auth", "계정 또는 비밀번호가 틀림", g);
        if (s == 403) return new GateError("origin", "관문이 이 앱 출처를 거부", g);
        if (s == 429) return new GateError("busy", "시도가 많음 — 잠시 뒤", g);
        return new GateError("server", "관문 응답 " + s, g);
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
        if (e instanceof IOException && "deadline".equals(e.getMessage())) return "net";
        return "unknown";
    }

    private static GateError bad(String msg, long g) { return new GateError("bad_input", msg, g); }

    private boolean validExp(double ex) {
        double t = now.getAsDouble();
        return !Double.isNaN(ex) && !Double.isInfinite(ex) && ex > t && ex <= t + EXP_MAX_AHEAD;
    }

    // org.json 의 getString·getDouble 은 숫자↔글을 바꿔 준다 — 형식이 다르면 거부하도록 타입을 직접 본다
    private static String strictStr(JSONObject j, String k) throws JSONException {
        Object v = j.has(k) ? j.get(k) : null;
        if (!(v instanceof String)) throw new JSONException(k);
        return (String) v;
    }

    private static double strictNum(JSONObject j, String k) throws JSONException {
        Object v = j.has(k) ? j.get(k) : null;
        if (!(v instanceof Number)) throw new JSONException(k);
        return ((Number) v).doubleValue();
    }

    // ── 보관: origin·device 는 로그아웃 뒤에도 남고, token·account·exp 는 로그아웃 때 지운다 ──
    /** 디스크 반영 결과를 상태로 올린다. 세션 없음인데 반영 실패면 locked(로그인·요청 거부). synchronized 안에서만. */
    private boolean persist() {
        if (closed) return false;
        JSONObject j = new JSONObject();
        try {
            j.put("origin", origin).put("device", device).put("token", token).put("account", account).put("exp", exp);
        } catch (JSONException e) { throw new IllegalStateException(e); }
        boolean ok = vault.save(j.toString());
        if (token == null) {
            if (!ok) ok = vault.clear();   // 덮어쓰기 실패면 통째로 지우기라도 — 옛 토큰이 디스크에 남지 않게
            locked = !ok;
        } else {
            stored = ok;                   // 메모리에만 있는 세션 — 다시 켜면 재로그인
        }
        return ok;
    }

    private synchronized void restore() {
        String s = vault.load();
        if (s == null) return;
        String o = null, dev = null, tok = null, acc = null;
        double ex = 0;
        try {
            JSONObject j = new JSONObject(s);
            if (j.has("origin")) o = gateOrigin(strictStr(j, "origin"));          // 보관본도 같은 규칙으로 다시 검사
            if (j.has("device")) { dev = strictStr(j, "device"); if (!TOKEN.matcher(dev).matches()) dev = null; }
            if (j.has("token")) {
                String t = strictStr(j, "token"), a = j.has("account") ? strictStr(j, "account") : "";
                double e = j.has("exp") ? strictNum(j, "exp") : 0;
                if (TOKEN.matcher(t).matches() && !a.isEmpty() && a.length() <= 64 && validExp(e) && o != null && dev != null) { tok = t; acc = a; ex = e; }
            }
        } catch (JSONException | GateError e) {
            o = null; dev = null; tok = null;      // 깨진 보관본은 버리고 처음부터
        }
        origin = o; device = dev; token = tok; account = acc; exp = ex;   // 검사를 다 마친 값만 한꺼번에
        persist();                                                        // 만료·불량 토큰은 여기서 지워진다
    }

    // ── 실제 HTTP: 플랫폼 기본 TLS 검사 그대로, redirect 안 따라감, 본문 상한, 전체 시한 ──
    public static final class HttpsTransport implements Transport {
        // 연결 5 s·읽기 한 번 10 s 와 별개로 응답 전체 20 s — 조금씩 흘려 보내는 응답이 무한히 붙잡지 못하게(본문 읽는 중에만 검사)
        static final long TOTAL_MS = 20000;

        @Override
        public Resp send(String method, String url, Map<String, String> headers, byte[] body, int maxBytes) throws IOException {
            if (!url.startsWith("https://")) throw new IOException("https 만");
            long deadline = System.nanoTime() + TOTAL_MS * 1_000_000L;
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
                            if (System.nanoTime() > deadline) throw new IOException("deadline");
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
