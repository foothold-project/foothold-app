package org.footholdproject.app;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class GateSslClientTest {
    @Test
    public void sameOrigin() {
        String g = "https://127.0.0.1:18453";
        assertTrue(GateSslClient.sameOrigin("https://127.0.0.1:18453/MLogin.dc.html?live=v2", g));
        assertTrue(GateSslClient.sameOrigin("https://gate.example.org/x", "https://gate.example.org:443"));
        assertFalse(GateSslClient.sameOrigin("https://127.0.0.1:18454/", g));          // 다른 포트
        assertFalse(GateSslClient.sameOrigin("https://cdn.example.org/a.js", g));      // 다른 호스트(하위 리소스) → 취소만
        assertFalse(GateSslClient.sameOrigin("http://127.0.0.1:18453/", g));           // 다른 scheme
        assertFalse(GateSslClient.sameOrigin("https://localhost/fh-offline.html", g)); // 로컬 안내 화면
        assertFalse(GateSslClient.sameOrigin("https://127.0.0.1:18453/", null));       // bundled(server.url 없음)
        assertFalse(GateSslClient.sameOrigin(null, g));
        assertFalse(GateSslClient.sameOrigin("::bad", g));
    }
}
