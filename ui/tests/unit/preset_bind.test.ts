// 프리셋 1단계(10-15): 좌표 출처 = 찍은/가져온 시점 결속 · Run 출처 보존 · 시작 정책(불일치 차단 · 미확인은 기록만) · 옛 계획/옛 앱 호환
import { beforeEach, expect, test, vi } from 'vitest';
import type { DocWrite, MapSrc, Mission, Run } from '@contracts';
const mem = new Map<string, string>();
(globalThis as any).localStorage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) };
const { addPlan, gtHere, planMap, rekey, runHere, startPolicy, startRun, wkey } = await import('../../src/data/run');
const { useLink } = await import('../../src/data/link');
const { qc, docsNow } = await import('../../src/data/shared');
const G = await import('../../src/data/geom');
// F4 개정: 연결 건물 = 검증된 기하 파일 sha(g:), 단층 = world 원본 SDF sha(w:)
const SW = 'a'.repeat(64), SW2 = 'b'.repeat(64), GS = 'c'.repeat(64), SS = 'd'.repeat(64);
const GEO = { building_id: 'v5', label: '', sdf_sha256: { l1: SW, l2: SW2 }, floors: [], boxes: [], meshes: [], connectors: [] } as any;
const ID = { world_src_sha256: SW, spawn_floor: 'l1', geom: { schema: 'v2_building_geom/1', sha256: GS }, epoch: 3 };
let geoCalls = 0, geoRes: (() => void)[] = [];
const flush = () => new Promise((r) => setTimeout(r, 0));

const W1 = [{ x: 1, y: 2, name: 'a', mods: [] }, { x: -3.5, y: 4, name: 'b', mods: [] }] as Mission['wps'];
const L1: MapSrc = { src: 'gt', world_id: 'v5_building', floor_id: 'l1', key: wkey(W1), rid: `g:${GS}` };
const mi = (o: Partial<Mission> = {}): Mission => ({ name: '계획', tmpl: 'base', memo: '', wps: structuredClone(W1), ...o });
// 링크 상태: 신선한 status + live_map(연결 건물이면 floor 판정)
const live = (lv: Record<string, unknown> | null, fresh = true) => useLink.setState({ open: true, lastMsg: fresh ? performance.now() : performance.now() - 5000, provider: 'simulation_gate', st: { live_map: lv, applied: [0, 0, 0] } as any });
const onL = (cur: string | null, state = 'on_floor', world = 'v5_building') => live({ st: 'ok', bound: true, world_id: world, floor_id: 'l1', floor: { rev: 1, state, current: cur, reason: '' }, ...ID });
const single = (o: object = {}) => live({ st: 'ok', bound: true, world_id: 'v5_single', floor_id: 'f1', world_src_sha256: SS, spawn_floor: 'f1', ...o });
// 기하 받기 대역: 즉시(기본) 또는 손으로 풀기(hold) — 늦은 응답 시험용
const geoNow = (sha = GS, g = GEO) => { G.ridDeps.get = async () => { geoCalls++; return { g, sha }; }; };
const geoHold = (sha = GS) => { G.ridDeps.get = () => { geoCalls++; return new Promise((res) => geoRes.push(() => res({ g: GEO, sha }))); }; };
beforeEach(async () => { mem.clear(); G.ridReset(); geoCalls = 0; geoRes = []; geoNow(); onL('l1'); gtHere(); await flush(); });

test('지금 지도: 연결 건물은 on_floor current 만 · transit/unknown·끊김·미수신은 이유', () => {
  expect(gtHere().map).toMatchObject({ world_id: 'v5_building', floor_id: 'l1' });
  onL('l2'); expect(gtHere().map?.floor_id).toBe('l2');                       // 시작층(floor_id l1)이 아니라 서버 현재층
  onL(null, 'transit'); expect(gtHere().why).toBe('층 이동 중');
  onL(null, 'unknown'); expect(gtHere().why).toBe('현재층 미확인');
  live({ st: 'ok', bound: true, world_id: 'rooms_a', floor_id: 'f1', world_src_sha256: SS, spawn_floor: 'f1' }); expect(gtHere().map).toMatchObject({ world_id: 'rooms_a', floor_id: 'f1', rid: `w:${SS}` });   // 단층: floor 판정 없음
  live({ st: 'stale', bound: true, world_id: 'rooms_a', floor_id: 'f1' }); expect(gtHere().why).toBe('지도 미수신');
  live(null); expect(gtHere().why).toBe('지도 미수신');
  expect(startPolicy(mi({ map: L1 }), gtHere()).line).toBe('지도 미확인 · 기록만 — 지금 지도 미수신 (거리·지도 겹치기 표시 안 함)');   // «지금 지금» 0
  onL('l1'); live({ st: 'ok', bound: true, world_id: 'v5_building', floor_id: 'l1', floor: { state: 'on_floor', current: 'l1' } }, false); expect(gtHere().why).toBe('연결 끊김');
});

