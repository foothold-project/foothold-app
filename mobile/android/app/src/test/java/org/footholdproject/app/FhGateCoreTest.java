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
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import javax.net.ssl.SSLHandshakeException;
import org.junit.Test;

/**
 * 가짜 통신·가짜 보관소로 FhGateCore 계약만 본다(네트워크·Keystore·에뮬 없음).
 * 경합은 «플러그인이 받은 순간의 Ctx» 를 먼저 잡아 두고 상태를 바꾼 뒤 실행하는 식으로 순서를 고정해 재현한다.
 */
public class FhGateCoreTest {
    static final String GATE = "https://gate.example.org:18453", GATE_B = "https://other.example.org";
    static final String TOK = "tok_AAAAAAAAAAAAAAAAAAAA", TOK2 = "tok_ZZZZZZZZZZZZZZZZZZZZ", DEV = "dev_BBBBBBBBBBBBBBBBBBBB";
    static final double NOW = 1_999_000_000, EXP = 2_000_000_000;   // EXP - NOW ≈ 11.6 일

    static final class Req {
        final String method, url, body; final Map<String, String> h; final int max;
        Req(String m, String u, Map<String, String> h, byte[] b, int max) { method = m; url = u; this.h = h; body = b == null ? null : new String(b, StandardCharsets.UTF_8); this.max = max; }
    }

    interface Answer { FhGateCore.Resp on(Req r) throws Exception; }   // 안에서 다른 호출(로그인 등)을 끼워 넣어 순서를 재현

    static final class FakeNet implements FhGateCore.Transport {
        final List<Req> reqs = new ArrayList<>(); Answer a;
        @Override public FhGateCore.Resp send(String m, String u, Map<String, String> h, byte[] b, int max) throws IOException {
            Req r = new Req(m, u, h, b, max); reqs.add(r);
            try { return a.on(r); } catch (IOException e) { throw e; } catch (Exception e) { throw new IllegalStateException(e); }
        }
    }

    static final class MemVault implements FhGateCore.Vault {
        String v; boolean saveOk = true, clearOk = true;
        @Override public String load() { return v; }
        @Override public boolean save(String json) { if (saveOk) v = json; return saveOk; }
        @Override public boolean clear() { if (clearOk) v = null; return clearOk; }
    }

    static FhGateCore.Resp json(int st, String s) { return new FhGateCore.Resp(st, "application/json", s.getBytes(StandardCharsets.UTF_8)); }
    static String loginOk(String tok) { return "{\"token\":\"" + tok + "\",\"device\":\"" + DEV + "\",\"account\":\"fixture\",\"exp\":" + (long) EXP + "}"; }
    static final String LOGIN_OK = loginOk(TOK);

    FakeNet net = new FakeNet(); MemVault vault = new MemVault();

    FhGateCore fresh(double now) { return new FhGateCore(net, vault, "https://localhost", () -> now); }

    FhGateCore loggedIn() throws Exception {
        FhGateCore c = fresh(NOW);
        c.setGate(GATE);
        net.a = r -> json(200, LOGIN_OK);
        c.login(c.ctx(), "fixture", "pw", "폰");
        net.reqs.clear();
        return c;
    }

    interface ThrowingRunnable { void run() throws Exception; }

    static FhGateCore.GateError err(ThrowingRunnable r) {
        try { r.run(); } catch (FhGateCore.GateError e) { return e; } catch (Exception e) { throw new AssertionError(e); }
        throw new AssertionError("오류 기대");
    }

    static String code(ThrowingRunnable r) { return err(r).code; }

    // ── 주소 규칙 ──
    @Test public void gateOriginSameRulesAsGateProfile() throws Exception {
        assertEquals("https://127.0.0.1:18453", FhGateCore.gateOrigin("https://127.0.0.1:18453"));
        assertEquals("https://127.0.0.1:18453", FhGateCore.gateOrigin("https://127.0.0.1:18453/"));
        assertEquals("https://gate.example.org", FhGateCore.gateOrigin("https://gate.example.org"));
        assertEquals("https://gate.example.org:65535", FhGateCore.gateOrigin("https://gate.example.org:65535"));
        String[] bad = {"http://127.0.0.1:18453", "https://u:p@127.0.0.1:18453", "https://127.0.0.1:18453/#x", "https://127.0.0.1:18453#", "https://127.0.0.1:18453/?a=1",
            "https://127.0.0.1:18453/MDrive.dc.html", "https://*.example.org", "https://localhost:18453", "wss://127.0.0.1:18453", "capacitor://localhost",
            "https://127.0.0.1:443", "HTTPS://127.0.0.1:18453", " https://127.0.0.1:18453", "https://127.0.0.1:18453 ", "", null, "https://Gate.example.org",
            "https://gate.example.org:65536", "https://gate.example.org:99999", "https://gate.example.org:"};
        for (String b : bad) assertEquals(b, "bad_input", code(() -> FhGateCore.gateOrigin(b)));
    }

