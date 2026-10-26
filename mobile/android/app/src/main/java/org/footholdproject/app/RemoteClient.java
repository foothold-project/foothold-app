package org.footholdproject.app;

import android.net.Uri;
import android.net.http.SslError;
import android.webkit.SslErrorHandler;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.widget.Toast;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebViewClient;
import java.io.ByteArrayInputStream;
import java.net.URI;

/**
 * 원격 주소 방식(1.1.0-dev): 앱 안 시작 화면(https://localhost)에서 고른 서버 origin 의 웹 화면을 같은 WebView 로 연다.
 *
 * 허용 목록을 capacitor.config 의 server.allowNavigation 에 두지 않고 여기서 막는 이유(@capacitor/android 8.5.2 소스 확인):
 *  - allowNavigation 항목은 Bridge.setAllowedOriginRules 로 플러그인 브리지 허용 origin 이 되고,
 *  - 같은 항목이 WebViewLocalServer authorities 가 되어 그 origin 요청을 로컬 서버가 가로채 JS 를 끼워 넣는다.
 *
 * 네이티브 통로: 자체 플러그인 0, 시작 화면도 플러그인을 쓰지 않는다 → JS 가 네이티브를 부르는 통로(JS_OBJECTS)를 생성자에서 전부 뗀다.
 *  androidBridge 는 WebMessageListener 로 붙든 fallback(addJavascriptInterface, origin 검사 없음)으로 붙든 둘 다 뗀다.
 *  뗀 것은 다음 문서부터 적용 — 첫 문서는 시작 화면(우리 코드)이고 원격 화면은 늘 그 뒤에 열린다.
 *  RemoteClientTest 가 @capacitor 소스의 addJavascriptInterface·addWebMessageListener 이름을 모아 JS_OBJECTS 와 대조한다.
 *
 * 허용(메인·하위 프레임 이동·리다이렉트·하위 요청 모두 같은 판정 = origin 정확 일치): 시작 화면 origin · 시작 화면에서 연 https origin(chosen).
 * 그 밖은 막는다 — 바깥 앱·외부 브라우저도 안 띄우고 짧은 안내만.
 * 인증서 오류: 늘 cancel(무시 단추·proceed 없음). 서버 화면이 안 열리면(인증서·망 오류) 시작 화면으로 돌아가 이유만 보인다 — 뒤로가기를 막아 둬서 갇히지 않게.
 */
public class RemoteClient extends BridgeWebViewClient {
    static final String[] JS_OBJECTS = { "androidBridge", "CapacitorCookiesAndroidInterface", "CapacitorHttpAndroidInterface" };
    private final Bridge bridge;
    private final String local;       // 시작 화면 origin(https://localhost)
    private volatile String chosen;   // 시작 화면에서 고른 서버 origin(scheme://host[:port]) — 시작 화면으로 돌아오면 비운다

    public RemoteClient(Bridge bridge) {
        super(bridge);
        this.bridge = bridge;
        this.local = origin(bridge.getLocalUrl());
        WebView w = bridge.getWebView();
        boolean wml = WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER);
        for (String n : JS_OBJECTS) {
            w.removeJavascriptInterface(n);
            if (wml) WebViewCompat.removeWebMessageListener(w, n);   // 없는 이름이면 아무 일 없음
        }
    }

    /** 지금 원격(서버) 화면이면 그 origin, 아니면 null */
    String remote(WebView view) {
        String cur = view.getUrl();
        return cur != null && chosen != null && !isLocal(cur) ? chosen : null;
    }

    @Override
    public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
        String url = request.getUrl().toString();
        if (isLocal(url)) return super.shouldOverrideUrlLoading(view, request);
        String cur = view.getUrl();
        // 시작 화면 → 서버: 그 origin 을 고른 것으로. 리다이렉트는 고르기가 아니다(입력한 서버가 다른 origin 으로 보내면 막힘)
        if (request.isForMainFrame() && !request.isRedirect() && (cur == null || isLocal(cur))) {
            String o = origin(url);
            if (o == null) return true;
            chosen = o;
            return false;
        }
        if (allowed(url, chosen)) return false;
        if (request.isForMainFrame()) Toast.makeText(view.getContext(), "입력한 서버 밖 주소는 이 앱에서 열지 않습니다", Toast.LENGTH_SHORT).show();
        return true;
    }

    /** iframe·POST 이동·하위 요청까지: shouldOverrideUrlLoading 이 안 불리는 길도 여기서 막는다(바깥 http(s) 요청 → 빈 403) */
    @Override
    public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
        String url = request.getUrl().toString(), s = request.getUrl().getScheme();
        if (("https".equalsIgnoreCase(s) || "http".equalsIgnoreCase(s)) && !isLocal(url) && !allowed(url, chosen)) {
            if (request.isForMainFrame()) view.post(() -> back(view, "out"));   // 빈 문서에 갇히지 않게
            return new WebResourceResponse("text/plain", "utf-8", 403, "Forbidden", null, new ByteArrayInputStream(new byte[0]));
        }
        return super.shouldInterceptRequest(view, request);
    }

    @Override
    public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
        super.onPageStarted(view, url, favicon);
        if (isLocal(url)) chosen = null;
    }

    @Override
    public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
        handler.cancel();   // 절대 proceed 없음
        String o = origin(error.getUrl());
        if (o != null && o.equals(chosen)) back(view, "tls");   // 서버 자체 인증서 문제 → 화면 전체를 끊는다. 다른 origin 하위 요청은 취소만
    }

    @Override
    public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
        super.onReceivedError(view, request, error);
        if (request.isForMainFrame() && !isLocal(request.getUrl().toString())) back(view, "net");
    }

    private void back(WebView view, String why) {
        chosen = null;
        view.loadUrl(bridge.getLocalUrl() + "/?e=" + why);
    }

    /** 시작 화면 origin 과 정확히 같을 때만(다른 포트·사용자정보·평문은 아님) */
    private boolean isLocal(String url) {
        return allowed(url, local);
    }

    /** https·사용자정보 없음·호스트 있음이면 scheme://host[:port](소문자, 기본 포트 생략), 아니면 null */
    static String origin(String url) {
        if (url == null) return null;
        try {
            URI u = new URI(url);
            if (!"https".equalsIgnoreCase(u.getScheme()) || u.getHost() == null || u.getRawUserInfo() != null) return null;
            int p = u.getPort();
            return "https://" + u.getHost().toLowerCase(java.util.Locale.ROOT) + (p == -1 || p == 443 ? "" : ":" + p);
        } catch (Exception e) {
            return null;
        }
    }

    /** url 의 origin 이 o 와 정확히 같으면 true(스킴·호스트·포트). 와일드카드 없음 */
    static boolean allowed(String url, String o) {
        return o != null && o.equals(origin(url));
    }
}
