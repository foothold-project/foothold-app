package org.footholdproject.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import java.net.InetAddress;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.junit.Test;

/** 수명 제어기 반례 — 가짜 Port 로 순서를 고정해 직렬 스레드 위의 동작을 본다(실 NSD·스레드 경합 시험 아님). */
public class FhNearbyCtlTest {
    static final class Fake implements FhNearby.Ctl.Port<FhNearby.Item> {
        boolean lan = true, timerOk = true, startThrows, stopThrows;
        int starts, stops, timers, timerCancels;
        final List<Object> resolving = new ArrayList<>();
        final List<String> out = new ArrayList<>();      // Promise 결과(호출 하나당 한 줄이어야 함)
        FhNearby.Ctl.Run<FhNearby.Item> last;
        @Override public boolean lanUp() { return lan; }
        @Override public void start(FhNearby.Ctl.Run<FhNearby.Item> r) { last = r; if (startThrows) throw new IllegalStateException("NSD 없음"); starts++; }
        @Override public void stop(FhNearby.Ctl.Run<FhNearby.Item> r) { stops++; if (stopThrows) throw new IllegalArgumentException("listener"); }
        @Override public void resolve(FhNearby.Ctl.Run<FhNearby.Item> r, Object svc) { resolving.add(svc); }
        @Override public boolean after(FhNearby.Ctl.Run<FhNearby.Item> r, int ms) { last = r; timers++; return timerOk; }
        @Override public void cancelTimer(FhNearby.Ctl.Run<FhNearby.Item> r) { timerCancels++; }
        @Override public void done(Object call, long gen, List<FhNearby.Item> items, String why, String stop) {
            StringBuilder b = new StringBuilder(call + " done why=" + why + " stop=" + stop + " n=" + items.size());
            for (FhNearby.Item it : items) b.append(' ').append(it.origin);
            out.add(b.toString());
        }
        @Override public void fail(Object call, String code, String msg, long gen) { out.add(call + " fail " + code); }
    }

    static FhNearby.Item item(String ip) throws Exception {
        Map<String, byte[]> t = new HashMap<>();
        t.put("app", "foothold-gate".getBytes(StandardCharsets.UTF_8));
        t.put("api", "1".getBytes(StandardCharsets.UTF_8));
        return FhNearby.item("g", 8453, Collections.singletonList(InetAddress.getByName(ip)), t);
    }

    @Test public void pauseBeforeQueuedDiscoverStartsNothing() {
        Fake f = new Fake(); FhNearby.Ctl<FhNearby.Item> c = new FhNearby.Ctl<>(f);
        c.pause();                                   // 숨김이 먼저 처리됨
        c.discover("A", 3, 5000);                     // 그 뒤 늦게 도착한 호출
        assertEquals(0, f.starts); assertEquals(0, f.timers); assertEquals(0, f.stops);
        assertEquals(Collections.singletonList("A done why=hidden stop=none n=0"), f.out);
        c.resume();
        c.discover("B", 3, 5000);
        assertEquals(1, f.starts);
    }

    @Test public void cancelPauseDestroyAfterStartStopOnceAndAnswerOnce() throws Exception {
        for (String ev : new String[]{"cancel", "pause", "destroy"}) {
            Fake f = new Fake(); FhNearby.Ctl<FhNearby.Item> c = new FhNearby.Ctl<>(f);
            c.discover("A", 1, 5000);
            FhNearby.Ctl.Run<FhNearby.Item> r = f.last;
            c.found(r, "svc1");
            assertEquals(1, f.resolving.size());
            if (ev.equals("cancel")) c.stopReq(); else if (ev.equals("pause")) c.pause(); else c.destroy();
            assertEquals(ev, 1, f.stops); assertEquals(ev, 1, f.timerCancels);
            // 늦은 콜백·중복 사건 — 표시 0, 시작 0, Promise 추가 0
            c.resolved(r, item("192.168.0.7")); c.found(r, "svc2"); c.timeout(r); c.startFailed(r); c.stopReq(); c.pause(); c.destroy();
            assertEquals(ev, 1, f.stops); assertEquals(ev, 1, f.starts); assertEquals(ev, 1, f.resolving.size());
            assertEquals(ev, 1, f.out.size());
            String want = ev.equals("cancel") ? "A done why=cancelled stop=requested n=0" : ev.equals("pause") ? "A done why=hidden stop=requested n=0" : "A fail stale";
            assertEquals(ev, want, f.out.get(0));
        }
    }

