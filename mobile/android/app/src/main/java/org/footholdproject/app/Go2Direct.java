package org.footholdproject.app;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.InetAddress;
import java.nio.charset.StandardCharsets;
import java.security.KeyFactory;
import java.security.SecureRandom;
import java.security.interfaces.RSAPublicKey;
import java.security.spec.X509EncodedKeySpec;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.function.BooleanSupplier;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Go2 직접 연결(계약 mobile/docs/GO2DIRECT-CONTRACT.md) — PC 관문(FhGate)과 별개인 순수 Java 부분.
 * 탐색 응답 판정 · 로봇 등록부 · LAN signaling(9991 con_notify → con_ing) · 평문 HTTP/1.1 최소 파서.
 * 바이트 형식 출처: 커뮤니티 MIT legion1581/unitree_webrtc_connect @e0abc57(Unitree 공식 보증 아님) + REA 정적 대조. 실로봇 실측 0.
 * 포함 안 함: data2=2(앱 내장 정적 키 — 추출 비밀이라 미포함) · 8081 /offer(옛 평문) · 클라우드 키 취득 · 원격/TURN · 점군 · 이동 명령.
 */
final class Go2Direct {
    static final String GROUP = "231.1.1.1", AP_ADDR = "192.168.12.1";
    static final int Q_PORT = 10131, R_PORT = 10134, SIG_PORT = 9991;
    static final int DGRAM_MAX = 1024, MAX_ROBOTS = 16;
    static final int HEAD_MAX = 8 * 1024, BODY_MAX = 64 * 1024, SDP_MAX = 32 * 1024, DATA1_MAX = 16 * 1024;
    static final int RSA_MIN_BITS = 1024, RSA_MAX_BITS = 4096;
    static final long SIG_DEADLINE_MS = 10_000;
    static final Pattern SN = Pattern.compile("^[A-Za-z0-9]{6,32}$");
    static final Pattern V4 = Pattern.compile("^(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})$");
    static final Pattern SUFFIX = Pattern.compile("^(?:[!-~][A-J]){5}$");      // con_notify data1 끝 10 자: 짝마다 둘째 글자 A–J → 숫자 하나
    static final Pattern PEM_B64 = Pattern.compile("^[A-Za-z0-9+/]{100,1400}={0,2}$");
    static final Pattern HEX32 = Pattern.compile("^[0-9a-f]{32}$");

    private Go2Direct() {}

    /** 오류 code 는 계약 표 그대로 JS 로 간다. 메시지에 키·주소·SDP 를 넣지 않는다. */
    static final class Err extends Exception {
        final String code;
        Err(String code, String msg) { super(msg); this.code = code; }
    }

    // ── 탐색 ──────────────────────────────────────────────────────────────

    static byte[] query(String sn) {
        JSONObject o = new JSONObject();
        try {
            o.put("name", "unitree_dapengche");
            if (sn != null) o.put("sn", sn);
        } catch (JSONException e) { throw new IllegalStateException(e); }
        return o.toString().getBytes(StandardCharsets.UTF_8);
    }

    /** 탐색 후보 = 응답 sn + 출발지 주소. 미검증 목록일 뿐(연결·저장 0). */
    static final class Robot implements FhNearby.Keyed {
        final String sn, ip;
        Robot(String sn, String ip) { this.sn = sn; this.ip = ip; }
        @Override public String key() { return sn; }
    }

    /** null = 버림. 출발지는 사설 IPv4, 크기 ≤1024, JSON 객체, sn 형식, ip 값이 있으면 출발지와 같아야 한다(다른 주소를 가리키는 응답 거부). */
    static Robot reply(byte[] data, int len, InetAddress src) {
        if (data == null || len <= 0 || len > DGRAM_MAX || !FhNearby.privateV4(src)) return null;
        JSONObject o;
        try { o = new JSONObject(new String(data, 0, len, StandardCharsets.UTF_8)); } catch (JSONException e) { return null; }
        Object sn = o.opt("sn"), ip = o.opt("ip");
        if (!(sn instanceof String) || !SN.matcher((String) sn).matches()) return null;
        String from = src.getHostAddress();
        if (ip != null && !from.equals(ip)) return null;
        return new Robot((String) sn, from);
    }

