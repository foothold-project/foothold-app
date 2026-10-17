import { afterAll, beforeAll, expect, test, vi } from 'vitest';
// SLAM-1(root 결정 A · 2026-10-16): 새 UI 의 시뮬 시작 = MapStartBox.openMapAsk 하나 → map_start(mode slam · map_version 없음) 1회.
// 확인은 페이지 안 StartAsk(askPage) 재사용 — native confirm 0. 결속(연결 세대·대상·시작 가능·사용 범위·카메라·화면)이 바뀌면 취소, 송신 직전 한 번 더 대조.
// 가짜 WebSocket/문서(link.test 와 같은 틀)로 node 에서 helper 직접 호출 — 실제 상자·메뉴 장착 반례는 ui_slam1_mount, 화면 배치·실제 STOP 접근은 670 화면 QA 몫
// r2(715 R1·R2): 양식·요청 수명 · true 뒤 송신 전 무효 · 원장 · 보냄/안 보냄 구분. r3(715 P2-1): sent = ask 호출(시도) · 미송신 반례 · max 단독. 이 사본은 미실행
vi.mock('../../src/data/shared', () => ({ refreshShared: () => {} }));
const sent: any[] = [], evs: Record<string, ((...a: any[]) => void)[]> = {};
let sock: any;
class FakeWS { readyState = 0; binaryType = ''; onopen: any; onmessage: any; onclose: any; constructor() { sock = this; } send(t: string) { sent.push(JSON.parse(t)); } }
const on = (k: string, f: any) => { (evs[k] ||= []).push(f); };
const off = (k: string, f: any) => { evs[k] = (evs[k] || []).filter((g) => g !== f); };
(globalThis as any).window = globalThis;
Object.assign(globalThis, {
  WebSocket: FakeWS, location: { href: 'http://127.0.0.1:5181/', protocol: 'http:', hash: '#/Main' }, addEventListener: on, removeEventListener: off,
  document: { hidden: false, addEventListener: on, removeEventListener: off, querySelectorAll: () => [] }, screen: { orientation: { addEventListener: on } },
});
const MS = (o: any = {}) => ({ ok: true, why: '', busy: false, ledger: null, session: null, last: null, usage_scope: 'user_experience', follow_cam_ok: true, ...o });
const ST = (o: any = {}) => ({ op: 'status', ver: 'v1', role: 'view', latch: true, resume_pending: false, reset_pending: false, sim_block: '시뮬 상태 미수신', episode: 1, state_age: 0.1, cam_age: null,
  docs_rev: 1, applied: [0, 0, 0], events: [], reason: '', me: 'pc', holder: null, stop_gen: 1, sim_start: { ok: true, why: '', busy: false, session: null }, map_start: MS(), sim: null, ...o });
let L: typeof import('../../src/data/link'), B: typeof import('../../src/map/MapStartBox');
const msg = (o: any) => sock.onmessage({ data: JSON.stringify(o) });
const starts = () => sent.filter((m) => m.op === 'map_start' || m.op === 'sim_start');
const SEL = { w: 'v5_building', f: 'l2', fc: false, label: '2층 건물 · 2층' };
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'performance'] });
  vi.advanceTimersByTime(10);
  L = await import('../../src/data/link'); B = await import('../../src/map/MapStartBox'); L.startLink();
  for (let i = 0; i < 10 && !sock; i++) await Promise.resolve();
  sock.readyState = 1; sock.onopen(); msg(ST());
});
afterAll(() => { vi.useRealTimers(); });

