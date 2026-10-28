package org.footholdproject.app;

import android.content.pm.ActivityInfo;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.WindowManager;
import androidx.activity.OnBackPressedCallback;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.BridgeActivity;
import org.json.JSONArray;
import org.json.JSONException;

/**
 * 1.2.0-dev 원격 주소 방식 껍데기 + 앱 안 오프라인 시뮬(www/sim, 시작 화면과 같은 앱 출처): 자체 플러그인 등록 0, JS 브리지 0(RemoteClient). 어느 화면도 네이티브를 부를 수 없고, 네이티브가 화면을 읽기만 한다(주변 찾기 결과만 이벤트로 넣는다).
 *  - 화면 꺼짐 방지(KEEP_SCREEN_ON) · 상태줄·내비 막대 숨김(immersive, 스와이프로 잠깐 표시) — 노치 여백은 Capacitor SystemBars 기본(css) 처리 그대로
 *  - 뒤로가기 무시: 조종 화면(#/drive/<id>)이 WebView 기록 뒤로로 나가지 않게. 끝내기는 화면 단추로
 *  - 조종 화면만 가로 고정: 웹 루트의 data-drive 표시를 evaluateJavascript 로 읽는다(브리지·플러그인 없이 — 원격 화면은 네이티브를 부를 수 없음).
 *    원격 조종 화면(#/drive)과 앱 안 시뮬 화면(sim/index.html 의 html[data-drive]) 둘 다
 *  - 주변 로봇 찾기(10-28, Nearby): 같은 읽기로 [data-nearby-scan=<seq>] 를 보고 찾기 시작·멈춤, 결과는 evaluateJavascript 로 'fh-nearby' 이벤트
 *  - Go2 상태 전용(10-28, Go2Status): 같은 읽기로 window.fhGo2Status={seq,url,code} 를 보고 1 s 읽기 시작·멈춤, 결과는 'fh-go2' 이벤트
 */
public class MainActivity extends BridgeActivity {
    private static final long DRIVE_POLL_MS = 500;
    private static final String POLL_JS = "(function(){var n=document.querySelector('[data-nearby-scan]'),g=window.fhGo2Status;"
        + "return [document.querySelector('[data-drive]')!==null,n?n.getAttribute('data-nearby-scan'):null,g?[String(g.seq),String(g.url),String(g.code)]:null]})()";
    private final Handler main = new Handler(Looper.getMainLooper());
    private boolean drive;
    private Nearby nearby;
    private Go2Status go2;

    // ponytail: 0.5 s 마다 읽기(조종 화면 들어간 뒤 최대 0.5 s 늦게 가로) — 더 빨라야 하면 웹이 title 등을 바꾸고 WebChromeClient 로 받기
    private final Runnable poll = new Runnable() {
        @Override
        public void run() {
            bridge.getWebView().evaluateJavascript(POLL_JS, MainActivity.this::polled);
            main.postDelayed(this, DRIVE_POLL_MS);
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        bridge.setWebViewClient(new RemoteClient(bridge));   // Bridge.setWebViewClient — 8.5.2 공개 API. 나머지 동작은 BridgeWebViewClient 그대로
        // JS → 네이티브 통로(androidBridge·Cookies·Http)는 RemoteClient 생성자에서 전부 뗀다 — 시작 화면·원격 화면 모두 플러그인 호출 0
        nearby = new Nearby(this, (js) -> bridge.getWebView().evaluateJavascript(js, null));
        go2 = new Go2Status(this, (js) -> bridge.getWebView().evaluateJavascript(js, null));
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        // 나중에 더한 콜백이 먼저 불린다 — @capacitor/app 의 뒤로가기(WebView goBack)보다 앞
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {}
        });
    }

    @Override
    public void onResume() {
        super.onResume();
        immersive();
        main.post(poll);
    }

    // 찾기는 onPause 에서 멈추지 않는다 — 권한 창도 onPause 를 부르고, 멈췄다 다시 시작하면 거부 때 창이 되풀이된다. 10 s 뒤 스스로 끝남
    @Override
    public void onPause() {
        main.removeCallbacks(poll);
        go2.stop();   // 가려지면 상태 읽기도 멈춤 — 돌아오면 읽기가 다시 시작
        super.onPause();
    }

    @Override
    public void onDestroy() {
        nearby.stop();
        go2.stop();
        super.onDestroy();
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] perms, int[] res) {
        super.onRequestPermissionsResult(code, perms, res);
        if (code != Nearby.REQ) return;
        boolean ok = res.length > 0;
        for (int r : res) ok &= r == PackageManager.PERMISSION_GRANTED;
        nearby.onPermission(ok);
    }

    /** 0.5 s 읽기 결과 [조종 화면?, 찾기 seq|null, 상태 전용 [seq,url,code]|null] */
    private void polled(String r) {
        try {
            JSONArray a = new JSONArray(r);
            setDrive(a.optBoolean(0));
            String s = a.isNull(1) ? null : a.optString(1);
            if (s == null) nearby.stop();
            else if (!s.equals(nearby.seq())) nearby.start(s);
            JSONArray g = a.optJSONArray(2);
            if (g == null) go2.stop();
            else {
                String k = g.optString(0) + "\n" + g.optString(1) + "\n" + g.optString(2);
                if (!k.equals(go2.key())) go2.start(k, g.optString(0), g.optString(1), g.optString(2));
            }
        } catch (JSONException e) {
            setDrive(false);
        }
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) immersive();
    }

    private void immersive() {
        WindowInsetsControllerCompat c = WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        c.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
        c.hide(WindowInsetsCompat.Type.systemBars());
    }

    private void setDrive(boolean on) {
        if (on == drive) return;
        drive = on;
        setRequestedOrientation(on ? ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE : ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED);
    }
}
