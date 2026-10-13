package org.footholdproject.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // SSL 오류 안내만 더한 클라이언트로 교체(Bridge.setWebViewClient — 8.5.2 공개 API). 나머지 동작은 BridgeWebViewClient 그대로
        bridge.setWebViewClient(new GateSslClient(bridge));
    }
}