    /** 점 4개 사설 IPv4 글자만(이름 해석 0). 아니면 null. */
    static InetAddress privateLiteral(String ip) {
        if (ip == null) return null;
        Matcher m = V4.matcher(ip);
        if (!m.matches()) return null;
        byte[] b = new byte[4];
        for (int i = 0; i < 4; i++) {
            String g = m.group(i + 1);
            if (g.length() > 1 && g.charAt(0) == '0') return null;   // 08 같은 8진수 오해 표기 거부
            int v = Integer.parseInt(g);
            if (v > 255) return null;
            b[i] = (byte) v;
        }
        try {
            InetAddress a = InetAddress.getByAddress(b);
            return FhNearby.privateV4(a) ? a : null;
        } catch (IOException e) { return null; }
    }

    /** 기기 키 입력(32 hex). 틀리면 null — 입력값을 오류에 싣지 않는다. */
    static byte[] keyHex(String s) {
        if (s == null) return null;
        s = s.trim().toLowerCase(Locale.ROOT);
        if (!HEX32.matcher(s).matches()) return null;
        byte[] b = new byte[16];
        for (int i = 0; i < 16; i++) b[i] = (byte) Integer.parseInt(s.substring(2 * i, 2 * i + 2), 16);
        return b;
    }

    // ── 등록부: 처음 본 로봇은 사람이 골라 등록. 키는 안에만 있고 밖으로는 hasKey 만 ─────────────

    static final class Registry {
        static final class Entry {
            final String sn, name; final byte[] key;
            Entry(String sn, String name, byte[] key) { this.sn = sn; this.name = name; this.key = key; }
        }

        private final FhGateCore.Vault vault;
        private Map<String, Entry> by = new LinkedHashMap<>();
        private String state = "ok";   // ok · unreadable(보관본은 있으나 못 풂) · invalid(풀었으나 형식 위반)
        private long gen;              // 설정 세대: 저장이 확인된 변경(등록·이름·키·삭제·reset)마다 +1. 옛 세대에 시작한 연결 결과는 채택 0(호출자가 대조)

        /**
         * 원본 보존: 못 풀거나 형식이 하나라도 틀리면 «일부 채택» 없이 전부 채택 0, 보관본은 그대로 두고 state 로 알린다.
         * 이 상태에서 register·setKey·forget 은 storage 거부(조용히 덮어쓰기 0). 덮는 길은 사용자가 명시한 reset() 뿐.
         */
        Registry(FhGateCore.Vault vault) {
            this.vault = vault;
            String s = vault.load();
            if (s == null) { if (vault.present()) state = "unreadable"; return; }
            Map<String, Entry> m = parse(s);
            if (m == null) state = "invalid"; else by = m;
        }

        /** v=1 · robots 배열 ≤16 · 항목마다 sn(형식)·name(정리된 글 그대로)·key(없거나 소문자 32 hex) · sn 중복 0. 하나라도 어기면 null. */
        static Map<String, Entry> parse(String s) {
            try {
                org.json.JSONTokener t = new org.json.JSONTokener(s);
                Object top = t.nextValue();
                if (!(top instanceof JSONObject) || t.more()) return null;   // JSONObject(String) 는 뒤에 붙은 글자를 무시한다 — 끝까지 확인
                JSONObject root = (JSONObject) top;
                Object v = root.opt("v"), ro = root.opt("robots");
                if (!(v instanceof Integer) || (Integer) v != 1 || !(ro instanceof JSONArray)) return null;
                JSONArray a = (JSONArray) ro;
                if (a.length() > MAX_ROBOTS) return null;
                Map<String, Entry> m = new LinkedHashMap<>();
                for (int i = 0; i < a.length(); i++) {
                    if (!(a.get(i) instanceof JSONObject)) return null;
                    JSONObject o = a.getJSONObject(i);
                    Object sn = o.opt("sn"), name = o.opt("name"), key = o.opt("key");
                    if (!(sn instanceof String) || !SN.matcher((String) sn).matches() || m.containsKey(sn)) return null;
                    if (!(name instanceof String) || ((String) name).isEmpty() || !FhNearby.name((String) name).equals(name)) return null;
                    if (key != null && !(key instanceof String && HEX32.matcher((String) key).matches())) return null;
                    m.put((String) sn, new Entry((String) sn, (String) name, key == null ? null : keyHex((String) key)));
                }
                return m;
            } catch (JSONException e) { return null; }
        }

        synchronized String state() { return state; }

