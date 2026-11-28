// 화면 글 다듬기(11/28 · 글만): 시뮬 월드 목록 실패 한 줄 · Gazebo 를 못 고르는 까닭 한 줄 · 화면 글의 긴 줄표 · 짧은 줄표 쓸기.
// 줄표 쓸기는 열린 PR 과 겹치지 않는 파일만(아래 SWEPT). 빈 값 자리 표시 «—» 하나짜리는 문장 줄표가 아니라 그대로 둔다
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sim } from '../phone';
import { SimLaunch } from '../simdrive';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Reply = { status: number; body?: unknown } | 'down';
const err = (status: number, code: string, message: string) => ({ status, body: { error: { code, message, detail: {} } } });
const WORLDS = { worlds: [{ id: 'empty', name: '빈 월드', description: '', spawn_floor_ids: ['l1'] }] };
function serve(worlds: Reply, robots: Reply = { status: 200, body: { items: [] } }) {
  vi.stubGlobal('fetch', async (url: string) => {
    const path = String(url).replace(/^\/api\/v1/, '').split('?')[0];
    const rep = path === '/simulation/worlds' ? worlds : path === '/simulation/robots' ? robots : err(404, 'NOT_FOUND', '찾을 수 없습니다.');
    if (rep === 'down') throw new TypeError('Failed to fetch');
    return new Response(JSON.stringify(rep.body), { status: rep.status, headers: { 'Content-Type': 'application/json' } });
  });
}
const flush = () => act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); });
let root: Root | null = null, box: HTMLDivElement;
afterEach(() => { act(() => root?.unmount()); root = null; box?.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); sim.clear(); });

const LIST_FAIL = '시뮬 월드 목록을 받지 못했습니다 · 서버 연결을 확인한 뒤 다시 여세요.';
/** 목록 실패 한 줄(검토 N1): «서버 연결을 확인» 은 서버에 닿지 못했을 때만. 닿았는데 거절 · 오류면 코드 + 까닭 한 줄. 서버 본문(«없음» 등)은 붙이지 않음 */
const WHY: [string, Reply, string][] = [
  ['서버에 닿지 않음(TypeError)', 'down', '을 받지 못했습니다 · 서버 연결을 확인한 뒤 다시 여세요.'],
  ['401', err(401, 'AUTH_REQUIRED', '없음'), '을 받지 못했습니다 (401) · 로그인이 끝났습니다. 다시 로그인하세요.'],
  ['403', err(403, 'FORBIDDEN', '없음'), '을 받지 못했습니다 (403) · 이 목록을 볼 권한이 없습니다.'],
  ['500', err(500, 'INTERNAL_ERROR', '없음'), '을 받지 못했습니다 (500) · 서버 오류입니다. 잠시 뒤 다시 여세요.'],
  ['502', err(502, 'BAD_GATEWAY', '없음'), '을 받지 못했습니다 (502) · 서버 오류입니다. 잠시 뒤 다시 여세요.'],
  ['404 그 밖', err(404, 'NOT_FOUND', '없음'), '을 받지 못했습니다 (404) · 요청을 처리하지 못했습니다. 다시 여세요.'],
];
describe('시뮬 월드 목록을 받지 못함 = 까닭 + 다음 할 일 한 줄', () => {
  for (const [how, rep, tail] of WHY) it(how, async () => {
    serve(rep);
    await act(async () => { await sim.load(); });
    expect(sim.get().err).toBe(`시뮬 월드 목록${tail}`);
    expect(sim.get().err).not.toContain('없음');
  });
});
describe('내 시뮬 로봇 목록을 받지 못함 = 같은 꼴', () => {
  for (const [how, rep, tail] of WHY) it(how, async () => {
    serve({ status: 200, body: WORLDS }, rep);
    await act(async () => { await sim.load(); });
    expect(sim.get().err).toBe(`내 시뮬 로봇 목록${tail}`);
    expect(sim.get().err).not.toContain('없음');
  });
  it('시뮬 관리자가 증명한 까닭(SIM_UNAVAILABLE · manager_unreachable)은 그 문구가 먼저', async () => {
    serve({ status: 200, body: WORLDS }, { status: 503, body: { error: { code: 'SIM_UNAVAILABLE', message: 'x', detail: { reason: 'manager_unreachable' } } } });
    await act(async () => { await sim.load(); });
    expect(sim.get().err).toBe('시뮬 관리자가 꺼져 있습니다. 관리자를 다시 켠 뒤 정리하세요.');
  });
});

