package org.footholdproject.app;

import android.net.Uri;
import android.net.http.SslError;
import android.webkit.SslErrorHandler;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebViewClient;
import java.net.URI;

/**
 * 원격 주소 방식(1.1.0-dev): 앱 안 시작 화면(https://localhost)에서 고른 서버 origin 의 웹 화면을 같은 WebView 로 연다.
 *
 * 허용 목록을 capacitor.config 의 server.allowNavigation 에 두지 않고 여기서 막는 이유(@capacitor/android 8.5.2 소스 확인):
 *  - allowNavigation 항목은 Bridge.setAllowedOriginRules 로 플러그인 브리지(androidBridge, WebMessageListener) 허용 origin 이 된다
 *    → *.trycloudflare.com(누구나 만들 수 있는 주소) 화면이 플러그인을 부를 수 있게 된다.
 *  - 같은 항목이 WebViewLocalServer authorities 가 되어 그 origin 요청을 로컬 서버가 가로채 JS 를 끼워 넣는다.
 *  config 를 비워 두면 브리지는 https://localhost 에만 붙고, 원격 요청은 WebView 가 그대로 받는다(쿠키·Origin 도 브라우저와 같음).
 *
 * 허용(메인·하위 프레임 이동): 앱 자신(시작 화면) · 시작 화면에서 처음 연 https origin(chosen) · *.trycloudflare.com. 그 밖은 막는다(바깥 앱도 안 띄움).
 * 인증서 오류: 늘 cancel(무시 단추·proceed 없음). 서버 화면이 안 열리면(인증서·망 오류) 시작 화면으로 돌아가 이유만 보인다 — 뒤로가기를 막아 둬서 갇히지 않게.
 */
public class RemoteClient extends BridgeWebViewClient {
    private final Bridge bridge;
    private volatile String chosen;   // 시작 화면에서 고른 서버 origin(scheme://host[:port]) — 시작 화면으로 돌아오면 비운다

    public RemoteClient(Bridge bridge) {
        super(bridge);
        this.bridge = bridge;
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
        if (request.isForMainFrame() && (cur == null || isLocal(cur))) {   // 시작 화면 → 서버: 그 origin 을 고른 것으로
            String o = origin(url);
            if (o == null) return true;
            chosen = o;
            return false;
        }
        return !allowed(url, chosen);
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

    private boolean isLocal(String url) {
        Uri u = Uri.parse(url);
        return bridge.getScheme().equals(u.getScheme()) && bridge.getHost().equalsIgnoreCase(u.getHost());
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

    /** 원격 화면에서 갈 수 있는 곳: 고른 origin 그대로, 또는 https://*.trycloudflare.com(기본 포트) */
    static boolean allowed(String url, String chosen) {
        String o = origin(url);
        if (o == null) return false;
        if (o.equals(chosen)) return true;
        String h = o.substring("https://".length());
        return h.endsWith(".trycloudflare.com") && h.indexOf(':') < 0;
    }
}