    // ── 로그인 기본 ──
    @Test public void loginKeepsTokenNativeAndSendsExactOrigin() throws Exception {
        FhGateCore c = fresh(NOW);
        c.setGate(GATE);
        long g0 = c.gen();
        net.a = r -> json(200, LOGIN_OK);
        FhGateCore.Login l = c.login(c.ctx(), "fixture", "pw", "폰");
        Req r = net.reqs.get(0);
        assertEquals("POST", r.method); assertEquals(GATE + "/api/app/login", r.url);
        assertEquals("https://localhost", r.h.get("Origin")); assertNull(r.h.get("Authorization"));
        assertEquals("fixture", l.account); assertEquals("dev_BB", l.device6); assertTrue(l.stored);
        assertEquals(g0 + 1, l.gen); assertEquals(g0 + 1, c.gen());           // 로그인 성공도 세대를 바꾼다
        assertFalse(c.state().toString().contains(TOK));
        assertTrue(vault.v.contains(TOK));
        assertEquals("bad_state", code(() -> c.login(c.ctx(), "fixture", "pw", null)));
    }

    @Test public void loginFailuresMapToCodesAndBadResponsesAreRejected() throws Exception {
        FhGateCore c = fresh(NOW);
        assertEquals("no_gate", code(() -> c.login(c.ctx(), "a", "b", null)));
        c.setGate(GATE);
        int[] st = {400, 401, 403, 429, 302, 500};
        String[] want = {"bad_input", "auth", "origin", "busy", "redirect", "server"};
        for (int i = 0; i < st.length; i++) {
            int s = st[i]; net.a = r -> json(s, "{}");
            FhGateCore.GateError e = err(() -> c.login(c.ctx(), "a", "b", null));
            assertEquals(want[i], e.code); assertFalse(e.sessionEnded);         // 로그인 401 은 «세션 끝남» 이 아니다
        }
        // 정상 토큰 + 틀린 exp/형식 → 거부, 저장 0, 발급된 세션은 서버 로그아웃 1회
        String[] badBodies = {
            "{\"token\":\"" + TOK + "\",\"device\":\"" + DEV + "\",\"account\":\"a\",\"exp\":1}",                       // 지난 만료
            "{\"token\":\"" + TOK + "\",\"device\":\"" + DEV + "\",\"account\":\"a\",\"exp\":\"" + (long) EXP + "\"}",  // 글로 된 숫자
            "{\"token\":\"" + TOK + "\",\"device\":\"" + DEV + "\",\"account\":\"a\",\"exp\":9999999999}",              // 너무 먼 만료
            "{\"token\":\"" + TOK + "\",\"device\":\"short\",\"account\":\"a\",\"exp\":" + (long) EXP + "}",
            "{\"token\":\"" + TOK + "\",\"device\":\"" + DEV + "\",\"account\":\"\",\"exp\":" + (long) EXP + "}",
        };
        for (String b : badBodies) {
            net.reqs.clear();
            net.a = r -> r.url.endsWith("/login") ? json(200, b) : json(200, "{}");
            assertEquals(b, "server", code(() -> c.login(c.ctx(), "a", "b", null)));
            assertFalse(vault.v.contains(TOK)); assertEquals(false, c.state().get("loggedIn"));
            assertEquals(b, GATE + "/api/app/logout", net.reqs.get(1).url);
        }
        // 형식부터 틀린 응답(토큰 숫자·없음) → 거부, 쓸 토큰이 없으니 로그아웃도 없음
        for (String b : new String[]{"{\"token\":12345678901234567890}", "{}", "not json", "{\"token\":\"short\",\"device\":\"" + DEV + "\",\"account\":\"a\",\"exp\":" + (long) EXP + "}"}) {
            net.reqs.clear(); net.a = r -> json(200, b);
            assertEquals(b, "server", code(() -> c.login(c.ctx(), "a", "b", null)));
            assertEquals(b, 1, net.reqs.size());
        }
    }