/** PC «시뮬» 띄우기 칸: Gazebo(서버 계산)는 지금 고를 수 없으면 «준비 중» 이 아니라 실제 까닭 한 줄 · 고를 수 없음 */
async function launchPc() {
  window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  box = document.createElement('div'); document.body.append(box);
  act(() => { root = createRoot(box); root.render(<SimLaunch me="u-lee" view />); });
  await flush();
  const gz = box.querySelector<HTMLInputElement>('input[name="sim-engine"][value="gazebo"]')!;
  return { gz, note: gz.closest('label')!.querySelector('small')!.textContent };
}
describe('Gazebo 를 못 고를 때 까닭 한 줄(t18)', () => {
  it('월드 목록을 받지 못함', async () => {
    serve('down');
    const { gz, note } = await launchPc();
    expect(gz.disabled).toBe(true);
    expect(note).toBe('서버에서 계산 · 월드 목록을 받지 못해 지금 고를 수 없음');
    const line = box.querySelector<HTMLElement>('[data-sim-msg]')!;
    expect(line.textContent).toBe(LIST_FAIL);
    expect(line.style.wordBreak).toBe('keep-all');   // 좁은 폰에서 «여 / 세요» 처럼 낱말 가운데서 끊지 않게(이 줄만)
  });
  it('서버에 띄울 월드가 없음', async () => {
    serve({ status: 200, body: { worlds: [] } });
    const { gz, note } = await launchPc();
    expect(gz.disabled).toBe(true);
    expect(note).toBe('서버에서 계산 · 서버에 띄울 월드가 없어 지금 고를 수 없음');
  });
  it('시뮬 관리자에 닿지 않음', async () => {
    serve({ status: 200, body: WORLDS }, { status: 200, body: { items: [], manager_error: 'SIM_UNAVAILABLE' } });
    const { gz, note } = await launchPc();
    expect(gz.disabled).toBe(true);
    expect(note).toBe('서버에서 계산 · 시뮬 관리자에 닿지 않아 지금 고를 수 없음');
  });
  it('고를 수 있으면 «서버에서 계산» 만', async () => {
    serve({ status: 200, body: WORLDS });
    const { gz, note } = await launchPc();
    expect(gz.disabled).toBe(false);
    expect(note).toBe('서버에서 계산');
    expect(box.textContent).not.toContain('준비 중');
  });
});

// t19: 화면 글(문자열 · JSX 글)에 긴 줄표(—) · 짧은 줄표(–) 없음. 주석은 보지 않는다
const SRC = import.meta.glob<string>(['../*.ts', '../*.tsx', '../screens/*.ts', '../screens/*.tsx'], { eager: true, query: '?raw', import: 'default' });
export const SWEPT = ['drivemedia.ts', 'extview.ts', 'go2model.tsx', 'lidar3d.tsx', 'lidarmap.tsx', 'media.ts', 'nearby.tsx', 'quad.tsx', 'run.tsx',
  'screens/actiontrial.tsx', 'screens/btedit.tsx', 'screens/history.tsx', 'screens/lifecycle.ts', 'screens/mapmake.tsx', 'screens/mapscen.tsx',
  'screens/scennode.tsx', 'screens/terrain.tsx', 'simstart.tsx', 'simwin.tsx', 'theme.tsx',
  'screens/phonelogin.tsx', 'screens/norobot.tsx', 'screens/takeover.tsx', 'screens/phonescan.tsx', 'screens/scanentry.tsx'];
