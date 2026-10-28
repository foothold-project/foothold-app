package org.footholdproject.app;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothManager;
import android.bluetooth.le.BluetoothLeScanner;
import android.bluetooth.le.ScanCallback;
import android.bluetooth.le.ScanRecord;
import android.bluetooth.le.ScanResult;
import android.bluetooth.le.ScanSettings;
import android.content.Context;
import android.content.pm.PackageManager;
import android.location.LocationManager;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.nsd.NsdManager;
import android.net.nsd.NsdServiceInfo;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.function.Consumer;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * 주변 로봇 찾기(10-28, 폰 홈 «+ 로봇 연결하기»): 찾기·표시만 — BLE 연결·쓰기 0, 로봇 설정 변경 0.
 *  - Wi-Fi a) mDNS(NsdManager) _foothold._tcp — 에이전트 광고 계약(GO2-friday): TXT v=1·name·model·agent=ws://<주소>:<포트>/phone/ws·rid(선택)
 *  - Wi-Fi b) Go2 기본 주소(192.168.12.1 = Go2 핫스팟, 192.168.123.161·.18 = 유선/내부망)에 TCP 연결만 해 보고 닫는다(아무것도 안 보냄). 실패는 조용히
 *  - 블루투스: BLE 광고 이름 «Go2_» — 근거 Bin4ry/UniPwn unitree_hack.py:95, jeff-hykin/dim-go2-dash protocol.rs:10(접두 Go2_·G1_·B2_·H1_·X1_, 서비스 0000ffe0)
 * 통로는 MainActivity 의 data-drive 와 같은 방식: 웹이 [data-nearby-scan=<seq>] 를 두면 네이티브가 읽고 찾기, 결과는 evaluateJavascript 로 'fh-nearby' 이벤트.
 * JS → 네이티브 통로(브리지·플러그인)는 여전히 0 — 원격 화면은 네이티브를 부를 수 없고, 표시만 둔다.
 */
final class Nearby {
    static final int REQ = 7301;
    static final String TYPE = "_foothold._tcp.";
    static final String[] GO2_ADDRS = { "192.168.12.1", "192.168.123.161", "192.168.123.18" };
    static final int[] GO2_PORTS = { 9991, 8081, 22 };   // Go2 WebRTC 신호(9991, 옛 8081 — dim-go2-dash robot_rtc.rs:38·40) · 내부 컴퓨터 ssh
    static final int PROBE_MS = 700;
    // ponytail: 10 s 고정 — 현장에서 짧으면 «다시 찾기», 길게 하려면 이 값만
    static final long SCAN_MS = 10_000;

    private final Activity act;
    private final Consumer<String> out;   // JS 한 줄을 화면에 흘린다(메인 스레드)
    private final Handler main = new Handler(Looper.getMainLooper());
    private final Map<String, Map<String, Object>> items = new LinkedHashMap<>();
    private final LinkedHashSet<String> problems = new LinkedHashSet<>();
    private final ArrayDeque<NsdServiceInfo> resolveQ = new ArrayDeque<>();
    private String seq;
    private int gen;
    private boolean scanning, resolving;
    private NsdManager.DiscoveryListener disc;
    private ScanCallback ble;
    private ExecutorService pool;

    Nearby(Activity act, Consumer<String> out) {
        this.act = act;
        this.out = out;
    }

    String seq() {
        return seq;
    }

    void start(String s) {
        stop();
        seq = s;
        gen++;
        items.clear();
        problems.clear();
        scanning = true;
        Network wifi = wifi();
        if (wifi == null) problems.add("wifi-off");
        mdns();
        probe(wifi);
        if (blePermitted()) ble(); else act.requestPermissions(blePerms(), REQ);
        final int g = gen;
        main.postDelayed(() -> { if (g == gen) finish(); }, SCAN_MS);
        emit();
    }

    /** 화면을 떠나거나 앱이 가려지면. 결과는 더 보내지 않는다 */
    void stop() {
        if (seq == null) return;
        finish();
        seq = null;
    }

    void onPermission(boolean granted) {
        if (!scanning) return;
        if (granted) ble(); else problems.add("bt-perm");
        emit();
    }

    private void finish() {
        gen++;
        scanning = false;
        if (disc != null) {
            try { ((NsdManager) act.getSystemService(Context.NSD_SERVICE)).stopServiceDiscovery(disc); } catch (RuntimeException ignored) {}
            disc = null;
        }
        stopBle();
        if (pool != null) { pool.shutdownNow(); pool = null; }
        resolveQ.clear();
        resolving = false;
        emit();
    }

    // ---- Wi-Fi ----

