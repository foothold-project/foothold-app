package org.footholdproject.app;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import org.junit.Test;

public class FhSaveTest {
    static final byte[] JPG = {(byte) 0xff, (byte) 0xd8, (byte) 0xff, (byte) 0xe0, 1, 2};

    static String code(String name, String text, byte[] raw) {
        try { FhSave.bytes(name, text, raw); } catch (FhGateCore.GateError e) { return e.code; }
        return "ok";
    }

    @Test public void fixedNamesOnly() {
        for (String n : new String[]{"foothold-v2-history-1791872905957.csv", "foothold-v2-zones-1791872905957.json"})
            assertEquals(n, "ok", code(n, n.endsWith("json") ? "[]" : "a,b\n", null));
        assertEquals("ok", code("foothold-v2-photo-1791872905957.jpg", null, JPG));
        for (String n : new String[]{null, "", "a.csv", "../foothold-v2-history-1791872905957.csv", "/sdcard/foothold-v2-history-1791872905957.csv",
                "foothold-v2-history-1791872905957.CSV", "foothold-v2-history-1791872905957.csv.exe", "foothold-v2-history-1791872905957.png",
                "foothold-v2-History-1791872905957.csv", "foothold-v2-history-17.csv", "https://x/foothold-v2-history-1791872905957.csv", "foothold-v2-history-1791872905957.csv\n"})
            assertEquals(String.valueOf(n), "bad_input", code(n, "a", null));
    }

    @Test public void kindMustMatchField() {
        assertEquals("ok", code("foothold-v2-history-1791872905957.csv", null, "a,b\n".getBytes(StandardCharsets.UTF_8)));   // csv 를 base64 로(UI saveBlob)
        assertEquals("ok", code("foothold-v2-zones-1791872905957.json", null, "[1]".getBytes(StandardCharsets.UTF_8)));
        assertEquals("bad_input", code("foothold-v2-zones-1791872905957.json", null, "nope".getBytes(StandardCharsets.UTF_8)));   // base64 로 와도 JSON 검사
        assertEquals("bad_input", code("foothold-v2-zones-1791872905957.json", null, new byte[0]));
        assertEquals("bad_input", code("foothold-v2-photo-1791872905957.jpg", "x", null));          // jpg 에 글
        assertEquals("bad_input", code("foothold-v2-history-1791872905957.csv", "a", JPG));         // 둘 다
        assertEquals("bad_input", code("foothold-v2-history-1791872905957.csv", null, null));       // 둘 다 없음
        assertEquals("bad_input", code("foothold-v2-history-1791872905957.csv", "", null));         // 빈 파일
        assertEquals("bad_input", code("foothold-v2-photo-1791872905957.jpg", null, new byte[]{1, 2, 3}));   // JPEG 아님
    }

    @Test public void jsonMustParseToTheEnd() {
        String n = "foothold-v2-state-1791872905957.json";
        assertEquals("ok", code(n, "{\"a\": [1, 2]}\n", null));
        for (String bad : new String[]{"{", "{} x", "nope", "[1,]x", "   "}) assertEquals(bad, "bad_input", code(n, bad, null));
    }

    @Test public void sizeCap() throws Exception {
        String n = "foothold-v2-history-1791872905957.csv";
        char[] big = new char[FhSave.MAX];
        java.util.Arrays.fill(big, 'a');
        assertEquals("ok", code(n, new String(big), null));                                           // 정확히 상한
        assertEquals("too_big", code(n, new String(big) + "a", null));
        assertEquals("too_big", code(n, new String(big, 0, FhSave.MAX / 2) + "가".repeat(FhSave.MAX / 4), null));   // 글자 수가 아니라 UTF-8 바이트로 셈
        FhSave.checkB64Len("A".repeat((FhSave.MAX / 3 + 1) * 4));
        try { FhSave.checkB64Len("A".repeat((FhSave.MAX / 3 + 1) * 4 + 1)); fail(); } catch (FhGateCore.GateError e) { assertEquals("too_big", e.code); }
    }

    @Test public void writeSucceedsOnlyAfterClose() throws Exception {
        byte[] b = "a,b\n".getBytes(StandardCharsets.UTF_8);
        boolean[] closed = {false};
        ByteArrayOutputStream sink = new ByteArrayOutputStream() { @Override public void close() { closed[0] = true; } };
        assertEquals(b.length, FhSave.write(sink, b));
        assertTrue(closed[0]); assertArrayEquals(b, sink.toByteArray());
        for (int k = 0; k < 3; k++) {                                     // 쓰기·비우기·닫기 어디서 실패해도 성공 아님
            final int at = k;
            OutputStream bad = new OutputStream() {
                @Override public void write(int x) throws IOException { if (at == 0) throw new IOException("disk"); }
                @Override public void flush() throws IOException { if (at == 1) throw new IOException("flush"); }
                @Override public void close() throws IOException { if (at == 2) throw new IOException("close"); }
            };
            try { FhSave.write(bad, b); fail("실패 기대 " + k); } catch (IOException expected) { assertFalse(expected.getMessage().isEmpty()); }
        }
        try { FhSave.write(null, b); fail(); } catch (IOException expected) { /* 위치 못 엶 */ }
    }
}
