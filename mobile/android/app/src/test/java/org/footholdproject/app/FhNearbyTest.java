package org.footholdproject.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.net.InetAddress;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.junit.Test;

public class FhNearbyTest {
    static InetAddress ip(String s) throws Exception { return InetAddress.getByName(s); }   // 숫자 주소만 — DNS 조회 없음

    static Map<String, byte[]> txt(String... kv) {
        Map<String, byte[]> m = new HashMap<>();
        for (int i = 0; i < kv.length; i += 2) m.put(kv[i], kv[i + 1] == null ? null : kv[i + 1].getBytes(StandardCharsets.UTF_8));
        return m;
    }

    static final Map<String, byte[]> OK = txt("txtvers", "1", "app", "foothold-gate", "api", "1");

    static String origin(int port, List<InetAddress> a, Map<String, byte[]> t) {
        FhNearby.Item it = FhNearby.item("FOOTHOLD 관문 · 0123abcd", port, a, t);
        return it == null ? null : it.origin;
    }

    @Test public void privateIpv4OnlyAndOriginNormalized() throws Exception {
        assertEquals("https://192.168.0.7:8453", origin(8453, Collections.singletonList(ip("192.168.0.7")), OK));
        assertEquals("https://10.1.2.3:9000", origin(9000, Collections.singletonList(ip("10.1.2.3")), OK));
        assertEquals("https://172.31.0.5:8453", origin(8453, Collections.singletonList(ip("172.31.0.5")), OK));
        assertEquals("https://192.168.0.7", origin(443, Collections.singletonList(ip("192.168.0.7")), OK));   // setGate 와 같은 정규화
        for (String bad : new String[]{"127.0.0.1", "0.0.0.0", "224.0.0.251", "239.255.255.250", "255.255.255.255", "169.254.10.1",
                "8.8.8.8", "100.64.0.1", "100.127.255.254", "172.15.0.1", "172.32.0.1", "192.169.0.1", "::1", "fe80::1", "fd00::1", "::ffff:8.8.8.8"})
            assertNull(bad, origin(8453, Collections.singletonList(ip(bad)), OK));
        // IPv4 사상 IPv6 는 Java 가 IPv4 로 바꿔 줌 — 같은 주소라 받음(사설 판정은 그대로)
        assertEquals("https://192.168.0.7:8453", origin(8453, Collections.singletonList(ip("::ffff:192.168.0.7")), OK));
        // IPv6·루프백 먼저 와도 첫 사설 IPv4 를 고름
        assertEquals("https://192.168.0.9:8453", origin(8453, Arrays.asList(ip("fe80::1"), ip("127.0.0.1"), ip("192.168.0.9"), ip("10.0.0.1")), OK));
        assertNull(origin(8453, Collections.emptyList(), OK));
        assertNull(origin(8453, null, OK));
    }

    @Test public void portFromSrvMustBeInRange() throws Exception {
        List<InetAddress> a = Collections.singletonList(ip("192.168.0.7"));
        for (int p : new int[]{0, -1, 65536, 70000}) assertNull(String.valueOf(p), origin(p, a, OK));
        assertEquals("https://192.168.0.7:65535", origin(65535, a, OK));
    }

    @Test public void txtAppAndApiExact() throws Exception {
        List<InetAddress> a = Collections.singletonList(ip("192.168.0.7"));
        assertEquals("https://192.168.0.7:8453", origin(8453, a, txt("app", "foothold-gate", "api", "1", "path", "/x", "token", "abc")));   // 그 밖 키 무시(쓰지 않음)
        for (Map<String, byte[]> t : Arrays.asList(null, txt(), txt("app", "foothold-gate"), txt("api", "1"), txt("app", "foothold-gate", "api", "2"),
                txt("app", "foothold-gate", "api", "01"), txt("app", "foothold-gate", "api", " 1"), txt("app", "foothold-gate", "api", null),
                txt("app", "Foothold-gate", "api", "1"), txt("app", "foothold-gate ", "api", "1"), txt("app", null, "api", "1")))
            assertNull(String.valueOf(t == null ? null : t.keySet()), origin(8453, a, t));
    }

    @Test public void nameDecodedCleanedAndCapped() {
        assertEquals("FOOTHOLD 관문 · 0123abcd", FhNearby.name("FOOTHOLD 관문 · 0123abcd"));
        assertEquals("FOOTHOLD 관문", FhNearby.name("FOOTHOLD\\032\\234\\180\\128\\235\\172\\184"));   // \DDD 바이트 = UTF-8 «관문»
        assertEquals("a.b", FhNearby.name("a\\.b"));
        assertEquals("ab", FhNearby.name("a\u0000\u001b‮​b"));   // 제어·방향 바꾸기·폭 없는 문자 제거
        assertEquals("", FhNearby.name(null));
        String longName = new String(new char[100]).replace('\0', '가');
        assertEquals(64, FhNearby.name(longName).length());
        assertEquals(64, FhNearby.name(new String(new char[70]).replace("\0", "😀")).codePointCount(0, FhNearby.name(new String(new char[70]).replace("\0", "😀")).length()));
    }

    @Test public void scanDedupsByOriginAndCaps16() throws Exception {
        FhNearby.Scan s = new FhNearby.Scan();
        assertTrue(s.add(FhNearby.item("a", 8453, Collections.singletonList(ip("192.168.0.7")), OK)));
        assertFalse(s.add(FhNearby.item("b(같은 주소)", 8453, Collections.singletonList(ip("192.168.0.7")), OK)));
        assertFalse(s.add(null));
        assertEquals("a", s.items().get(0).name);
        for (int i = 1; i < 40; i++) s.add(FhNearby.item("n" + i, 8453, Collections.singletonList(ip("10.0.0." + i)), OK));
        assertEquals(16, s.items().size());
        assertTrue(s.full());
    }

    @Test public void msClamped() {
        assertEquals(5000, FhNearby.clampMs(null));
        assertEquals(1000, FhNearby.clampMs(0));
        assertEquals(1000, FhNearby.clampMs(-5));
        assertEquals(8000, FhNearby.clampMs(60000));
        assertEquals(3000, FhNearby.clampMs(3000));
    }
}