        /** 사용자가 명시한 초기화만: 빈 등록부를 저장(옛 보관본과 그 안의 기기 키는 사라짐). 저장 실패면 상태 그대로. */
        synchronized void reset() throws Err {
            if (!vault.save("{\"v\":1,\"robots\":[]}")) throw new Err("storage", "등록부 저장 실패");
            by = new LinkedHashMap<>();
            state = "ok";
            gen++;
        }

        synchronized long gen() { return gen; }

        synchronized List<Entry> list() { return new ArrayList<>(by.values()); }
        synchronized boolean known(String sn) { return by.containsKey(sn); }
        synchronized byte[] key(String sn) { Entry e = by.get(sn); return e == null ? null : e.key; }

        synchronized void register(String sn, String name) throws Err {
            usable();
            if (sn == null || !SN.matcher(sn).matches()) throw new Err("bad_input", "로봇 일련번호 형식");
            if (!by.containsKey(sn) && by.size() >= MAX_ROBOTS) throw new Err("full", "등록은 16대까지");
            String n = FhNearby.name(name);
            if (!FhNearby.name(n).equals(n)) throw new Err("bad_input", "이름 형식(역슬래시 표기)");   // 다시 읽을 때 달라지는 이름 = 복원 때 invalid 가 됨
            Entry old = by.get(sn);
            commit(sn, new Entry(sn, n.isEmpty() ? sn : n, old == null ? null : old.key));
        }

        synchronized void forget(String sn) throws Err { usable(); need(sn); commit(sn, null); }

        synchronized void setKey(String sn, byte[] key) throws Err {
            usable();
            Entry e = need(sn);
            if (key != null && key.length != 16) throw new Err("bad_input", "기기 키 형식(32 hex)");
            commit(sn, new Entry(sn, e.name, key));
        }

        private void usable() throws Err {
            if (!"ok".equals(state)) throw new Err("storage", "등록부 원본을 읽지 못함 — 명시 초기화 전 변경 0");
        }

        private Entry need(String sn) throws Err {
            Entry e = sn == null ? null : by.get(sn);
            if (e == null) throw new Err("not_registered", "등록되지 않은 로봇");
            return e;
        }

        /** 디스크 반영이 확인돼야 메모리에도 반영 — 실패면 이전 상태 그대로 storage 오류. */
        private void commit(String sn, Entry e) throws Err {
            Map<String, Entry> next = new LinkedHashMap<>(by);
            if (e == null) next.remove(sn); else next.put(sn, e);
            JSONArray a = new JSONArray();
            try {
                for (Entry x : next.values()) {
                    JSONObject o = new JSONObject().put("sn", x.sn).put("name", x.name);
                    if (x.key != null) o.put("key", hex(x.key));
                    a.put(o);
                }
                if (!vault.save(new JSONObject().put("v", 1).put("robots", a).toString())) throw new Err("storage", "등록부 저장 실패");
            } catch (JSONException ex) { throw new Err("internal", "등록부 형식"); }
            by = next;
            gen++;
        }
    }

    static String hex(byte[] b) {
        StringBuilder s = new StringBuilder();
        for (byte x : b) s.append(String.format(Locale.ROOT, "%02x", x & 0xff));
        return s.toString();
    }

    // ── signaling(LAN 9991) ─────────────────────────────────────────────

    /** 평문 HTTP POST 한 번. 결과 = 200 본문(상한 BODY_MAX). 그 밖 상태·redirect·형식 위반은 Err. 구현은 시험용 가짜뿐 — 실소켓 미구현. */
    interface Http {
        byte[] post(InetAddress ip, String path, String contentType, byte[] body, long deadlineMs) throws IOException, Err;
    }

    static final class Answer {
        final String sdp, auth;   // auth = device_key(기기 키 GCM 으로 공개키 인증) · none(data2=1, 미인증 — 읽기만, 명령 개방 0)
        Answer(String sdp, String auth) { this.sdp = sdp; this.auth = auth; }
    }

