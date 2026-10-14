package org.footholdproject.app;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.Uri;
import android.net.nsd.NsdManager;
import android.net.nsd.NsdServiceInfo;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.provider.DocumentsContract;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.IOException;
import java.net.InetAddress;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.ArrayDeque;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import org.json.JSONObject;

/**
 * JS ↔ FhGateCore 연결(얇게). 계약: mobile/docs/FHGATE-CONTRACT.md
 * 세션 토큰은 어떤 resolve·reject·이벤트에도 넣지 않는다. 로그도 찍지 않는다.
 */
@CapacitorPlugin(name = "FhGate")
public class FhGatePlugin extends Plugin {
    static final String APP_ORIGIN = "https://localhost";   // Capacitor Android bundled 화면 출처(androidScheme https 기본)

    private FhGateCore core;
    // ponytail: 실행 2 스레드 + 대기 8 칸 고정. 넘치면 busy 로 바로 거부(큐 무한 증가 없음). 2 스레드는 처리량일 뿐 우선순위 보장이 아니다 —
    // 그래서 로그아웃·주소 변경·파괴의 «로컬 폐기»는 이 큐를 거치지 않고 호출 스레드에서 바로 한다
    private final ThreadPoolExecutor io = new ThreadPoolExecutor(2, 2, 0L, TimeUnit.MILLISECONDS, new ArrayBlockingQueue<>(8));

    interface Job { void run() throws FhGateCore.GateError; }

    @Override
    public void load() {
        core = new FhGateCore(new FhGateCore.HttpsTransport(), new KeystoreVault(getContext()), APP_ORIGIN, () -> System.currentTimeMillis() / 1000.0);
    }

    /** Activity 파괴: 이 인스턴스의 대기·진행 작업을 무효(stale)로 — 대기 작업은 실행돼도 네트워크 0, 늦은 응답은 보관소·상태를 못 바꾼다.
     *  보관 세션은 지우지 않는다(사용자 로그아웃 아님). 큐에 남은 Promise 는 shutdown 뒤에도 실행돼 stale 로 끝난다. */
    @Override
    protected void handleOnDestroy() {
        core.close();
        io.shutdown();
        endScan(scan, null, true);
    }

    @Override
    protected void handleOnPause() {
        endScan(scan, "hidden", false);   // 화면이 숨으면 탐색을 바로 멈춘다(배경에서 멀티캐스트 계속 0)
    }

    // ── 주변 관문 검색(계약 D′): NSD 로 목록만. 연결·로그인·저장·probe 0, 후보는 미검증 ──
    // ponytail: resolveService(36 deprecated)를 하나씩 순서대로 — minSdk 24 호환, 34 미만은 동시 resolve 가 FAILURE_ALREADY_ACTIVE.
    //           34+ registerServiceInfoCallback 으로 바꾸면 병렬·주소 갱신 가능(필요해지면)
    private final Handler main = new Handler(Looper.getMainLooper());
    private volatile Scan scan;                                // 진행 중 탐색 하나(바꾸기는 nsdLock 안에서만)
    private final Object nsdLock = new Object();

    private static final class Scan {
        final PluginCall call; final long gen; final FhNearby.Scan found = new FhNearby.Scan();
        final ArrayDeque<NsdServiceInfo> queue = new ArrayDeque<>();
        NsdManager.DiscoveryListener listener; Runnable timeout; boolean resolving, ended; int tries;
        Scan(PluginCall call, long gen) { this.call = call; this.gen = gen; }
    }

