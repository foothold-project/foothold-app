// 새 기획(10-18) 리허설 데이터 모듈: 파서(qa-fixtures q1–q7 재사용) · 응답 모양 · 불확실 오류 문구 · 지우기 정책 · 예시 계획 · 목록 의미(broken/damaged) · 연결 수.
// 입력: tests/fixtures/rehearsal/q1–q8 = 670 qa-fixtures 사본(sha256 동일 · runs/ 는 Git 무시라 추적 경로로 복사, 원본 보존).
// 한계: 서버 validate 일치는 여기서 보지 않음(서버 pytest). 출처 정규식 검사는 보조 근거일 뿐 — 실제 편집·비동기 장착(저장 중 편집·도면·가져오기 경합)은 670 브라우저 범위.
import { describe, expect, test } from 'vitest';
const fsm = 'node:fs', cm = 'node:crypto', fs = await import(/* @vite-ignore */ fsm);   // node 형 선언 없이(ui_u4a 방식)
Object.assign(globalThis, { location: { href: 'http://127.0.0.1/', protocol: 'http:', hash: '', search: '', pathname: '/' }, localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  addEventListener() {}, removeEventListener() {}, innerWidth: 1440, innerHeight: 900 });
if (!globalThis.crypto) Object.defineProperty(globalThis, 'crypto', { value: (await import(/* @vite-ignore */ cm)).webcrypto, configurable: true });
if (!('navigator' in globalThis)) Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'node' }, configurable: true });
const R = await import('../../src/data/rehearsal');
const FX = (n: string): string => fs.readFileSync(new URL(`../fixtures/rehearsal/${n}`, import.meta.url), 'utf8');
const SRC = (n: string): string => fs.readFileSync(new URL(`../../src/${n}`, import.meta.url), 'utf8');
const res = (status: number, j: unknown) => ({ postRehearsal: async () => ({ status, body: typeof j === 'string' ? j : JSON.stringify(j) }) });
const errs = (s: Parameters<typeof R.checkScene>[0]) => R.checkScene(s).filter((x) => x.level === 'error');

describe('JSON 가져오기 파서', () => {
  test('q1·q2 통과(이름의 <script> 는 글자 그대로)', () => {
    const a = R.parseScene(FX('q1_valid_min.json')), b = R.parseScene(FX('q2_valid_2floor_stairs.json'));
    expect(typeof a).toBe('object'); expect(typeof b).toBe('object');
    expect((a as any).name).toContain('<script>');
    expect(errs(b as any)).toEqual([]);
    for (const n of ['q3_warn_geometry.json', 'q8_bad_blocked.json']) expect(typeof R.parseScene(FX(n)), n).toBe('object');   // 경고·지도 판정은 서버 몫 — 읽기는 됨
  });
  test('q4 문법·q5 모르는 판·q6 중복 키·q7 1e999 거부(문자열 이유)', () => {
    for (const n of ['q4_bad_syntax.json', 'q5_bad_schema.json', 'q6_bad_keys.json']) expect(typeof R.parseScene(FX(n))).toBe('string');
    expect(R.parseScene(FX('q6_bad_keys.json'))).toMatch(/name/);
    const q7 = R.parseScene(FX('q7_bad_values_refs.json'));
    expect(typeof q7 === 'string' || errs(q7).length > 0).toBe(true);
  });
  test('중복 키: 이스케이프로 같은 키도 잡음 · 다른 객체의 같은 키는 허용', () => {
    expect(R.dupKey('{"a":1,"\\u0061":2}')).toMatch(/a/);
    expect(R.dupKey('{"a":{"b":1},"c":{"b":2}}')).toBeNull();
    expect(R.dupKey('{"s":"{\\"a\\":1,\\"a\\":2}"}')).toBeNull();   // 문자열 안 글자는 키 아님
  });
  test('256 KiB 넘는 글은 읽기 전에 거부', () => {
    expect(R.parseScene(' '.repeat(R.RLIM.req + 1))).toMatch(/256/);
  });
});