test('확인 1회 = map_start 1회 · mode slam · map_version 없음 · 고른 지형·층·카메라 그대로 · 수락 ≠ 켜짐', async () => {
  const n = sent.length, asked: string[] = [];
  const p = B.openMapAsk(SEL, {}, null, (t) => { asked.push(t); return true; });
  await flush();
  const q = starts(); expect(q.length).toBe(1);
  expect(q[0]).toMatchObject({ op: 'map_start', world_id: 'v5_building', floor_id: 'l2', mode: 'slam', follow_cam: false });
  expect('map_version' in q[0]).toBe(false);
  expect(asked[0]).toMatch(/^시뮬을 실행할까요\?/); expect(asked[0]).toContain('2층 건물 · 2층'); expect(asked[0]).toContain('STOP 잠금 상태로 시작');
  expect(asked[0]).toContain('기존 지도 이어 만들기는 아직 지원하지 않음'); expect(asked[0]).not.toMatch(/조종권을 받|STOP 잠금을 풉/);   // 조종 시작과 섞지 않음
  msg({ op: 'reply', rid: q[0].rid, ok: true, text: '지도 체험 시작 요청함(v5_building/l2 slam) — 준비되면 지도·영상이 들어옵니다' });
  expect(await p).toMatchObject({ ok: true, sent: true }); expect(sent.slice(n).filter((m) => m.op === 'take' || m.op === 'resume').length).toBe(0);   // 자동 take/resume 0
  sent.length = 0;
});

test('취소 = 보낸 것 0 · null(조용히)', async () => {
  expect(await B.openMapAsk(SEL, {}, null, () => false)).toBe(null); expect(starts().length).toBe(0);
});

test('실제 페이지 안 확인창(askPage): STOP 누르면 창 닫힘 → 보낸 것 0(중단 이유 글) · 확인 단추 글 = «시뮬 시작»', async () => {
  const own = {}, p = B.openMapAsk(SEL, own);
  expect(L.useAsk.getState().text).toMatch(/^시뮬을 실행할까요/); expect(L.useAsk.getState().ok).toBe(B.MAP_ASK_OK);
  L.sendStop();                                         // sendStop → cancelStart → answerAsk(false)
  expect(L.useAsk.getState().text).toBe(null);
  expect(await p).toMatchObject({ ok: false, sent: false, text: expect.stringMatching(/STOP·숨김·이탈.*보낸 것 0/) }); expect(starts().length).toBe(0); expect(sent.some((m) => m.op === 'stop')).toBe(true);   // r2: startGen 이 바뀜 → 이유 글
  sent.length = 0; msg(ST());
});

test('열린 동안 서버 시작 가능이 거짓으로 바뀌면(다른 기기 시작 등) 그 창만 닫고 보낸 것 0', async () => {
  const own = {}, p = B.openMapAsk(SEL, own);
  msg(ST({ map_start: MS({ ok: false, why: 'Gazebo 가 이미 켜짐 — 끈 뒤 다시(세계 변경 = 끄고 새로 시작)' }) }));
  expect(L.useAsk.getState().text).toBe(null);
  const r = await p; expect(r!.ok).toBe(false); expect(r!.text).toMatch(/시작 불가로 바뀜 · Gazebo 가 이미 켜짐.*보낸 것 0/);
  expect(starts().length).toBe(0); msg(ST());
});

test('열린 동안 사용 범위·카메라 지원·연결 대상이 바뀌면 취소(옛 조건으로 송신 0)', async () => {
  for (const [st, re] of [[ST({ map_start: MS({ usage_scope: 'experiment', ledger: { used: 0, max: 3, keys: [] } }) }), /사용 범위 바뀜/], [ST({ map_start: MS({ follow_cam_ok: false }) }), /카메라 지원 바뀜/]] as const) {
    const p = B.openMapAsk({ ...SEL, fc: true }, {});
    msg(st); expect(L.useAsk.getState().text).toBe(null);
    expect((await p)!.text).toMatch(re); expect(starts().length).toBe(0); msg(ST());
  }
  const p = B.openMapAsk(SEL, {});
  L.setProvider('go2_direct'); expect(L.useAsk.getState().text).toBe(null);
  expect((await p)!.text).toMatch(/(연결·대상 바뀜|화면)/); expect(starts().length).toBe(0);
  L.setProvider('simulation_gate'); sock.readyState = 1; sock.onopen?.(); msg(ST()); sent.length = 0;
});

