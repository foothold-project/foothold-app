package org.footholdproject.app;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.io.ByteArrayInputStream;
import java.net.InetAddress;
import java.nio.charset.StandardCharsets;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.List;
import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import org.json.JSONObject;
import org.junit.Test;

/** Go2Direct 반례 — 가짜 로봇(JVM RSA 키쌍)·가짜 HTTP. 실로봇·실소켓·실펌웨어 형식 확인 아님(커뮤니티 코드 기준 재현). */
public class Go2DirectTest {
    static final String OFFER = "v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\n";
    static final byte[] DEVKEY = new byte[16];
    static { for (int i = 0; i < 16; i++) DEVKEY[i] = (byte) (i * 7 + 1); }

    static InetAddress ip(String s) throws Exception { return InetAddress.getByName(s); }

    static Go2Direct.Robot rep(String json, String src) throws Exception {
        byte[] b = json.getBytes(StandardCharsets.UTF_8);
        return Go2Direct.reply(b, b.length, ip(src));
    }

    // ── 탐색 응답 ──
    @Test public void replyStrict() throws Exception {
        Go2Direct.Robot r = rep("{\"sn\":\"B42D2000ABCDEF12\",\"ip\":\"192.168.1.20\"}", "192.168.1.20");
        assertEquals("B42D2000ABCDEF12", r.sn); assertEquals("192.168.1.20", r.ip); assertEquals("B42D2000ABCDEF12", r.key());
        assertEquals("192.168.1.21", rep("{\"sn\":\"B42D2000ABCDEF12\"}", "192.168.1.21").ip);          // ip 없으면 출발지
        assertNull(rep("{\"sn\":\"B42D2000ABCDEF12\",\"ip\":\"192.168.1.99\"}", "192.168.1.20"));      // 다른 주소를 가리킴
        assertNull(rep("{\"sn\":\"B42D2000ABCDEF12\"}", "8.8.8.8"));                                  // 공인
        assertNull(rep("{\"sn\":\"B42D2000ABCDEF12\"}", "100.100.1.1"));                              // CGNAT/Tailscale
        assertNull(rep("{\"sn\":\"B42D 2000\"}", "10.0.0.2"));                                        // sn 형식
        assertNull(rep("{\"sn\":\"../../x\"}", "10.0.0.2"));
        assertNull(rep("{\"sn\":12345678}", "10.0.0.2"));
        assertNull(rep("{\"name\":\"unitree_dapengche\"}", "10.0.0.2"));                              // 다른 폰의 질의 메아리
        assertNull(rep("not json", "10.0.0.2"));
        byte[] big = new byte[1025];
        assertNull(Go2Direct.reply(big, big.length, ip("10.0.0.2")));
        assertEquals("{\"name\":\"unitree_dapengche\"}", new String(Go2Direct.query(null), StandardCharsets.UTF_8));
    }

    @Test public void scanDedupBySnAndCap() throws Exception {
        FhNearby.Scan<Go2Direct.Robot> s = new FhNearby.Scan<>();
        assertTrue(s.add(rep("{\"sn\":\"SN000001\"}", "10.0.0.2")));
        assertFalse(s.add(rep("{\"sn\":\"SN000001\"}", "10.0.0.3")));   // 같은 sn 의 두 번째 주소는 버림(처음 것만)
        for (int i = 2; i < 30; i++) s.add(rep("{\"sn\":\"SN0000" + (10 + i) + "\"}", "10.0.0." + i));
        assertEquals(16, s.items().size());
    }

