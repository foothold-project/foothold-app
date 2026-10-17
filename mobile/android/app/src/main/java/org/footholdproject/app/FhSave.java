package org.footholdproject.app;

import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.regex.Pattern;
import org.json.JSONException;
import org.json.JSONTokener;

/**
 * B2 saveFile 의 순수 검사·쓰기(안드로이드 의존 없음 — JVM 시험). 계약: mobile/docs/FHGATE-CONTRACT.md §1 saveFile.
 * 이름은 화면이 이미 쓰는 꼴(foothold-v2-<종류>-<ms>.csv|json|jpg) 하나만. 경로·URL·토큰은 받지도 돌려주지도 않는다.
 */
final class FhSave {
    // ponytail: 종류 상관없이 5 MB 한 상한(사진 받기 상한과 같음). 큰 CSV 가 실제로 생기면 종류별로 나눈다
    static final int MAX = 5 * 1024 * 1024;
    static final Pattern NAME = Pattern.compile("^foothold-v2-[a-z]{1,20}-[0-9]{10,16}\\.(csv|json|jpg)$");

    private FhSave() {}

    static String ext(String name) { return name.substring(name.lastIndexOf('.') + 1); }

    static String mime(String name) {
        switch (ext(name)) {
            case "csv": return "text/csv";
            case "json": return "application/json";
            default: return "image/jpeg";
        }
    }

    /** base64 문자열 길이만으로 먼저 상한 확인(큰 문자열을 풀기 전에). */
    static void checkB64Len(String b64) throws FhGateCore.GateError {
        if (b64 != null && b64.length() > (MAX / 3 + 1) * 4) throw new FhGateCore.GateError("too_big", "5 MB 초과", -1);
    }

    /**
     * 저장할 바이트. text 와 raw(base64 를 푼 것) 중 정확히 하나 — jpg 는 raw 만, csv·json 은 둘 다 됨(UI saveBlob 이 base64 하나로 보냄).
     * json 은 값 하나로 끝까지 파싱돼야, jpg 는 JPEG 시작 표지(FF D8 FF)가 있어야 한다.
     */
    static byte[] bytes(String name, String text, byte[] raw) throws FhGateCore.GateError {
        if (name == null || !NAME.matcher(name).matches()) throw bad("파일 이름 형식(foothold-v2-<종류>-<숫자>.csv|json|jpg)");
        boolean jpg = ext(name).equals("jpg");
        if ((text == null) == (raw == null)) throw bad("text·base64 중 정확히 하나");
        if (jpg && raw == null) throw bad("jpg 는 base64 만");
        byte[] b = raw != null ? raw : text.getBytes(StandardCharsets.UTF_8);
        if (b.length == 0) throw bad("빈 파일");
        if (b.length > MAX) throw new FhGateCore.GateError("too_big", "5 MB 초과", -1);
        if (jpg && !(b.length >= 3 && (b[0] & 0xff) == 0xff && (b[1] & 0xff) == 0xd8 && (b[2] & 0xff) == 0xff)) throw bad("JPEG 가 아님");
        if (ext(name).equals("json")) {
            try {
                JSONTokener t = new JSONTokener(new String(b, StandardCharsets.UTF_8));
                Object v = t.nextValue();
                // ponytail: org.json 은 느슨해서(따옴표 없는 글도 받음) 최상위만 객체·배열로 묶는다. 엄격 파서가 필요하면 그때 바꾼다
                if (!(v instanceof org.json.JSONObject || v instanceof org.json.JSONArray)) throw bad("JSON 은 객체·배열만");
                if (t.nextClean() != 0) throw bad("JSON 뒤에 남은 글");
            } catch (JSONException e) {
                throw bad("JSON 형식");
            }
        }
        return b;
    }

    /** 쓰고 닫기까지 끝나야 돌아온다(닫기 실패도 IOException). 돌려준 길이 = 실제로 쓴 바이트 수. */
    static int write(OutputStream os, byte[] b) throws IOException {
        if (os == null) throw new IOException("저장 위치를 열지 못함");
        try {
            os.write(b);
            os.flush();
        } finally {
            os.close();
        }
        return b.length;
    }

    /** 선택기를 여는 순간의 내용 + 호출 문맥(Ctx). 결과·오류 gen 은 언제나 이 c 의 gen — 복귀 때 현재 gen 을 새로 읽지 않는다. */
    static final class Pending {
        final byte[] b; final FhGateCore.Ctx c;
        Pending(byte[] b, FhGateCore.Ctx c) { this.b = b; this.c = c; }
    }

    interface Opener { OutputStream open() throws IOException; }

    /**
     * 선택기 복귀 뒤 io 스레드에서 도는 저장 한 번. 대조 3곳: ① 쓰기 전(문맥 끝 → 안 쓰고 discard·stale) ② 쓰기 실패(discard, 현재 문맥이면 io·옛 문맥이면 stale)
     * ③ 다 쓰고 닫은 뒤(문맥 끝 → **파일은 완성, 지우지 않음**, 응답만 stale). discard = 선택기가 만든 빈·덜 쓴 문서 지우기(최선, 실패해도 그대로).
     * 돌려준 값 = 쓴 바이트 수(결과 gen 은 c.gen). ③ 대조와 resolve 사이 틈은 다른 호출과 같이 남는다.
     */
    static int save(FhGateCore core, Pending p, Opener open, Runnable discard) throws FhGateCore.GateError {
        if (!core.current(p.c)) { discard.run(); throw new FhGateCore.GateError("stale", "취소된 저장 — 쓰지 않음", p.c.gen()); }
        int n;
        try {
            n = write(open.open(), p.b);
        } catch (IOException | RuntimeException x) {
            discard.run();
            throw core.current(p.c) ? new FhGateCore.GateError("io", "파일 쓰기 실패 — 저장 안 됨", p.c.gen()) : new FhGateCore.GateError("stale", "취소된 저장 — 저장 안 됨", p.c.gen());
        }
        if (!core.current(p.c)) throw new FhGateCore.GateError("stale", "파일은 저장됨 — 취소된 호출이라 응답 버림", p.c.gen());
        return n;
    }

    private static FhGateCore.GateError bad(String m) { return new FhGateCore.GateError("bad_input", m, -1); }
}