    // ── 1) 큐에서 기다린 옛 호출: 받은 순간의 문맥으로만, 바뀌었으면 네트워크 0 ──
    @Test public void queuedLoginAfterLogoutIsStaleWithoutNetwork() throws Exception {
        FhGateCore c = fresh(NOW);
        c.setGate(GATE);
        FhGateCore.Ctx queued = c.ctx();
        c.endLocal();
        net.a = r -> json(200, LOGIN_OK);
        FhGateCore.GateError e = err(() -> c.login(queued, "fixture", "pw", null));
        assertEquals("stale", e.code); assertEquals(queued.gen(), e.gen);
        assertEquals(0, net.reqs.size()); assertEquals(false, c.state().get("loggedIn"));
    }

    @Test public void queuedLoginAfterGateChangeNeverSendsCredentialsToNewGate() throws Exception {
        FhGateCore c = fresh(NOW);
        c.setGate(GATE);
        FhGateCore.Ctx queued = c.ctx();
        c.setGate(GATE_B);
        net.a = r -> json(200, LOGIN_OK);
        assertEquals("stale", code(() -> c.login(queued, "fixture", "pw", null)));
        assertEquals(0, net.reqs.size());
    }

    @Test public void queuedRequestFromOldSessionIsStaleAfterRelogin() throws Exception {
        FhGateCore c = loggedIn();
        FhGateCore.Ctx queued = c.ctx();
        c.endLocal();
        net.a = r -> json(200, loginOk(TOK2));
        c.login(c.ctx(), "fixture", "pw", null);
        net.reqs.clear();
        assertEquals("stale", code(() -> c.request(queued, "whoami", null)));
        assertEquals("stale", code(() -> c.photo(queued, "media/photos/20261013/a.jpg")));
        assertEquals("stale", code(() -> c.wsTicket(queued)));
        assertEquals(0, net.reqs.size());
    }

    // ── 2) 동시 로그인: 같은 세대 두 번째는 busy, 늦은 첫 응답이 새 로그인을 덮지 않음 ──
    @Test public void concurrentLoginSameGenIsBusy() throws Exception {
        FhGateCore c = fresh(NOW);
        c.setGate(GATE);
        FhGateCore.Ctx a = c.ctx(), b = c.ctx();
        String[] second = new String[1];
        net.a = r -> { second[0] = code(() -> c.login(b, "fixture", "pw", null)); return json(200, LOGIN_OK); };
        c.login(a, "fixture", "pw", null);
        assertEquals("busy", second[0]);
        assertEquals(1, net.reqs.size());
    }

    @Test public void lateFirstLoginDoesNotOverwriteNewerLogin() throws Exception {
        FhGateCore c = fresh(NOW);
        c.setGate(GATE);
        FhGateCore.Ctx first = c.ctx();
        int[] n = {0};
        net.a = r -> {
            n[0]++;
            if (n[0] == 1) {                                       // 첫 로그인 응답이 오기 전에: 로그아웃 → 새 로그인 성공
                c.endLocal();
                c.login(c.ctx(), "fixture", "pw", null);
                return json(200, LOGIN_OK);                        // 그 뒤에 첫 응답 도착(TOK)
            }
            if (n[0] == 2) return json(200, loginOk(TOK2));        // 새 로그인 응답
            return json(200, "{}");                                // 첫 로그인 세션의 서버 로그아웃
        };
        assertEquals("stale", code(() -> c.login(first, "fixture", "pw", null)));
        assertTrue(vault.v.contains(TOK2)); assertFalse(vault.v.contains(TOK));
        assertEquals(true, c.state().get("loggedIn"));
        Req last = net.reqs.get(2);
        assertEquals(GATE + "/api/app/logout", last.url); assertEquals("Bearer " + TOK, last.h.get("Authorization"));
    }