// F2: 서버가 결속 불가로 내린 상태(reset·bad·bound false)는 GT 확정 0 — 격자만 아직인 wait(bound true)는 확정
test('F2 결속 불가 = 미확인 · 격자 대기 wait+bound 는 확정', () => {
  const B = { world_id: 'v5_building', floor_id: 'l1', floor: { rev: 1, state: 'on_floor', current: 'l1', reason: '' }, ...ID };
  for (const [lv, why] of [[{ st: 'reset', bound: false }, '시뮬 리셋 중'], [{ st: 'bad', bound: false }, '지도 오류'], [{ st: 'reset', bound: true }, '시뮬 리셋 중'], [{ st: 'bad', bound: true }, '지도 오류'],
    [{ st: 'ok', bound: false }, '서버 결속 미확인'], [{ st: 'wait', bound: false }, '서버 결속 미확인'], [{ st: 'ok' }, '서버 결속 미확인']] as const) {
    live({ ...B, ...lv }); expect(gtHere()).toEqual({ why });
    expect(startPolicy(mi({ map: L1 }), gtHere())).toMatchObject({ block: null, map: null });   // 출처 있는 계획도 결속 시작 0(기록만)
    expect(addPlan(mi({ wps: [] }), gtHere())).toMatchObject({ act: 'bind', why });             // 빈 계획에 붙일 출처 없음(화면은 map 없이 둠)
  }
  live({ ...B, st: 'wait', bound: true }); expect(gtHere().map).toMatchObject({ world_id: 'v5_building', floor_id: 'l1' });
});
// F3: 연결 건물은 floor 판정 필수 — 누락·null·모르는 current 를 시작층 floor_id 로 대신하지 않음
test('F3 연결 건물 floor 누락·null·모르는 current = 현재층 미확인 · 단층은 floor_id', () => {
  const B = { st: 'ok', bound: true, world_id: 'v5_building', floor_id: 'l1', ...ID };
  for (const f of [undefined, null, { rev: 1, state: 'on_floor', current: null }, { rev: 1, state: 'on_floor', current: 'f1' }, { rev: 1, state: 'on_floor', current: 'l3' },
    { rev: 1, state: 'on_floor', current: 2 }, { rev: 1, state: 'unknown', current: 'l1' }, { rev: 1, state: 'weird', current: 'l1' }]) {
    live(f === undefined ? B : { ...B, floor: f }); expect(gtHere()).toEqual({ why: '현재층 미확인' });
    expect(runHere({ wps: [], map: L1 } as unknown as Run).ok).toBe(false);
  }
  live({ ...B, floor_id: 'l3' }); expect(gtHere().why).toBe('모르는 지도·층');
  live({ ...B, world_id: 'x_world', floor_id: 'l1' }); expect(gtHere().why).toBe('모르는 지도·층');
  single(); expect(gtHere().map).toMatchObject({ world_id: 'v5_single', floor_id: 'f1' });
  single({ floor: { rev: 1, state: 'unknown', current: null } }); expect(gtHere().why).toBe('현재층 미확인');
  single({ floor_id: 'l2' }); expect(gtHere().why).toBe('모르는 지도·층');
});

test('시작 정책 표: 일치 = 결속 · world/층 불일치 = 차단 · 출처 없음/지문 어긋남/층 이동 중 = 기록만', () => {
  const ok = startPolicy(mi({ map: L1 }), gtHere());
  expect(ok.block).toBeNull(); expect(ok.map).toEqual(L1);
  onL('l2'); const fl = startPolicy(mi({ map: L1 }), gtHere());
  expect(fl.block).toMatch(/다른 지도.*l1.*l2/); expect(fl.map).toBeNull();
  single(); expect(startPolicy(mi({ map: L1 }), gtHere()).block).toMatch(/v5_building · l1.*v5_single · f1/);
  onL('l1');
  const old = startPolicy(mi(), gtHere());                                       // 옛 계획(map 없음)
  expect([old.block, old.map]).toEqual([null, null]); expect(old.line).toMatch(/기록만 — 출처 미확인\(출처 기록 없음\)/);
  const moved = startPolicy(mi({ map: L1, wps: [...structuredClone(W1), { x: 9, y: 9, name: 'c', mods: [] }] }), gtHere());   // 옛 앱이 map 을 보존한 채 지점 추가
  expect([moved.block, moved.map]).toEqual([null, null]); expect(moved.line).toMatch(/출처 기록 뒤 좌표가 바뀜/);
  onL(null, 'transit'); const tr = startPolicy(mi({ map: L1 }), gtHere());
  expect([tr.block, tr.map]).toEqual([null, null]); expect(tr.line).toMatch(/지금 층 이동 중/);
});