    @Test public void literalAndKeyHex() {
        assertTrue(Go2Direct.privateLiteral("192.168.12.1") != null);
        assertNull(Go2Direct.privateLiteral("robot.local"));
        assertNull(Go2Direct.privateLiteral("192.168.012.1"));
        assertNull(Go2Direct.privateLiteral("8.8.8.8"));
        assertNull(Go2Direct.privateLiteral("192.168.1.256"));
        assertArrayEquals(DEVKEY, Go2Direct.keyHex(" " + Go2Direct.hex(DEVKEY).toUpperCase() + "\n"));
        assertNull(Go2Direct.keyHex("abc"));
        assertNull(Go2Direct.keyHex(Go2Direct.hex(DEVKEY) + "00"));
        assertNull(Go2Direct.keyHex(Go2Direct.hex(DEVKEY).replace('1', 'g')));
    }

    @Test public void b64RoundTripAndStrict() throws Exception {
        SecureRandom r = new SecureRandom();
        for (int n = 0; n < 40; n++) {
            byte[] b = new byte[n]; r.nextBytes(b);
            String e = Go2Direct.b64(b);
            assertEquals(java.util.Base64.getEncoder().encodeToString(b), e);
            assertArrayEquals(b, Go2Direct.b64(e));
        }
        for (String bad : new String[]{"abc", "ab=c", "a=bc", "ab-_", "====", "ab c"}) {
            try { Go2Direct.b64(bad); fail(bad); } catch (Go2Direct.Err e) { assertEquals("bad_robot", e.code); }
        }
    }

    // ── 등록부 ──
    static final class MemVault implements FhGateCore.Vault {
        String blob; boolean ok = true, undecryptable;
        @Override public String load() { return undecryptable ? null : blob; }
        @Override public boolean present() { return blob != null; }
        @Override public boolean save(String json) { if (ok) blob = json; return ok; }
        @Override public boolean clear() { blob = null; return true; }
    }

    @Test public void registryCommitsOnlyWhenSaved() throws Exception {
        MemVault v = new MemVault();
        Go2Direct.Registry g = new Go2Direct.Registry(v);
        g.register("SN000001", "현장 ‮로봇\u0007");
        assertEquals("현장 로봇", g.list().get(0).name);                    // 방향 바꾸기·제어 문자 제거
        g.setKey("SN000001", DEVKEY);
        assertArrayEquals(DEVKEY, new Go2Direct.Registry(v).key("SN000001"));   // 다시 열어도 같음
        v.ok = false;
        try { g.forget("SN000001"); fail(); } catch (Go2Direct.Err e) { assertEquals("storage", e.code); }
        assertTrue(g.known("SN000001"));                                    // 저장 실패면 메모리도 그대로
        v.ok = true;
        try { g.setKey("SN999999", DEVKEY); fail(); } catch (Go2Direct.Err e) { assertEquals("not_registered", e.code); }
        try { g.register("bad sn", "x"); fail(); } catch (Go2Direct.Err e) { assertEquals("bad_input", e.code); }
        g.register("SN000001", "새 이름");
        assertArrayEquals(DEVKEY, g.key("SN000001"));                       // 이름 바꿔도 키 유지
        g.forget("SN000001");
        assertFalse(new Go2Direct.Registry(v).known("SN000001"));
        for (int i = 0; i < 16; i++) g.register("SN1000" + (10 + i), "");
        try { g.register("SN200000", ""); fail(); } catch (Go2Direct.Err e) { assertEquals("full", e.code); }
        v.blob = "{broken";
        assertEquals(0, new Go2Direct.Registry(v).list().size());
        try { g.register("SN100010", "a\\\\065"); fail(); } catch (Go2Direct.Err e) { assertEquals("bad_input", e.code); }
    }

    static final String K1 = "0123456789abcdef0123456789abcdef";

