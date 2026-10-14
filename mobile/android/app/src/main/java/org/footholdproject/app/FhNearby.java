package org.footholdproject.app;

import java.io.ByteArrayOutputStream;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 주변 관문 검색(계약 D′, mobile/docs/FHGATE-CONTRACT.md) — NSD 결과 한 건을 «후보»로 바꿀지 판정하는 순수 Java 부분.
 * 후보 = 미검증 목록일 뿐: 여기서 연결·로그인·저장·probe 를 하지 않는다. 인증서 SAN 대조는 사용자가 고른 뒤 probe 가 한다.
 */
final class FhNearby {
    static final String TYPE = "_foothold-gate._tcp";   // 도메인 local
    static final int MAX_ITEMS = 16, NAME_MAX = 64, MIN_MS = 1000, MAX_MS = 8000, DEF_MS = 5000;

    private FhNearby() {}

    static final class Item {
        final String name, origin;
        Item(String name, String origin) { this.name = name; this.origin = origin; }
    }

    static int clampMs(Integer ms) {
        return ms == null ? DEF_MS : Math.max(MIN_MS, Math.min(MAX_MS, ms));
    }

    /** null = 버림. 주소는 사설 IPv4(10/8·172.16/12·192.168/16)만, 포트는 SRV 값, TXT 는 app·api 만 보고 그 밖 키는 무시. */
    static Item item(String rawName, int port, List<InetAddress> addrs, Map<String, byte[]> txt) {
        if (txt == null || !"foothold-gate".equals(str(txt.get("app"))) || !"1".equals(str(txt.get("api")))) return null;
        if (port < 1 || port > 65535 || addrs == null) return null;
        for (InetAddress a : addrs) {
            if (!privateV4(a)) continue;
            try {
                // 기존 관문 주소 규칙을 그대로 통과해야 후보 — 443 은 생략(gateOrigin 은 «:443» 표기를 거부)
                return new Item(name(rawName), FhGateCore.gateOrigin("https://" + a.getHostAddress() + (port == 443 ? "" : ":" + port)));
            } catch (FhGateCore.GateError e) {
                return null;
            }
        }
        return null;
    }

    /** 사설 대역 유니캐스트 IPv4 만. 루프백·0·멀티캐스트·169.254·브로드캐스트·공인·CGNAT(100.64/10, Tailscale)·IPv6 는 전부 밖. */
    static boolean privateV4(InetAddress a) {
        if (!(a instanceof Inet4Address)) return false;
        byte[] b = a.getAddress();
        int o0 = b[0] & 0xff, o1 = b[1] & 0xff;   // 서브넷 브로드캐스트는 접두 길이를 몰라 못 거름 — 그런 광고는 probe 실패로 드러남
        return o0 == 10 || (o0 == 172 && o1 >= 16 && o1 <= 31) || (o0 == 192 && o1 == 168);
    }

    /** DNS-SD 이름 표시용: \DDD·\x 이스케이프 해석(일부 Android 판이 그대로 돌려줌) → 제어·서식 문자(방향 바꾸기 포함) 제거 → 64 자. */
    static String name(String raw) {
        if (raw == null) return "";
        ByteArrayOutputStream o = new ByteArrayOutputStream();
        for (int i = 0; i < raw.length(); ) {
            char ch = raw.charAt(i);
            if (ch == '\\' && isDigit3(raw, i + 1)) {
                int v = Integer.parseInt(raw.substring(i + 1, i + 4));
                if (v <= 255) { o.write(v); i += 4; continue; }
            }
            if (ch == '\\' && i + 1 < raw.length()) { ch = raw.charAt(++i); }
            int cp = Character.codePointAt(raw, i);
            byte[] u = new String(Character.toChars(cp)).getBytes(StandardCharsets.UTF_8);
            o.write(u, 0, u.length);
            i += Character.charCount(cp);
        }
        String s = new String(o.toByteArray(), StandardCharsets.UTF_8);
        StringBuilder out = new StringBuilder();
        int n = 0;
        for (int i = 0; i < s.length() && n < NAME_MAX; ) {
            int cp = s.codePointAt(i);
            int t = Character.getType(cp);
            if (!Character.isISOControl(cp) && t != Character.FORMAT && t != Character.LINE_SEPARATOR && t != Character.PARAGRAPH_SEPARATOR) { out.appendCodePoint(cp); n++; }
            i += Character.charCount(cp);
        }
        return out.toString().trim();
    }

    private static boolean isDigit3(String s, int i) {
        return i + 3 <= s.length() && Character.isDigit(s.charAt(i)) && Character.isDigit(s.charAt(i + 1)) && Character.isDigit(s.charAt(i + 2))
                && s.charAt(i) < 128 && s.charAt(i + 1) < 128 && s.charAt(i + 2) < 128;
    }

    private static String str(byte[] v) {
        return v == null ? null : new String(v, StandardCharsets.UTF_8);
    }

    /** 한 번의 탐색 결과: 같은 origin 은 처음 것만, 최대 16. */
    static final class Scan {
        private final Map<String, Item> by = new LinkedHashMap<>();
        boolean add(Item it) {
            if (it == null || full() || by.containsKey(it.origin)) return false;
            by.put(it.origin, it);
            return true;
        }
        boolean full() { return by.size() >= MAX_ITEMS; }
        List<Item> items() { return new ArrayList<>(by.values()); }
    }
}
