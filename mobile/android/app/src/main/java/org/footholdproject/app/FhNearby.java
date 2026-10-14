package org.footholdproject.app;

import java.io.ByteArrayOutputStream;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 주변 관문 검색(계약 D′, mobile/docs/FHGATE-CONTRACT.md) — NSD 결과 한 건을 «후보»로 바꿀지 판정하는 순수 Java 부분.
 * 후보 = 미검증 목록일 뿐: 여기서 연결·로그인·저장·probe 를 하지 않는다. 인증서 SAN 대조는 사용자가 고른 뒤 probe 가 한다.
 */
final class FhNearby {
    static final String TYPE = "_foothold-gate._tcp";   // 도메인 local
    static final int MAX_ITEMS = 16, NAME_MAX = 64, MIN_MS = 1000, MAX_MS = 8000, DEF_MS = 5000;

    private FhNearby() {}

    /** 탐색 후보 공통: 한 번의 탐색 안에서 같은 key 는 처음 것만(관문 = origin, 로봇 = sn — Go2Direct). */
    interface Keyed { String key(); }

    static final class Item implements Keyed {
        final String name, origin;
        Item(String name, String origin) { this.name = name; this.origin = origin; }
        @Override public String key() { return origin; }
    }

    static int clampMs(Integer ms) {
        return ms == null ? DEF_MS : Math.max(MIN_MS, Math.min(MAX_MS, ms));
    }

    /** null = 버림. 주소는 사설 IPv4(10/8·172.16/12·192.168/16)만, 포트는 SRV 값, TXT 는 app·api 만 보고 그 밖 키는 무시. */
    static Item item(String rawName, int port, List<InetAddress> addrs, Map<String, byte[]> txt) {
        if (txt == null || !"foothold-gate".equals(str(txt.get("app"))) || !"1".equals(str(txt.get("api")))) return null;
        if (port < 1 || port > 65535 || addrs == null) return null;
        for (InetAddress a : addrs) {
            if (!privateV4(a)) continue;
            try {
                // 기존 관문 주소 규칙을 그대로 통과해야 후보 — 443 은 생략(gateOrigin 은 «:443» 표기를 거부)
                return new Item(name(rawName), FhGateCore.gateOrigin("https://" + a.getHostAddress() + (port == 443 ? "" : ":" + port)));
            } catch (FhGateCore.GateError e) {
                return null;
            }
        }
        return null;
    }

    /** 사설 대역 유니캐스트 IPv4 만. 루프백·0·멀티캐스트·169.254·브로드캐스트·공인·CGNAT(100.64/10, Tailscale)·IPv6 는 전부 밖. */
    static boolean privateV4(InetAddress a) {
        if (!(a instanceof Inet4Address)) return false;
        byte[] b = a.getAddress();
        int o0 = b[0] & 0xff, o1 = b[1] & 0xff;   // 서브넷 브로드캐스트는 접두 길이를 몰라 못 거름 — 그런 광고는 probe 실패로 드러남
        return o0 == 10 || (o0 == 172 && o1 >= 16 && o1 <= 31) || (o0 == 192 && o1 == 168);
    }

    /** DNS-SD 이름 표시용: \DDD·\x 이스케이프 해석(일부 Android 판이 그대로 돌려줌) → 제어·서식 문자(방향 바꾸기 포함) 제거 → 64 자. */
    static String name(String raw) {
        if (raw == null) return "";
        ByteArrayOutputStream o = new ByteArrayOutputStream();
        for (int i = 0; i < raw.length(); ) {
            char ch = raw.charAt(i);
            if (ch == '\\' && isDigit3(raw, i + 1)) {
                int v = Integer.parseInt(raw.substring(i + 1, i + 4));
                if (v <= 255) { o.write(v); i += 4; continue; }
            }
            if (ch == '\\' && i + 1 < raw.length()) { ch = raw.charAt(++i); }
            int cp = Character.codePointAt(raw, i);
            byte[] u = new String(Character.toChars(cp)).getBytes(StandardCharsets.UTF_8);
            o.write(u, 0, u.length);
            i += Character.charCount(cp);
        }
        String s = new String(o.toByteArray(), StandardCharsets.UTF_8);
        StringBuilder out = new StringBuilder();
        int n = 0;
        for (int i = 0; i < s.length() && n < NAME_MAX; ) {
            int cp = s.codePointAt(i);
            int t = Character.getType(cp);
            if (!Character.isISOControl(cp) && t != Character.FORMAT && t != Character.LINE_SEPARATOR && t != Character.PARAGRAPH_SEPARATOR) { out.appendCodePoint(cp); n++; }
            i += Character.charCount(cp);
        }
        return out.toString().trim();
    }

    private static boolean isDigit3(String s, int i) {
        return i + 3 <= s.length() && Character.isDigit(s.charAt(i)) && Character.isDigit(s.charAt(i + 1)) && Character.isDigit(s.charAt(i + 2))
                && s.charAt(i) < 128 && s.charAt(i + 1) < 128 && s.charAt(i + 2) < 128;
    }

    private static String str(byte[] v) {
        return v == null ? null : new String(v, StandardCharsets.UTF_8);
    }

