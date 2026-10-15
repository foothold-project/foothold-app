import { expect, test, vi } from 'vitest';
// 시작 확인창 자리(10-16 670 d866c6e 기존 P2 «390 확인창이 STOP 덮음 0/5» · root ASK GO): placeAsk = 보이는 STOP(+8) 이 자른 빈 띠 안에만.
// 실측 반례: 670 claude.md(review-d866c6e) 390×844 STOP [153,154,334,206](d866c6e) · [206,196,374,248](cd7e7c5) — 옛 자리 [1,56,389,244] 는 둘 다 덮음.
// 자리 없으면 null(StartAsk 가 기존 answerAsk(false) + 안내로 닫음). 실화면 STOP 첫 클릭·Space·창 취소 송신 0·전체화면은 670 고정판 QA 몫(여기서는 기하만).
Object.assign(globalThis, { localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} }, location: { href: 'http://127.0.0.1/', protocol: 'http:', hash: '', search: '', pathname: '/' } });
vi.spyOn(console, 'error').mockImplementation(() => {});
const { placeAsk } = await import('../../src/app/shell');

type B = { left: number; top: number; right: number; bottom: number };
const B = (left: number, top: number, right: number, bottom: number): B => ({ left, top, right, bottom });
const hit = (a: { left: number; top: number; width: number; maxHeight: number }, s: B, g = 8) =>
  a.left < s.right + g && s.left - g < a.left + a.width && a.top < s.bottom + g && s.top - g < a.top + a.maxHeight;
const N = { h: 188, min: 120, w: 200 };   // 내용 전부 188 · 단추 줄+여백+본문 최소 120 · 단추 줄 최소 폭 200(가정값 — 실측은 StartAsk 가 매 프레임)
// 정상 배치 = 화면 안 · STOP 겹침 0 · 단추 줄까지 들어가는 높이(need.min 이상) · 폭은 단추 줄 이상
const ok = (W: number, H: number, stops: B[], n = N) => {
  const a = placeAsk(W, H, n, stops)!;
  expect(a).not.toBeNull();
  expect(a.width).toBe(Math.min(380, W - 32)); expect(a.width).toBeGreaterThanOrEqual(n.w);
  expect(a.left).toBeGreaterThanOrEqual(8); expect(a.left + a.width).toBeLessThanOrEqual(W - 8);
  expect(a.top).toBeGreaterThanOrEqual(8); expect(a.top + a.maxHeight).toBeLessThanOrEqual(H - 8);
  expect(a.maxHeight).toBeGreaterThanOrEqual(n.min);
  for (const s of stops) expect(hit(a, s)).toBe(false);
  return a;
};
const OLD = { left: 1, top: 56, width: 388, maxHeight: 188 };   // 670 실측 옛 확인창 [1,56,389,244]

test('390×844: 실측 STOP 두 자리(d866c6e·cd7e7c5) — 옛 자리는 덮고 새 자리는 겹침 0 · 내용 전부', () => {
  for (const s of [B(153, 154, 334, 206), B(206, 196, 374, 248)]) {
    expect(hit(OLD, s, 0)).toBe(true);
    expect(ok(390, 844, [s]).maxHeight).toBeGreaterThanOrEqual(N.h);
  }
});

test('390×560 · 844×390 · 1440×900: 들어가면 머리줄 아래 56 가운데', () => {
  expect(ok(390, 560, [B(153, 154, 334, 206)]).maxHeight).toBeGreaterThanOrEqual(N.h);
  const l = ok(844, 390, [B(692, 8, 828, 60), B(700, 300, 836, 382)]); expect([l.top, l.left]).toEqual([56, 232]);
  const d = ok(1440, 900, [B(1270, 12, 1420, 64)]); expect([d.top, d.left]).toEqual([56, 530]);
});