    @PluginMethod
    public void discover(PluginCall call) {
        FhGateCore.Ctx c = core.ctx();
        int ms = FhNearby.clampMs(call.getInt("ms"));
        if (!core.current(c)) { reject(call, new FhGateCore.GateError("stale", "앱 화면이 다시 만들어짐", c.gen())); return; }
        Scan s;
        synchronized (nsdLock) {
            if (scan != null) { reject(call, new FhGateCore.GateError("busy", "주변 검색이 이미 진행 중", c.gen())); return; }
            s = scan = new Scan(call, c.gen());
        }
        if (!lanUp()) { endScan(s, "wifi", false); return; }
        NsdManager nsd = (NsdManager) getContext().getSystemService(Context.NSD_SERVICE);
        s.listener = new NsdManager.DiscoveryListener() {
            @Override public void onStartDiscoveryFailed(String t, int code) { endScan(s, "nsd", false); }
            @Override public void onStopDiscoveryFailed(String t, int code) {}
            @Override public void onDiscoveryStarted(String t) {}
            @Override public void onDiscoveryStopped(String t) {}
            @Override public void onServiceLost(NsdServiceInfo i) {}   // 창이 짧아 목록에서 빼지 않음 — 고른 뒤 probe 가 도달을 확인
            @Override public void onServiceFound(NsdServiceInfo i) {
                synchronized (nsdLock) { if (s.ended || s.queue.size() >= 2 * FhNearby.MAX_ITEMS) return; s.queue.add(i); }
                resolveNext(nsd, s);
            }
        };
        s.timeout = () -> endScan(s, null, false);
        main.postDelayed(s.timeout, ms);
        try {
            nsd.discoverServices(FhNearby.TYPE, NsdManager.PROTOCOL_DNS_SD, s.listener);
        } catch (RuntimeException x) {
            endScan(s, "nsd", false);
        }
    }

    /** 진행 중 탐색을 바로 끝냄 — 그 Promise 는 items [] · why cancelled. 없으면 그냥 resolve. */
    @PluginMethod
    public void discoverStop(PluginCall call) {
        endScan(scan, "cancelled", false);
        call.resolve();
    }

    private void resolveNext(NsdManager nsd, Scan s) {
        NsdServiceInfo next;
        synchronized (nsdLock) {
            if (s.ended || s.resolving || s.found.full() || s.tries >= 2 * FhNearby.MAX_ITEMS || (next = s.queue.poll()) == null) return;
            s.resolving = true; s.tries++;
        }
        try {
            nsd.resolveService(next, new NsdManager.ResolveListener() {
                @Override public void onResolveFailed(NsdServiceInfo i, int code) { resolved(nsd, s, null); }
                @Override public void onServiceResolved(NsdServiceInfo i) { resolved(nsd, s, i); }
            });
        } catch (RuntimeException x) {
            resolved(nsd, s, null);
        }
    }

    private void resolved(NsdManager nsd, Scan s, NsdServiceInfo i) {
        boolean full;
        synchronized (nsdLock) {
            s.resolving = false;
            if (s.ended) return;
            if (i != null) {
                List<InetAddress> a = Build.VERSION.SDK_INT >= 34 ? i.getHostAddresses() : (i.getHost() == null ? Collections.emptyList() : Collections.singletonList(i.getHost()));
                s.found.add(FhNearby.item(i.getServiceName(), i.getPort(), a, i.getAttributes()));
            }
            full = s.found.full();
        }
        if (full) endScan(s, null, false); else resolveNext(nsd, s);
    }

    /** 탐색 끝내기(한 번만): 타이머 해제·NSD stop·Promise 정리. why 가 있으면(취소·숨김·실패) 모은 것도 버리고 items []. */
    private void endScan(Scan s, String why, boolean destroyed) {
        if (s == null) return;
        synchronized (nsdLock) {
            if (s.ended) return;
            s.ended = true;
            if (scan == s) scan = null;
        }
        if (s.timeout != null) main.removeCallbacks(s.timeout);
        if (s.listener != null) {
            try { ((NsdManager) getContext().getSystemService(Context.NSD_SERVICE)).stopServiceDiscovery(s.listener); } catch (RuntimeException ignored) { /* 시작 실패·이미 멈춤 — stop 할 것 없음 */ }
        }
        if (destroyed) { reject(s.call, new FhGateCore.GateError("stale", "앱 화면이 다시 만들어짐", s.gen)); return; }
        JSArray items = new JSArray();
        if (why == null) for (FhNearby.Item it : s.found.items()) {
            JSObject o = new JSObject();
            o.put("name", it.name); o.put("origin", it.origin); o.put("app", "foothold-gate"); o.put("api", 1);
            items.put(o);
        }
        JSObject r = new JSObject();
        r.put("gen", s.gen); r.put("items", items);
        if (why != null) r.put("why", why);
        s.call.resolve(r);
    }

