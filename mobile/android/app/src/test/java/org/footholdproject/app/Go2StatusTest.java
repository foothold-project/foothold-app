package org.footholdproject.app;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import java.nio.charset.StandardCharsets;
import org.junit.Test;

public class Go2StatusTest {
    private static Go2Status.Resp parse(String s) {
        return Go2Status.parse(s.getBytes(StandardCharsets.UTF_8));
    }

    @Test
    public void target() {
        assertArrayEquals(new String[] { "192.168.12.18", "9610" }, Go2Status.target("http://192.168.12.18:9610/go2/status"));
        assertArrayEquals(new String[] { "10.0.0.7", "8080" }, Go2Status.target("http://10.0.0.7:8080/go2/status"));
        assertNull(Go2Status.target("https://192.168.12.18:9610/go2/status"));
        assertNull(Go2Status.target("http://8.8.8.8:9610/go2/status"));         // 공인 주소
        assertNull(Go2Status.target("http://evil.local:9610/go2/status"));      // 이름 풀이 없음
        assertNull(Go2Status.target("http://192.168.12.18/go2/status"));        // 포트 없음
        assertNull(Go2Status.target("http://192.168.12.18:9610/phone/ws"));
        assertNull(Go2Status.target("http://192.168.12.18:9610/go2/status?code=12345678"));   // 코드는 URL 에 싣지 않는다
        assertNull(Go2Status.target("http://u:p@192.168.12.18:9610/go2/status"));
        assertNull(Go2Status.target("http://192.168.12.18:9610/go2/status#x"));
        assertNull(Go2Status.target("http://192.168.012.18:9610/go2/status"));  // 정규화가 필요한 표기는 거부
        assertNull(Go2Status.target(null));
    }

    @Test
    public void parseResp() {
        Go2Status.Resp r = parse("HTTP/1.0 200 OK\r\nContent-Type: application/json\r\n\r\n{\"v\":1}");
        assertEquals(200, r.status);
        assertEquals("{\"v\":1}", r.body);
        assertEquals(401, parse("HTTP/1.0 401 Unauthorized\r\n\r\n{\"error\":401}").status);
        Go2Status.Resp t = parse("HTTP/1.0 429 Too Many Requests\r\nretry-after: 60\r\n\r\n");
        assertEquals(429, t.status);
        assertEquals(60, t.retry);
        assertEquals(600, parse("HTTP/1.1 429 X\r\nRetry-After: 99999\r\n\r\n").retry);   // 상한
        assertEquals(60, parse("HTTP/1.1 429 X\r\nRetry-After: Wed, 21 Oct 2026 07:28:00 GMT\r\n\r\n").retry);   // 날짜 형식 → 기본 60
        assertNull(parse("HTTP/1.0 200 OK\r\n"));            // 머리 끝 없음
        assertNull(parse("SSH-2.0-OpenSSH\r\n\r\n"));
        assertNull(parse("HTTP/1.0 abc OK\r\n\r\n"));
    }
}
