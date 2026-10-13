package org.footholdproject.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * JS ↔ FhGateCore 연결(얇게). 계약: mobile/docs/FHGATE-CONTRACT.md
 * 세션 토큰은 어떤 resolve·reject·이벤트에도 넣지 않는다. 로그도 찍지 않는다.
 */
@CapacitorPlugin(name = "FhGate")
public class FhGatePlugin extends Plugin {
    static final String APP_ORIGIN = "https://localhost";   // Capacitor Android bundled 화면 출처(androidScheme https 기본)

    private FhGateCore core;
    // ponytail: 2 스레드 고정 — 느린 요청 하나가 로그아웃·표 발급을 막지 않게. 동시 요청이 많아지면 늘린다
    private final ExecutorService io = Executors.newFixedThreadPool(2);

    @Override
    public void load() {
        core = new FhGateCore(new FhGateCore.HttpsTransport(), new KeystoreVault(getContext()), APP_ORIGIN, System.currentTimeMillis() / 1000.0);
    }

    @Override
    protected void handleOnDestroy() {
        io.shutdown();
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
            call.resolve(obj(core.state()));
        } catch (FhGateCore.GateError e) {
            call.reject(e.getMessage(), e.code);
        }
    }

    @PluginMethod
    public void login(PluginCall call) {
        String user = call.getString("user"), pw = call.getString("pw"), label = call.getString("label");
        io.execute(() -> {
            try {
                FhGateCore.Login l = core.login(user, pw, label);
                JSObject r = new JSObject();
                r.put("account", l.account); r.put("device6", l.device6); r.put("exp", l.exp); r.put("gen", l.gen);
                call.resolve(r);
            } catch (FhGateCore.GateError e) {
                call.reject(e.getMessage(), e.code);
            }
        });
    }

    @PluginMethod
    public void request(PluginCall call) {
        String op = call.getString("op");
        JSObject body = call.getObject("body");
        io.execute(() -> {
            try {
                FhGateCore.Result res = core.request(op, body == null ? null : body.toString());
                JSObject r = new JSObject();
                r.put("status", res.resp.status); r.put("body", res.resp.text()); r.put("gen", res.gen);
                call.resolve(r);
            } catch (FhGateCore.GateError e) {
                fail(call, e);
            }
        });
    }

    @PluginMethod
    public void photo(PluginCall call) {
        String path = call.getString("path");
        io.execute(() -> {
            try {
                FhGateCore.Result res = core.photo(path);
                JSObject r = new JSObject();
                r.put("status", res.resp.status); r.put("gen", res.gen);
                if (res.resp.status == 200) { r.put("mime", "image/jpeg"); r.put("base64", Base64.encodeToString(res.resp.body, Base64.NO_WRAP)); }
                call.resolve(r);
            } catch (FhGateCore.GateError e) {
                fail(call, e);
            }
        });
    }

    @PluginMethod
    public void wsTicket(PluginCall call) {
        io.execute(() -> {
            try {
                FhGateCore.Result res = core.wsTicket();
                JSObject r = new JSObject();
                r.put("url", res.resp.text()); r.put("gen", res.gen);
                call.resolve(r);
            } catch (FhGateCore.GateError e) {
                fail(call, e);
            }
        });
    }

    /** 로컬 폐기는 지금 바로, 서버 알림은 뒤에서 한 번 — 결과는 logoutResult 이벤트. */
    @PluginMethod
    public void logout(PluginCall call) {
        FhGateCore.Ended e = core.endLocal();
        afterEnd(e, call.getString("reason", "user"));
        JSObject r = new JSObject();
        r.put("ok", true); r.put("server", e.hadSession() ? "pending" : "none"); r.put("gen", e.gen);
        call.resolve(r);
    }

    private void afterEnd(FhGateCore.Ended e, String reason) {
        io.execute(() -> {
            JSObject ev = new JSObject();
            ev.put("server", core.serverLogout(e)); ev.put("reason", reason); ev.put("gen", e.gen);
            notifyListeners("logoutResult", ev);
        });
    }

    private void fail(PluginCall call, FhGateCore.GateError e) {
        if (e.code.equals("auth")) {          // 서버가 세션 끝을 알림 → core 가 이미 로컬 폐기·gen+1
            JSObject ev = new JSObject();
            ev.put("reason", "expired"); ev.put("gen", core.gen());
            notifyListeners("sessionEnded", ev);
        }
        call.reject(e.getMessage(), e.code);
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
        public void save(String json) {
            try {
                Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
                c.init(Cipher.ENCRYPT_MODE, key());
                byte[] iv = c.getIV(), ct = c.doFinal(json.getBytes(StandardCharsets.UTF_8));
                byte[] all = new byte[iv.length + ct.length];
                System.arraycopy(iv, 0, all, 0, iv.length);
                System.arraycopy(ct, 0, all, iv.length, ct.length);
                sp.edit().putString(K, Base64.encodeToString(all, Base64.NO_WRAP)).commit();
            } catch (Exception e) {
                sp.edit().remove(K).commit();   // 암호화 못 하면 평문 저장 대신 아무것도 안 남긴다(재실행 때 다시 로그인)
            }
        }
    }
}