    /** Wi-Fi·이더넷 망이 하나라도 있나(ACCESS_NETWORK_STATE, 일반 권한). VPN 만 있으면 false — Tailscale 은 LAN 검색 대상 아님. */
    @SuppressWarnings("deprecation")
    private boolean lanUp() {
        ConnectivityManager cm = (ConnectivityManager) getContext().getSystemService(Context.CONNECTIVITY_SERVICE);
        if (cm == null) return false;
        for (Network n : cm.getAllNetworks()) {
            NetworkCapabilities nc = cm.getNetworkCapabilities(n);
            if (nc != null && (nc.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) || nc.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET))) return true;
        }
        return false;
    }

    @PluginMethod
    public void state(PluginCall call) {
        call.resolve(obj(core.state()));
    }

    @PluginMethod
    public void setGate(PluginCall call) {
        try {
            FhGateCore.Ended e = core.setGate(call.getString("origin"));
            if (e.hadSession()) afterEnd(e, "gate");
            JSObject r = obj(core.state());
            r.put("wiped", e.wiped);
            call.resolve(r);
        } catch (FhGateCore.GateError e) {
            reject(call, e);
        }
    }

    @PluginMethod
    public void login(PluginCall call) {
        FhGateCore.Ctx c = core.ctx();                       // 받는 순간 고정 — 큐에서 기다리는 사이 바뀌면 stale
        String user = call.getString("user"), pw = call.getString("pw"), label = call.getString("label");
        run(call, c, () -> {
            FhGateCore.Login l = core.login(c, user, pw, label);
            core.confirm(l, c);                              // 성공 세대가 이미 끝났으면(로그아웃·주소 변경·파괴) 성공 대신 stale
            JSObject r = new JSObject();
            r.put("account", l.account); r.put("device6", l.device6); r.put("exp", l.exp); r.put("gen", l.gen); r.put("stored", l.stored);
            call.resolve(r);
        });
    }

    @PluginMethod
    public void request(PluginCall call) {
        FhGateCore.Ctx c = core.ctx();
        String op = call.getString("op");
        JSObject body = call.getObject("body");
        run(call, c, () -> {
            FhGateCore.Result res = core.request(c, op, body == null ? null : body.toString());
            JSObject r = new JSObject();
            r.put("status", res.resp.status); r.put("body", res.resp.text()); r.put("gen", res.gen);
            done(call, c, r);
        });
    }

    /** 로그인 전 도달·인증서·서버 호환 확인. 인자 없음(지금 관문만), 토큰 안 보냄. resolve ≠ 로그인 성공. */
    @PluginMethod
    public void probe(PluginCall call) {
        FhGateCore.Ctx c = core.ctx();
        run(call, c, () -> {
            FhGateCore.Probe p = core.probe(c);
            JSObject r = new JSObject();
            r.put("status", p.status); r.put("compat", p.api != null); r.put("api", p.api == null ? JSONObject.NULL : p.api); r.put("gen", p.gen);
            done(call, c, r);
        });
    }

    @PluginMethod
    public void photo(PluginCall call) {
        FhGateCore.Ctx c = core.ctx();
        String path = call.getString("path");
        run(call, c, () -> {
            FhGateCore.Result res = core.photo(c, path);
            JSObject r = new JSObject();
            r.put("status", res.resp.status); r.put("gen", res.gen);
            if (res.resp.status == 200) { r.put("mime", "image/jpeg"); r.put("base64", Base64.encodeToString(res.resp.body, Base64.NO_WRAP)); }
            done(call, c, r);
        });
    }

    @PluginMethod
    public void wsTicket(PluginCall call) {
        FhGateCore.Ctx c = core.ctx();
        run(call, c, () -> {
            FhGateCore.Result res = core.wsTicket(c);
            JSObject r = new JSObject();
            r.put("url", res.resp.text()); r.put("gen", res.gen);
            done(call, c, r);
        });
    }

    /** 로컬 폐기는 지금 바로(큐 안 거침), 서버 알림은 뒤에서 한 번 — 결과는 logoutResult 이벤트. ok = 디스크 폐기까지 됐나. */
    @PluginMethod
    public void logout(PluginCall call) {
        FhGateCore.Ended e = core.endLocal();
        afterEnd(e, call.getString("reason", "user"));
        JSObject r = new JSObject();
        r.put("ok", e.wiped); r.put("server", e.hadSession() ? "pending" : "none"); r.put("gen", e.gen);
        call.resolve(r);
    }

    // ── B2 저장: 사용자가 고른 위치(시스템 문서 선택기)에 쓰고, 다 쓰고 닫힌 뒤에만 성공. 경로·URI 는 화면에 돌려주지 않는다 ──
    private FhSave.Pending pendingSave;   // ponytail: 선택기 하나만(두 번째는 busy). 화면 재생성으로 잃으면 stale(gen -1 = 원 문맥 모름)

    @PluginMethod
    public void saveFile(PluginCall call) {
        FhGateCore.Ctx c = core.ctx();                       // 받는 순간 고정 — 결과·오류 gen 은 끝까지 이 문맥
        String name = call.getString("name"), b64 = call.getString("base64");
        byte[] b;
        try {
            FhSave.checkB64Len(b64);
            byte[] raw = null;
            if (b64 != null) {
                try { raw = Base64.decode(b64, Base64.NO_WRAP); } catch (IllegalArgumentException x) { throw new FhGateCore.GateError("bad_input", "base64 형식", -1); }
            }
            b = FhSave.bytes(name, call.getString("text"), raw);
        } catch (FhGateCore.GateError e) {
            reject(call, new FhGateCore.GateError(e.code, e.getMessage(), c.gen()));
            return;
        }
        if (!core.current(c)) { reject(call, new FhGateCore.GateError("stale", "앱 화면이 다시 만들어짐", c.gen())); return; }
        if (pendingSave != null) { reject(call, new FhGateCore.GateError("busy", "저장 창이 이미 열려 있음", c.gen())); return; }
        pendingSave = new FhSave.Pending(b, c);
        Intent i = new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType(FhSave.mime(name)).putExtra(Intent.EXTRA_TITLE, name);
        try {
            startActivityForResult(call, i, "saveDone");
        } catch (RuntimeException x) {                       // 선택기 없음·시작 실패 — 대기 칸을 비우고 Promise 를 고정 코드로 끝낸다
            pendingSave = null;
            reject(call, core.unexpected(c));
        }
    }

    @ActivityCallback
    private void saveDone(PluginCall call, ActivityResult result) {
        FhSave.Pending p = pendingSave;
        pendingSave = null;
        if (call == null) return;
        if (p == null) { reject(call, new FhGateCore.GateError("stale", "앱 화면이 다시 만들어져 저장할 내용을 잃음 — 다시 저장", -1)); return; }
        Uri u = result.getData() == null ? null : result.getData().getData();
        if (result.getResultCode() != Activity.RESULT_OK || u == null) {
            reject(call, new FhGateCore.GateError(core.current(p.c) ? "cancelled" : "stale", "저장 취소", p.c.gen()));
            return;
        }
        try {
            io.execute(() -> {
                try {
                    int n = FhSave.save(core, p, () -> getContext().getContentResolver().openOutputStream(u, "wt"), () -> removePartial(u));
                    JSObject r = new JSObject();
                    r.put("saved", true); r.put("bytes", n); r.put("gen", p.c.gen());   // 위치·URI 는 돌려주지 않음
                    call.resolve(r);                              // 다 쓰고 닫힌 뒤, 문맥 대조 통과 때만
                } catch (FhGateCore.GateError e) {
                    reject(call, e);
                } catch (RuntimeException e) {
                    reject(call, core.unexpected(p.c));
                }
            });
        } catch (RejectedExecutionException x) {
            removePartial(u);                                     // 안 쓴 빈 문서를 남기지 않는다(가능하면)
            reject(call, new FhGateCore.GateError(io.isShutdown() ? "stale" : "busy", io.isShutdown() ? "앱 화면이 다시 만들어짐 — 저장 안 됨" : "요청이 밀림 — 저장 안 됨, 다시 저장", p.c.gen()));
        }
    }

    private void removePartial(Uri u) {
        try { DocumentsContract.deleteDocument(getContext().getContentResolver(), u); } catch (Exception ignored) { /* 지우지 못하면 빈·덜 쓴 파일이 남을 수 있음 — 오류 문구는 «저장 안 됨» 그대로 */ }
    }

    private void afterEnd(FhGateCore.Ended e, String reason) {
        Runnable send = () -> {
            JSObject ev = new JSObject();
            ev.put("server", core.serverLogout(e)); ev.put("reason", reason); ev.put("gen", e.gen);
            notifyListeners("logoutResult", ev);
        };
        try {
            io.execute(send);
        } catch (RejectedExecutionException x) {   // 큐가 찼거나 파괴 중 — 서버 알림 못 함을 그대로 알린다(성공으로 바꾸지 않음)
            JSObject ev = new JSObject();
            ev.put("server", e.hadSession() ? "failed" : "none"); ev.put("reason", reason); ev.put("gen", e.gen);
            notifyListeners("logoutResult", ev);
        }
    }

    /** io 에 제출. 거부·예기치 않은 예외도 Promise 를 남기지 않고 고정 코드로 끝낸다. */
    private void run(PluginCall call, FhGateCore.Ctx c, Job job) {
        try {
            io.execute(() -> {
                try {
                    job.run();
                } catch (FhGateCore.GateError e) {
                    reject(call, e);
                } catch (RuntimeException e) {
                    reject(call, core.unexpected(c));          // 현재 문맥 internal · 옛 문맥 stale
                }
            });
        } catch (RejectedExecutionException e) {
            reject(call, new FhGateCore.GateError(io.isShutdown() ? "stale" : "busy", io.isShutdown() ? "앱 화면이 다시 만들어짐" : "요청이 밀림 — 잠시 뒤", c.gen()));
        }
    }

    /** resolve 직전에도 문맥 대조 — 그 사이 로그아웃·주소 변경·파괴면 stale. */
    private void done(PluginCall call, FhGateCore.Ctx c, JSObject r) {
        if (core.current(c)) call.resolve(r);
        else reject(call, new FhGateCore.GateError("stale", "취소된 호출 — 응답 버림", c.gen()));
    }

    private void reject(PluginCall call, FhGateCore.GateError e) {
        if (e.sessionEnded) {
            // 이 호출의 세션(e.gen)이 401 로 끝났다는 알림. gen 은 사건의 gen 그대로 — 화면은 자기 현재 gen 과 같을 때만 반응
            JSObject ev = new JSObject();
            ev.put("reason", "expired"); ev.put("gen", e.gen);
            notifyListeners("sessionEnded", ev);
        }
        JSObject d = new JSObject();
        d.put("gen", e.gen);
        call.reject(e.getMessage(), e.code, d);
    }

    private static JSObject obj(Map<String, Object> m) {
        JSObject o = new JSObject();
        for (Map.Entry<String, Object> e : m.entrySet()) o.put(e.getKey(), e.getValue());
        return o;
    }

    /** Android Keystore 의 AES-GCM 키(내보낼 수 없음)로 세션 덩어리를 암호화해 SharedPreferences 에 둔다. */
    static final class KeystoreVault implements FhGateCore.Vault {
        private static final String ALIAS = "fhgate.session", PREF = "fhgate", K = "blob";
        private final SharedPreferences sp;

        KeystoreVault(Context c) { sp = c.getSharedPreferences(PREF, Context.MODE_PRIVATE); }

        private SecretKey key() throws Exception {
            KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
            ks.load(null);
            if (ks.containsAlias(ALIAS)) return ((KeyStore.SecretKeyEntry) ks.getEntry(ALIAS, null)).getSecretKey();
            KeyGenerator g = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
            g.init(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).setKeySize(256).build());
            return g.generateKey();
        }

        @Override
        public String load() {
            String b = sp.getString(K, null);
            if (b == null) return null;
            try {
                byte[] all = Base64.decode(b, Base64.NO_WRAP);
                Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
                c.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, all, 0, 12));
                return new String(c.doFinal(all, 12, all.length - 12), StandardCharsets.UTF_8);
            } catch (Exception e) {
                sp.edit().remove(K).commit();   // 못 푸는 보관본(키 분실·변조)은 버리고 로그아웃 상태로
                return null;
            }
        }

        @Override
        public boolean save(String json) {
            try {
                Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
                c.init(Cipher.ENCRYPT_MODE, key());
                byte[] iv = c.getIV(), ct = c.doFinal(json.getBytes(StandardCharsets.UTF_8));
                byte[] all = new byte[iv.length + ct.length];
                System.arraycopy(iv, 0, all, 0, iv.length);
                System.arraycopy(ct, 0, all, iv.length, ct.length);
                return sp.edit().putString(K, Base64.encodeToString(all, Base64.NO_WRAP)).commit();   // commit 결과 = 디스크 반영 여부
            } catch (Exception e) {
                return false;   // 암호화 못 함 — 평문으로 대신 저장하지 않는다. 지우기는 Core 가 clear() 로 따로 시도
            }
        }

        @Override
        public boolean clear() {
            return sp.edit().remove(K).commit();
        }
    }
}