    /**
     * offer SDP → answer SDP. 단계 사이마다 cancelled 확인(true 면 stale). 시한은 전체 하나(deadlineMs, 절대 시각).
     * mode sta = 같은 LAN(id STA_localNetwork), ap = 로봇 Wi-Fi 직접(id 빈 글).
     */
    static Answer signal(Http h, String ip, String mode, String offerSdp, byte[] devKey, long deadlineMs, BooleanSupplier cancelled, SecureRandom rnd) throws Err, IOException {
        InetAddress a = privateLiteral(ip);
        if (a == null) throw new Err("bad_input", "로봇 주소는 사설 IPv4 숫자만");
        if (!"sta".equals(mode) && !"ap".equals(mode)) throw new Err("bad_input", "mode 는 sta·ap");
        if (offerSdp == null || offerSdp.length() > SDP_MAX || !offerSdp.startsWith("v=0")) throw new Err("bad_input", "offer SDP 형식");
        if (cancelled.getAsBoolean()) throw new Err("stale", "취소됨");

        // ① con_notify → base64(JSON{data1, data2})
        byte[] r1 = h.post(a, "/con_notify", null, new byte[0], deadlineMs);
        if (cancelled.getAsBoolean()) throw new Err("stale", "취소됨");
        JSONObject n;
        try { n = new JSONObject(new String(b64(new String(r1, StandardCharsets.US_ASCII).trim()), StandardCharsets.UTF_8)); }
        catch (JSONException e) { throw new Err("bad_robot", "con_notify 형식"); }
        Object d1o = n.opt("data1"), d2o = n.opt("data2");
        if (!(d1o instanceof String) || ((String) d1o).length() > DATA1_MAX) throw new Err("bad_robot", "con_notify data1");
        int d2 = d2o == null ? 1 : (d2o instanceof Integer ? (Integer) d2o : -1);
        String data1, auth;
        if (d2 == 1) { data1 = (String) d1o; auth = "none"; }
        else if (d2 == 2) throw new Err("unsupported_legacy_key", "이 펌웨어 방식(data2=2)은 지원하지 않음");
        else if (d2 == 3) {
            if (devKey == null) throw new Err("key_required", "기기 키 필요(data2=3)");
            data1 = gcmOpen(devKey, b64((String) d1o));
            auth = "device_key";
        } else throw new Err("bad_robot", "con_notify data2");

        // ② data1 = 앞 10 자 + 공개키(base64 DER) + 끝 10 자(경로)
        if (data1.length() < 120) throw new Err("bad_robot", "con_notify data1 길이");
        String suffix = data1.substring(data1.length() - 10), pem = data1.substring(10, data1.length() - 10);
        if (!SUFFIX.matcher(suffix).matches() || !PEM_B64.matcher(pem).matches()) throw new Err("bad_robot", "con_notify data1 형식");
        StringBuilder path = new StringBuilder("/con_ing_");
        for (int i = 1; i < 10; i += 2) path.append((char) ('0' + (suffix.charAt(i) - 'A')));
        RSAPublicKey pub;
        try { pub = (RSAPublicKey) KeyFactory.getInstance("RSA").generatePublic(new X509EncodedKeySpec(b64(pem))); }
        catch (Exception e) { throw new Err("bad_robot", "로봇 공개키 형식"); }
        int bits = pub.getModulus().bitLength();
        if (bits < RSA_MIN_BITS || bits > RSA_MAX_BITS) throw new Err("bad_robot", "로봇 공개키 길이");

        // ③ con_ing: data1 = AES-256-ECB(offer JSON) · data2 = RSA-PKCS1v1.5(AES 키 글자 32 개). 프로토콜이 정한 방식(ECB) — 바꿀 수 없음
        byte[] k = new byte[16];
        rnd.nextBytes(k);
        byte[] aesKey = hex(k).getBytes(StandardCharsets.US_ASCII);
        String body;
        try {
            String offer = new JSONObject().put("id", "sta".equals(mode) ? "STA_localNetwork" : "").put("sdp", offerSdp).put("type", "offer").put("token", "").toString();
            Cipher rsa = Cipher.getInstance("RSA/ECB/PKCS1Padding");
            rsa.init(Cipher.ENCRYPT_MODE, pub);
            body = new JSONObject()
                    .put("data1", b64(ecb(Cipher.ENCRYPT_MODE, aesKey, offer.getBytes(StandardCharsets.UTF_8))))
                    .put("data2", b64(rsa.doFinal(aesKey))).toString();
        } catch (Err e) { throw e; } catch (Exception e) { throw new Err("internal", "암호화 실패"); }
        if (cancelled.getAsBoolean()) throw new Err("stale", "취소됨");
        byte[] r2 = h.post(a, path.toString(), "application/x-www-form-urlencoded", body.getBytes(StandardCharsets.UTF_8), deadlineMs);
        if (cancelled.getAsBoolean()) throw new Err("stale", "취소됨");

        // ④ answer = AES-256-ECB(JSON{sdp,type})
        JSONObject ans;
        try { ans = new JSONObject(new String(ecb(Cipher.DECRYPT_MODE, aesKey, b64(new String(r2, StandardCharsets.US_ASCII).trim())), StandardCharsets.UTF_8)); }
        catch (JSONException e) { throw new Err("bad_robot", "answer 형식"); }
        Object sdp = ans.opt("sdp"), type = ans.opt("type");
        if ("reject".equals(sdp)) throw new Err("robot_busy", "로봇이 다른 연결을 쓰는 중");
        if (!"answer".equals(type) || !(sdp instanceof String) || ((String) sdp).length() > SDP_MAX || !((String) sdp).startsWith("v=0")) throw new Err("bad_robot", "answer SDP 형식");
        return new Answer((String) sdp, auth);
    }