    // ── 3) 401·IO 오류는 그 호출의 gen 에 묶인다 ──
    @Test public void unauthorizedEndsOnlyItsOwnSessionWithItsGen() throws Exception {
        FhGateCore c = loggedIn();
        FhGateCore.Ctx ctx = c.ctx();
        net.a = r -> json(401, "{}");
        FhGateCore.GateError e = err(() -> c.request(ctx, "whoami", null));
        assertEquals("auth", e.code); assertTrue(e.sessionEnded); assertEquals(ctx.gen(), e.gen);
        assertEquals(ctx.gen() + 1, c.gen()); assertFalse(vault.v.contains(TOK));
        assertEquals("no_session", code(() -> c.request(c.ctx(), "whoami", null)));
    }

    @Test public void late401AfterNewLoginDoesNotEndNewSession() throws Exception {
        FhGateCore c = loggedIn();
        FhGateCore.Ctx old = c.ctx();
        int[] n = {0};
        net.a = r -> {
            if (++n[0] == 1) { c.endLocal(); c.login(c.ctx(), "fixture", "pw", null); return json(401, "{}"); }
            return json(200, loginOk(TOK2));
        };
        FhGateCore.GateError e = err(() -> c.request(old, "whoami", null));
        assertEquals("stale", e.code); assertFalse(e.sessionEnded); assertEquals(old.gen(), e.gen);
        assertEquals(true, c.state().get("loggedIn")); assertTrue(vault.v.contains(TOK2));
    }

    @Test public void ioErrorOfOldContextIsStale() throws Exception {
        FhGateCore c = loggedIn();
        FhGateCore.Ctx old = c.ctx();
        net.a = r -> { c.endLocal(); throw new ConnectException("x"); };
        assertEquals("stale", code(() -> c.request(old, "whoami", null)));
        FhGateCore c2 = loggedIn();
        net.a = r -> { throw new SSLHandshakeException("x"); };
        assertEquals("tls", code(() -> c2.request(c2.ctx(), "whoami", null)));
    }

    // ── 4) 파괴: 대기·진행 작업 무효, 보관본을 늦게 못 바꿈, 보관 세션은 유지 ──
    @Test public void closeInvalidatesPendingAndLateWritesButKeepsStoredSession() throws Exception {
        FhGateCore c = loggedIn();
        String before = vault.v;
        FhGateCore.Ctx pending = c.ctx();
        c.close();
        assertEquals("stale", code(() -> c.request(pending, "whoami", null)));
        assertEquals(0, net.reqs.size());
        assertEquals(before, vault.v);                                   // destroy ≠ 사용자 로그아웃
        FhGateCore again = fresh(NOW);                                   // 새 Activity
        assertEquals(true, again.state().get("loggedIn"));
    }

    @Test public void loginInFlightWhenClosedIsNotStored() throws Exception {
        FhGateCore c = fresh(NOW);
        c.setGate(GATE);
        net.a = r -> r.url.endsWith("/login") ? closeThen(c, json(200, LOGIN_OK)) : json(200, "{}");
        assertEquals("stale", code(() -> c.login(c.ctx(), "fixture", "pw", null)));
        assertFalse(vault.v.contains(TOK));
        assertEquals(GATE + "/api/app/logout", net.reqs.get(1).url);    // 서버에 생긴 세션은 정리
    }

    static FhGateCore.Resp closeThen(FhGateCore c, FhGateCore.Resp r) { c.close(); return r; }

    @Test public void late401AfterCloseDoesNotTouchVault() throws Exception {
        FhGateCore c = loggedIn();
        String before = vault.v;
        net.a = r -> { c.close(); return json(401, "{}"); };
        assertEquals("stale", code(() -> c.request(c.ctx(), "whoami", null)));
        assertEquals(before, vault.v);
    }

    // ── 5) 저장 실패를 성공처럼 보고하지 않음 ──
    @Test public void loginSaveFailureIsMemoryOnly() throws Exception {
        FhGateCore c = fresh(NOW);
        c.setGate(GATE);
        vault.saveOk = false;
        net.a = r -> json(200, LOGIN_OK);
        FhGateCore.Login l = c.login(c.ctx(), "fixture", "pw", null);
        assertFalse(l.stored); assertEquals(false, c.state().get("stored")); assertEquals(true, c.state().get("loggedIn"));
        assertFalse(String.valueOf(vault.v).contains(TOK));
    }