test('지문: 순서 무관 · 좌표 바뀌면 다름 · 이름만 바꾸면 그대로', () => {
  expect(wkey([...W1].reverse())).toBe(wkey(W1));
  expect(wkey([{ ...W1[0], x: 1.01 }, W1[1]])).not.toBe(wkey(W1));
  expect(planMap(mi({ map: L1, wps: W1.map((w) => ({ ...w, name: '새 이름' })) })).map).toEqual(L1);
});

test('찍는 시점 결속: 빈 계획 = 지금 지도 · 같은 지도 = 유지 · 다른/모르는 지도 = drop · 이미 미확인 = none', () => {
  expect(addPlan(mi({ wps: [] }), gtHere()).act).toBe('bind');
  expect(addPlan(mi({ map: L1 }), gtHere()).act).toBe('keep');
  onL('l2'); expect(addPlan(mi({ map: L1 }), gtHere())).toMatchObject({ act: 'drop' });
  onL(null, 'transit'); expect(addPlan(mi({ map: L1 }), gtHere()).why).toMatch(/지금 지도 미확인\(층 이동 중\)/);
  expect(addPlan(mi(), gtHere()).act).toBe('none');
});

test('rekey: 유효 출처면 새 지문 · 이미 어긋난 출처는 지움(옛 지문을 새 좌표에 맞춰 «확인»으로 올리지 않음)', () => {
  const a = mi({ map: L1 }); rekey(a, () => { a.wps.splice(0, 1); });
  expect(a.map).toEqual({ ...L1, key: wkey(a.wps) }); expect(planMap(a).map).toBeTruthy();
  const b = mi({ map: { ...L1, key: 'deadbeef' } }); rekey(b, () => { b.wps.splice(0, 1); });
  expect(b.map).toBeUndefined();
});

test('runHere: 기록 출처가 지금 지도와 같을 때만 거리·겹치기', () => {
  const R = { wps: W1.map((w) => ({ ...w, st: '대기', at: '', why: '', chk: '', photos: [] })), map: L1 } as unknown as Run;
  expect(runHere(R).ok).toBe(true);
  onL('l2'); expect(runHere(R)).toMatchObject({ ok: false, why: expect.stringMatching(/다른 지도/) });
  onL('l1'); expect(runHere({ ...R, map: undefined } as Run)).toMatchObject({ ok: false, why: expect.stringMatching(/시작 때 출처 미확인/) });
});

// ---- startRun(모든 진입점 공통): 보내는 Run 문서와 확인창 사이 변화 ----
const put = (docs: unknown[]) => qc.setQueryData(['docs'], { docs, rev: 1, broken: null });
const env = (id: string, kind: string, doc: unknown, rev = 1) => ({ id, kind, rev, by: 'A', at: 't', doc });
const go = async (m: Mission, onAsk?: () => unknown) => {
  put([env('m1', 'mission', m, 4)]); const sent: DocWrite[] = [];
  const ask = vi.fn(async () => { await onAsk?.(); return true; });
  const r = await startRun(docsNow(), 'm1', async (w) => { sent.push(w); return { ok: true, id: 'r1', rev: 1, kind: 'run', name: '', new: true } as any; }, { ask });
  return { r, sent, ask: String((ask.mock.calls as unknown[][])[0]?.[0] ?? '') };
};

test('startRun 일치: 확인 1회에 이름·지도·지점 수 · Run 에 map·mrev', async () => {
  const { sent, ask } = await go(mi({ map: L1 }));
  expect(ask).toMatch(/«계획».*\n· 지도 v5_building · l1 \(GT · 기하 cccccccc\) · 지금 시뮬과 같은 GT 출처\(SDF\/기하 sha 기준 · 메시·모델 파일 미대조\)\n· 지점 2개/);
  expect(sent).toHaveLength(1); const doc = (sent[0] as any).doc as Run;
  expect(doc.map).toEqual(L1); expect(doc.mrev).toBe(4); expect(doc.wps.map((w) => [w.x, w.y])).toEqual([[1, 2], [-3.5, 4]]);
});
test('startRun 옛 계획: 기록만으로 시작(map 없음·mrev 있음) · 불일치: 확인창 없이 차단', async () => {
  const a = await go(mi()); expect(a.ask).toMatch(/지도 미확인 · 기록만/);
  const d = (a.sent[0] as any).doc as Run; expect('map' in d).toBe(false); expect(d.mrev).toBe(4);
  onL('l2'); const b = await go(mi({ map: L1 }));
  expect(b.r).toBeNull(); expect(b.sent).toHaveLength(0); expect(b.ask).toBe('');
});
test('startRun 확인하는 사이 계획 판·층이 바뀌면 보내지 않음', async () => {
  const a = await go(mi({ map: L1 }), () => put([env('m1', 'mission', mi({ map: L1 }), 5)]));
  expect(a.r).toBeNull(); expect(a.sent).toHaveLength(0);
  const b = await go(mi({ map: L1 }), () => onL(null, 'transit'));
  expect(b.r).toBeNull(); expect(b.sent).toHaveLength(0);
});