    // ponytail: java.util.Base64 는 API 26+ (minSdk 24) — 표준 알파벳·패딩 필수의 엄격한 최소 구현
    private static final String B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

    static String b64(byte[] b) {
        StringBuilder s = new StringBuilder();
        for (int i = 0; i < b.length; i += 3) {
            int n = (b[i] & 0xff) << 16 | (i + 1 < b.length ? (b[i + 1] & 0xff) << 8 : 0) | (i + 2 < b.length ? b[i + 2] & 0xff : 0);
            s.append(B64.charAt(n >> 18 & 63)).append(B64.charAt(n >> 12 & 63))
             .append(i + 1 < b.length ? B64.charAt(n >> 6 & 63) : '=').append(i + 2 < b.length ? B64.charAt(n & 63) : '=');
        }
        return s.toString();
    }

    static byte[] b64(String s) throws Err {
        if (s == null || s.length() % 4 != 0) throw new Err("bad_robot", "base64 형식");
        int pad = s.endsWith("==") ? 2 : s.endsWith("=") ? 1 : 0;
        byte[] out = new byte[s.length() / 4 * 3 - pad];
        for (int i = 0, o = 0; i < s.length(); i += 4) {
            int n = 0;
            for (int j = 0; j < 4; j++) {
                char c = s.charAt(i + j);
                int v = c == '=' && i + 4 == s.length() && j >= 4 - pad ? 0 : B64.indexOf(c);
                if (v < 0) throw new Err("bad_robot", "base64 형식");
                n = n << 6 | v;
            }
            for (int j = 0; j < 3 && o < out.length; j++) out[o++] = (byte) (n >> (16 - 8 * j));
        }
        return out;
    }

    private static byte[] ecb(int mode, byte[] key, byte[] in) throws Err {
        try {
            Cipher c = Cipher.getInstance("AES/ECB/PKCS5Padding");
            c.init(mode, new SecretKeySpec(key, "AES"));
            return c.doFinal(in);
        } catch (Exception e) { throw new Err("bad_robot", "AES 복호 실패"); }
    }

