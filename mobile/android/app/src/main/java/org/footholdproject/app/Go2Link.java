package org.footholdproject.app;

import android.app.Activity;
import android.net.Network;
import android.os.Handler;
import android.os.Looper;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Arrays;
import java.util.function.Consumer;
import org.json.JSONObject;

/**
 * 실기 직결 중계(10-30 PHONE-REAL-CONNECT): 원격 https 화면은 로봇 Wi-Fi 주소(ws://사설 IPv4)에 직접 못 붙고, Go2 Wi-Fi 는 인터넷이 없어 기본 망이 LTE 다.
 * 그래서 127.0.0.1 임시 포트를 열고, 받은 연결 1개를 Wi-Fi 망에 묶은 소켓(Nearby.onLink → bindSocket)으로 찾은 로봇 host:port 에 바이트 그대로 잇는다.
 *  - 대상 = 주변 찾기(Nearby)가 mDNS 로 찾은 인증 WS 에이전트 하나(Nearby.found). 화면이 다른 주소를 주면 'not-found' — 열지 않음
 *  - 127.0.0.1 에만 bind, 한 번만 받음(첫 수락 직후 listen 닫음). 열 때마다 일회 nonce 를 화면(WebView)에만 주고, 첫 줄이
 *    «GET /phone/ws?fh=<nonce> HTTP/1.1» 일 때만 로봇에 이어 «GET /phone/ws HTTP/1.1» 로 바꿔 보낸다. 틀리면 닫고 중계를 버린다(로봇 연결 0).
 *    같은 폰의 다른 앱이 먼저 붙으면 이번 중계만 버려지고(화면은 «다시 연결» = 새 포트·nonce), 에이전트의 출입증·조종권 검사는 그대로
 *  - 닫기: 화면이 window.fhGo2Link 를 지움(조종 끝·나가기) · 앱 가림(onPause) · 로봇 Wi-Fi 망이 바뀌거나 끊김(0.5 s 읽기마다 check). 로봇은 입력이 끊기면 deadman 으로 멈춤
 * 통로: 화면이 window.fhGo2Link={seq,host,port} 를 두면 MainActivity 0.5 s 읽기가 보고 시작, 결과는 'fh-go2-link' 이벤트 {seq,port,nonce} 또는 {seq,why}.
 */
final class Go2Link {
    static final int CONNECT_MS = 3000;

    interface Opener {
        Socket open() throws IOException;
    }

    private final Activity act;
    private final Consumer<String> out;
    private final Nearby nearby;
    private final Handler main = new Handler(Looper.getMainLooper());
    private String key, seq, host;
    private Network net;
    private Relay relay;

    Go2Link(Activity act, Consumer<String> out, Nearby nearby) {
        this.act = act;
        this.out = out;
        this.nearby = nearby;
    }

    String key() {
        return key;
    }

    void start(String k, String s, String h, int port) {
        stop();
        key = k;
        seq = s;
        if (!nearby.found(h, port)) { emit("why", "not-found"); return; }
        Network n = Nearby.onLink(act, h);
        if (n == null) { emit("why", Nearby.wifi(act) == null ? "wifi-off" : "other-subnet"); return; }
        byte[] b = new byte[16];
        new SecureRandom().nextBytes(b);
        StringBuilder nonce = new StringBuilder();
        for (byte x : b) nonce.append(String.format("%02x", x));
        try {
            relay = new Relay(nonce.toString(), () -> {
                Socket r = new Socket();
                n.bindSocket(r);
                r.connect(new InetSocketAddress(h, port), CONNECT_MS);
                return r;
            });
        } catch (IOException e) {
            emit("why", "relay-fail");
            return;
        }
        host = h;
        net = n;
        emit("port", relay.port(), "nonce", nonce.toString());
    }

    /** 0.5 s 읽기마다: 로봇 Wi-Fi 망이 바뀌거나 끊기면 즉시 닫음(다시 열기는 화면의 «다시 연결») */
    void check() {
        if (relay == null || net.equals(Nearby.onLink(act, host))) return;
        relay.close();
        relay = null;
        emit("why", Nearby.wifi(act) == null ? "wifi-off" : "other-subnet");
    }