    @Test public void logoutWipeFailureLocksUntilWiped() throws Exception {
        FhGateCore c = loggedIn();
        vault.saveOk = false; vault.clearOk = false;
        FhGateCore.Ended e = c.endLocal();
        assertFalse(e.wiped); assertEquals(true, c.state().get("locked"));
        assertEquals(false, c.state().get("loggedIn"));                 // 메모리에서는 지워짐
        assertEquals("storage", code(() -> c.login(c.ctx(), "fixture", "pw", null)));
        assertEquals(0, net.reqs.size());
        vault.saveOk = true;
        FhGateCore.Ended again = c.endLocal();
        assertTrue(again.wiped); assertEquals(false, c.state().get("locked")); assertFalse(vault.v.contains(TOK));
    }

    @Test public void logoutSaveFailureFallsBackToClear() throws Exception {
        FhGateCore c = loggedIn();
        vault.saveOk = false;
        FhGateCore.Ended e = c.endLocal();
        assertTrue(e.wiped); assertNull(vault.v); assertEquals(false, c.state().get("locked"));
    }

    // ── 6) 표·보관본 형식 엄격 ──
    @Test public void wsTicketUrlAndTtlValidation() throws Exception {
        FhGateCore c = loggedIn();
        net.a = r -> json(200, "{\"ticket\":\"tkt_CCCCCCCCCCCCCCCCCCCC\",\"ttl_s\":30}");
        FhGateCore.Result res = c.wsTicket(c.ctx());
        assertEquals("wss://gate.example.org:18453/api/app/ws?t=tkt_CCCCCCCCCCCCCCCCCCCC", res.resp.text());
        for (String b : new String[]{"{\"ticket\":\"a&b=c\",\"ttl_s\":30}", "{\"ticket\":\"tkt_CCCCCCCCCCCCCCCCCCCC\",\"ttl_s\":0}",
                "{\"ticket\":\"tkt_CCCCCCCCCCCCCCCCCCCC\",\"ttl_s\":31}", "{\"ticket\":\"tkt_CCCCCCCCCCCCCCCCCCCC\"}",
                "{\"ticket\":\"tkt_CCCCCCCCCCCCCCCCCCCC\",\"ttl_s\":\"30\"}"}) {
            net.a = r -> json(200, b);
            assertEquals(b, "server", code(() -> c.wsTicket(c.ctx())));
        }
    }

    @Test public void restoreIsStrict() throws Exception {
        loggedIn();
        String good = vault.v;
        assertEquals(false, fresh(EXP + 1).state().get("loggedIn"));    // 만료
        Map<String, String> broken = new HashMap<>();
        broken.put("bad origin", "{\"origin\":\"http://evil\",\"device\":\"" + DEV + "\",\"token\":\"" + TOK + "\",\"account\":\"a\",\"exp\":" + (long) EXP + "}");
        broken.put("bad device", "{\"origin\":\"" + GATE + "\",\"device\":\"x\",\"token\":\"" + TOK + "\",\"account\":\"a\",\"exp\":" + (long) EXP + "}");
        broken.put("no account", "{\"origin\":\"" + GATE + "\",\"device\":\"" + DEV + "\",\"token\":\"" + TOK + "\",\"exp\":" + (long) EXP + "}");
        broken.put("exp string", "{\"origin\":\"" + GATE + "\",\"device\":\"" + DEV + "\",\"token\":\"" + TOK + "\",\"account\":\"a\",\"exp\":\"" + (long) EXP + "\"}");
        broken.put("exp far", "{\"origin\":\"" + GATE + "\",\"device\":\"" + DEV + "\",\"token\":\"" + TOK + "\",\"account\":\"a\",\"exp\":9999999999}");
        broken.put("not json", "{{");
        for (Map.Entry<String, String> b : broken.entrySet()) {
            vault.v = b.getValue();
            FhGateCore c = fresh(NOW);
            assertEquals(b.getKey(), false, c.state().get("loggedIn"));
            assertFalse(b.getKey(), String.valueOf(vault.v).contains(TOK));
        }
        vault.v = good;
        assertEquals(true, fresh(NOW).state().get("loggedIn"));
    }