    /** data2=3: raw = 암호문 ‖ nonce(12) ‖ tag(16). 태그 불일치 = 키가 이 로봇 것이 아님. */
    static String gcmOpen(byte[] key, byte[] raw) throws Err {
        if (raw.length < 28 + 1) throw new Err("bad_robot", "data1 길이(GCM)");
        int ct = raw.length - 28;
        byte[] in = new byte[ct + 16];
        System.arraycopy(raw, 0, in, 0, ct);
        System.arraycopy(raw, raw.length - 16, in, ct, 16);
        try {
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.DECRYPT_MODE, new SecretKeySpec(key, "AES"), new GCMParameterSpec(128, raw, ct, 12));
            return new String(c.doFinal(in), StandardCharsets.UTF_8);
        } catch (Exception e) { throw new Err("key_rejected", "기기 키가 이 로봇과 맞지 않음"); }
    }

    // ── 평문 HTTP/1.1 바이트 형식(Go2 9991 signaling 전용 예외 — 관문 TLS 와 무관). 실소켓 Port 는 미구현(파일 0) ──

    static byte[] request(InetAddress ip, String path, String contentType, byte[] body) {
        StringBuilder h = new StringBuilder("POST ").append(path).append(" HTTP/1.1\r\nHost: ").append(ip.getHostAddress()).append(':').append(SIG_PORT)
                .append("\r\nConnection: close\r\nAccept-Encoding: identity\r\nContent-Length: ").append(body.length).append("\r\n");
        if (contentType != null) h.append("Content-Type: ").append(contentType).append("\r\n");
        byte[] head = h.append("\r\n").toString().getBytes(StandardCharsets.US_ASCII);
        byte[] all = new byte[head.length + body.length];
        System.arraycopy(head, 0, all, 0, head.length);
        System.arraycopy(body, 0, all, head.length, body.length);
        return all;
    }

    /** 응답 읽기: 머리 ≤8 KiB, 본문 ≤64 KiB. 200 만 성공 — 3xx(redirect)·그 밖 상태·multipart·chunked 외 전송 인코딩은 거부. */
    static byte[] response(InputStream in) throws IOException, Err {
        ByteArrayOutputStream hb = new ByteArrayOutputStream();
        int st = 0;
        while (st < 4) {
            int c = in.read();
            if (c < 0) throw new Err("bad_robot", "응답 머리가 끊김");
            hb.write(c);
            if (hb.size() > HEAD_MAX) throw new Err("bad_robot", "응답 머리 상한 초과");
            st = (c == '\r' && (st == 0 || st == 2)) || (c == '\n' && (st == 1 || st == 3)) ? st + 1 : (c == '\r' ? 1 : 0);
        }
        String[] lines = new String(hb.toByteArray(), StandardCharsets.ISO_8859_1).split("\r\n");
        Matcher m = Pattern.compile("^HTTP/1\\.[01] (\\d{3})(?: .*)?$").matcher(lines[0]);
        if (!m.matches()) throw new Err("bad_robot", "응답 상태줄");
        int status = Integer.parseInt(m.group(1));
        if (status >= 300 && status < 400) throw new Err("bad_robot", "redirect 거부");
        if (status != 200) throw new Err("bad_robot", "로봇 응답 상태 " + status);
        long len = -1;
        boolean chunked = false;
        for (int i = 1; i < lines.length; i++) {
            int p = lines[i].indexOf(':');
            if (p <= 0) continue;
            String k = lines[i].substring(0, p).trim().toLowerCase(Locale.ROOT), v = lines[i].substring(p + 1).trim();
            if (k.equals("content-length")) {
                if (!v.matches("\\d{1,9}") || len >= 0) throw new Err("bad_robot", "Content-Length 형식");
                len = Long.parseLong(v);
                if (len > BODY_MAX) throw new Err("bad_robot", "응답 본문 상한 초과");
            } else if (k.equals("transfer-encoding")) {
                if (!v.equalsIgnoreCase("chunked")) throw new Err("bad_robot", "전송 인코딩 거부");
                chunked = true;
            } else if (k.equals("content-type") && v.toLowerCase(Locale.ROOT).startsWith("multipart/")) {
                throw new Err("bad_robot", "multipart 거부");
            }
        }
        if (chunked && len >= 0) throw new Err("bad_robot", "길이 표기 충돌");
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        if (len >= 0) readN(in, out, (int) len);
        else if (chunked) {
            while (true) {
                String sz = line(in);
                int semi = sz.indexOf(';');
                if (semi >= 0) sz = sz.substring(0, semi);
                if (!sz.trim().matches("[0-9a-fA-F]{1,6}")) throw new Err("bad_robot", "chunk 크기 형식");
                int n = Integer.parseInt(sz.trim(), 16);
                if (n == 0) break;
                if (out.size() + n > BODY_MAX) throw new Err("bad_robot", "응답 본문 상한 초과");
                readN(in, out, n);
                if (!line(in).isEmpty()) throw new Err("bad_robot", "chunk 끝 형식");
            }
        } else {
            byte[] buf = new byte[4096];
            for (int r; (r = in.read(buf)) > 0; ) {
                if (out.size() + r > BODY_MAX) throw new Err("bad_robot", "응답 본문 상한 초과");
                out.write(buf, 0, r);
            }
        }
        return out.toByteArray();
    }

    private static void readN(InputStream in, ByteArrayOutputStream out, int n) throws IOException, Err {
        byte[] buf = new byte[Math.min(n, 4096) + 1];
        while (n > 0) {
            int r = in.read(buf, 0, Math.min(n, buf.length));
            if (r < 0) throw new Err("bad_robot", "응답 본문이 끊김");
            out.write(buf, 0, r);
            n -= r;
        }
    }

    private static String line(InputStream in) throws IOException, Err {
        StringBuilder s = new StringBuilder();
        for (int c; ; ) {
            c = in.read();
            if (c < 0) throw new Err("bad_robot", "응답이 끊김");
            if (c == '\n') break;
            if (c != '\r') s.append((char) c);
            if (s.length() > 64) throw new Err("bad_robot", "chunk 줄 상한 초과");
        }
        return s.toString();
    }

}