    /** 손상·버전·형식 위반이면 채택 0 + 원본 보존 + 변경 거부. 덮는 길은 reset() 뿐. */
    @Test public void registryPreservesUnreadableOriginal() throws Exception {
        String ok = "{\"v\":1,\"robots\":[{\"sn\":\"SN000001\",\"name\":\"a\",\"key\":\"" + K1 + "\"}]}";
        String[] bad = {
            "{broken",
            "{\"v\":2,\"robots\":[]}",
            "{\"v\":\"1\",\"robots\":[]}",
            "{\"v\":1}",
            "{\"v\":1,\"robots\":{}}",
            "{\"v\":1,\"robots\":[1]}",
            "{\"v\":1,\"robots\":[{\"sn\":\"SN000001\",\"name\":\"a\"},{\"sn\":\"SN000001\",\"name\":\"b\"}]}",
            "{\"v\":1,\"robots\":[{\"sn\":\"bad sn\",\"name\":\"a\"}]}",
            "{\"v\":1,\"robots\":[{\"sn\":\"SN000001\"}]}",
            "{\"v\":1,\"robots\":[{\"sn\":\"SN000001\",\"name\":5}]}",
            "{\"v\":1,\"robots\":[{\"sn\":\"SN000001\",\"name\":\"a\u0007\"}]}",
            "{\"v\":1,\"robots\":[{\"sn\":\"SN000001\",\"name\":\"a\",\"key\":\"" + K1.toUpperCase() + "\"}]}",
            "{\"v\":1,\"robots\":[{\"sn\":\"SN000001\",\"name\":\"a\",\"key\":\"abc\"}]}",
            "{\"v\":1,\"robots\":[{\"sn\":\"SN000001\",\"name\":\"a\",\"key\":null}]}",
            ok.replace("]}", "," + "{\"sn\":\"SN000002\",\"name\":\"b\"}]}").replace("SN000002", "SN000002") + "x",
        };
        for (String b : bad) {
            MemVault v = new MemVault(); v.blob = b;
            Go2Direct.Registry g = new Go2Direct.Registry(v);
            assertEquals(b, "invalid", g.state());
            assertEquals(0, g.list().size());
            for (int op = 0; op < 3; op++) {
                try {
                    if (op == 0) g.register("SN000009", "x"); else if (op == 1) g.setKey("SN000001", DEVKEY); else g.forget("SN000001");
                    fail(b + " op" + op);
                } catch (Go2Direct.Err e) { assertEquals("storage", e.code); }
            }
            assertEquals(b, v.blob);                                        // 원본 그대로
        }
        StringBuilder many = new StringBuilder("{\"v\":1,\"robots\":[");
        for (int i = 0; i < 17; i++) many.append(i == 0 ? "" : ",").append("{\"sn\":\"SN1000").append(10 + i).append("\",\"name\":\"a\"}");
        MemVault vm = new MemVault(); vm.blob = many + "]}";
        assertEquals("invalid", new Go2Direct.Registry(vm).state());

        MemVault v = new MemVault(); v.blob = ok; v.undecryptable = true;    // 보관본은 있는데 못 풂(키 분실 등)
        Go2Direct.Registry g = new Go2Direct.Registry(v);
        assertEquals("unreadable", g.state());
        try { g.register("SN000009", "x"); fail(); } catch (Go2Direct.Err e) { assertEquals("storage", e.code); }
        assertEquals(ok, v.blob);
        v.ok = false;
        try { g.reset(); fail(); } catch (Go2Direct.Err e) { assertEquals("storage", e.code); }
        assertEquals("unreadable", g.state()); assertEquals(ok, v.blob);
        v.ok = true;
        g.reset();                                                          // 명시 초기화만 덮는다
        assertEquals("ok", g.state()); assertEquals(0, g.list().size());
        g.register("SN000009", "x");

        MemVault none = new MemVault();                                     // 보관본 없음 = 정상 빈 등록부
        assertEquals("ok", new Go2Direct.Registry(none).state());
        MemVault good = new MemVault(); good.blob = ok;
        Go2Direct.Registry gg = new Go2Direct.Registry(good);
        assertEquals("ok", gg.state()); assertArrayEquals(Go2Direct.keyHex(K1), gg.key("SN000001"));
    }