test('화면 이동(hashchange)·새 확인창·양식 고른 값 변경(mapFormChanged) = 취소 · 다른 주인 창·다른 양식은 안 닫음', async () => {
  let p = B.openMapAsk(SEL, {});
  (globalThis as any).location.hash = '#/MDrive'; (evs.hashchange || []).forEach((f) => f());
  expect((await p)!.text).toMatch(/화면 바뀜/); (globalThis as any).location.hash = '#/Main';
  p = B.openMapAsk(SEL, {});
  const other = L.askPage('다른 확인', undefined, {});   // 새 확인창이 열리면 앞 창은 false
  expect(await p).toBe(null); L.answerAsk(false); await other;
  const own = {}, F = { id: B.mapFormOpen(), cur: () => SEL }; p = B.openMapAsk(SEL, own, null, undefined, F);
  expect(L.dropAsk({})).toBe(false); expect(B.mapFormChanged(F.id + 99)).toBe(false); expect(L.useAsk.getState().text).not.toBe(null);   // 다른 주인·다른 양식 → 그대로
  expect(B.mapFormChanged(F.id)).toBe(true); expect((await p)!.text).toMatch(/고른 지형·층·카메라 바뀜.*보낸 것 0/);   // MapStartBox 단추 onClick·[w, f, fcOn] 효과 경로
  expect(starts().length).toBe(0);
});

test('송신 직전 대조: 확인을 누를 때 상태가 1 s 넘게 안 왔으면 보낸 것 0', async () => {
  const r = await B.openMapAsk(SEL, {}, null, () => { vi.advanceTimersByTime(1500); return true; });
  expect(r!.text).toMatch(/링크 끊김·상태 미확인.*보낸 것 0/); expect(starts().length).toBe(0); msg(ST());
});

test('반복 누름: 응답 전 두 번째 시작은 보낸 것 0 · 외부 카메라 미지원이면 확인창도 안 엶 · 실기 대상 0', async () => {
  const p1 = B.openMapAsk(SEL, {}, null, () => true); await flush();
  expect((await B.openMapAsk(SEL, {}, null, () => true))!.text).toMatch(/응답을 기다리는 중/);
  expect(starts().length).toBe(1);
  msg({ op: 'reply', rid: starts()[0].rid, ok: false, text: '방금 요청함 — 100 s 뒤 다시' });
  expect(await p1).toMatchObject({ ok: false, text: '방금 요청함 — 100 s 뒤 다시' });   // 거부 원문 보존 · 자동 재시도 0
  await flush(); expect(starts().length).toBe(1); sent.length = 0;
  msg(ST({ map_start: MS({ follow_cam_ok: undefined }) })); let opened = false;
  expect((await B.openMapAsk({ ...SEL, fc: true }, {}, null, () => { opened = true; return true; }))!.text).toMatch(/외부 3인칭 카메라/); expect(opened).toBe(false);
  msg(ST({ map_start: MS({ ok: false, why: '로그인한 기기에서만(관문 경유)' }) }));
  expect((await B.openMapAsk(SEL, {}, null, () => { opened = true; return true; }))!.text).toMatch(/로그인한 기기에서만/); expect(opened).toBe(false);
  expect(starts().length).toBe(0); msg(ST());
});