describe('호출·응답', () => {
  test('요청 256 KiB 초과 → 413 «보내지 않았습니다»(호출 0)', async () => {
    let n = 0; const t = { postRehearsal: async () => { n++; return { status: 200, body: '{}' }; } };
    const r = await R.rcall({ op: 'put', big: 'x'.repeat(R.RLIM.req) }, undefined, t);
    expect(r.ok).toBe(false); expect(n).toBe(0); expect(!r.ok && r.code).toBe(413); expect(!r.ok && r.error).toMatch(/보내지 않았습니다/);
  });
  test('보낸 뒤 실패 = «요청 결과를 확인하지 못함»(안 보냈다고 단정 0)', async () => {
    const r = await R.rcall({ op: 'list' }, undefined, { postRehearsal: async () => { throw new Error('시간 초과'); } });
    expect(!r.ok && r.error).toContain(R.UNSURE); expect(!r.ok && r.error).not.toMatch(/보내지 못함|보내지 않/);
  });
  test('200 이어도 모양이 틀리면 쓰지 않음 · 503 은 원문 보존', async () => {
    const bad = await R.rcall({ op: 'get', id: 'a' }, R.SH.get, res(200, { project: { id: 'a' }, scene: {} }));
    expect(bad.ok).toBe(false); expect(!bad.ok && bad.code).toBe(200);
    const sv = await R.rcall({ op: 'analyze' }, R.SH.analyze, res(503, { error: '계산 시간 상한' }));
    expect(!sv.ok && sv.code).toBe(503); expect(!sv.ok && sv.error).toContain('계산 시간 상한');
  });
  test('409 는 cur 판을 돌려줌', () => {
    const r = R.parseRes({ status: 409, body: JSON.stringify({ error: '판 충돌', cur: { rev: 4, sha256: 'a'.repeat(64) } }) });
    expect(!r.ok && r.cur?.rev).toBe(4);
  });
  test('목록: broken 은 문자열만 · damaged 는 id 목록 — 빈 목록과 다른 글', () => {
    expect(R.SH.list({ projects: [], broken: 3 })).toBe('broken');
    expect(R.SH.list({ projects: [], broken: 'symlink' })).toBeNull();
    expect(R.brokenTxt({ projects: [], broken: 'symlink' })).toMatch(/저장소 이상.*원문: symlink/);
    expect(R.brokenTxt({ projects: [] })).toBeNull();
    expect(R.damagedTxt({ projects: [], damaged: ['p1', 'p2'] })).toMatch(/2개.*p1, p2.*나머지 0개/);
    expect(R.damagedTxt({ projects: [], damaged: [] })).toBeNull();
  });
});

describe('설계도 편집', () => {
  test('빈 설계도·예시 계획(2층 계단)은 화면 검사 오류 0 · 예시는 이름에 «예시 계획»', () => {
    expect(errs(R.blankScene())).toEqual([]);
    const ex = R.exampleScene();
    expect(errs(ex)).toEqual([]); expect(ex.name).toContain('예시 계획');
    expect(ex.floors).toHaveLength(2); expect(ex.elements.some((e) => e.type === 'stairs')).toBe(true);
    expect(R.blankScene().robots).toHaveLength(0);   // 예시를 기본값으로 흘리지 않음
  });
  test('층 높이 1–10 · 층간 1 m 이상(서버 범위와 같음)', () => {
    const s = R.blankScene(); s.floors[0].height = 0.5;
    expect(R.checkScene(s).some((x) => x.code === 'floor_h')).toBe(true);
    const t = R.exampleScene(); t.floors[1].z = 0.5;
    expect(R.checkScene(t).some((x) => x.code === 'floor_order')).toBe(true);
  });
  test('ID 는 문서 전체에서 하나', () => {
    const s = R.exampleScene(); const id = R.newId(s, 'w');
    expect(R.allIds(s)).not.toContain(id);
  });
  test('지우기 정책: 쓰이는 층 거부 · 로봇은 그 경로·배치안 참조 함께 정리', () => {
    const s = R.exampleScene();
    expect(typeof R.removeSel(s, { k: 'floor', id: 'f2' })).toBe('string');
    expect(typeof R.removeSel(s, { k: 'floor', id: 'f1' })).toBe('string');
    const r = R.removeSel(s, { k: 'robot', id: 'go2_a' }); if (typeof r === 'string') throw new Error(r);
    expect(r.s.routes.some((x) => x.robot === 'go2_a')).toBe(false);
    expect(r.s.scenarios.every((x) => !x.robots.includes('go2_a') && !x.routes.includes('p1'))).toBe(true);
    expect(errs(r.s)).toEqual([]);
  });
  test('배치안: 경로를 넣으면 그 로봇도 · 로봇을 빼면 그 경로도', () => {
    let s = R.exampleScene(); const sc = s.scenarios[0].id;
    s = R.edit(s, (c) => { c.scenarios[0].robots = []; c.scenarios[0].routes = []; });
    s = R.toggleIn(s, sc, 'routes', 'p1'); expect(s.scenarios[0].robots).toContain('go2_a');
    s = R.toggleIn(s, sc, 'robots', 'go2_a'); expect(s.scenarios[0].routes).not.toContain('p1');
  });
  test('도면 배경 128 KiB 넘으면 거부', async () => {
    const big = async () => ({ b64: 'A'.repeat(200000), w: 10, h: 10 });
    expect(typeof await R.fitBackground(R.blankScene(), 'f1', big)).toBe('string');
  });
});