    /** 설정 세대: 저장이 확인된 변경만 +1. 실패·거부는 그대로 — 호출자는 시작 때 gen 과 끝날 때 gen 이 다르면 결과 채택 0. */
    @Test public void registryGenOnlyOnCommit() throws Exception {
        MemVault v = new MemVault();
        Go2Direct.Registry g = new Go2Direct.Registry(v);
        long g0 = g.gen();
        g.register("SN000001", "a");                 assertEquals(g0 + 1, g.gen());
        g.setKey("SN000001", DEVKEY);                assertEquals(g0 + 2, g.gen());
        v.ok = false;
        try { g.forget("SN000001"); fail(); } catch (Go2Direct.Err e) { assertEquals("storage", e.code); }
        assertEquals(g0 + 2, g.gen());
        v.ok = true;
        try { g.forget("SN999999"); fail(); } catch (Go2Direct.Err e) { assertEquals("not_registered", e.code); }
        assertEquals(g0 + 2, g.gen());
        g.forget("SN000001");                        assertEquals(g0 + 3, g.gen());
        g.reset();                                   assertEquals(g0 + 4, g.gen());
    }

    /** 로봇 탐색도 관문 탐색과 같은 수명 제어기(모의 Port — 데이터그램 = {bytes, 출발지}). 실 UDP Port 는 미구현. */
    @Test public void robotScanLifecycleWithMockPort() throws Exception {
        List<String> out = new ArrayList<>();
        int[] starts = {0}, stops = {0};
        List<FhNearby.Ctl.Run<Go2Direct.Robot>> runs = new ArrayList<>();
        List<FhNearby.Ctl<Go2Direct.Robot>> ctl = new ArrayList<>();
        FhNearby.Ctl<Go2Direct.Robot> c = new FhNearby.Ctl<>(new FhNearby.Ctl.Port<Go2Direct.Robot>() {
            @Override public boolean lanUp() { return true; }
            @Override public void start(FhNearby.Ctl.Run<Go2Direct.Robot> r) { starts[0]++; runs.add(r); }
            @Override public void stop(FhNearby.Ctl.Run<Go2Direct.Robot> r) { stops[0]++; }
            @Override public void resolve(FhNearby.Ctl.Run<Go2Direct.Robot> r, Object svc) {
                Object[] d = (Object[]) svc;
                ctl.get(0).resolved(r, Go2Direct.reply((byte[]) d[0], ((byte[]) d[0]).length, (InetAddress) d[1]));
            }
            @Override public boolean after(FhNearby.Ctl.Run<Go2Direct.Robot> r, int ms) { return true; }
            @Override public void cancelTimer(FhNearby.Ctl.Run<Go2Direct.Robot> r) {}
            @Override public void done(Object call, long gen, List<Go2Direct.Robot> items, String why, String stop) {
                StringBuilder b = new StringBuilder(call + " gen=" + gen + " why=" + why + " stop=" + stop);
                for (Go2Direct.Robot it : items) b.append(' ').append(it.sn).append('@').append(it.ip);
                out.add(b.toString());
            }
            @Override public void fail(Object call, String code, String msg, long gen) { out.add(call + " fail " + code); }
        });
        ctl.add(c);
        c.discover("B", 8, 3000);
        c.discover("C", 8, 3000);                                            // 진행 중 두 번째 = busy
        FhNearby.Ctl.Run<Go2Direct.Robot> r = runs.get(0);
        byte[] ok = "{\"sn\":\"SN000001\",\"ip\":\"10.0.0.5\"}".getBytes(StandardCharsets.UTF_8);
        byte[] spoof = "{\"sn\":\"SN000002\",\"ip\":\"10.0.0.99\"}".getBytes(StandardCharsets.UTF_8);
        c.found(r, new Object[]{ok, ip("10.0.0.5")});
        c.found(r, new Object[]{ok, ip("10.0.0.6")});                        // 같은 sn 다른 주소 → 처음 것만
        c.found(r, new Object[]{spoof, ip("10.0.0.7")});                     // 다른 주소를 가리킴 → 버림
        c.timeout(r);
        c.found(r, new Object[]{ok, ip("10.0.0.8")});                        // 끝난 뒤 늦은 응답 → 표시 0
        assertEquals(1, starts[0]); assertEquals(1, stops[0]);
        assertEquals(java.util.Arrays.asList("C fail busy", "B gen=8 why=null stop=requested SN000001@10.0.0.5"), out);
    }

