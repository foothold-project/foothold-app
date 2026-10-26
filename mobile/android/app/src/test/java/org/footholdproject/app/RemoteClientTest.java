package org.footholdproject.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class RemoteClientTest {
    @Test
    public void origin() {
        assertEquals("https://a-b.trycloudflare.com", RemoteClient.origin("https://A-B.trycloudflare.com/#/drive"));
        assertEquals("https://gate.example.org", RemoteClient.origin("https://gate.example.org:443/x"));
        assertEquals("https://10.0.0.5:8443", RemoteClient.origin("https://10.0.0.5:8443/"));
        assertNull(RemoteClient.origin("http://gate.example.org/"));            // 평문
        assertNull(RemoteClient.origin("https://u:p@gate.example.org/"));       // 사용자정보
        assertNull(RemoteClient.origin("intent://x#Intent;end"));
        assertNull(RemoteClient.origin("::bad"));
        assertNull(RemoteClient.origin(null));
    }

    @Test
    public void allowed() {
        String c = "https://gate.example.org";
        assertTrue(RemoteClient.allowed("https://gate.example.org/api/v1/me", c));
        assertTrue(RemoteClient.allowed("https://x-y.trycloudflare.com/", c));
        assertFalse(RemoteClient.allowed("https://x-y.trycloudflare.com:8443/", c));   // 터널은 기본 포트만
        assertFalse(RemoteClient.allowed("https://trycloudflare.com.evil.org/", c));
        assertFalse(RemoteClient.allowed("https://eviltrycloudflare.com/", c));
        assertFalse(RemoteClient.allowed("https://gate.example.org:8443/", c));        // 같은 호스트 다른 포트
        assertFalse(RemoteClient.allowed("http://gate.example.org/", c));
        assertFalse(RemoteClient.allowed("https://other.example.org/", c));
        assertFalse(RemoteClient.allowed("https://other.example.org/", null));
    }
}