    /** Wi-Fi(또는 유선) 망. Go2 핫스팟은 인터넷이 없어 기본 망이 모바일 데이터일 수 있다 — 기본 주소 확인은 이 망에 묶어서 */
    @SuppressWarnings("deprecation")
    private Network wifi() {
        ConnectivityManager cm = (ConnectivityManager) act.getSystemService(Context.CONNECTIVITY_SERVICE);
        if (cm == null) return null;
        for (Network n : cm.getAllNetworks()) {
            NetworkCapabilities c = cm.getNetworkCapabilities(n);
            if (c != null && (c.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) || c.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET))) return n;
        }
        return null;
    }

    private void mdns() {
        NsdManager nsd = (NsdManager) act.getSystemService(Context.NSD_SERVICE);
        if (nsd == null) return;
        final int g = gen;
        disc = new NsdManager.DiscoveryListener() {
            @Override public void onStartDiscoveryFailed(String t, int code) { main.post(() -> { if (g == gen) { disc = null; problems.add("mdns-fail"); emit(); } }); }
            @Override public void onStopDiscoveryFailed(String t, int code) {}
            @Override public void onDiscoveryStarted(String t) {}
            @Override public void onDiscoveryStopped(String t) {}
            @Override public void onServiceLost(NsdServiceInfo s) {}
            @Override public void onServiceFound(NsdServiceInfo s) {
                main.post(() -> { if (g == gen) { resolveQ.add(s); resolveNext(nsd); } });
            }
        };
        try {
            nsd.discoverServices(TYPE, NsdManager.PROTOCOL_DNS_SD, disc);
        } catch (RuntimeException e) {
            disc = null;
            problems.add("mdns-fail");
        }
    }

    /** 34 미만은 한 번에 하나만 풀 수 있다(FAILURE_ALREADY_ACTIVE) — 줄 세워 하나씩 */
    @SuppressWarnings("deprecation")
    private void resolveNext(NsdManager nsd) {
        if (resolving || resolveQ.isEmpty()) return;
        resolving = true;
        final int g = gen;
        nsd.resolveService(resolveQ.poll(), new NsdManager.ResolveListener() {
            @Override public void onResolveFailed(NsdServiceInfo s, int code) { main.post(() -> next(g, nsd)); }
            @Override public void onServiceResolved(NsdServiceInfo s) {
                InetAddress h = s.getHost();
                String ip = h == null ? null : lan(h.getHostAddress());
                Map<String, String> t = ip == null ? null : txt(s.getAttributes(), ip);
                main.post(() -> {
                    if (g == gen && t != null && s.getPort() > 0) {
                        Map<String, Object> it = new HashMap<>(t);
                        it.put("via", "mdns");
                        it.put("host", ip);
                        it.put("port", s.getPort());
                        if (!it.containsKey("name")) it.put("name", clean(s.getServiceName(), 40));
                        add("mdns:" + ip + ":" + s.getPort(), it);
                    }
                    next(g, nsd);
                });
            }
        });
    }

    private void next(int g, NsdManager nsd) {
        if (g != gen) return;
        resolving = false;
        resolveNext(nsd);
    }

    /** Go2 기본 주소: 연결만 열었다 닫는다. 같은 망(Go2 핫스팟·유선)일 때만 의미가 있다 */
    private void probe(Network wifi) {
        if (wifi == null) return;
        final int g = gen;
        pool = Executors.newFixedThreadPool(GO2_ADDRS.length);
        for (String ip : GO2_ADDRS) {
            pool.execute(() -> {
                for (int port : GO2_PORTS) {
                    if (Thread.currentThread().isInterrupted()) return;
                    try (Socket s = new Socket()) {
                        wifi.bindSocket(s);
                        s.connect(new InetSocketAddress(ip, port), PROBE_MS);
                        Map<String, Object> it = new HashMap<>();
                        it.put("via", "addr");
                        it.put("host", ip);
                        it.put("port", port);
                        it.put("name", "Go2 기본 주소 " + ip);
                        main.post(() -> { if (g == gen) add("addr:" + ip, it); });
                        return;
                    } catch (Exception ignored) {
                        // 조용히 다음 포트
                    }
                }
            });
        }
    }

    // ---- 블루투스 ----

    private static String[] blePerms() {
        return Build.VERSION.SDK_INT >= 31 ? new String[] { Manifest.permission.BLUETOOTH_SCAN } : new String[] { Manifest.permission.ACCESS_FINE_LOCATION };
    }

    private boolean blePermitted() {
        for (String p : blePerms()) if (act.checkSelfPermission(p) != PackageManager.PERMISSION_GRANTED) return false;
        return true;
    }

    @SuppressLint("MissingPermission")
    private void ble() {
        BluetoothManager bm = (BluetoothManager) act.getSystemService(Context.BLUETOOTH_SERVICE);
        BluetoothAdapter a = bm == null ? null : bm.getAdapter();
        if (a == null || !a.isEnabled()) { problems.add("bt-off"); return; }
        if (Build.VERSION.SDK_INT < 31) {   // 11 이하: 위치 서비스가 꺼져 있으면 BLE 결과가 비어 온다
            LocationManager lm = (LocationManager) act.getSystemService(Context.LOCATION_SERVICE);
            if (lm != null && Build.VERSION.SDK_INT >= 28 && !lm.isLocationEnabled()) problems.add("loc-off");
        }
        BluetoothLeScanner sc = a.getBluetoothLeScanner();
        if (sc == null) { problems.add("bt-off"); return; }
        final int g = gen;
        ble = new ScanCallback() {
            @Override public void onScanResult(int type, ScanResult r) {
                ScanRecord rec = r.getScanRecord();
                String name = rec == null ? null : rec.getDeviceName();   // 광고 안의 이름 — BluetoothDevice.getName()(CONNECT 권한) 안 씀
                if (!isGo2(name)) return;
                Map<String, Object> it = new HashMap<>();
                it.put("via", "ble");
                it.put("name", clean(name, 40));
                it.put("rssi", r.getRssi());
                main.post(() -> { if (g == gen) add("ble:" + clean(name, 40), it); });
            }
            @Override public void onScanFailed(int code) { main.post(() -> { if (g == gen) { problems.add("bt-fail"); emit(); } }); }
        };
        try {
            sc.startScan(null, new ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build(), ble);
        } catch (RuntimeException e) {   // SecurityException 포함
            ble = null;
            problems.add("bt-fail");
        }
    }

    @SuppressLint("MissingPermission")
    private void stopBle() {
        if (ble == null) return;
        try {
            BluetoothManager bm = (BluetoothManager) act.getSystemService(Context.BLUETOOTH_SERVICE);
            BluetoothLeScanner sc = bm.getAdapter().getBluetoothLeScanner();
            if (sc != null) sc.stopScan(ble);
        } catch (RuntimeException ignored) {}
        ble = null;
    }

    // ---- 화면으로 ----

    private void add(String key, Map<String, Object> it) {
        if (items.containsKey(key)) return;
        it.put("key", key);
        items.put(key, it);
        emit();
    }

    private void emit() {
        if (seq == null) return;
        try {
            JSONObject o = new JSONObject();
            o.put("seq", seq);
            o.put("scanning", scanning);
            JSONArray a = new JSONArray();
            for (Map<String, Object> it : items.values()) a.put(new JSONObject(it));
            o.put("items", a);
            o.put("problems", new JSONArray(problems));
            out.accept("window.dispatchEvent(new CustomEvent('fh-nearby',{detail:" + o + "}))");   // JSON = JS 식(문자열은 JSONObject 가 이스케이프)
        } catch (Exception ignored) {}
    }

    // ---- 순수 판정(RemoteClientTest 처럼 JVM 단위 시험) ----

    static boolean isGo2(String name) {
        return name != null && name.startsWith("Go2_") && name.length() <= 40;
    }

    /** 사설 IPv4(10/8 · 172.16/12 · 192.168/16) 점 표기면 정규화해서, 아니면 null. 이름 풀이 없음 */
    static String lan(String ip) {
        if (ip == null) return null;
        String[] p = ip.split("\\.", -1);
        if (p.length != 4) return null;
        int[] b = new int[4];
        for (int i = 0; i < 4; i++) {
            if (p[i].isEmpty() || p[i].length() > 3) return null;
            for (char c : p[i].toCharArray()) if (c < '0' || c > '9') return null;
            b[i] = Integer.parseInt(p[i]);
            if (b[i] > 255) return null;
        }
        boolean priv = b[0] == 10 || (b[0] == 172 && b[1] >= 16 && b[1] <= 31) || (b[0] == 192 && b[1] == 168);
        return priv ? b[0] + "." + b[1] + "." + b[2] + "." + b[3] : null;
    }

    /** TXT(계약 v=1) → 화면에 보낼 값. v≠1 이면 null. agent 는 ws://<찾은 주소>:<포트>/… 일 때만 남긴다 */
    static Map<String, String> txt(Map<String, byte[]> attrs, String host) {
        if (attrs == null || !"1".equals(str(attrs.get("v")))) return null;
        Map<String, String> o = new HashMap<>();
        String name = clean(str(attrs.get("name")), 40), model = clean(str(attrs.get("model")), 40), rid = str(attrs.get("rid")), agent = str(attrs.get("agent"));
        if (name != null) o.put("name", name);
        if (model != null) o.put("model", model);
        if (rid != null && rid.matches("[0-9A-Za-z-]{1,64}")) o.put("rid", rid);
        if (agent != null && agentOk(agent, host)) o.put("agent", agent);
        return o;
    }

    static boolean agentOk(String agent, String host) {
        if (agent.length() > 200 || host == null) return false;
        try {
            URI u = new URI(agent);
            return "ws".equals(u.getScheme()) && host.equals(u.getHost()) && u.getRawUserInfo() == null && u.getPort() > 0 && u.getPort() <= 65535;
        } catch (Exception e) {
            return false;
        }
    }

    private static String str(byte[] b) {
        return b == null ? null : new String(b, StandardCharsets.UTF_8);
    }

    /** 제어 문자·방향 바꿈 문자 빼고 max 자로. 비면 null */
    static String clean(String s, int max) {
        if (s == null) return null;
        StringBuilder b = new StringBuilder();
        s.codePoints().filter(c -> !Character.isISOControl(c) && Character.getType(c) != Character.FORMAT).forEach(b::appendCodePoint);
        String t = b.toString().trim();
        if (t.isEmpty()) return null;
        return t.codePointCount(0, t.length()) > max ? t.substring(0, t.offsetByCodePoints(0, max)) : t;
    }
}
