package org.footholdproject.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.io.IOException;
import java.net.ConnectException;
import java.net.UnknownHostException;
import java.nio.charset.StandardCharsets;
import java.security.cert.CertPathValidatorException;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import javax.net.ssl.SSLHandshakeException;
import org.junit.Test;

/** 가짜 통신·가짜 보관소로 FhGateCore 계약만 본다(네트워크·Keystore·에뮬 없음). */
public class FhGateCoreTest {
    static final String GATE = "https://gate.example.org:18453";
    static final String TOK = "tok_AAAAAAAAAAAAAAAAAAAA", DEV = "dev_BBBBBBBBBBBBBBBBBBBB";

    static final class Req {
        final String method, url, body; final Map<String, String> h; final int max;
        Req(String m, String u, Map<String, String> h, byte[] b, int max) { method = m; url = u; this.h = h; body = b == null ? null : new String(b, StandardCharsets.UTF_8); this.max = max; }
    }

    interface Answer { FhGateCore.Resp on(Req r) throws IOException; }

    static final class FakeNet implements FhGateCore.Transport {
        final List<Req> reqs = new ArrayList<>(); Answer a;
        @Override public FhGateCore.Resp send(String m, String u, Map<String, String> h, byte[] b, int max) throws IOException {
            Req r = new Req(m, u, h, b, max); reqs.add(r); return a.on(r);
        }
    }

    static final class MemVault implements FhGateCore.Vault {
        String v;
        @Override public String load() { return v; }
        @Override public void save(String json) { v = json; }
    }

    static FhGateCore.Resp json(int st, String s) { return new FhGateCore.Resp(st, "application/json", s.getBytes(StandardCharsets.UTF_8)); }
    static final String LOGIN_OK = "{\"token\":\"" + TOK + "\",\"device\":\"" + DEV + "\",\"account\":\"fixture\",\"exp\":2000000000}";

    FakeNet net = new FakeNet(); MemVault vault = new MemVault();

    FhGateCore loggedIn() throws Exception {
        FhGateCore c = new FhGateCore(net, vault, "https://localhost", 1000);
        c.setGate(GATE);
        net.a = r -> json(200, LOGIN_OK);
        c.login("fixture", "pw", "폰");
        net.reqs.clear();
        return c;
    }

    static String code(ThrowingRunnable r) {
        try { r.run(); } catch (FhGateCore.GateError e) { return e.code; } catch (Exception e) { throw new AssertionError(e); }
        throw new AssertionError("오류 기대");
    }

    interface ThrowingRunnable { void run() throws Exception; }

    @Test public void gateOriginSameRulesAsGateProfile() throws Exception {
        assertEquals("https://127.0.0.1:18453", FhGateCore.gateOrigin("https://127.0.0.1:18453"));
        assertEquals("https://127.0.0.1:18453", FhGateCore.gateOrigin("https://127.0.0.1:18453/"));
        assertEquals("https://gate.example.org", FhGateCore.gateOrigin("https://gate.example.org"));
        String[] bad = {"http://127.0.0.1:18453", "https://u:p@127.0.0.1:18453", "https://127.0.0.1:18453/#x", "https://127.0.0.1:18453#", "https://127.0.0.1:18453/?a=1",
            "https://127.0.0.1:18453/MDrive.dc.html", "https://*.example.org", "https://localhost:18453", "wss://127.0.0.1:18453", "capacitor://localhost",
            "https://127.0.0.1:443", "HTTPS://127.0.0.1:18453", " https://127.0.0.1:18453", "https://127.0.0.1:18453 ", "", null, "https://Gate.example.org"};
        for (String b : bad) assertEquals(b, "bad_input", code(() -> FhGateCore.gateOrigin(b)));
    }

    @Test public void loginKeepsTokenNativeAndSendsExactOrigin() throws Exception {
        FhGateCore c = new FhGateCore(net, vault, "https://localhost", 1000);
        c.setGate(GATE);
        net.a = r -> json(200, LOGIN_OK);
        FhGateCore.Login l = c.login("fixture", "pw", "폰");
        Req r = net.reqs.get(0);
        assertEquals("POST", r.method); assertEquals(GATE + "/api/app/login", r.url);
        assertEquals("https://localhost", r.h.get("Origin")); assertNull(r.h.get("Authorization"));
        assertEquals("fixture", l.account); assertEquals("dev_BB", l.device6);
        assertFalse(c.state().toString().contains(TOK));          // 화면에 가는 상태에 토큰 없음
        assertTrue(vault.v.contains(TOK));                          // 보관소(네이티브)에만
        assertEquals("bad_state", code(() -> c.login("fixture", "pw", null)));   // 로그인 중 재로그인 거부
    }