    // ── 기존 계약 ──
    @Test public void requestUsesBearerFixedPathAndKeepsDocsCodesWithoutRetry() throws Exception {
        FhGateCore c = loggedIn();
        net.a = r -> json(409, "{\"cur\":{\"v\":3}}");
        FhGateCore.Result res = c.request(c.ctx(), "docs.post", "{\"k\":1}");
        assertEquals(409, res.resp.status); assertTrue(res.resp.text().contains("cur"));
        Req r = net.reqs.get(0);
        assertEquals("POST", r.method); assertEquals(GATE + "/api/app/docs", r.url);
        assertEquals("Bearer " + TOK, r.h.get("Authorization")); assertEquals("https://localhost", r.h.get("Origin"));
        for (int s : new int[]{400, 403, 404, 500, 503}) { net.a = q -> json(s, "{}"); assertEquals(s, c.request(c.ctx(), "docs.post", "{}").resp.status); }
        assertEquals(6, net.reqs.size());
        net.a = q -> json(503, "{}");
        assertEquals("server", code(() -> c.request(c.ctx(), "docs.get", null)));
        assertEquals("bad_input", code(() -> c.request(c.ctx(), "http://evil/x", null)));
        assertEquals("bad_input", code(() -> c.request(c.ctx(), "docs.post", null)));
        net.a = q -> json(301, "");
        assertEquals("redirect", code(() -> c.request(c.ctx(), "whoami", null)));
    }

    @Test public void photoPathCheckedBeforeAnyNetwork() throws Exception {
        FhGateCore c = loggedIn();
        for (String p : new String[]{"media/photos/2026101/a.jpg", "media/photos/20261013/../x.jpg", "media/photos/20261013/a.png", "/media/photos/20261013/a.jpg",
                "https://evil/media/photos/20261013/a.jpg", "media/photos/20261013/a.jpg?x=1", "api/media", "media/photos/20261013/a..b.jpg", "media/photos/20261013/" + "x".repeat(81) + ".jpg", null})
            assertEquals(String.valueOf(p), "bad_input", code(() -> c.photo(c.ctx(), p)));
        assertEquals(0, net.reqs.size());
        net.a = r -> new FhGateCore.Resp(200, "image/jpeg", new byte[]{1, 2});
        FhGateCore.Result res = c.photo(c.ctx(), "media/photos/20261013/cam-1.jpg");
        assertEquals(GATE + "/api/app/media/photos/20261013/cam-1.jpg", net.reqs.get(0).url);
        assertEquals(FhGateCore.PHOTO_MAX, net.reqs.get(0).max); assertEquals(2, res.resp.body.length);
        net.a = r -> new FhGateCore.Resp(200, "text/html", new byte[]{1});
        assertEquals("bad_type", code(() -> c.photo(c.ctx(), "media/photos/20261013/cam-1.jpg")));
        net.a = r -> { throw new IOException("too_big"); };
        assertEquals("too_big", code(() -> c.photo(c.ctx(), "media/photos/20261013/cam-1.jpg")));
    }

    @Test public void logoutIsLocalFirstAndServerFailureIsNotSuccess() throws Exception {
        FhGateCore c = loggedIn();
        long g = c.gen();
        FhGateCore.Ended e = c.endLocal();
        assertTrue(e.hadSession()); assertTrue(e.wiped); assertEquals(g + 1, e.gen);
        assertFalse(vault.v.contains(TOK)); assertTrue(vault.v.contains(DEV));
        assertEquals(0, net.reqs.size());
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
        FhGateCore.Ended e = c.setGate(GATE_B);
        assertTrue(e.hadSession()); assertEquals(GATE, e.origin);      // 서버 로그아웃은 옛 관문으로
        assertFalse(vault.v.contains(TOK)); assertFalse(vault.v.contains(DEV));
        assertEquals(GATE_B, c.state().get("origin"));
    }

    @Test public void classifyNativeErrors() {
        assertEquals("tls", FhGateCore.classify(new SSLHandshakeException("x")));
        assertEquals("tls", FhGateCore.classify(new IOException(new CertPathValidatorException("x"))));
        assertEquals("net", FhGateCore.classify(new UnknownHostException("x")));
        assertEquals("net", FhGateCore.classify(new IOException("deadline")));
        assertEquals("unknown", FhGateCore.classify(new IOException("x")));
    }

    @Test public void httpsTransportRefusesPlainHttp() {
        try { new FhGateCore.HttpsTransport().send("GET", "http://127.0.0.1:1/", new HashMap<>(), null, 10); fail(); }
        catch (IOException e) { assertEquals("https 만", e.getMessage()); }
    }
}