test('공간 부족: 필수 높이 이상인 가장 넓은 띠에 줄여서(본문만 안 스크롤) · 40~필수 높이 띠뿐이면 null', () => {
  const s = [B(16, 100, 374, 152)];   // 390×300: 위 띠 [8,92]=84 · 아래 띠 [160,292]=132
  const a = ok(390, 300, s); expect([a.top, a.maxHeight]).toEqual([160, 132]); expect(a.maxHeight).toBeLessThan(N.h);
  expect(placeAsk(390, 300, { ...N, min: 140 }, s)).toBeNull();   // 두 띠 다 40 이상이지만 필수 140 미만 → 자리 없음(옛 MIN 40 팝오버 규칙이면 열렸을 것)
  expect(placeAsk(390, 300, { ...N, min: 85 }, s)).not.toBeNull();
});

test('null: 아주 작은 창(높이·폭) · 단추 줄이 폭에 안 들어감 · STOP 이 띠를 다 자름', () => {
  expect(placeAsk(390, 120, N, [])).toBeNull();                 // H−16 < 필수 높이
  expect(placeAsk(200, 844, N, [])).toBeNull();                 // 폭 168 < 단추 줄 200
  expect(placeAsk(390, 844, { ...N, w: 360 }, [])).toBeNull();   // 폭 358 이어도 단추 줄이 넘치면 자리 아님
  expect(placeAsk(390, 300, N, [B(16, 60, 374, 120), B(16, 180, 374, 240)])).toBeNull();   // 띠 [8,52]·[128,172]·[248,292] 전부 < 120
});

test('STOP 여러 개(머리줄 + 확대 STOP) · 화면 밖 STOP 무시 · 가로로 안 걸치는 STOP 은 세로를 안 자름', () => {
  ok(390, 844, [B(153, 154, 334, 206), B(16, 700, 374, 828)]);
  ok(390, 844, [B(153, 154, 334, 206), B(-500, -500, -400, -400), B(0, 2000, 390, 2100)]);
  expect(ok(1440, 900, [B(1300, 40, 1420, 400)]).top).toBe(56);
});

test('크기·회전·전체화면 변화: 옛 좌표 자리는 새 STOP 을 덮을 수 있어 다시 계산해야 함', () => {
  const before = ok(844, 390, [B(692, 8, 828, 60)]);            // 가로: STOP 오른쪽 위
  const sNew = B(16, 40, 374, 120);                              // 세로로 돌린 뒤 확대 STOP 이 위쪽 전체 폭
  expect(hit({ ...before, left: (390 - 358) / 2, width: 358 }, sNew)).toBe(true);
  expect(ok(390, 844, [sNew]).top).toBeGreaterThanOrEqual(128);
});

test('StartAsk 첫 그림(SSR): 내용·단추 순서·초점 대상·z 60 그대로 · 본문만 스크롤 칸 · 단추 줄 고정 · 바깥 스크롤 0', async () => {
  const React = await import('react'), { renderToStaticMarkup } = await import('react-dom/server');
  const { StartAsk } = await import('../../src/app/shell'), { useAsk, START_ASK } = await import('../../src/data/link');
  const put = (x: { text: string | null; ok?: string }) => { useAsk.setState(x); Object.assign(useAsk.getInitialState(), x); };   // SSR 은 zustand 초기 상태를 읽음
  put({ text: START_ASK, ok: undefined });
  const s = renderToStaticMarkup(React.createElement(StartAsk)).replace(/&quot;/g, '"');
  put({ text: null });
  const text = s.replace(/<style>[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, '\n').split('\n').map((t) => t.trim()).filter(Boolean);
  expect(text).toEqual([...START_ASK.split('\n'), '취소', '조종 시작']);   // 글·순서 = 옛 확인창과 같음
  expect(s).toMatch(/^<div role="alertdialog" aria-modal="false" aria-labelledby="fh-ask-h" data-start-ask="1" style="position:fixed;z-index:60;box-sizing:border-box;left:50%;top:56px;transform:translateX\(-50%\)/);   // 첫 그림 = 옛 자리(그리기 전 layout effect 가 옮김)
  expect(s).toContain('display:flex;flex-direction:column;overflow:hidden');
  expect(s).toMatch(/<div data-ask-body="1" style="flex:1 1 auto;min-height:0;overflow-y:auto"><div id="fh-ask-h"/);
  expect(s).toMatch(/<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:10px;flex:none"><button type="button" style="[^"]*">취소<\/button><button type="button" style="[^"]*" data-ask-ok="1">조종 시작<\/button><\/div>/);
});
