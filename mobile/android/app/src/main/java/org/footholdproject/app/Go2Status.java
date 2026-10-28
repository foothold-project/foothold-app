package org.footholdproject.app;

import android.app.Activity;
import android.net.Network;
import android.os.Handler;
import android.os.Looper;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.function.Consumer;
import org.json.JSONObject;

/**
 * Go2 상태 전용(10-28, GO2-readonly 계약 runs/go2-readonly/PHONE-CONTRACT.md): mDNS mode=go2-readonly 또는 직접 입력한 주소의
 * GET http://<사설 IPv4>:<포트>/go2/status 를 1 s 마다(요청 3 s 제한) 읽어 'fh-go2' 이벤트로 화면에. 조종·등록·STOP 없음.
 *  - 현장 코드(8자리)는 매 요청 X-Foothold-Code 헤더로만 — URL·로그·저장 0. 401 = 화면이 코드 다시 받음, 429 = Retry-After(기본 60 s) 동안 쉼
 *  - WebView fetch 가 아니라 여기서 소켓으로(HTTP/1.0, Connection: close) — 앱 전체 평문 허용(network security config)을 열지 않는다.
 *    Go2 핫스팟은 인터넷이 없어 기본 망이 모바일 데이터일 수 있다 → 소켓을 Wi-Fi 망에 묶는다(서버는 기본 망 그대로)
 * 통로: 화면이 window.fhGo2Status={seq,url,code} 를 두면 MainActivity 0.5 s 읽기가 보고 시작, 없어지면 멈춤.
 */
final class Go2Status {
    static final long PERIOD_MS = 1000;
    static final int TIMEOUT_MS = 3000, MAX = 64 * 1024;

    private final Activity act;
    private final Consumer<String> out;
    private final Handler main = new Handler(Looper.getMainLooper());
    private volatile String key;
    private Thread th;

    Go2Status(Activity act, Consumer<String> out) {
        this.act = act;
        this.out = out;
    }

    String key() {
        return key;
    }

    void start(String k, String seq, String url, String code) {
        stop();
        key = k;
        String[] t = target(url);
        if (t == null || code == null || !code.matches("\\d{8}")) { emit(k, seq, "{\"status\":-2}"); return; }   // 화면이 이미 거르는 값 — 여기서도 안 보냄
        th = new Thread(() -> loop(k, seq, t[0], Integer.parseInt(t[1]), code), "go2-status");
        th.start();
    }

    void stop() {
        key = null;
        if (th != null) { th.interrupt(); th = null; }
    }

    private void loop(String k, String seq, String host, int port, String code) {
        while (k.equals(key)) {
            long t0 = System.nanoTime(), wait = PERIOD_MS;
            String body;
            Network n = Nearby.wifi(act);
            if (n == null) body = "{\"status\":0,\"why\":\"wifi-off\"}";
            else {
                Resp r;
                try { r = parse(get(n, host, port, code)); } catch (Exception e) { r = null; }
                if (r == null) body = "{\"status\":0}";
                else if (r.status == 200) {
                    try { body = "{\"status\":200,\"body\":" + new JSONObject(r.body) + "}"; } catch (Exception e) { body = "{\"status\":-1}"; }
                } else {
                    body = "{\"status\":" + r.status + (r.status == 429 ? ",\"retry\":" + r.retry : "") + "}";
                    if (r.status == 429) wait = r.retry * 1000L;   // 자동 재시도 폭주 금지
                }
            }
            emit(k, seq, body);
            long left = wait - (System.nanoTime() - t0) / 1_000_000;
            try { if (left > 0) Thread.sleep(left); } catch (InterruptedException e) { return; }
        }
    }

    private void emit(String k, String seq, String json) {
        main.post(() -> {
            if (!k.equals(key)) return;
            out.accept("window.dispatchEvent(new CustomEvent('fh-go2',{detail:Object.assign(" + json + ",{seq:" + JSONObject.quote(seq) + "})}))");
        });
    }

    /** 요청 한 번(3 s 제한). 코드는 헤더에만 */
    private static byte[] get(Network n, String host, int port, String code) throws Exception {
        long end = System.nanoTime() + TIMEOUT_MS * 1_000_000L;
        try (Socket s = new Socket()) {
            n.bindSocket(s);
            s.connect(new InetSocketAddress(host, port), TIMEOUT_MS);
            s.setSoTimeout(TIMEOUT_MS);
            OutputStream o = s.getOutputStream();
            o.write(("GET /go2/status HTTP/1.0\r\nHost: " + host + ":" + port + "\r\nAccept: application/json\r\nX-Foothold-Code: " + code + "\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
            o.flush();
            InputStream in = s.getInputStream();
            ByteArrayOutputStream b = new ByteArrayOutputStream();
            byte[] buf = new byte[4096];
            for (int r; (r = in.read(buf)) != -1; ) {
                b.write(buf, 0, r);
                if (b.size() > MAX || System.nanoTime() > end) throw new Exception("too big/slow");
            }
            return b.toByteArray();
        }
    }

    // ---- 순수 판정(JVM 단위 시험) ----

    static final class Resp {
        final int status, retry;
        final String body;
        Resp(int status, int retry, String body) { this.status = status; this.retry = retry; this.body = body; }
    }

    /** http://<사설 IPv4>:<포트>/go2/status(질의·조각·사용자정보 없음) → {호스트, 포트}, 아니면 null */
    static String[] target(String url) {
        if (url == null || url.length() > 100) return null;
        try {
            URI u = new URI(url);
            String h = Nearby.lan(u.getHost());
            if (!"http".equals(u.getScheme()) || h == null || !h.equals(u.getHost()) || u.getRawUserInfo() != null || u.getRawQuery() != null || u.getRawFragment() != null
                || !"/go2/status".equals(u.getRawPath()) || u.getPort() <= 0 || u.getPort() > 65535) return null;
            return new String[] { h, String.valueOf(u.getPort()) };
        } catch (Exception e) {
            return null;
        }
    }

    /** HTTP/1.x 응답(본문 끝 = 연결 닫힘) → 상태·Retry-After(429, 1~600 s, 기본 60)·본문. 틀린 모양이면 null */
    static Resp parse(byte[] raw) {
        String s = new String(raw, StandardCharsets.UTF_8);
        int sep = s.indexOf("\r\n\r\n");
        if (sep < 0) return null;
        String[] lines = s.substring(0, sep).split("\r\n");
        String[] st = lines[0].split(" ", 3);
        if (st.length < 2 || !st[0].startsWith("HTTP/1.")) return null;
        int status;
        try { status = Integer.parseInt(st[1]); } catch (NumberFormatException e) { return null; }
        if (status < 100 || status > 599) return null;
        int retry = 60;
        for (int i = 1; i < lines.length; i++) {
            int c = lines[i].indexOf(':');
            if (c > 0 && lines[i].substring(0, c).trim().equalsIgnoreCase("Retry-After")) {
                try { retry = Math.max(1, Math.min(600, Integer.parseInt(lines[i].substring(c + 1).trim()))); } catch (NumberFormatException ignored) {}
            }
        }
        return new Resp(status, retry, s.substring(sep + 4));
    }
}