test('소스: 새 UI 시작 경로에 평지 sim_start·static 실행·native confirm 0', () => {
  const fsm = 'node:fs';
  return import(/* @vite-ignore */ fsm).then(({ readFileSync }) => {
    const rd = (p: string) => readFileSync(new URL(`../../src/${p}`, import.meta.url), 'utf8') as string;
    const box = rd('map/MapStartBox.tsx'), stt = rd('app/status.tsx'), md = rd('screens/MDrive.tsx'), lk = rd('data/link.ts');
    for (const s of [box, stt, md, lk]) { expect(s).not.toMatch(/startSimAsk\(/); expect(s).not.toMatch(/ask\('sim_start'/); }
    expect(box).not.toMatch(/confirm\(/); expect(box).not.toMatch(/mode: 'static'|map_version: ver|aria-label="여는 방식"|aria-label="저장 지도 버전"/);
    expect(box).toMatch(/ask\('map_start', \{ world_id: sel\.w, floor_id: sel\.f, mode: 'slam', follow_cam: sel\.fc \}\)/);
    expect(box).toMatch(/useEffect\(chg, \[w, f, fcOn\]\);/); expect(box).toMatch(/useEffect\(\(\) => \{ if \(part !== 'save'\) form\.current = mapFormOpen\(\); \}, \[\]\);/);
    for (const h of ['onChange={(e) => { chg(); const next = e.target.value as W;', 'onClick={() => { chg(); setF(k); }}', 'onChange={(e) => { chg(); setFc(e.target.checked); }}']) expect(box).toContain(h);   // 선택 변경은 렌더 전 동기 무효
    expect(lk).toMatch(/export const startGen = \(\) => startTok;/); expect(lk.match(/startTok\+\+|\+\+startTok/g)!.length).toBe(2);   // 읽기만 추가 · 올리는 곳 그대로(cancelStart·startDrive)
    expect(md).not.toMatch(/'시뮬 시작\(30분\)'/); expect(stt).not.toMatch(/'시뮬 시작\(30분\)'/);
  });
});

// ── r2 추가 반례(helper) ──
test('true 로 답한 뒤 송신 전 무효(같은 틱): 양식 기록·양식 고른 값·STOP·숨김·새 양식 → 보낸 것 0', async () => {
  let cur = SEL;
  const cases: [string, (F: { id: number }) => void, RegExp][] = [
    ['기록', (F) => { B.mapFormChanged(F.id); }, /고른 지형·층·카메라 바뀜/],
    ['렌더 전 고른 값', () => { cur = { ...SEL, f: 'l1' }; }, /고른 지형·층·카메라 바뀜/],
    ['STOP', () => { L.sendStop(); }, /STOP·숨김·이탈/],
    ['숨김', () => { L.hide(); }, /STOP·숨김·이탈/],
    ['새 양식(메뉴 다시 열기)', () => { B.mapFormOpen(); }, /새 시작 양식이 열림/],
  ];
  for (const [, act, re] of cases) {
    cur = SEL; msg(ST()); sent.length = 0;
    const F = { id: B.mapFormOpen(), cur: () => cur };
    const r = await B.openMapAsk(SEL, {}, null, () => { act(F); return true; }, F);
    expect(r).toMatchObject({ ok: false, sent: false }); expect(r!.text).toMatch(re); expect(r!.text).toMatch(/보낸 것 0/); expect(starts().length).toBe(0);
  }
  msg(ST()); sent.length = 0;
});

test('옛 요청 callback: 새 요청이 열리면 앞 요청은 나중에 true 여도 보낸 것 0', async () => {
  let release!: (v: boolean) => void;
  const p1 = B.openMapAsk(SEL, {}, null, () => new Promise<boolean>((r) => { release = r; }));
  const p2 = B.openMapAsk(SEL, {}, null, () => false);
  expect(await p2).toBe(null);
  release(true);
  expect((await p1)!.text).toMatch(/새 시작 확인이 열림.*보낸 것 0/); expect(starts().length).toBe(0);
});

test('원장: 열린 동안 used/max 변화·이 지형·층 사용됨 = 취소 · 사용함이면 확인창 안 엶 · 사용 범위 미확인 글 구분', async () => {
  const LG = { used: 0, max: 3, keys: [] as string[] };
  msg(ST({ map_start: MS({ usage_scope: 'experiment', ledger: LG }) }));
  let r = await B.openMapAsk(SEL, {}, null, () => { msg(ST({ map_start: MS({ usage_scope: 'experiment', ledger: { ...LG, used: 1 } }) })); return true; });
  expect(r!.text).toMatch(/지도 원장 바뀜.*보낸 것 0/);
  msg(ST({ map_start: MS({ usage_scope: 'experiment', ledger: LG }) }));
  r = await B.openMapAsk(SEL, {}, null, () => { msg(ST({ map_start: MS({ usage_scope: 'experiment', ledger: { ...LG, max: 4 } }) })); return true; });   // r3: max 단독 변화
  expect(r!.text).toMatch(/지도 원장 바뀜.*보낸 것 0/); expect(starts().length).toBe(0);
  msg(ST({ map_start: MS({ usage_scope: 'experiment', ledger: LG }) }));
  r = await B.openMapAsk(SEL, {}, null, () => { msg(ST({ map_start: MS({ usage_scope: 'experiment', ledger: { ...LG, keys: ['v5_building/l2'] } }) })); return true; });
  expect(r!.text).toMatch(/(지도 원장 바뀜|이 지형·층 원장 사용됨).*보낸 것 0/);
  msg(ST({ map_start: MS({ usage_scope: 'experiment', ledger: { ...LG, keys: ['v5_building/l2'] } }) })); let opened = false;
  expect((await B.openMapAsk(SEL, {}, null, () => { opened = true; return true; }))!.text).toMatch(/원장 사용함 — 보낸 것 0/); expect(opened).toBe(false);
  const asked: string[] = [];
  msg(ST({ map_start: MS({ usage_scope: null, ledger: null }) }));
  await B.openMapAsk(SEL, {}, null, (t) => { asked.push(t); return false; });
  msg(ST({ map_start: MS({ usage_scope: 'experiment', ledger: null }) }));
  await B.openMapAsk(SEL, {}, null, (t) => { asked.push(t); return false; });
  expect(asked[0]).toContain('사용 범위 미확인(서버가 안 알림)'); expect(asked[0]).not.toContain('사용자 체험');
  expect(asked[1]).toContain('지도 원장 1회 사용 (원장 미확인)');
  expect(starts().length).toBe(0); msg(ST());
});

test('보낸 뒤: 시간 초과 = sent 참 · 켜짐/꺼짐 단정 0 · 그 사이 STOP 도 «보낸 것 0» 으로 안 바뀜', async () => {
  const p = B.openMapAsk(SEL, {}, null, () => true); await flush();
  expect(starts().length).toBe(1);
  L.sendStop(); vi.advanceTimersByTime(5000);
  const r = await p;
  expect(r).toMatchObject({ ok: false, sent: true }); expect(r!.text).toMatch(/서버 응답 없음/); expect(r!.text).not.toMatch(/보낸 것 0|안 켜짐/);
  sent.length = 0; msg(ST());
});

test('r3 P2-1: 링크가 닫히는 중(readyState 3 · close 이벤트 전) = ask 호출(sent 참)이지만 실제 WS 송신 0 · 결과 글에 «보냄» 단정 0', async () => {
  sock.readyState = 3;                                  // onclose 안 부름 → 상태 쪽 open·신선도는 그대로(why 통과)
  const r = await B.openMapAsk(SEL, {}, null, () => true);
  expect(r).toMatchObject({ ok: false, sent: true, text: '링크 끊김 — 보내지 못함' });   // 반환 = ask 호출함(호환) · 원문 = 미송신
  expect(starts().length).toBe(0);                      // 실제 WS send 0(FakeWS.send 기록 없음)
  const line = B.reqLine(r!);                           // 결과 글(화면 kv 와 같은 함수)
  expect(line).toContain('보내지 못함'); expect(line).toMatch(/^요청 처리 결과 · 수락 안 됨·결과 미확인/);
  expect(line.replace('보내지 못함', '')).not.toMatch(/보냄/); expect(line).not.toMatch(/안 켜짐/);
  expect(B.reqLine({ ok: false, text: '시작 확인 취소 · x — 보낸 것 0', sent: false })).toMatch(/^안 보냄 · /);
  expect(B.reqLine({ ok: true, text: 'x', sent: true })).toMatch(/^요청 수락\(아직 켜진 것 아님/);
  sock.readyState = 1; sent.length = 0; msg(ST());
});