/** 주석을 빼고 남긴 코드(문자열 · JSX 글 포함) */
function code(src: string) {
  let out = '', mode: '' | "'" | '"' | '`' | 'line' | 'block' = '';
  for (let i = 0; i < src.length; i++) {
    const c = src[i], nx = src[i + 1];
    if (!mode) {
      if (c === '/' && nx === '/' && src[i - 1] !== ':') { mode = 'line'; i++; continue; }
      if (c === '/' && nx === '*') { mode = 'block'; i++; continue; }
      if (c === "'" || c === '"' || c === '`') mode = c;
      out += c; continue;
    }
    if (mode === 'line') { if (c === '\n') { mode = ''; out += c; } continue; }
    if (mode === 'block') { if (c === '*' && nx === '/') { mode = ''; i++; } else if (c === '\n') out += c; continue; }
    out += c;
    if (c === '\\') { out += nx; i++; continue; }
    if (c === mode || (c === '\n' && mode !== '`')) mode = '';
  }
  return out;
}
/** 빈 값 자리 표시(«—» 하나: '—' · "—" · >—< · {'—'}) 는 문장 줄표가 아니다 */
const dashes = (src: string) => code(src).split('\n').map((l, k) => [k + 1, l.replace(/(['"`>])—(['"`<])/g, '$1$2')] as const)
  .filter(([, l]) => /[—–]/.test(l)).map(([k, l]) => `${k}: ${l.trim().slice(0, 80)}`);
// t19 (11-28 조정 결정): 빈 칸 자리 표시도 말로. 기록 표 「로봇·사람」 빈 칸 = 「없음」, 실행 보고 구간 걸린 시간 = 「계산 못함」, id 는 있는데 이름을 모르면 「이름 모름」
describe('빈 칸 자리 표시도 줄표 대신 말(t19)', () => {
  for (const f of ['screens/history.tsx', 'screens/runreport.tsx']) it(f, () => {
    expect(code(SRC[`../${f}`]).split('\n').filter((l) => /[—–]/.test(l))).toEqual([]);
  });
});
describe('화면 글에 줄표 없음(t19)', () => {
  for (const f of SWEPT) it(f, () => {
    const src = SRC[`../${f}`];
    expect(src, f).toBeTruthy();
    expect(dashes(src)).toEqual([]);
  });
});

// t19 둘째 (11-28 조정): 지도 보기 안내 · 시나리오 경로 거리 설명의 문장 줄표만. 같은 파일의 다른 줄은 열린 PR 과 겹치지 않게 뒤로
describe('지도 보기 안내 · 경로 거리 설명에 줄표 없음(t19)', () => {
  it('maps.tsx 「보기만」 안내', () => {
    expect(code(SRC['../screens/maps.tsx'])).toContain("'보기만. «편집»을 누르면 도구가 나옵니다'");
    expect(code(SRC['../screens/maps.tsx'])).not.toMatch(/보기만 [—–]/);
  });
  it('missions.tsx 예상 거리 설명', () => {
    expect(code(SRC['../screens/missions.tsx'])).toContain('m <span className="lbl">· 지점 사이 직선과');
    expect(code(SRC['../screens/missions.tsx'])).not.toMatch(/[—–] 지점 사이 직선과/);
  });
});

// t19 셋째 (11-28 조정 «가»): 열린 PR 하나에만 걸린 네 파일 중 그 PR 이 고치는 줄(앞뒤 3 줄)과 먼 화면 글만.
// go2status.tsx 30 · 31 · 55(빈 값 «—») · 135 줄과 terrain3d.tsx 252 줄은 #389 · #546 과 겹쳐 뒤로
describe('네 파일 화면 글 줄표(t19 셋째)', () => {
  for (const f of ['screens/mapedit.tsx', 'screens/voxel3d.tsx']) it(`${f} 줄표 없음`, () => {
    expect(dashes(SRC[`../${f}`])).toEqual([]);
  });
  it('go2status.tsx 현장 코드 · 응답 없음 안내', () => {
    const c = code(SRC['../go2status.tsx']);
    for (const t of ['현장 코드가 틀렸거나 만료됐습니다. 로봇 쪽 코드를', '로봇이 잠시 막았습니다. ${', "'응답 없음(3초). 같은 Wi-Fi", '현장 코드 8자리. 로봇이 맞는지']) expect(c).toContain(t);
  });
});