    @Test public void destroyedRejectsNewDiscoverWithoutStart() {
        Fake f = new Fake(); FhNearby.Ctl<FhNearby.Item> c = new FhNearby.Ctl<>(f);
        c.destroy();
        c.discover("A", 1, null);
        assertEquals(0, f.starts); assertEquals(0, f.timers);
        assertEquals(Collections.singletonList("A fail stale"), f.out);
    }

    @Test public void timeoutReturnsFoundAndResolvesOneAtATime() throws Exception {
        Fake f = new Fake(); FhNearby.Ctl<FhNearby.Item> c = new FhNearby.Ctl<>(f);
        c.discover("A", 2, 3000);
        FhNearby.Ctl.Run<FhNearby.Item> r = f.last;
        c.found(r, "s1"); c.found(r, "s2"); c.found(r, "s3");
        assertEquals(1, f.resolving.size());          // 동시 resolve 0
        c.resolved(r, item("192.168.0.7"));
        assertEquals(2, f.resolving.size());
        c.resolved(r, null);                          // 실패·버린 후보
        assertEquals(3, f.resolving.size());
        c.resolved(r, item("192.168.0.7"));           // 같은 origin — 하나만
        c.timeout(r);
        assertEquals(Collections.singletonList("A done why=null stop=requested n=1 https://192.168.0.7:8453"), f.out);
        assertEquals(1, f.stops);
    }

    @Test public void failuresStillEndThePromiseAndReportStop() {
        Fake f = new Fake(); f.startThrows = true; FhNearby.Ctl<FhNearby.Item> c = new FhNearby.Ctl<>(f);
        c.discover("A", 1, 5000);                     // NSD 서비스 없음 — 시작 안 됐으니 stop 안 부름
        assertEquals(Collections.singletonList("A done why=nsd stop=none n=0"), f.out); assertEquals(0, f.stops); assertEquals(1, f.timerCancels);
        c.discover("B", 1, 5000);                     // 실패 뒤 다음 호출은 busy 가 아님
        assertEquals("B done why=nsd stop=none n=0", f.out.get(1));

        f = new Fake(); f.stopThrows = true; c = new FhNearby.Ctl<>(f);
        c.discover("C", 1, 5000); c.timeout(f.last);  // 멈춤 요청 실패는 성공으로 바꾸지 않음
        assertEquals(Collections.singletonList("C done why=null stop=failed n=0"), f.out);

        f = new Fake(); c = new FhNearby.Ctl<>(f);
        c.discover("D", 1, 5000); c.startFailed(f.last);   // onStartDiscoveryFailed — NSD 쪽 탐색 없음
        assertEquals(Collections.singletonList("D done why=nsd stop=none n=0"), f.out); assertEquals(0, f.stops);

        f = new Fake(); f.timerOk = false; c = new FhNearby.Ctl<>(f);
        c.discover("E", 1, 5000);                     // 시한을 못 걸면 시작하지 않음(끝없는 탐색 0)
        assertEquals(0, f.starts); assertEquals(Collections.singletonList("E done why=nsd stop=none n=0"), f.out);

        f = new Fake(); f.lan = false; c = new FhNearby.Ctl<>(f);
        c.discover("F", 1, 5000);
        assertEquals(0, f.starts); assertEquals(0, f.timers); assertEquals(Collections.singletonList("F done why=wifi stop=none n=0"), f.out);
    }

    @Test public void busyWhileRunningAndFullEndsEarly() throws Exception {
        Fake f = new Fake(); FhNearby.Ctl<FhNearby.Item> c = new FhNearby.Ctl<>(f);
        c.discover("A", 1, 5000);
        c.discover("B", 1, 5000);
        assertEquals("B fail busy", f.out.get(0)); assertEquals(1, f.starts);
        FhNearby.Ctl.Run<FhNearby.Item> r = f.last;
        for (int i = 1; i <= 16; i++) { c.found(r, "s" + i); c.resolved(r, item("10.0.0." + i)); }
        assertEquals(2, f.out.size());
        assertTrue(f.out.get(1).startsWith("A done why=null stop=requested n=16"));
        assertEquals(1, f.stops);
    }
}
