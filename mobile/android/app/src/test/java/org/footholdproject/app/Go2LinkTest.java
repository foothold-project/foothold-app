package org.footholdproject.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.io.IOException;
import java.io.InputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;

/** 실기 중계: 대상 고정(Nearby.real) · 127.0.0.1 만 · 한 번만 받음 · 첫 줄 nonce 맞을 때만 로봇에(경로에서 nonce 뺌) · close 면 즉시 닫힘. 로봇 = 루프백 메아리 서버 */
public class Go2LinkTest {
    private static final String NONCE = "0123456789abcdef0123456789abcdef", HELLO = "GET /phone/ws?fh=" + NONCE + " HTTP/1.1\r\n";
    private final AtomicInteger opened = new AtomicInteger();
    private ServerSocket echo;
    private Go2Link.Relay relay;

    @Before
    public void setUp() throws IOException {
        echo = new ServerSocket(0, 8, InetAddress.getLoopbackAddress());
        Thread t = new Thread(() -> {
            while (!echo.isClosed()) {
                try {
                    Socket s = echo.accept();
                    new Thread(() -> {
                        try (Socket c = s) {
                            byte[] b = new byte[256];
                            for (int n; (n = c.getInputStream().read(b)) != -1; ) c.getOutputStream().write(b, 0, n);
                        } catch (IOException ignored) {}
                    }).start();
                } catch (IOException e) { return; }
            }
        });
        t.setDaemon(true);
        t.start();
        relay = new Go2Link.Relay(NONCE, () -> { opened.incrementAndGet(); return new Socket(InetAddress.getLoopbackAddress(), echo.getLocalPort()); });
    }

    @After
    public void tearDown() throws IOException {
        relay.close();
        echo.close();
    }

    private Socket dial() throws IOException {
        Socket s = new Socket();
        s.connect(new InetSocketAddress(InetAddress.getLoopbackAddress(), relay.port()), 1000);
        s.setSoTimeout(2000);
        return s;
    }

    private static String roundTrip(Socket s, String msg) throws IOException {
        return roundTrip(s, msg, msg.length());
    }

    private static String roundTrip(Socket s, String msg, int len) throws IOException {
        s.getOutputStream().write(msg.getBytes(StandardCharsets.UTF_8));
        byte[] b = new byte[len];
        InputStream in = s.getInputStream();
        for (int off = 0; off < b.length; ) {
            int n = in.read(b, off, b.length - off);
            if (n < 0) throw new IOException("closed");
            off += n;
        }
        return new String(b, StandardCharsets.UTF_8);
    }

    /** 닫혔는지: 읽기가 -1 또는 연결 재설정 */
    private static boolean closed(Socket s) {
        try { return s.getInputStream().read() == -1; } catch (SocketTimeoutException e) { return false; } catch (IOException e) { return true; }
    }

    @Test
    public void loopbackOnly() {
        assertTrue(relay.bound().isLoopbackAddress());
        assertEquals("127.0.0.1", relay.bound().getHostAddress());
        assertTrue(relay.port() > 0);
    }

    @Test
    public void nonceThenRewrittenAndRelayed() throws IOException {
        try (Socket s = dial()) {
            // 로봇(메아리)이 받은 첫 줄 = nonce 뺀 경로, 나머지 바이트는 그대로
            assertEquals("GET /phone/ws HTTP/1.1\r\nHost: x\r\n", roundTrip(s, HELLO + "Host: x\r\n", "GET /phone/ws HTTP/1.1\r\nHost: x\r\n".length()));
            assertEquals("cmd", roundTrip(s, "cmd"));
        }
        assertEquals(1, opened.get());
    }

    @Test
    public void wrongNonceNeverReachesRobot() throws Exception {
        for (String first : new String[] { "GET /phone/ws?fh=" + "0".repeat(32) + " HTTP/1.1\r\n", "GET /phone/ws HTTP/1.1\r\n", "{\"t\":\"hello\"}\n", "x".repeat(3000) }) {
            Go2Link.Relay r = new Go2Link.Relay(NONCE, () -> { opened.incrementAndGet(); return new Socket(InetAddress.getLoopbackAddress(), echo.getLocalPort()); });
            try (Socket s = new Socket()) {
                s.connect(new InetSocketAddress(InetAddress.getLoopbackAddress(), r.port()), 1000);
                s.setSoTimeout(2000);
                s.getOutputStream().write(first.getBytes(StandardCharsets.UTF_8));
                assertTrue(closed(s));
            } catch (IOException ignored) {   // 긴 쓰레기는 쓰는 중에 닫힐 수 있음
            } finally {
                r.close();
            }
        }
        assertEquals("틀린 첫 줄이면 로봇 연결 0", 0, opened.get());
    }