describe('JSON 파일 왕복(경계)', () => {
  test('240 KiB 가까운 정상 설계도: 내보낸 글 = 들여쓰기 없음 · 바이트 ≤240 KiB · 다시 읽으면 같은 값', () => {
    const s = R.exampleScene();
    s.world.background = { mime: 'image/jpeg', data_b64: 'A'.repeat(R.RLIM.bg - 4), floor: 'f1', ref_px: [[0, 0], [100, 0]], ref_m: [[0, 0], [10, 0]] };
    for (let i = 0; R.bytesOf(s) < R.RLIM.scene - 400; i++) s.elements.push({ id: `wx${i}`, type: 'wall', floor: 'f1', a: [1 + (i % 17), 1 + 0.01 * i], b: [2 + (i % 17), 1 + 0.01 * i], thickness: 0.1, height: 1 });
    const txt = R.sceneJson(s), n = new TextEncoder().encode(txt).length;
    expect(n).toBeGreaterThan(R.RLIM.scene - 1000); expect(n).toBeLessThanOrEqual(R.RLIM.scene);
    expect(JSON.stringify(s, null, 1).length).toBeGreaterThan(R.RLIM.req);   // 들여쓰기면 가져오기 상한을 넘는 경계임을 확인
    const back = R.parseScene(txt); expect(typeof back, String(back)).toBe('object'); expect(back).toEqual(s);
  });
});

describe('내보내기 파일 확인', () => {
  const mk = async (bytes: Uint8Array, over: Partial<Parameters<typeof R.saveExport>[0]> = {}) => {
    const h = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
    return { filename: 'a.zip', mime: 'application/zip' as const, base64: btoa(String.fromCharCode(...bytes)), sha256: h, bytes: bytes.length, project: { id: 'p', rev: 1 } as any, ...over };
  };
  test('크기·sha 일치 때만 저장 · 그사이 바뀌면(still=false) 저장 0', async () => {
    const b = new Uint8Array([1, 2, 3]); let saved = 0; const save = async () => { saved++; return '저장됨'; };
    expect(await R.saveExport(await mk(b), () => true, save)).toMatch(/저장됨/); expect(saved).toBe(1);
    expect(await R.saveExport(await mk(b, { sha256: 'f'.repeat(64) }), () => true, save)).toMatch(/불일치/);
    expect(await R.saveExport(await mk(b, { bytes: 9 }), () => true, save)).toMatch(/크기 불일치/);
    expect(await R.saveExport(await mk(b), () => false, save)).toBeNull(); expect(saved).toBe(1);
  });
});

describe('연결 수 · 화면 명령 0', async () => {
  const { liveOf } = await import('../../src/app/fleetui');
  test('몸 상태가 있을 때만 연결 로봇 1 · 관문만 / 실기 선택 / 끊김은 0대(none·lost)', () => {
    expect(liveOf({ linkOk: true, s: { x: 0 } }, false).n).toBe(1);
    expect(liveOf({ linkOk: true, s: null }, false)).toEqual({ n: 0, txt: '관문 연결 · 몸 상태 미확인' });
    expect(liveOf({ linkOk: false, s: null }, true).txt).toMatch(/실기 Go2.*미연결/);
    expect(liveOf({ linkOk: false, s: null }, false)).toEqual({ n: 0, txt: '연결 없음' });
  });
  test('새 화면·부품 출처에 명령 경로 0(sendOp·startDrive·setProvider·sendStop·send)', () => {
    for (const f of ['screens/Field.tsx', 'screens/Fleet.tsx', 'screens/MapEditor.tsx', 'app/fleetui.tsx', 'map/SceneCanvas.tsx']) {
      const s = SRC(f).replace(/^\s*\/\/.*$/gm, '');
      expect(s, f).not.toMatch(/\b(sendOp|startDrive|setProvider|sendStop|takeOver)\b/);
      expect(s, f).not.toMatch(/from '\.\.\/data\/link'[^\n]*\bsend\b/);
    }
  });
  test('계획 지도에 실측 궤적·실위치를 넘기지 않음(SceneCanvas 에 TRAIL·robot 없음)', () => {
    for (const f of ['screens/Field.tsx', 'screens/Fleet.tsx']) for (const m of SRC(f).matchAll(/<SceneCanvas[^>]*\/>/gs)) expect(m[0], f).not.toMatch(/TRAIL|v\.robot|trail=/);
  });
});

describe('편집기 내용 보존(출처 검사)', () => {
  const s = SRC('screens/MapEditor.tsx');
  test('되돌리기·다시 하기도 «저장 안 함»·내보내기·검토 결과를 무효화', () => {
    expect(s).toMatch(/const undo = \(\) => \{[^\n]*touched\(\)/); expect(s).toMatch(/const redo = \(\) => \{[^\n]*touched\(\)/);
  });
  test('저장 응답 뒤 편집이 있으면 dirty 유지 · 도면·불러오기는 편집되면 채택 0 · 목록은 따로 번호', () => {
    expect(s).toMatch(/later = editSeq\.current !== es[\s\S]*if \(!later\) setDirty\(false\)/);
    expect(s).toMatch(/editSeq\.current !== es\) return setMsg\(\{ t: '도면을/);
    expect(s).toMatch(/editSeq\.current !== es\) return setMsg\(\{ t: `불러오는 사이/);
    expect(s).toMatch(/\+\+listSeq\.current/);
    expect(s).toMatch(/const okLeave = \(\) => !live\.current\.dirty/);
  });
});