    @Test public void loginFailuresMapToCodes() throws Exception {
        FhGateCore c = new FhGateCore(net, vault, "https://localhost", 1000);
        assertEquals("no_gate", code(() -> c.login("a", "b", null)));
        c.setGate(GATE);
        int[] st = {400, 401, 403, 429, 302, 500};
        String[] want = {"bad_input", "auth", "origin", "busy", "redirect", "server"};
        for (int i = 0; i < st.length; i++) { int s = st[i]; net.a = r -> json(s, "{}"); assertEquals(want[i], code(() -> c.login("a", "b", null))); }
        net.a = r -> json(200, "{\"token\":\"short\",\"device\":\"" + DEV + "\",\"account\":\"a\",\"exp\":1}");
        assertEquals("server", code(() -> c.login("a", "b", null)));
        assertFalse(String.valueOf(vault.v).contains("short"));
    }

    @Test public void staleLoginIsDroppedNotStored() throws Exception {
        FhGateCore c = new FhGateCore(net, vault, "https://localhost", 1000);
        c.setGate(GATE);
        net.a = r -> { c.endLocal(); return json(200, LOGIN_OK); };   // 응답 오기 전에 로그아웃·주소 변경
        assertEquals("stale", code(() -> c.login("fixture", "pw", null)));
        assertFalse(vault.v.contains(TOK)); assertEquals(false, c.state().get("loggedIn"));
        assertEquals(2, net.reqs.size());                                     // 서버에 생긴 그 세션은 한 번 로그아웃
        assertEquals(GATE + "/api/app/logout", net.reqs.get(1).url); assertEquals("Bearer " + TOK, net.reqs.get(1).h.get("Authorization"));
    }

    @Test public void requestUsesBearerFixedPathAndKeepsDocsCodesWithoutRetry() throws Exception {
        FhGateCore c = loggedIn();
        net.a = r -> json(409, "{\"cur\":{\"v\":3}}");
        FhGateCore.Result res = c.request("docs.post", "{\"k\":1}");
        assertEquals(409, res.resp.status); assertTrue(res.resp.text().contains("cur"));
        Req r = net.reqs.get(0);
        assertEquals("POST", r.method); assertEquals(GATE + "/api/app/docs", r.url);
        assertEquals("Bearer " + TOK, r.h.get("Authorization")); assertEquals("https://localhost", r.h.get("Origin"));
        for (int s : new int[]{400, 403, 404, 500, 503}) { net.a = q -> json(s, "{}"); assertEquals(s, c.request("docs.post", "{}").resp.status); }
        assertEquals(6, net.reqs.size());                           // 재시도 없음: 요청 6번 = 전송 6번
        net.a = q -> json(503, "{}");
        assertEquals("server", code(() -> c.request("docs.get", null)));
        assertEquals("bad_input", code(() -> c.request("http://evil/x", null)));
        assertEquals("bad_input", code(() -> c.request("docs.post", null)));
        net.a = q -> json(301, "");
        assertEquals("redirect", code(() -> c.request("whoami", null)));
    }

    @Test public void unauthorizedEndsLocalSessionAndBumpsGen() throws Exception {
        FhGateCore c = loggedIn();
        long g = c.gen();
        net.a = r -> json(401, "{}");
        assertEquals("auth", code(() -> c.request("whoami", null)));
        assertEquals(g + 1, c.gen()); assertFalse(vault.v.contains(TOK));
        assertEquals("no_session", code(() -> c.request("whoami", null)));
    }

    @Test public void staleRequestResultIsDropped() throws Exception {
        FhGateCore c = loggedIn();
        net.a = r -> { c.endLocal(); return json(200, "{}"); };
        assertEquals("stale", code(() -> c.request("whoami", null)));
    }

