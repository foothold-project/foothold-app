package org.footholdproject.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;
import org.junit.Test;

public class NearbyTest {
    private static Map<String, byte[]> attrs(String... kv) {
        Map<String, byte[]> m = new HashMap<>();
        for (int i = 0; i < kv.length; i += 2) m.put(kv[i], kv[i + 1].getBytes(StandardCharsets.UTF_8));
        return m;
    }

    @Test
    public void lan() {
        assertEquals("192.168.12.1", Nearby.lan("192.168.12.1"));
        assertEquals("10.0.0.5", Nearby.lan("10.0.0.5"));
        assertEquals("172.31.255.1", Nearby.lan("172.31.255.1"));
        assertEquals("192.168.1.7", Nearby.lan("192.168.001.007"));   // 정규화
        assertNull(Nearby.lan("172.32.0.1"));
        assertNull(Nearby.lan("8.8.8.8"));
        assertNull(Nearby.lan("169.254.1.1"));
        assertNull(Nearby.lan("192.168.1.256"));
        assertNull(Nearby.lan("192.168.1"));
        assertNull(Nearby.lan("192.168.1.1.1"));
        assertNull(Nearby.lan("192.168.1.-1"));
        assertNull(Nearby.lan("fe80::1"));
        assertNull(Nearby.lan("evil.local"));
        assertNull(Nearby.lan(null));
    }

    @Test
    public void txt() {
        Map<String, String> t = Nearby.txt(attrs("v", "1", "name", "go2-edu-1", "model", "Go2 EDU", "agent", "ws://192.168.12.18:8765/phone/ws",
            "rid", "6f1c2a3b-0000-4000-8000-000000000001"), "192.168.12.18");
        assertEquals("go2-edu-1", t.get("name"));
        assertEquals("Go2 EDU", t.get("model"));
        assertEquals("ws://192.168.12.18:8765/phone/ws", t.get("agent"));
        assertEquals("6f1c2a3b-0000-4000-8000-000000000001", t.get("rid"));
        assertNull(Nearby.txt(attrs("name", "x"), "10.0.0.2"));             // v 없음
        assertNull(Nearby.txt(attrs("v", "2", "name", "x"), "10.0.0.2"));   // 다른 판
        assertNull(Nearby.txt(null, "10.0.0.2"));
        Map<String, String> bad = Nearby.txt(attrs("v", "1", "name", "a‮b\nc", "rid", "../x", "agent", "ws://10.0.0.9:1/phone/ws"), "10.0.0.2");
        assertEquals("abc", bad.get("name"));        // 방향 바꿈·줄바꿈 빼기
        assertFalse(bad.containsKey("rid"));         // 허용 문자 밖
        assertFalse(bad.containsKey("agent"));       // 찾은 주소와 다른 호스트
        assertEquals(40, Nearby.txt(attrs("v", "1", "name", "가".repeat(60)), "10.0.0.2").get("name").length());
    }

    @Test
    public void agent() {
        assertTrue(Nearby.agentOk("ws://10.0.0.2:8765/phone/ws", "10.0.0.2"));
        assertFalse(Nearby.agentOk("wss://10.0.0.2:8765/phone/ws", "10.0.0.2"));
        assertFalse(Nearby.agentOk("http://10.0.0.2:8765/", "10.0.0.2"));
        assertFalse(Nearby.agentOk("ws://10.0.0.2/phone/ws", "10.0.0.2"));             // 포트 없음
        assertFalse(Nearby.agentOk("ws://u:p@10.0.0.2:8765/phone/ws", "10.0.0.2"));
        assertFalse(Nearby.agentOk("ws://attacker.example:8765/", "10.0.0.2"));
        assertFalse(Nearby.agentOk("ws://10.0.0.2:8765/phone/ws", null));
    }

    @Test
    public void go2Name() {
        assertTrue(Nearby.isGo2("Go2_49077"));
        assertFalse(Nearby.isGo2("G1_1234"));
        assertFalse(Nearby.isGo2("go2_49077"));
        assertFalse(Nearby.isGo2("HMSoft"));
        assertFalse(Nearby.isGo2(null));
    }
}