// ---- 복제(2묶음): 저장 전 초안, 출처·양식·할 일 그대로, 이름 «… 사본» ----
const { dupMission } = await import('../../src/data/run');
test('dupMission: 깊은 사본 · 이름 60자 안 · 출처 그대로(유효/미확인 유지) · 원본 무변경', () => {
  const src = mi({ map: L1, tmpl: 't9', memo: 'm', name: '가'.repeat(60) });
  const c = dupMission(src);
  expect(c.name).toBe(`${'가'.repeat(57)} 사본`); expect(c.name.length).toBe(60);
  expect([c.tmpl, c.memo, c.wps, c.map]).toEqual([src.tmpl, src.memo, src.wps, src.map]);
  c.wps[0].x = 99; c.map!.world_id = 'x'; c.wps[0].mods.push('사진');
  expect(src.wps[0].x).toBe(1); expect(src.map!.world_id).toBe('v5_building'); expect(src.wps[0].mods).toEqual([]);
  expect(planMap(dupMission(src)).map).toEqual(L1);
  const old = dupMission(mi()); expect('map' in old).toBe(false); expect(planMap(old).why).toBe('출처 미확인(출처 기록 없음)');
});

// F1: 확인창은 비차단 — 1 s 넘게 읽어도 그동안 status 가 들어오면 정상 시작 · 안 들어오면(끊김) 신선도 1 s 그대로 차단 · STOP 은 창을 닫아 보낸 것 0
const tickWhile = (ms: number, beat: boolean) => new Promise<void>((res) => { const t0 = performance.now(), id = setInterval(() => { if (beat) useLink.setState({ lastMsg: performance.now() }); if (performance.now() - t0 >= ms) { clearInterval(id); res(); } }, 100); });
test('F1 확인 1.3 s 동안 status 계속 = 결속 시작 · status 없음 = 시작 안 됨(1 s 완화 0)', async () => {
  const a = await go(mi({ map: L1 }), () => tickWhile(1300, true));
  expect(a.sent).toHaveLength(1); expect(((a.sent[0] as any).doc as Run).map).toEqual(L1);
  onL('l1'); const b = await go(mi({ map: L1 }), () => tickWhile(1300, false));
  expect(b.r).toBeNull(); expect(b.sent).toHaveLength(0);
});
test('F1 기본 확인창 = 페이지 안(단추 «진행 시작») · STOP(cancelStart) 이면 닫히고 보낸 것 0 · 양식이 사라지면 보내지 않음', async () => {
  const L = await import('../../src/data/link');
  put([env('m1', 'mission', mi({ map: L1 }), 4), env('t1', 'tmpl', { name: 'T', desc: '', mods: [] })]); const sent: DocWrite[] = [];
  const sendF = async (w: DocWrite) => { sent.push(w); return { ok: true } as any; };
  const p = startRun(docsNow(), 'm1', sendF);
  expect(L.useAsk.getState()).toMatchObject({ ok: '진행 시작' }); expect(L.useAsk.getState().text).toMatch(/수동 진행을 시작할까요/);
  L.cancelStart(); expect(await p).toBeNull(); expect(sent).toHaveLength(0); expect(L.useAsk.getState().text).toBeNull();
  const q = startRun(docsNow(), 'm1', sendF); L.answerAsk(true); expect(await q).toBeTruthy(); expect(sent).toHaveLength(1);
  const m2 = mi({ map: L1, tmpl: 't1' }); put([env('m1', 'mission', m2, 4), env('t1', 'tmpl', { name: 'T', desc: '', mods: [] })]);
  const r3 = startRun(docsNow(), 'm1', sendF); put([env('m1', 'mission', m2, 4)]); L.answerAsk(true);
  expect(await r3).toBeNull(); expect(sent).toHaveLength(1);
});