    @Test public void photoPathCheckedBeforeAnyNetwork() throws Exception {
        FhGateCore c = loggedIn();
        for (String p : new String[]{"media/photos/2026101/a.jpg", "media/photos/20261013/../x.jpg", "media/photos/20261013/a.png", "/media/photos/20261013/a.jpg",
                "https://evil/media/photos/20261013/a.jpg", "media/photos/20261013/a.jpg?x=1", "api/media", null})
            assertEquals(String.valueOf(p), "bad_input", code(() -> c.photo(p)));
        assertEquals(0, net.reqs.size());
        net.a = r -> new FhGateCore.Resp(200, "image/jpeg", new byte[]{1, 2});
        FhGateCore.Result res = c.photo("media/photos/20261013/cam-1.jpg");
        assertEquals(GATE + "/api/app/media/photos/20261013/cam-1.jpg", net.reqs.get(0).url);
        assertEquals(FhGateCore.PHOTO_MAX, net.reqs.get(0).max); assertEquals(2, res.resp.body.length);
        net.a = r -> new FhGateCore.Resp(200, "text/html", new byte[]{1});
        assertEquals("bad_type", code(() -> c.photo("media/photos/20261013/cam-1.jpg")));
        net.a = r -> { throw new IOException("too_big"); };
        assertEquals("too_big", code(() -> c.photo("media/photos/20261013/cam-1.jpg")));
    }

    @Test public void wsTicketUrlAndValidation() throws Exception {
        FhGateCore c = loggedIn();
        net.a = r -> json(200, "{\"ticket\":\"tkt_CCCCCCCCCCCCCCCCCCCC\",\"ttl_s\":30}");
        FhGateCore.Result res = c.wsTicket();
        assertEquals("wss://gate.example.org:18453/api/app/ws?t=tkt_CCCCCCCCCCCCCCCCCCCC", res.resp.text());
        assertFalse(res.resp.text().contains(TOK));
        net.a = r -> json(200, "{\"ticket\":\"a&b=c\"}");
        assertEquals("server", code(c::wsTicket));
    }

    @Test public void logoutIsLocalFirstAndServerFailureIsNotSuccess() throws Exception {
        FhGateCore c = loggedIn();
        long g = c.gen();
        FhGateCore.Ended e = c.endLocal();
        assertTrue(e.hadSession()); assertEquals(g + 1, e.gen);
        assertFalse(vault.v.contains(TOK)); assertTrue(vault.v.contains(DEV));     // 기기 값은 같은 관문에서 유지
        assertEquals(0, net.reqs.size());                                           // 서버 응답 안 기다림
        net.a = r -> { throw new ConnectException("x"); };
        assertEquals("failed", c.serverLogout(e));
        net.a = r -> json(500, "{}");
        assertEquals("failed", c.serverLogout(e));
        net.a = r -> json(200, "{}");
        assertEquals("ok", c.serverLogout(e));
        assertEquals("Bearer " + TOK, net.reqs.get(2).h.get("Authorization"));
        assertEquals("none", c.serverLogout(c.endLocal()));
    }

    @Test public void gateChangeWipesSessionAndDevice() throws Exception {
        FhGateCore c = loggedIn();
        FhGateCore.Ended same = c.setGate(GATE);
        assertFalse(same.hadSession()); assertEquals(true, c.state().get("loggedIn"));
        FhGateCore.Ended e = c.setGate("https://other.example.org");
        assertTrue(e.hadSession()); assertFalse(vault.v.contains(TOK)); assertFalse(vault.v.contains(DEV));
        assertEquals("https://other.example.org", c.state().get("origin"));
    }

    @Test public void restoreDropsExpiredAndRechecksOrigin() throws Exception {
        loggedIn();
        FhGateCore later = new FhGateCore(net, vault, "https://localhost", 2000000001.0);
        assertEquals(false, later.state().get("loggedIn")); assertFalse(vault.v.contains(TOK));
        vault.v = "{\"origin\":\"http://evil\",\"token\":\"" + TOK + "\",\"exp\":3000000000}";
        FhGateCore bad = new FhGateCore(net, vault, "https://localhost", 1000);
        assertNull(bad.state().get("origin"));
    }

    @Test public void classifyNativeErrors() {
        assertEquals("tls", FhGateCore.classify(new SSLHandshakeException("x")));
        assertEquals("tls", FhGateCore.classify(new IOException(new CertPathValidatorException("x"))));
        assertEquals("net", FhGateCore.classify(new UnknownHostException("x")));
        assertEquals("unknown", FhGateCore.classify(new IOException("x")));
    }

    @Test public void httpsTransportRefusesPlainHttp() {
        try { new FhGateCore.HttpsTransport().send("GET", "http://127.0.0.1:1/", Map.of(), null, 10); fail(); }
        catch (IOException e) { assertEquals("https 만", e.getMessage()); }
    }
}
