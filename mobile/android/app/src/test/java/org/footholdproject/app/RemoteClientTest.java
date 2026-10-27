package org.footholdproject.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.Arrays;
import java.util.List;
import java.util.TreeSet;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Collectors;
import java.util.stream.Stream;
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
        assertTrue(RemoteClient.allowed("https://GATE.example.org:443/#/drive", c));
        assertFalse(RemoteClient.allowed("https://attacker.trycloudflare.com/", c));   // PR #118 r0: 터널 와일드카드 허용
        assertFalse(RemoteClient.allowed("https://x-y.trycloudflare.com/", "https://a-b.trycloudflare.com"));
        assertFalse(RemoteClient.allowed("https://trycloudflare.com.evil.org/", c));
        assertFalse(RemoteClient.allowed("https://eviltrycloudflare.com/", c));
        assertFalse(RemoteClient.allowed("https://gate.example.org:8443/", c));        // 같은 호스트 다른 포트
        assertFalse(RemoteClient.allowed("http://gate.example.org/", c));
        assertFalse(RemoteClient.allowed("https://other.example.org/", c));
        assertFalse(RemoteClient.allowed("https://other.example.org/", null));
        assertFalse(RemoteClient.allowed("https://u@gate.example.org/", c));
    }

    @Test
    public void local() {   // isLocal = allowed(url, 시작 화면 origin)
        String l = RemoteClient.origin("https://localhost");
        assertTrue(RemoteClient.allowed("https://localhost/?e=net", l));
        assertFalse(RemoteClient.allowed("https://localhost:8443/", l));      // PR #118 r0: 포트 안 봄
        assertFalse(RemoteClient.allowed("https://u:p@localhost/", l));
        assertFalse(RemoteClient.allowed("http://localhost/", l));
        assertFalse(RemoteClient.allowed("https://localhost.evil.org/", l));
    }

    @Test
    public void sim() {   // /sim/ 에서는 고른 서버를 비우지 않음(시뮬 «집» = 뒤로 서버 화면) — 앱 출처의 /sim/ 아래만
        String l = RemoteClient.origin("https://localhost");
        assertTrue(RemoteClient.isSim("https://localhost/sim/index.html?from=server", l));
        assertTrue(RemoteClient.isSim("https://localhost/sim/", l));
        assertFalse(RemoteClient.isSim("https://localhost/", l));
        assertFalse(RemoteClient.isSim("https://localhost/?e=net", l));
        assertFalse(RemoteClient.isSim("https://localhost/index.html?x=/sim/", l));
        assertFalse(RemoteClient.isSim("https://localhost/sim/../index.html", l));
        assertFalse(RemoteClient.isSim("https://localhost/sim/%2e%2e/index.html", l));   // PR #145 Codex: 인코딩 상위 경로
        assertFalse(RemoteClient.isSim("https://localhost/sim/%2E%2E/index.html", l));
        assertFalse(RemoteClient.isSim("https://localhost/sim/..%2findex.html", l));
        assertFalse(RemoteClient.isSim("https://localhost/sim/.%2e/index.html", l));
        assertFalse(RemoteClient.isSim("https://localhost/sim/%2fx", l));
        assertFalse(RemoteClient.isSim("https://localhost/simx/index.html", l));
        assertFalse(RemoteClient.isSim("https://localhost:8443/sim/index.html", l));
        assertFalse(RemoteClient.isSim("http://localhost/sim/index.html", l));
        assertFalse(RemoteClient.isSim("https://gate.example.org/sim/index.html", l));
        assertFalse(RemoteClient.isSim("https://localhost/sim/index.html", null));
    }

    /** @capacitor 의 JS → 네이티브 통로 이름이 모두 RemoteClient.JS_OBJECTS 로 떼어지는지(판 올림으로 새 통로가 생기면 실패) */
    @Test
    public void jsBridgesAllRemoved() throws Exception {
        Pattern p = Pattern.compile("(?:addJavascriptInterface|addWebMessageListener)\\(\\s*[\\w.()]+\\s*,\\s*\"([^\"]+)\"");
        TreeSet<String> found = new TreeSet<>();
        for (String d : new String[] { "../../node_modules/@capacitor/android/capacitor/src/main/java", "../../node_modules/@capacitor/app/android/src/main/java" }) {
            Path root = Paths.get(d);
            assertTrue("소스 없음: " + root.toAbsolutePath(), Files.isDirectory(root));
            List<Path> files;
            try (Stream<Path> w = Files.walk(root)) { files = w.filter((f) -> f.toString().endsWith(".java")).collect(Collectors.toList()); }
            for (Path f : files) { Matcher m = p.matcher(new String(Files.readAllBytes(f), "UTF-8")); while (m.find()) found.add(m.group(1)); }
        }
        assertTrue(found.contains("androidBridge"));   // 정규식이 낡으면 여기서 걸린다
        assertTrue("안 떼는 통로: " + found, Arrays.asList(RemoteClient.JS_OBJECTS).containsAll(found));
    }
}