    void stop() {
        key = null;
        if (relay != null) { relay.close(); relay = null; }
    }

    private void emit(Object... kv) {
        String k = key;
        try {
            JSONObject d = new JSONObject().put("seq", seq);
            for (int i = 0; i < kv.length; i += 2) d.put((String) kv[i], kv[i + 1]);
            main.post(() -> { if (k != null && k.equals(key)) out.accept("window.dispatchEvent(new CustomEvent('fh-go2-link',{detail:" + d + "}))"); });
        } catch (Exception ignored) {}
    }

    // ---- 중계(JVM 단위 시험 — Opener 만 바꿔 끼움) ----

    static final class Relay {
        static final int LINE_MAX = 2048, HELLO_MS = 3000;
        private final ServerSocket server;
        private final Opener opener;
        private final byte[] want;
        private Socket phone, robot;   // 이은 한 쌍(this 로 잠금)
        private boolean closed;

        Relay(String nonce, Opener opener) throws IOException {
            this.opener = opener;
            want = ("GET /phone/ws?fh=" + nonce + " HTTP/1.1").getBytes(StandardCharsets.US_ASCII);
            server = new ServerSocket(0, 1, InetAddress.getByAddress(new byte[] { 127, 0, 0, 1 }));
            Thread t = new Thread(this::run, "go2-link");
            t.setDaemon(true);
            t.start();
        }

        int port() {
            return server.getLocalPort();
        }

        InetAddress bound() {
            return server.getInetAddress();
        }

        void close() {
            quiet(server);
            synchronized (this) {
                closed = true;
                quiet(phone);
                quiet(robot);
            }
        }

        /** 한 번만 받고 listen 을 닫는다. 첫 줄 nonce 가 맞을 때만 로봇에 잇는다 */
        private void run() {
            Socket c;
            try { c = server.accept(); } catch (IOException e) { return; }
            quiet(server);
            Socket r = null;
            try {
                synchronized (this) { if (closed) return; phone = c; }
                c.setSoTimeout(HELLO_MS);
                InputStream in = c.getInputStream();
                byte[] line = line(in);
                if (line == null || !MessageDigest.isEqual(line, want)) return;   // 틀린 nonce·모양 = 로봇 연결 0, 이 중계는 끝
                c.setSoTimeout(0);
                r = opener.open();
                synchronized (this) { if (closed) return; robot = r; }
                OutputStream o = r.getOutputStream();
                o.write("GET /phone/ws HTTP/1.1\r\n".getBytes(StandardCharsets.US_ASCII));
                o.flush();
                Socket rr = r;
                Thread up = new Thread(() -> pump(c, rr), "go2-link-up");
                up.setDaemon(true);
                up.start();
                pump(r, c);
            } catch (Exception ignored) {
            } finally {
                quiet(r);
                quiet(c);
            }
        }

        /** CRLF 앞까지(최대 LINE_MAX), 못 읽으면 null */
        static byte[] line(InputStream in) throws IOException {
            ByteArrayOutputStream b = new ByteArrayOutputStream();
            for (int x; (x = in.read()) != -1; ) {
                if (x == '\n') {
                    byte[] a = b.toByteArray();
                    return a.length > 0 && a[a.length - 1] == '\r' ? Arrays.copyOf(a, a.length - 1) : null;
                }
                if (b.size() >= LINE_MAX) return null;
                b.write(x);
            }
            return null;
        }

        /** 한쪽이 끝나면 둘 다 닫는다(반쯤 열린 연결 0) */
        private static void pump(Socket from, Socket to) {
            byte[] buf = new byte[16 * 1024];
            try {
                InputStream in = from.getInputStream();
                OutputStream o = to.getOutputStream();
                for (int n; (n = in.read(buf)) != -1; ) { o.write(buf, 0, n); o.flush(); }
            } catch (IOException ignored) {
            } finally {
                quiet(from);
                quiet(to);
            }
        }

        private static void quiet(java.io.Closeable c) {
            try { if (c != null) c.close(); } catch (IOException ignored) {}
        }
    }
}