// ---- F4 개정 rid: 옛 출처 자동 승격 0 · 개정 다르면 다른 지도 · 단층 SDF · 연결 건물 검증 기하 · 늦은/다른 응답 버림 ----
test('F4 rid 없는 옛 출처(1f93089~ec25939 저장) = 기록만 · rid 다르면 차단 · 같으면 결속', () => {
  const { rid: _r, ...old } = L1;
  expect(planMap(mi({ map: old })).why).toMatch(/^출처 미확인\(개정 기록 없음/);
  expect(startPolicy(mi({ map: old }), gtHere())).toMatchObject({ block: null, map: null, line: expect.stringMatching(/기록만 — 출처 미확인\(개정 기록 없음/) });
  expect(addPlan(mi({ map: old }), gtHere()).act).toBe('none');
  expect(startPolicy(mi({ map: { ...L1, rid: `g:${'e'.repeat(64)}` } }), gtHere()).block).toMatch(/다른 지도.*기하 eeeeeeee.*기하 cccccccc/);
  expect(startPolicy(mi({ map: L1 }), gtHere()).map).toEqual(L1);
});
test('F4 단층 = w:<world 원본 SDF sha> · sha 없음·형식 틀림·spawn 다름 = 미확인', () => {
  single(); expect(gtHere().map?.rid).toBe(`w:${SS}`);
  for (const o of [{ world_src_sha256: undefined }, { world_src_sha256: null }, { world_src_sha256: 'D'.repeat(64) }, { world_src_sha256: 'd'.repeat(63) }, { spawn_floor: null }, { spawn_floor: 'l1' }]) {
    single(o); expect(gtHere().why).toMatch(/좌표 개정 미확인\(world 원본 SDF/);
  }
});
test('F4 연결 건물: 받기 전 미확인·같은 키 재요청 0 · 받은 뒤 g: · geomBind 실패(spawn SDF 다름)·live 기하 sha 다름 = 미확인', async () => {
  G.ridReset(); geoCalls = 0; geoHold(); onL('l1');
  expect(gtHere().why).toBe('좌표 개정 확인 중(GT 기하 파일 받는 중)'); gtHere(); expect(geoCalls).toBe(1);
  geoRes.shift()!(); await flush(); expect(gtHere().map?.rid).toBe(`g:${GS}`);
  onL('l2'); expect(gtHere().map).toMatchObject({ floor_id: 'l2', rid: `g:${GS}` });            // 같은 개정, 현재층만 다름
  live({ st: 'ok', bound: true, world_id: 'v5_building', floor_id: 'l1', floor: { rev: 1, state: 'on_floor', current: 'l1' }, ...ID, world_src_sha256: SW2 });
  expect(gtHere().map).toBeUndefined(); expect(gtHere().why).toMatch(/확인 중/);                    // 키 바뀜(SDF) → 옛 검증본 폐기·새로 받는 중
  expect(geoRes).toHaveLength(1); geoRes.shift()!(); await flush(); expect(gtHere().why).toMatch(/미검증/);   // 받은 기하의 sdf_sha256[l1] = SW ≠ live SW2 → geomBind 실패
  live({ st: 'ok', bound: true, world_id: 'v5_building', floor_id: 'l1', floor: { rev: 1, state: 'on_floor', current: 'l1' }, ...ID, spawn_floor: 'l2', world_src_sha256: SW2 });
  gtHere(); expect(geoRes).toHaveLength(1); geoRes.shift()!(); await flush(); expect(gtHere().map?.rid).toBe(`g:${GS}`);   // l2 기동 SDF 도 같은 기하 개정
});
test('F4 늦은 옛 응답: 요청 뒤 리셋(episode)·새 연결(gen)·live 기하 sha 바뀜·응답 sha 다름 = rid 붙임 0', async () => {
  for (const change of [() => useLink.setState((s) => ({ st: { ...s.st, episode: 9 } as any })), () => useLink.setState((s) => ({ gen: s.gen + 1 })),
    () => live({ st: 'ok', bound: true, world_id: 'v5_building', floor_id: 'l1', floor: { rev: 1, state: 'on_floor', current: 'l1' }, ...ID, geom: { schema: 'v2_building_geom/1', sha256: SW2 } })]) {
    G.ridReset(); geoRes = []; geoHold(); onL('l1'); gtHere(); change(); geoRes.shift()!(); await flush();
    onL('l1'); useLink.setState((s) => ({ st: { ...s.st, episode: undefined } as any })); geoHold();
    expect(gtHere().map).toBeUndefined();
  }
  G.ridReset(); geoNow('f'.repeat(64)); onL('l1'); gtHere(); await flush(); expect(gtHere().why).toMatch(/미검증/);   // 응답 파일 sha ≠ live geom.sha256
});
// ---- G1(Codex P1): cold — 캐시 예열(beforeEach 의 gtHere+flush) 없이 빈 계획 화면 → 첫 점. 화면 onTap 과 같은 순서(gtHere → addPlan → bind 면 h.map) ----
const tap = (d: Mission) => { const h = gtHere(), a = addPlan(d, h); d.wps.push({ x: d.wps.length, y: 0, name: '', mods: [] }); const m = a.act === 'bind' ? h.map : a.act === 'keep' ? d.map : undefined; if (m) d.map = { ...m, key: wkey(d.wps) }; else delete d.map; return a.act; };
test('G1 cold: 빈 계획 화면 그리기(gtHere)만으로 기하 준비 → 첫 점 g:rid · 둘째 점 keep', async () => {
  G.ridReset(); geoCalls = 0; geoHold(); onL('l1');
  expect(gtHere().why).toMatch(/확인 중/); expect(geoCalls).toBe(1);                   // 화면 진입(첫 그리기) = 요청 1회, 받는 중 표시
  gtHere(); gtHere(); expect(geoCalls).toBe(1);                                        // 다시 그려도 받는 중엔 재요청 0
  geoRes.shift()!(); await flush();
  const d = mi({ wps: [] }); expect(tap(d)).toBe('bind'); expect(planMap(d).map?.rid).toBe(`g:${GS}`);
  expect(tap(d)).toBe('keep'); expect(planMap(d).map?.rid).toBe(`g:${GS}`);
});
test('G1 cold: 받는 중·실패 때 찍은 첫 점 = 기록만 · 나중에 받아져도 자동 승격 0 · 실패 뒤 6 s 안 재요청 0', async () => {
  G.ridReset(); geoCalls = 0; geoHold(); onL('l1');
  const d = mi({ wps: [] }); expect(tap(d)).toBe('bind'); expect(d.map).toBeUndefined();        // 받는 중 클릭 → 기록만
  geoRes.shift()!(); await flush(); expect(gtHere().map?.rid).toBe(`g:${GS}`);                   // 늦게 성공
  expect(planMap(d).map).toBeUndefined(); expect(tap(d)).toBe('none'); expect(d.map).toBeUndefined();
  let t = 1000; const now0 = G.ridDeps.now; G.ridDeps.now = () => t;
  try {
    G.ridReset(); geoCalls = 0; G.ridDeps.get = async () => { geoCalls++; return '기하 받기 실패'; };
    gtHere(); await flush(); expect(gtHere().why).toMatch(/미검증 · 기하 받기 실패/); expect(geoCalls).toBe(1);
    const e = mi({ wps: [] }); expect(tap(e)).toBe('bind'); expect(e.map).toBeUndefined();
    t += 5000; gtHere(); expect(geoCalls).toBe(1);                                               // 6 s 안 재요청 0
    t += 2000; geoNow(); gtHere(); await flush(); expect(geoCalls).toBe(2); expect(gtHere().map?.rid).toBe(`g:${GS}`);   // 6 s 지난 뒤 1회 재요청 → 성공
    expect(planMap(e).map).toBeUndefined(); expect(tap(e)).toBe('none');
  } finally { G.ridDeps.now = now0; }
});
test('G1 키 전환: 받는 중 전환 → 옛 응답 0 · 확인된 키도 전환하면 폐기(되돌아와도 새로 받음)', async () => {
  G.ridReset(); geoCalls = 0; geoHold(); onL('l1'); gtHere(); expect(geoCalls).toBe(1);
  useLink.setState((s) => ({ gen: s.gen + 1 })); onL('l1');                                     // 새 연결(키 B)
  geoRes.shift()!(); await flush();                                                             // 옛 키 A 응답 도착
  expect(gtHere().map).toBeUndefined(); expect(gtHere().why).toMatch(/확인 중/); expect(geoCalls).toBe(2);   // B 로 새로 받는 중
  geoRes.shift()!(); await flush(); expect(gtHere().map?.rid).toBe(`g:${GS}`);
  const B = useLink.getState().st;
  live({ st: 'ok', bound: true, world_id: 'v5_building', floor_id: 'l1', floor: { rev: 1, state: 'on_floor', current: 'l1' }, ...ID, epoch: 4 });   // 키 C
  expect(gtHere().map).toBeUndefined(); expect(geoCalls).toBe(3);
  useLink.setState({ st: B }); expect(gtHere().map).toBeUndefined(); expect(geoCalls).toBe(4);   // B 로 돌아와도 옛 검증본 재사용 0
  geoRes.shift()!(); geoRes.shift()!(); await flush(); expect(gtHere().map?.rid).toBe(`g:${GS}`);
});
test('G1 키 A→B→A 왕복: 첫 A 요청의 늦은 응답은 보관 0(전환 뒤 옛 응답) · 새 A 요청 응답만 결속', async () => {
  G.ridReset(); geoCalls = 0; geoHold(); onL('l1'); gtHere();                                   // A 요청 1
  const A = useLink.getState().st;
  live({ st: 'ok', bound: true, world_id: 'v5_building', floor_id: 'l1', floor: { rev: 1, state: 'on_floor', current: 'l1' }, ...ID, epoch: 4 }); gtHere();   // B 요청 2
  useLink.setState({ st: A }); gtHere(); expect(geoCalls).toBe(3);                              // A 로 돌아옴 → A 요청 3
  geoRes.shift()!(); await flush(); expect(gtHere().map).toBeUndefined(); expect(gtHere().why).toMatch(/확인 중/);   // 요청 1 응답(키는 같아도 옛 요청) = 버림
  geoRes.shift()!(); geoRes.shift()!(); await flush(); expect(gtHere().map?.rid).toBe(`g:${GS}`);
});
// ---- G2(Codex 2129 P2): 조기 반환 경로(기하 sha 누락 · 단층 world)를 gtHere 가 관찰하면 옛 요청·검증본 폐기 — A 로 돌아와도 재사용·옛 응답 보관 0 ----
const noSha = () => live({ st: 'ok', bound: true, world_id: 'v5_building', floor_id: 'l1', floor: { rev: 1, state: 'on_floor', current: 'l1' }, ...ID, geom: { schema: 'v2_building_geom/1', sha256: null } });
for (const [nm, mid] of [['기하 sha 누락', noSha], ['단층 world', () => single()]] as const) {
  test(`G2 A→${nm}→A: 진행 중 요청의 늦은 응답 보관 0 · 새 요청만 결속`, async () => {
    G.ridReset(); geoCalls = 0; geoHold(); onL('l1'); gtHere(); expect(geoCalls).toBe(1);       // A 요청 1(받는 중)
    mid(); gtHere(); onL('l1');                                                                 // 중간 상태 관찰 → 같은 전체 키 A 복원
    expect(gtHere().why).toMatch(/확인 중/); expect(geoCalls).toBe(2);                          // 받는 중이던 요청 1 을 기다리지 않고 새로 요청
    geoRes.shift()!(); await flush(); expect(gtHere().map).toBeUndefined();                     // 요청 1 응답 = 버림
    geoRes.shift()!(); await flush(); expect(gtHere().map?.rid).toBe(`g:${GS}`);
  });
  test(`G2 A→${nm}→A: 확인된 검증본 재사용 0 · 다시 받은 뒤 결속`, async () => {
    G.ridReset(); geoCalls = 0; geoHold(); onL('l1'); gtHere(); geoRes.shift()!(); await flush();
    expect(gtHere().map?.rid).toBe(`g:${GS}`); expect(geoCalls).toBe(1);
    mid(); gtHere(); onL('l1');
    expect(gtHere().map).toBeUndefined(); expect(geoCalls).toBe(2);
    const d = mi({ wps: [] }); expect(tap(d)).toBe('bind'); expect(d.map).toBeUndefined();     // 다시 받기 전 첫 점 = 기록만
    geoRes.shift()!(); await flush(); expect(gtHere().map?.rid).toBe(`g:${GS}`); expect(tap(d)).toBe('none');   // 늦은 승격 0
  });
}
test('F4 확인창 사이 rid 바뀌면 보내지 않음 · 보낸 Run.map 에 rid', async () => {
  const a = await go(mi({ map: L1 }), () => live({ st: 'ok', bound: true, world_id: 'v5_building', floor_id: 'l1', floor: { rev: 1, state: 'on_floor', current: 'l1' }, ...ID, geom: { schema: 'v2_building_geom/1', sha256: SW2 } }));
  expect(a.r).toBeNull(); expect(a.sent).toHaveLength(0);
  onL('l1'); expect(gtHere().map).toBeUndefined();                                  // 원래 키로 돌아와도 옛 검증본 재사용 0(G1) — 다시 받아야 결속
  await flush(); const b = await go(mi({ map: L1 })); expect(((b.sent[0] as any).doc as Run).map?.rid).toBe(`g:${GS}`);
});
test('F4 확인창 사이 rid 가 앞 8자만 같고 뒤가 바뀌어도 값으로 잡음(문구 비교만으론 못 잡음)', async () => {
  const G2 = 'c'.repeat(8) + 'e'.repeat(56), GE = { ...GEO };
  const a = await go(mi({ map: L1 }), () => { G.ridReset(); geoNow(G2, GE); live({ st: 'ok', bound: true, world_id: 'v5_building', floor_id: 'l1', floor: { rev: 1, state: 'on_floor', current: 'l1' }, ...ID, geom: { schema: 'v2_building_geom/1', sha256: G2 } }); gtHere(); return flush(); });
  expect(a.r).toBeNull(); expect(a.sent).toHaveLength(0);
});

// ---- E1: 확인창 수명 = 연 화면(route)·주인·고른 계획/편집기 세대. 바뀌면 창 닫힘 + Run 쓰기 0 · 다른 주인의 창은 그대로 ----
test('E1 주인 결속: 그 주인 dropAsk = 창 닫힘·Run 0 · 다른 주인 dropAsk 는 무영향 · 취소 뒤 새 시작은 정상', async () => {
  const L = await import('../../src/data/link'), A = {}, B = {};
  put([env('m1', 'mission', mi({ map: L1 }), 4)]); const sent: DocWrite[] = [];
  const sendF = async (w: DocWrite) => { sent.push(w); return { ok: true } as any; };
  const p = startRun(docsNow(), 'm1', sendF, { owner: A });
  L.dropAsk(B); L.dropAsk(null); expect(L.useAsk.getState().text).not.toBeNull();             // 남의 창·주인 없음 = 그대로
  L.dropAsk(A); expect(L.useAsk.getState().text).toBeNull(); expect(await p).toBeNull(); expect(sent).toHaveLength(0);
  const q = startRun(docsNow(), 'm1', sendF, { owner: A }); L.answerAsk(true); expect(await q).toBeTruthy(); expect(sent).toHaveLength(1);   // 양성 대조
  const n1 = L.askPage('조종을 시작할까요?'); L.dropAsk(A); expect(L.useAsk.getState().text).not.toBeNull(); L.answerAsk(false); expect(await n1).toBe(false);   // N1 창은 편집기 주인이 못 닫음
});
test('E1 확인 뒤 alive 거짓(이탈·A→B·복제 = 편집기 gen/선택 바뀜) 또는 route 바뀜 = 쓰기 0 · gen 을 확인 직후 대조(E.write 가 새 gen 을 잡아 살리지 않음)', async () => {
  const E = { gen: 1, id: 'm1' }, g0 = E.gen, alive = () => E.gen === g0 && E.id === 'm1';
  for (const change of [() => { E.gen++; }, () => { E.id = 'm2'; }]) {
    E.gen = 1; E.id = 'm1';
    put([env('m1', 'mission', mi({ map: L1 }), 4)]); const sent: DocWrite[] = [];
    const r = await startRun(docsNow(), 'm1', async (w) => { sent.push(w); return { ok: true } as any; }, { alive, ask: async () => { change(); return true; } });
    expect(r).toBeNull(); expect(sent).toHaveLength(0);
  }
  vi.stubGlobal('location', { hash: '#/PcPlan?mission=m1' });
  try {
    put([env('m1', 'mission', mi({ map: L1 }), 4)]); const sent: DocWrite[] = [];
    const r = await startRun(docsNow(), 'm1', async (w) => { sent.push(w); return { ok: true } as any; }, { ask: async () => { (globalThis.location as any).hash = '#/PcHistory'; return true; } });
    expect(r).toBeNull(); expect(sent).toHaveLength(0);
    (globalThis.location as any).hash = '#/PcPlan?mission=m1'; const ok = await startRun(docsNow(), 'm1', async (w) => { sent.push(w); return { ok: true } as any; }, { ask: async () => true });
    expect(ok).toBeTruthy(); expect(sent).toHaveLength(1);
  } finally { vi.unstubAllGlobals(); }
});
test('dirty: 확인창 연 뒤 같은 계획 수정 = 그 창 취소·Run 0·편집 내용/판 그대로 · alive 만으로도 dirty 차단 · 저장(깨끗) 뒤 새 시작은 1건 · N1 창 무영향', async () => {
  const L = await import('../../src/data/link'), { planEdit, planOwn } = await import('../../src/data/run');
  const E = { gen: 1, id: 'm1' as string | null, rev: 4, dirty: false, d: { name: '계획' }, touch() {} };
  put([env('m1', 'mission', mi({ map: L1 }), 4)]); const sent: DocWrite[] = [];
  const sendF = async (w: DocWrite) => { sent.push(w); return { ok: true } as any; };
  const p = startRun(docsNow(), 'm1', sendF, planOwn(E));
  expect(L.useAsk.getState().text).not.toBeNull();
  planEdit(E, () => { E.d.name = '고친 이름'; });                                   // 창 열린 채 같은 계획 수정
  expect(L.useAsk.getState().text).toBeNull(); expect(await p).toBeNull(); expect(sent).toHaveLength(0);
  expect(E).toMatchObject({ dirty: true, gen: 1, id: 'm1', rev: 4, d: { name: '고친 이름' } });   // 편집 복원·저장·판 변경 0
  // 창 닫기 없이 확인 직후 대조만으로도(다른 경로로 dirty) 쓰기 0
  E.dirty = false; const q = await startRun(docsNow(), 'm1', sendF, { ...planOwn(E), ask: async () => { E.dirty = true; return true; } });
  expect(q).toBeNull(); expect(sent).toHaveLength(0);
  E.dirty = false; const r = startRun(docsNow(), 'm1', sendF, planOwn(E)); L.answerAsk(true);   // 양성: 저장(깨끗) 뒤 새 시작
  expect(await r).toBeTruthy(); expect(sent).toHaveLength(1);
  const n1 = L.askPage('조종을 시작할까요?'); planEdit(E, () => {}); expect(L.useAsk.getState().text).not.toBeNull(); L.answerAsk(false); expect(await n1).toBe(false);
  expect(L.dropAsk(E)).toBe(false);
});
test('복제 이름: 문자 단위로 자름(외톨이 surrogate 0) · UTF-16 60 상한 · UTF-8 왕복 같음', () => {
  const rt = (s: string) => new TextDecoder('utf-8', { fatal: true }).decode(new TextEncoder().encode(s)) === s && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);
  for (const n of ['가'.repeat(56) + '🤖' + '나나', '🤖'.repeat(30), 'a' + '😀'.repeat(29), '가'.repeat(60), '짧은 이름 🤖']) {
    const c = dupMission(mi({ name: n } as any)).name;
    expect(rt(c)).toBe(true); expect(c.length).toBeLessThanOrEqual(60); expect(c.endsWith(' 사본')).toBe(true);
    expect(n.startsWith(c.slice(0, -3))).toBe(true);
  }
  expect(dupMission(mi({ name: '가'.repeat(56) + '🤖나나' } as any)).name).toBe('가'.repeat(56) + ' 사본');
  expect(dupMission(mi({ name: '짧은 이름 🤖' } as any)).name).toBe('짧은 이름 🤖 사본');
});
