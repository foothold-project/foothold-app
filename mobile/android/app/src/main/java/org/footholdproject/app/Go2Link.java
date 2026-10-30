package org.footholdproject.app;

import android.app.Activity;
import android.net.Network;
import android.os.Handler;
import android.os.Looper;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.util.function.Consumer;
import org.json.JSONObject;

/**
 * 실기 직결 중계(10-30 PHONE-REAL-CONNECT): 원격 https 화면은 로봇 Wi-Fi 주소(ws://사설 IPv4)에 직접 못 붙고, Go2 Wi-Fi 는 인터넷이 없어 기본 망이 LTE 다.
 * 그래서 127.0.0.1 임시 포트를 열고, 받은 연결 1개를 Wi-Fi 망에 묶은 소켓(Nearby.onLink → bindSocket)으로 찾은 로봇 host:port 에 바이트 그대로 잇는다.
 *  - 대상 = 주변 찾기(Nearby)가 mDNS 로 찾은 인증 WS 에이전트 하나(Nearby.found). 화면이 다른 주소를 주면 'not-found' — 열지 않음
 *  - 127.0.0.1 에만 bind, 연결 1개만(쓰는 중이면 새 연결은 바로 닫음). 같은 폰의 다른 앱도 이 포트에 붙을 수는 있으나 에이전트의 출입증·조종권 검사는 그대로
 *  - 닫기: 화면이 window.fhGo2Link 를 지움(조종 끝·나가기) · 앱 가림(onPause) · 로봇 Wi-Fi 망이 바뀌거나 끊김(0.5 s 읽기마다 check). 로봇은 입력이 끊기면 deadman 으로 멈춤
 * 통로: 화면이 window.fhGo2Link={seq,host,port} 를 두면 MainActivity 0.5 s 읽기가 보고 시작, 결과는 'fh-go2-link' 이벤트 {seq,port} 또는 {seq,why}.
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
        try {
            relay = new Relay(() -> {
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
        emit("port", relay.port());
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

    private void emit(String name, Object v) {
        String k = key;
        try {
            JSONObject d = new JSONObject().put("seq", seq).put(name, v);
            main.post(() -> { if (k != null && k.equals(key)) out.accept("window.dispatchEvent(new CustomEvent('fh-go2-link',{detail:" + d + "}))"); });
        } catch (Exception ignored) {}
    }

    // ---- 중계(JVM 단위 시험 — Opener 만 바꿔 끼움) ----

    static final class Relay {
        private final ServerSocket server;
        private final Opener opener;
        private Socket phone, robot;   // 지금 잇는 한 쌍(this 로 잠금)

        Relay(Opener opener) throws IOException {
            this.opener = opener;
            server = new ServerSocket(0, 1, InetAddress.getByAddress(new byte[] { 127, 0, 0, 1 }));
            Thread t = new Thread(this::accept, "go2-link");
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
                quiet(phone);
                quiet(robot);
                phone = robot = null;
            }
        }

        private void accept() {
            while (!server.isClosed()) {
                Socket c;
                try { c = server.accept(); } catch (IOException e) { return; }
                synchronized (this) {
                    if (phone != null || server.isClosed()) { quiet(c); continue; }   // 연결 1개만
                    phone = c;
                }
                Thread t = new Thread(() -> serve(c), "go2-link-io");
                t.setDaemon(true);
                t.start();
            }
        }

        private void serve(Socket c) {
            try {
                Socket r = opener.open();
                synchronized (this) {
                    if (phone != c) { quiet(r); return; }   // 그 사이 닫힘
                    robot = r;
                }
                Thread up = new Thread(() -> pump(c, r), "go2-link-up");
                up.setDaemon(true);
                up.start();
                pump(r, c);
            } catch (Exception ignored) {
            } finally {
                synchronized (this) {
                    if (phone == c) { quiet(robot); phone = robot = null; }
                }
                quiet(c);
            }
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
