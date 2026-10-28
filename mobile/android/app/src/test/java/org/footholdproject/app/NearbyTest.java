package org.footholdproject.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Collections;
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
    public void sameSubnet() {
        // 현장: 폰·노트북이 Go2 핫스팟 192.168.12.0/24, 노트북 Wi-Fi 주소를 광고
        assertTrue(Nearby.sameSubnet("192.168.12.18", Arrays.asList("fe80::1%wlan0/64", "192.168.12.5/24")));
        assertTrue(Nearby.sameSubnet("10.1.200.7", Collections.singletonList("10.1.3.4/16")));
        assertFalse(Nearby.sameSubnet("10.0.0.7", Collections.singletonList("192.168.12.5/24")));        // 다른 사설 서브넷
        assertFalse(Nearby.sameSubnet("192.168.123.161", Collections.singletonList("192.168.12.5/24")));  // Go2 내부망(유선)은 폰 Wi-Fi 와 다름
        assertFalse(Nearby.sameSubnet("192.168.13.1", Collections.singletonList("192.168.12.5/24")));
        assertFalse(Nearby.sameSubnet("192.168.12.18", Collections.emptyList()));                       // 정보 없음
        assertFalse(Nearby.sameSubnet("192.168.12.18", null));
        assertFalse(Nearby.sameSubnet("192.168.12.18", Collections.singletonList("fe80::1%wlan0/64")));  // IPv6 뿐
        assertFalse(Nearby.sameSubnet("192.168.12.18", Arrays.asList("192.168.12.5", "x/24", "192.168.12.5/abc")));
        assertFalse(Nearby.sameSubnet("10.0.0.7", Collections.singletonList("10.9.9.9/4")));             // 너무 넓은 prefix
        assertFalse(Nearby.sameSubnet("8.8.8.8", Collections.singletonList("8.8.8.1/24")));              // 공인 주소 대상
        assertTrue(Nearby.sameSubnet("192.168.12.5", Collections.singletonList("192.168.12.5/32")));
        // 망 전환: 같은 대상도 매번 지금 망 주소로 다시 판정
        assertTrue(Nearby.sameSubnet("192.168.12.18", Collections.singletonList("192.168.12.5/24")));
        assertFalse(Nearby.sameSubnet("192.168.12.18", Collections.singletonList("192.168.0.20/24")));
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
    public void discoveryOnly() {
        assertEquals("discovery-only", Nearby.txt(attrs("v", "1", "name", "Go2 EDU (검색 시험)", "mode", "discovery-only"), "10.0.0.2").get("mode"));
        assertFalse(Nearby.txt(attrs("v", "1", "mode", "other"), "10.0.0.2").containsKey("mode"));
        assertFalse(Nearby.txt(attrs("v", "1"), "10.0.0.2").containsKey("mode"));
    }

    @Test
    public void go2Readonly() {
        Map<String, String> t = Nearby.txt(attrs("v", "1", "name", "Go2 EDU", "mode", "go2-readonly", "agent", "http://192.168.12.18:9610/go2/status"), "192.168.12.18");
        assertEquals("go2-readonly", t.get("mode"));
        assertEquals("http://192.168.12.18:9610/go2/status", t.get("agent"));
        // go2-readonly 를 /phone/ws 로 고쳐 쓰지 않는다 · 다른 호스트·경로는 버림
        assertFalse(Nearby.txt(attrs("v", "1", "mode", "go2-readonly", "agent", "ws://192.168.12.18:9610/phone/ws"), "192.168.12.18").containsKey("agent"));
        assertFalse(Nearby.txt(attrs("v", "1", "mode", "go2-readonly", "agent", "http://192.168.12.19:9610/go2/status"), "192.168.12.18").containsKey("agent"));
        assertFalse(Nearby.txt(attrs("v", "1", "mode", "discovery-only", "agent", "http://192.168.12.18:9610/go2/status"), "192.168.12.18").containsKey("agent"));
        assertFalse(Nearby.txt(attrs("v", "1", "agent", "http://192.168.12.18:9610/go2/status"), "192.168.12.18").containsKey("agent"));   // mode 없음 = ws 만
    }

    @Test
    public void netNote() {
        assertEquals("wifi-off", Nearby.netNote(false, false));
        assertEquals("wifi-no-internet", Nearby.netNote(true, false));   // Go2 핫스팟: 로봇은 Wi-Fi, 서버는 모바일 데이터
        assertNull(Nearby.netNote(true, true));
    }

    @Test
    public void agent() {
        assertTrue(Nearby.agentOk("ws://10.0.0.2:8765/phone/ws", "10.0.0.2", null));
        assertFalse(Nearby.agentOk("wss://10.0.0.2:8765/phone/ws", "10.0.0.2", null));
        assertFalse(Nearby.agentOk("http://10.0.0.2:8765/", "10.0.0.2", null));
        assertFalse(Nearby.agentOk("ws://10.0.0.2/phone/ws", "10.0.0.2", null));             // 포트 없음
        assertFalse(Nearby.agentOk("ws://u:p@10.0.0.2:8765/phone/ws", "10.0.0.2", null));
        assertFalse(Nearby.agentOk("ws://attacker.example:8765/", "10.0.0.2", null));
        assertFalse(Nearby.agentOk("ws://10.0.0.2:8765/phone/ws", null, null));
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