    /** 한 번의 탐색 결과: 같은 key 는 처음 것만, 최대 16. */
    static final class Scan<T extends Keyed> {
        private final Map<String, T> by = new LinkedHashMap<>();
        boolean add(T it) {
            if (it == null || full() || by.containsKey(it.key())) return false;
            by.put(it.key(), it);
            return true;
        }
        boolean full() { return by.size() >= MAX_ITEMS; }
        List<T> items() { return new ArrayList<>(by.values()); }
    }

    /**
     * 탐색 수명 제어기 — **모든 메서드는 한 직렬 스레드(Android = main Handler)에서만 부른다.** 시작·멈춤·pause·파괴·NSD 콜백이
     * 모두 이 한 줄을 지나므로 «멈춘 뒤 시작» 같은 순서 뒤집힘이 없다. NSD·타이머·Promise 는 Port 로 분리(시험은 가짜 Port).
     * T = 후보 종류(관문 Item · 로봇 Go2Direct.Robot). 수명 규칙은 같다.
     */
    static final class Ctl<T extends Keyed> {
        interface Port<T extends Keyed> {
            boolean lanUp();
            void start(Run<T> r);                         // NSD 탐색 시작 요청 — 실패는 RuntimeException
            void stop(Run<T> r);                          // NSD 탐색 멈춤 요청 — 실패는 RuntimeException
            void resolve(Run<T> r, Object svc);           // 비동기 — 결과는 같은 직렬 스레드로 resolved(r, item|null)
            boolean after(Run<T> r, int ms);              // ms 뒤 직렬 스레드에서 timeout(r). false = 예약 못 함
            void cancelTimer(Run<T> r);
            void done(Object call, long gen, List<T> items, String why, String stop);
            void fail(Object call, String code, String msg, long gen);
        }

        static final class Run<T extends Keyed> {
            final Object call; final long gen;
            final Scan<T> found = new Scan<>();
            final ArrayDeque<Object> queue = new ArrayDeque<>();
            boolean started, resolving, ended;
            int tries;
            Object handle;                             // Port 가 쓰는 칸(Android = DiscoveryListener)
            Runnable timer;                            // Port 가 쓰는 칸(Android = 시한 Runnable)
            Run(Object call, long gen) { this.call = call; this.gen = gen; }
        }

        private final Port<T> port;
        private Run<T> run;
        private boolean paused, closed;

        Ctl(Port<T> port) { this.port = port; }

        void discover(Object call, long gen, Integer ms) {
            if (closed) { port.fail(call, "stale", "앱 화면이 다시 만들어짐", gen); return; }
            if (run != null) { port.fail(call, "busy", "주변 검색이 이미 진행 중", gen); return; }
            Run<T> r = new Run<>(call, gen);
            if (paused) { port.done(call, gen, new ArrayList<>(), "hidden", "none"); return; }   // 숨은 뒤 늦게 온 호출 — NSD 시작 0
            if (!port.lanUp()) { port.done(call, gen, new ArrayList<>(), "wifi", "none"); return; }
            run = r;
            if (!port.after(r, clampMs(ms))) { end(r, "nsd"); return; }
            try {
                port.start(r);
                r.started = true;
            } catch (RuntimeException e) {             // NSD 서비스 없음·인자 거부 등
                end(r, "nsd");
            }
        }

        void stopReq() { if (run != null) end(run, "cancelled"); }
        void pause() { paused = true; if (run != null) end(run, "hidden"); }
        void resume() { paused = false; }
        void destroy() {
            closed = true;
            Run<T> r = run;
            if (r == null) return;
            String stop = finish(r);
            port.fail(r.call, "stale", "앱 화면이 다시 만들어짐 (stop " + stop + ")", r.gen);
        }

        void startFailed(Run<T> r) { if (live(r)) { r.started = false; end(r, "nsd"); } }   // 시작 실패면 NSD 쪽 탐색이 없음 — stop 부르지 않음
        void timeout(Run<T> r) { if (live(r)) end(r, null); }

        void found(Run<T> r, Object svc) {
            if (!live(r) || r.queue.size() >= 2 * MAX_ITEMS) return;
            r.queue.add(svc);
            next(r);
        }

        void resolved(Run<T> r, T it) {
            if (!live(r)) return;                      // 끝난 탐색의 늦은 resolve — 표시 0
            r.resolving = false;
            r.found.add(it);
            if (r.found.full()) end(r, null); else next(r);
        }

        private void next(Run<T> r) {
            if (r.resolving || r.found.full() || r.tries >= 2 * MAX_ITEMS || r.queue.isEmpty()) return;
            r.resolving = true; r.tries++;
            Object svc = r.queue.poll();
            try { port.resolve(r, svc); } catch (RuntimeException e) { r.resolving = false; next(r); }
        }

        private boolean live(Run<T> r) { return r == run && !r.ended; }

        /** 끝내기(한 번만). why 가 있으면 items []. stop = none(시작 안 됨)·requested(멈춤 요청 수락 — 실제 멈춤 확인 아님)·failed. */
        private void end(Run<T> r, String why) {
            if (r.ended) return;
            String stop = finish(r);
            port.done(r.call, r.gen, why == null ? r.found.items() : new ArrayList<>(), why, stop);
        }

        private String finish(Run<T> r) {
            r.ended = true;
            if (run == r) run = null;
            port.cancelTimer(r);
            if (!r.started) return "none";
            try { port.stop(r); return "requested"; } catch (RuntimeException e) { return "failed"; }
        }
    }
}