    // ── signaling: 가짜 로봇 ──
    static final class FakeRobot implements Go2Direct.Http {
        final KeyPair kp;
        int data2 = 1; byte[] devKey = DEVKEY; String suffix = "xBxCxDxExF"; String answerSdp = "v=0\r\nanswer\r\n"; String answerType = "answer";
        final List<String> paths = new ArrayList<>();
        String gotOffer;
        FakeRobot() throws Exception {
            KeyPairGenerator g = KeyPairGenerator.getInstance("RSA"); g.initialize(1024); kp = g.generateKeyPair();
        }
        @Override public byte[] post(InetAddress ip, String path, String ct, byte[] body, long dl) throws Go2Direct.Err {
            paths.add(path);
            try {
                if (path.equals("/con_notify")) {
                    String d1 = "0123456789" + Go2Direct.b64(kp.getPublic().getEncoded()) + suffix;
                    Object enc = d1;
                    if (data2 == 3 || data2 == 2) {
                        byte[] nonce = new byte[12]; new SecureRandom().nextBytes(nonce);
                        Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
                        c.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(devKey, "AES"), new GCMParameterSpec(128, nonce));
                        byte[] ctTag = c.doFinal(d1.getBytes(StandardCharsets.UTF_8));
                        byte[] raw = new byte[ctTag.length + 12];
                        int ctl = ctTag.length - 16;
                        System.arraycopy(ctTag, 0, raw, 0, ctl); System.arraycopy(nonce, 0, raw, ctl, 12); System.arraycopy(ctTag, ctl, raw, ctl + 12, 16);
                        enc = Go2Direct.b64(raw);
                    }
                    JSONObject o = new JSONObject().put("data1", enc);
                    if (data2 != 0) o.put("data2", data2);
                    return Go2Direct.b64(o.toString().getBytes(StandardCharsets.UTF_8)).getBytes(StandardCharsets.US_ASCII);
                }
                JSONObject b = new JSONObject(new String(body, StandardCharsets.UTF_8));
                Cipher rsa = Cipher.getInstance("RSA/ECB/PKCS1Padding"); rsa.init(Cipher.DECRYPT_MODE, kp.getPrivate());
                byte[] aes = rsa.doFinal(Go2Direct.b64(b.getString("data2")));
                Cipher e = Cipher.getInstance("AES/ECB/PKCS5Padding"); e.init(Cipher.DECRYPT_MODE, new SecretKeySpec(aes, "AES"));
                gotOffer = new String(e.doFinal(Go2Direct.b64(b.getString("data1"))), StandardCharsets.UTF_8);
                e.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(aes, "AES"));
                String ans = new JSONObject().put("sdp", answerSdp).put("type", answerType).toString();
                return Go2Direct.b64(e.doFinal(ans.getBytes(StandardCharsets.UTF_8))).getBytes(StandardCharsets.US_ASCII);
            } catch (Go2Direct.Err x) { throw x; } catch (Exception x) { throw new AssertionError(x); }
        }
    }

    static Go2Direct.Answer sig(FakeRobot f, byte[] key) throws Exception {
        return Go2Direct.signal(f, "192.168.12.1", "ap", OFFER, key, System.currentTimeMillis() + 5000, () -> false, new SecureRandom());
    }

    static String code(FakeRobot f, byte[] key) throws Exception {
        try { sig(f, key); return "ok"; } catch (Go2Direct.Err e) { return e.code; }
    }

    @Test public void roundTripPlainIsUnauthenticated() throws Exception {
        FakeRobot f = new FakeRobot();
        Go2Direct.Answer a = sig(f, null);
        assertEquals("v=0\r\nanswer\r\n", a.sdp); assertEquals("none", a.auth);
        assertEquals("/con_ing_12345", f.paths.get(1));                     // xB xC xD xE xF → 1 2 3 4 5
        JSONObject o = new JSONObject(f.gotOffer);
        assertEquals("", o.getString("id")); assertEquals("offer", o.getString("type")); assertEquals(OFFER, o.getString("sdp")); assertEquals("", o.getString("token"));
        f.data2 = 0;                                                        // data2 없음 = 평문 취급
        assertEquals("none", sig(f, null).auth);
    }

    @Test public void deviceKeyPath() throws Exception {
        FakeRobot f = new FakeRobot(); f.data2 = 3;
        assertEquals("device_key", sig(f, DEVKEY).auth);
        assertEquals("key_required", code(f, null));
        byte[] wrong = DEVKEY.clone(); wrong[0] ^= 1;
        assertEquals("key_rejected", code(f, wrong));
        assertEquals(1, f.paths.stream().filter(p -> p.startsWith("/con_ing")).count());   // 키 문제면 con_ing 전송 0
    }

    @Test public void unsupportedAndBadRobot() throws Exception {
        FakeRobot f = new FakeRobot(); f.data2 = 2;
        assertEquals("unsupported_legacy_key", code(f, DEVKEY));
        f = new FakeRobot(); f.data2 = 9;
        assertEquals("bad_robot", code(f, null));
        f = new FakeRobot(); f.suffix = "xBxCxDxExK";                       // K 는 A–J 밖
        assertEquals("bad_robot", code(f, null));
        f = new FakeRobot(); f.suffix = "xBxCxDxE";                         // 길이 틀림 → 공개키 경계가 어긋남
        assertEquals("bad_robot", code(f, null));
        f = new FakeRobot(); f.answerSdp = "reject";
        assertEquals("robot_busy", code(f, null));
        f = new FakeRobot(); f.answerType = "offer";
        assertEquals("bad_robot", code(f, null));
        f = new FakeRobot(); f.answerSdp = "x";
        assertEquals("bad_robot", code(f, null));
    }

    @Test public void smallRsaRejected() throws Exception {
        KeyPairGenerator g = KeyPairGenerator.getInstance("RSA"); g.initialize(512);
        // 512 비트 공개키 → PEM 이 짧아 형식(길이 100+) 또는 길이 하한에서 거부
        KeyPair kp = g.generateKeyPair();
        Go2Direct.Http h = (ip, path, ct, body, dl) -> {
            String d1 = "0123456789" + Go2Direct.b64(kp.getPublic().getEncoded()) + "xBxCxDxExF";
            try { return Go2Direct.b64(new JSONObject().put("data1", d1).put("data2", 1).toString().getBytes(StandardCharsets.UTF_8)).getBytes(StandardCharsets.US_ASCII); }
            catch (Exception e) { throw new AssertionError(e); }
        };
        try { Go2Direct.signal(h, "10.0.0.5", "sta", OFFER, null, System.currentTimeMillis() + 5000, () -> false, new SecureRandom()); fail(); }
        catch (Go2Direct.Err e) { assertEquals("bad_robot", e.code); }
    }

    @Test public void inputAndCancel() throws Exception {
        FakeRobot f = new FakeRobot();
        long dl = System.currentTimeMillis() + 5000;
        for (String[] bad : new String[][]{{"robot.local", "ap", OFFER}, {"8.8.8.8", "ap", OFFER}, {"10.0.0.5", "remote", OFFER}, {"10.0.0.5", "ap", "x"}}) {
            try { Go2Direct.signal(f, bad[0], bad[1], bad[2], null, dl, () -> false, new SecureRandom()); fail(); }
            catch (Go2Direct.Err e) { assertEquals("bad_input", e.code); }
        }
        assertEquals(0, f.paths.size());                                    // 입력 거부 = 네트워크 0
        int[] n = {0};
        try { Go2Direct.signal(f, "10.0.0.5", "sta", OFFER, null, dl, () -> ++n[0] > 1, new SecureRandom()); fail(); }
        catch (Go2Direct.Err e) { assertEquals("stale", e.code); }
        assertEquals(1, f.paths.size());                                    // con_notify 뒤 취소 → con_ing 0
        Go2Direct.signal(f, "10.0.0.5", "sta", OFFER, null, dl, () -> false, new SecureRandom());
        assertEquals("STA_localNetwork", new JSONObject(f.gotOffer).getString("id"));
    }

    // ── 평문 HTTP 응답 파서 ──
    static String resp(String raw) {
        try { return new String(Go2Direct.response(new ByteArrayInputStream(raw.getBytes(StandardCharsets.ISO_8859_1))), StandardCharsets.ISO_8859_1); }
        catch (Go2Direct.Err e) { return "!" + e.code + ":" + e.getMessage(); }
        catch (Exception e) { return "!io"; }
    }

    @Test public void httpParser() {
        assertEquals("abc", resp("HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\nabcdef"));
        assertEquals("abcdef", resp("HTTP/1.0 200 OK\r\nContent-Type: text/plain\r\n\r\nabcdef"));         // 닫힘까지
        assertEquals("hello world", resp("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n6;x=1\r\n world\r\n0\r\n\r\n"));
        assertTrue(resp("HTTP/1.1 302 Found\r\nLocation: http://x/\r\n\r\n").startsWith("!bad_robot:redirect"));
        assertTrue(resp("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n").startsWith("!bad_robot"));
        assertTrue(resp("HTTP/1.1 200 OK\r\nContent-Type: multipart/mixed; boundary=x\r\n\r\n").startsWith("!bad_robot:multipart"));
        assertTrue(resp("HTTP/1.1 200 OK\r\nContent-Length: 999999\r\n\r\n").startsWith("!bad_robot"));
        assertTrue(resp("HTTP/1.1 200 OK\r\nContent-Length: 3\r\nContent-Length: 3\r\n\r\nabc").startsWith("!bad_robot"));
        assertTrue(resp("HTTP/1.1 200 OK\r\nContent-Length: 3\r\nTransfer-Encoding: chunked\r\n\r\nabc").startsWith("!bad_robot"));
        assertTrue(resp("HTTP/1.1 200 OK\r\nTransfer-Encoding: gzip\r\n\r\n").startsWith("!bad_robot"));
        assertTrue(resp("HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nabc").startsWith("!bad_robot"));    // 끊김
        assertTrue(resp("SSH-2.0-x\r\n\r\n").startsWith("!bad_robot"));
        StringBuilder h = new StringBuilder("HTTP/1.1 200 OK\r\n");
        while (h.length() < 9000) h.append("X-Pad: aaaaaaaaaaaaaaaaaaaaaaaa\r\n");
        assertTrue(resp(h + "\r\n").startsWith("!bad_robot:응답 머리 상한"));
        StringBuilder b = new StringBuilder("HTTP/1.1 200 OK\r\n\r\n");
        for (int i = 0; i < 70 * 1024; i++) b.append('a');
        assertTrue(resp(b.toString()).startsWith("!bad_robot:응답 본문 상한"));
    }

    @Test public void requestBytes() throws Exception {
        String r = new String(Go2Direct.request(ip("10.0.0.5"), "/con_ing_12345", "application/x-www-form-urlencoded", "{}".getBytes(StandardCharsets.UTF_8)), StandardCharsets.US_ASCII);
        assertEquals("POST /con_ing_12345 HTTP/1.1\r\nHost: 10.0.0.5:9991\r\nConnection: close\r\nAccept-Encoding: identity\r\nContent-Length: 2\r\n"
                + "Content-Type: application/x-www-form-urlencoded\r\n\r\n{}", r);
    }
}