    @Test
    public void silentPhoneTimesOut() throws IOException {
        try (Socket s = dial()) {
            s.setSoTimeout(Go2Link.Relay.HELLO_MS + 2000);
            assertTrue(closed(s));   // 첫 줄 없이 붙어만 있으면 HELLO_MS 뒤 닫힘
        }
        assertEquals(0, opened.get());
    }

    @Test
    public void acceptsOnceThenListenClosed() throws Exception {
        try (Socket a = dial()) {
            assertEquals("GET /phone/ws HTTP/1.1\r\n", roundTrip(a, HELLO, "GET /phone/ws HTTP/1.1\r\n".length()));
            assertRefused(relay.port());   // 쓰는 중 두 번째 연결
        }
        Thread.sleep(100);
        assertRefused(relay.port());       // 끝난 뒤 다시 붙기
    }

    @Test
    public void squatterBurnsRelayOnly() throws Exception {
        try (Socket squat = dial()) {      // 다른 앱이 먼저 붙음(nonce 모름)
            squat.getOutputStream().write("GET /phone/ws HTTP/1.1\r\n".getBytes(StandardCharsets.US_ASCII));
            assertTrue(closed(squat));
        }
        assertRefused(relay.port());       // 진짜 화면도 이 포트는 못 씀 → «다시 연결» = 새 포트·nonce
        assertEquals(0, opened.get());
    }

    @Test
    public void closeDropsLinkAndPort() throws IOException {
        Socket s = dial();
        roundTrip(s, HELLO, "GET /phone/ws HTTP/1.1\r\n".length());
        int port = relay.port();
        relay.close();
        assertTrue(closed(s));
        s.close();
        assertRefused(port);
    }

    @Test
    public void robotUnreachableClosesPhone() throws IOException {
        Go2Link.Relay dead = new Go2Link.Relay(NONCE, () -> { throw new IOException("unreachable"); });
        try (Socket s = new Socket()) {
            s.connect(new InetSocketAddress(InetAddress.getLoopbackAddress(), dead.port()), 1000);
            s.setSoTimeout(2000);
            s.getOutputStream().write(HELLO.getBytes(StandardCharsets.US_ASCII));
            assertTrue("로봇에 못 붙으면 폰 쪽도 닫힘", closed(s));
        } finally {
            dead.close();
        }
    }

    private static void assertRefused(int port) {
        try (Socket again = new Socket()) {
            again.connect(new InetSocketAddress(InetAddress.getLoopbackAddress(), port), 500);
            again.setSoTimeout(1000);
            if (!closed(again)) fail("닫힌 중계 포트가 받음");
        } catch (IOException expected) {}
    }

    @Test
    public void targetFixedToFoundAgent() {
        Map<String, Object> it = new HashMap<>();
        it.put("via", "mdns");
        it.put("host", "192.168.123.18");
        it.put("port", 8765);
        it.put("rid", "r1");
        it.put("agent", "ws://192.168.123.18:8765/phone/ws");
        assertTrue(Nearby.real(it, "192.168.123.18", 8765));
        assertFalse(Nearby.real(it, "192.168.123.19", 8765));   // 화면이 다른 주소를 줌
        assertFalse(Nearby.real(it, "192.168.123.18", 22));     // 다른 포트
        assertFalse(Nearby.real(it, null, 8765));
        Map<String, Object> noRid = new HashMap<>(it);
        noRid.remove("rid");
        assertFalse(Nearby.real(noRid, "192.168.123.18", 8765));
        Map<String, Object> ro = new HashMap<>(it);
        ro.put("mode", "go2-readonly");
        assertFalse(Nearby.real(ro, "192.168.123.18", 8765));
        Map<String, Object> addr = new HashMap<>(it);
        addr.put("via", "addr");
        assertFalse(Nearby.real(addr, "192.168.123.18", 8765));
        Map<String, Object> other = new HashMap<>(it);
        other.put("agent", "ws://192.168.123.18:8765/other");
        assertFalse(Nearby.real(other, "192.168.123.18", 8765));
    }
}
