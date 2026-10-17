package org.footholdproject.app;

import android.net.http.SslError;
import android.webkit.SslErrorHandler;
import android.webkit.WebView;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebViewClient;
import java.net.URI;

/**
 * 인증서(SSL) 오류 처리만 더한 Capacitor 기본 WebViewClient (@capacitor/android 8.5.2 BridgeWebViewClient 상속).
 *
 * 8.5.2 BridgeWebViewClient 는 onReceivedSslError 를 오버라이드하지 않는다 → WebViewClient 기본(취소)만 하고
 * errorPath 도 부르지 않는다(onReceivedError 는 SSL 거부에 오지 않음 — 10-13 4회차 logcat: net_error -202 뒤 오류 화면 없음).
 * 그래서 신뢰 못 하는 관문에서 앱이 빈/브라우저 오류 화면에 머문다. 여기서는:
 *  - 모든 SSL 오류는 handler.cancel() — proceed 는 어떤 경우에도 하지 않는다(인증서 오류 무시 없음).
 *  - 그 오류가 관문(server.url) origin 이면 → 관문을 신뢰할 수 없다 → 로컬 errorPath(보기 전용 연결 오류 안내)로.
 *    SslError 에는 isForMainFrame 이 없다(WebResourceRequest 를 받지 않는 콜백). 그래서 프레임이 아니라 origin 으로 가른다:
 *    관문 origin = 메인 문서·같은 출처 하위 요청 모두 관문 인증서 → 화면 전체를 안내로 바꿔 상호작용을 끊는 쪽이 안전.
 *    다른 origin 의 하위 리소스 = 취소만(기본 동작 그대로, 화면 이동 없음).
 *  - 이미 안내 화면이면 다시 부르지 않는다(재진입 루프 방지). 안내 화면은 https://localhost 로컬이라 SSL 이 없다.
 *  - bundled 기본 빌드(server.url 없음) = 취소만 → 지금까지와 같은 동작.
 * 나머지(shouldInterceptRequest·브리지·생명주기·onReceivedError/HttpError 의 errorPath)는 부모를 그대로 쓴다.
 */
public class GateSslClient extends BridgeWebViewClient {
    private final Bridge bridge;

    public GateSslClient(Bridge bridge) {
        super(bridge);
        this.bridge = bridge;
    }

    @Override
    public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
        handler.cancel();                                            // 절대 proceed 없음
        String errorUrl = bridge.getErrorUrl();
        if (errorUrl == null || !sameOrigin(error.getUrl(), bridge.getServerUrl())) return;
        String cur = view.getUrl();
        if (cur != null && cur.startsWith(errorUrl)) return;         // 이미 안내 화면
        view.loadUrl(errorUrl);
    }

    /** scheme·host·port(기본 포트 채움)가 같으면 true. 어느 쪽이든 null·파싱 실패면 false. */
    static boolean sameOrigin(String a, String b) {
        if (a == null || b == null) return false;
        try {
            URI x = new URI(a), y = new URI(b);
            return x.getScheme() != null && x.getHost() != null
                && x.getScheme().equalsIgnoreCase(y.getScheme()) && x.getHost().equalsIgnoreCase(y.getHost())
                && port(x) == port(y);
        } catch (Exception e) {
            return false;
        }
    }

    private static int port(URI u) {
        return u.getPort() != -1 ? u.getPort() : ("https".equalsIgnoreCase(u.getScheme()) ? 443 : "http".equalsIgnoreCase(u.getScheme()) ? 80 : -1);
    }
}
