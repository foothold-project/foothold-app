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
import org.junit.After;
import org.junit.Before;
import org.junit.Test;

/** 실기 중계: 대상 고정(Nearby.real) · 127.0.0.1 만 · 연결 1개만 · 한쪽 끝나면 둘 다 · close 면 즉시 닫힘. 로봇 = 루프백 메아리 서버 */
public class Go2LinkTest {
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
        relay = new Go2Link.Relay(() -> new Socket(InetAddress.getLoopbackAddress(), echo.getLocalPort()));
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
        s.getOutputStream().write(msg.getBytes(StandardCharsets.UTF_8));
        byte[] b = new byte[msg.length()];
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
    public void relaysBytes() throws IOException {
        try (Socket s = dial()) {
            assertEquals("{\"t\":\"hello\"}", roundTrip(s, "{\"t\":\"hello\"}"));
            assertEquals("cmd", roundTrip(s, "cmd"));
        }
    }

    @Test
    public void oneConnectionOnly() throws Exception {
        try (Socket a = dial()) {
            assertEquals("x", roundTrip(a, "x"));
            try (Socket b = dial()) {
                assertTrue("쓰는 중이면 두 번째 연결은 바로 닫힘", closed(b));
            }
            assertEquals("y", roundTrip(a, "y"));   // 첫 연결은 그대로
        }
        // 첫 연결이 끝나면 다시 받음(다시 연결)
        long end = System.currentTimeMillis() + 2000;
        while (true) {
            try (Socket c = dial()) {
                assertEquals("z", roundTrip(c, "z"));
                break;
            } catch (IOException e) {
                if (System.currentTimeMillis() > end) throw e;
                Thread.sleep(20);
            }
        }
    }

    @Test
    public void closeDropsLinkAndPort() throws IOException {
        Socket s = dial();
        assertEquals("a", roundTrip(s, "a"));
        int port = relay.port();
        relay.close();
        assertTrue(closed(s));
        s.close();
        try (Socket again = new Socket()) {
            again.connect(new InetSocketAddress(InetAddress.getLoopbackAddress(), port), 500);
            fail("닫힌 중계 포트에 붙음");
        } catch (IOException expected) {}
    }

    @Test
    public void robotSideEndClosesPhoneSide() throws IOException {
        try (Socket s = dial()) {
            assertEquals("a", roundTrip(s, "a"));
            echo.close();   // 새 연결만 막힘 — 이미 이은 쪽은 살아 있음
            assertEquals("b", roundTrip(s, "b"));
        }
        Go2Link.Relay dead = new Go2Link.Relay(() -> { throw new IOException("unreachable"); });
        try (Socket s = new Socket()) {
            s.connect(new InetSocketAddress(InetAddress.getLoopbackAddress(), dead.port()), 1000);
            s.setSoTimeout(2000);
            assertTrue("로봇에 못 붙으면 폰 쪽도 닫힘", closed(s));
        } finally {
            dead.close();
        }
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
