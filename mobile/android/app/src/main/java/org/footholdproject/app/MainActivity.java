package org.footholdproject.app;

import android.content.pm.ActivityInfo;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.WindowManager;
import androidx.activity.OnBackPressedCallback;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.BridgeActivity;

/**
 * 1.2.0-dev 원격 주소 방식 껍데기 + 앱 안 오프라인 시뮬(www/sim, 시작 화면과 같은 앱 출처): 자체 플러그인 등록 0, JS 브리지 0(RemoteClient). 어느 화면도 네이티브를 부를 수 없고, 네이티브가 화면을 읽기만 한다.
 *  - 화면 꺼짐 방지(KEEP_SCREEN_ON) · 상태줄·내비 막대 숨김(immersive, 스와이프로 잠깐 표시) — 노치 여백은 Capacitor SystemBars 기본(css) 처리 그대로
 *  - 뒤로가기 무시: 조종 화면(#/drive/<id>)이 WebView 기록 뒤로로 나가지 않게. 끝내기는 화면 단추로
 *  - 조종 화면만 가로 고정: 웹 루트의 data-drive 표시를 evaluateJavascript 로 읽는다(브리지·플러그인 없이 — 원격 화면은 네이티브를 부를 수 없음).
 *    원격 조종 화면(#/drive)과 앱 안 시뮬 화면(sim/index.html 의 html[data-drive]) 둘 다
 */
public class MainActivity extends BridgeActivity {
    private static final long DRIVE_POLL_MS = 500;
    private static final String DRIVE_JS = "document.querySelector('[data-drive]')!==null";
    private final Handler main = new Handler(Looper.getMainLooper());
    private boolean drive;

    // ponytail: 0.5 s 마다 읽기(조종 화면 들어간 뒤 최대 0.5 s 늦게 가로) — 더 빨라야 하면 웹이 title 등을 바꾸고 WebChromeClient 로 받기
    private final Runnable poll = new Runnable() {
        @Override
        public void run() {
            bridge.getWebView().evaluateJavascript(DRIVE_JS, (r) -> setDrive("true".equals(r)));
            main.postDelayed(this, DRIVE_POLL_MS);
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        bridge.setWebViewClient(new RemoteClient(bridge));   // Bridge.setWebViewClient — 8.5.2 공개 API. 나머지 동작은 BridgeWebViewClient 그대로
        // JS → 네이티브 통로(androidBridge·Cookies·Http)는 RemoteClient 생성자에서 전부 뗀다 — 시작 화면·원격 화면 모두 플러그인 호출 0
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

    @Override
    public void onPause() {
        main.removeCallbacks(poll);
        super.onPause();
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
