import { expect, test, vi } from 'vitest';
// UI-SIMPLIFY v3 U2-a(§4 Main·MDrive·MHome): 미수신≠꺼짐 · 상태 오래됨/끊김 구분 · 영상 칩 · 막힌 방향 안내 · 안전 한 줄(보장 표현 0) · 낡은 운영 문구 제거.
vi.mock('../../src/data/shared', () => ({ refreshShared: () => {}, reread: () => {} }));
(globalThis as any).window = globalThis;
Object.assign(globalThis, { location: { href: 'http://127.0.0.1/', protocol: 'http:', hash: '', search: '', pathname: '/' }, addEventListener: () => {}, document: { hidden: false, addEventListener: () => {}, querySelectorAll: () => [] } });
import mainSrc from '../../src/screens/Main.tsx?raw';
import mainView from '../../src/screens/Main.view.tsx?raw';
import mdriveSrc from '../../src/screens/MDrive.tsx?raw';
import mhomeSrc from '../../src/screens/MHome.tsx?raw';
import mhomeView from '../../src/screens/MHome.view.tsx?raw';
import chipSrc from '../../src/app/chip.tsx?raw';
import canvasSrc from '../../src/map/MapCanvas.tsx?raw';
import pickSrc from '../../src/map/MapPick.tsx?raw';
import quadSrc from '../../src/app/OpsQuad.tsx?raw';
const { headChips, camChip } = await import('../../src/app/status');
const { dirWhy } = await import('../../src/app/drive');
const { stageOf } = await import('../../src/data/drive_stage');
const F = await import('../../src/data/facts');
const code = (s: string) => s.replace(/(^|\s)\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');   // 주석 제외(운영 글·코드만)

const ST = { role: 'control', latch: false, sim_block: '', holder: null, sim_start: { ok: true, why: '', session: null } };
const link = (o: any) => headChips({ provider: 'simulation_gate', linkOk: false, everMsg: true, authEnd: false, bad: null, st: ST as any, viewOnly: false, linkTxt: 'x', roleTxt: '', latch: false, ...o }).find((c) => c.k === 'link')!;

test('링크: 소켓 열림 + 상태 안 옴 = 상태 오래됨(warn) · 소켓 닫힘 = 연결 끊김(bad) · 첫 연결 전 = 연결 중', () => {
  expect(`${link({ open: true }).tone}:${link({ open: true }).text}`).toBe('warn:상태 오래됨');
  expect(`${link({ open: false }).tone}:${link({ open: false }).text}`).toBe('bad:연결 끊김');
  expect(link({ open: true, everMsg: false }).text).toBe('연결 중');
});

test('영상 칩: 확인된 꺼짐만 off · 대기/없음은 warn(미확인≠꺼짐) · 12자 이하', () => {
  const c = (camOk: boolean, camTxt: string) => { const x = camChip({ camOk, camTxt }); return `${x.tone}:${x.text}`; };
  expect([c(true, '정상'), c(false, '꺼짐 (시뮬 정지)'), c(false, '리셋 후 대기'), c(false, '새 프레임 대기'), c(false, '미수신')])
    .toEqual(['ok:영상 받음', 'off:영상 꺼짐', 'warn:영상 대기', 'warn:영상 대기', 'warn:영상 없음']);
  for (const s of ['영상 받음', '영상 꺼짐', '영상 대기', '영상 없음']) expect(s.length).toBeLessThanOrEqual(12);
});

test('막힌 방향: 누르는 동안 서버 «미검증» 이유가 처음 보일 때 1회만 안내 · 안 누르면 0', () => {
  const r = '후진 미검증 — 보내지 않음';
  expect(dirWhy('', true, r)).toEqual([r, `${r} · ${F.DIR_TAG}`]);
  expect(dirWhy(r, true, r)).toEqual([r, null]);              // 같은 이유 반복 = 토스트 0
  expect(dirWhy(r, false, r)).toEqual(['', null]);            // 손 떼면 초기화
  expect(dirWhy('', true, '조종 가능')).toEqual(['', null]);   // 미검증 아닌 이유 = 0
});

test('단계 문구: 시뮬 미수신·끊김을 «꺼져/꺼짐»으로 단정하지 않음', () => {
  for (const sb of ['시뮬 상태 미수신', '시뮬 상태 끊김']) {
    const s = stageOf({ linkOk: true, linkTxt: '정상', st: { ...ST, sim_block: sb } as any, viewOnly: false, fallen: false, newVer: false, block: null });
    expect(s.next).not.toMatch(/꺼져|꺼짐/); expect(s.next).toMatch(/확인 안 됨/);
  }
});

test('안전 한 줄: STOP 뜻 + ? 안에 STOP_TIP·관측값 한정·재움직임·시험 조건 · 보장 표현 0', () => {
  const sl = chipSrc.slice(chipSrc.indexOf('export function SafeLine'), chipSrc.indexOf('export const DirTag'));
  for (const k of ['SAFE_LINE', 'STOP_TIP', 'SAFE_NOTE', 'STOP_FACT', 'RELURCH', 'TRIAL_SAFE']) expect(sl).toContain(k);
  expect(F.SAFE_LINE).toMatch(/입력 차단·잠금/); expect(F.SAFE_LINE).toMatch(/다시 움직일 수/);
  for (const s of [F.SAFE_LINE, F.SAFE_NOTE]) expect(s).not.toMatch(/보장(?!이 아닙)|반드시 멈|안전합니다/);
  expect(F.SAFE_NOTE).toMatch(/보장이 아닙니다/);
  // 세 화면 모두 안전 한 줄을 보인다(MDrive 가로·세로 둘, MHome STOP 밑)
  expect(mainSrc.match(/<SafeLine \/>/g)!.length).toBeGreaterThanOrEqual(2);
  expect(mdriveSrc).toMatch(/<SafeLine className="drv-safe" \/>/); expect(mdriveSrc).toMatch(/<\/div>\n {4}<SafeLine \/>/);
  expect(mhomeSrc).toMatch(/safe: <p[^>]*><SafeLine \/><\/p>/); expect(mhomeView).toMatch(/\{v\.safe \?\? null\}/);
});

test('Main: 시뮬 꺼짐 단정·시작 버튼 제거 · 리셋 버튼 숨김 · 조종 반납 이름 · STOP 줄바꿈 안 줄어듦', () => {
  expect(code(mainSrc)).not.toMatch(/시뮬 꺼짐|SimOff|startSimAsk|조종권 반납|Gazebo 렌더|GT /);
  expect(mainSrc).toMatch(/b3P: \{ hidden: true \}/);
  expect(mainSrc).toMatch(/b2T: '조종 반납'/); expect(mainSrc).toMatch(/hidden: role !== 'control'/);
  expect(mainView).toMatch(/"flexWrap":"wrap"/); expect(mainView).toMatch(/"flexShrink":"?0/);
  expect(mainSrc).toMatch(/siteNode: <span data-dev>/);
});

test('MDrive·MHome 운영 문구: 조종 반납 · 막힌 방향 라벨 · 낡은 문구 0', () => {
  expect(code(mdriveSrc)).not.toMatch(/조종권 반납|Gazebo 렌더 카메라|BAND_H/);
  expect(mdriveSrc).toMatch(/앞만\(뒤·옆✕\)/); expect(mdriveSrc).toMatch(/<DirTag \/>/); expect(mdriveSrc).toMatch(/useDirWhy\(\)/);
  expect(mdriveSrc).toMatch(/<p data-dev>\{`화면 판/); expect(mdriveSrc).toMatch(/\{TRIAL_SAFE\}<span data-dev>/);
  expect(code(mhomeSrc)).not.toMatch(/Go2 시뮬 · v2|배터리 미제공/); expect(mhomeView).not.toMatch(/명령 0·잠금/);
  expect(mhomeView).toMatch(/입력 차단·잠금/);
});

// ── U2-b: Main 지도 패널·보조 뷰(다른 화면 MapCanvas 글은 lean 없으면 그대로 — U3~5)
test('U2-b 지도 캔버스(lean=Main 만): 가운데 위치 없음 하나 · 주황 띠 0 · 로봇 중심 회색+이유 · 1 m 축척만', () => {
  expect(mainSrc).toMatch(/<MapCanvas name="main" lean /);
  expect(canvasSrc).toMatch(/o\.small \|\| o\.lean \? '위치 없음'/);
  expect(canvasSrc).toMatch(/const why = !o\.lean && v\.mode === 'robot'/);           // 띠는 lean 아닐 때만(다른 화면 글 무변경)
  expect(canvasSrc).toMatch(/rb\.classList\.toggle\('lv-why', !!w\)/); expect(canvasSrc).toMatch(/if \(w\) toast\(w\)/);
  expect(canvasSrc).toMatch(/if \(!o\.small && o\.lean\) \{[^\n]*\n[^\n]*\n\s*g\.font = '12px sans-serif'; g\.fillStyle = C\.mut; g\.fillText\('1 m'/);
});

test('U2-b 지도 보기(overlay=Main 만): 라벨 + ? · 보는 지도 ≠ 실행 지도 + ?(원문) · 선택지에 GT 0', () => {
  expect(pickSrc).toMatch(/\{overlay \? <span[^>]*>지도 보기<Help label="지도 보기 · 설명">화면만 바뀜 · 시뮬은 그대로<\/Help>/);
  expect(pickSrc).toMatch(/\{diff && overlay && <span[^>]*>보는 지도 ≠ 실행 지도<Help [^>]*>\{diff\}<\/Help>/);
  const sel = pickSrc.slice(pickSrc.indexOf('{overlay ? <select'), pickSrc.indexOf('</select>'));
  expect(sel).not.toMatch(/GT|Gazebo|world/);
});

test('U2-b 관제 패널·보조 뷰: 실행 대상 전환 숨김 · 제목 짧게 · 칸 종류 구분 · 접힘 버튼 하나', () => {
  expect(code(mainSrc)).toMatch(/modePick: null/); expect(code(mainSrc)).not.toMatch(/<ModePick|시뮬 도면/);
  for (const l of ["'시뮬 외부 영상'", "'라이다 · 로봇 기준(한 스캔·누적 아님)'", "'점군 · 지도 기준 누적'"]) expect(quadSrc).toContain(`label: ${l}`);
  expect(code(quadSrc)).not.toMatch(/Gazebo|3인칭|보조 뷰 2칸/);
  expect(quadSrc).toMatch(/'외부 카메라 · 점군 ›'/); expect(quadSrc).toMatch(/<Help label="외부 카메라 · 점군 · 지금 이유">/);
});

// ── U2 보완(root GO): A1 서버 이유 · ⑧ 링크 표시 · A4 RTT · A3 새 누름 · B1~B3 · P2
const { srvWhy } = await import('../../src/data/drive_stage');
const { dirListener } = await import('../../src/app/drive');
const LK = await import('../../src/data/link');
const quad = quadSrc;
const In0 = { linkOk: true, linkTxt: '정상', viewOnly: false, fallen: false, newVer: false, block: null as string | null };
const NEU = '손을 한 번 뗀 뒤 다시 누르세요';

test('A1: 조종 가능인데 서버가 막는 이유(새 누름 등)는 단계·본문에 · 클라이언트 막힘/잠금/보기 전용/빈 이유면 0', () => {
  const st = { ...ST, reason: NEU } as any;
  expect(srvWhy({ ...In0, st })).toBe(NEU);
  const g = stageOf({ ...In0, st }); expect(g.i).toBe(3); expect(g.stop).toContain(NEU);   // «조종 가능»만 말하지 않음
  expect(stageOf({ ...In0, st: { ...ST, reason: '' } as any }).stop).toBeNull();            // 막힘 풀림 = 서버가 '' → 조종 가능
  for (const x of [{ block: 'STOP 잠금' }, { st: { ...st, latch: true } }, { viewOnly: true }, { st: { ...st, role: 'view_other' } }, { linkOk: false }])
    expect(srvWhy({ ...In0, st, ...x } as any)).toBeNull();
  expect(code(mainSrc)).toMatch(/noTxt \? `이동하려면: \$\{noTxt\}` : sw \? `지금 안 움직임: \$\{sw\}` : ctl \?/);
  expect(code(mainSrc)).toMatch(/const sw = srvWhy\(\{[^}]*block: no \}\)/);                 // 실제 발행 판정(driveBlock)과 같은 block
});

test('⑧ 링크 표시: 본문 «링크 끊김» 단정 대신 연결 상태 글 · 넘어짐이면 다음 행동에 대처 먼저(판정 무변경)', () => {
  expect(code(mainSrc)).toMatch(/no && no\.startsWith\('링크 끊김'\) \? `링크 \$\{v\.linkTxt\}` : no/);
  const f = stageOf({ ...In0, viewOnly: true, fallen: true, st: ST as any });
  expect(f.i).toBe(0); expect(f.next).toMatch(/^넘어짐 — /); expect(f.next).toContain('«조종 시작»');
  expect(stageOf({ ...In0, fallen: true, linkOk: false, st: ST as any }).next).not.toMatch(/넘어짐/);   // 막힘이 있으면 막힘 안내 그대로
});

test('A4 RTT: 미측정·확인 못 함·확인 중을 «느림»으로 말하지 않음', () => {
  expect(code(mainSrc)).not.toMatch(/응답 느림|느림/);
  expect(code(mainSrc)).toMatch(/text=\{rtt\.txt\.replace\('앱↔관문 ', '관문 '\)\}/);
  expect(code(mdriveSrc)).not.toMatch(/느림/);
});

test('A3 방향 안내: 빠른 놓기→재누름(사이 status 없음)도 누름마다 1회 · 같은 누름 반복 0 · 실제 press/lift 경계', () => {
  LK.useLink.setState({ provider: 'simulation_gate', open: true, lastMsg: performance.now(), bad: null, viewOnly: false, firstVer: 'v', st: { ...ST, ver: 'v', reason: '' } as any } as any);
  expect(LK.driveBlock()).toBeNull();
  const out: string[] = [], l = dirListener((t) => out.push(t)), r = '후진 미검증 — 보내지 않음', S = { st: { reason: r } };
  expect(LK.press('b', 1, { fx: -1, fy: 0, fw: 0 })).toBe(true); l(S); l(S); expect(out).toHaveLength(1);   // 같은 누름 = 1회
  LK.lift('b', 1); expect(LK.press('b', 2, { fx: -1, fy: 0, fw: 0 })).toBe(true); l(S);                       // 사이 status 0
  expect(out).toHaveLength(2);
  LK.lift('b', 2); l({ st: { reason: '' } }); expect(out).toHaveLength(2);
  expect(code(chipSrc + mainSrc)).not.toMatch(/pressN\+\+/);   // 계수는 link.ts press 성공에서만
});

test('B1 세로 띠: 조종 틀 예약 = 띠 실제 높이(safe-area·줄바꿈 포함) · 띠 크기 변화도 다시 맞춤', async () => {
  const dsrc = (await import('../../src/app/drive.tsx?raw')).default;
  expect(code(dsrc)).toMatch(/innerHeight - t - \(por \? bandH\(px\('paddingBottom'\)\) : px\('paddingBottom'\)\)/);
  expect(code(dsrc)).toMatch(/querySelector\('\.drv-band'\)\?\.getBoundingClientRect\(\)\.height/);
  expect(code(dsrc)).toMatch(/new ResizeObserver\(fit\)/); expect(code(dsrc)).toMatch(/ro\?\.disconnect\(\)/);
});

test('B3 가로 MDrive: 안전 줄은 HUD 흐름 마지막 줄(절대 위치 0) · 옆 버튼·사진은 원래 자리', () => {
  const huds = mdriveSrc.slice(mdriveSrc.indexOf('huds: <>'), mdriveSrc.indexOf('side: <>'));
  expect(huds).toMatch(/<SafeLine className="drv-safe" \/><\/>/);
  expect(mdriveSrc.slice(mdriveSrc.indexOf('side: <>'), mdriveSrc.indexOf('banner:'))).not.toMatch(/SafeLine/);
  expect(mdriveSrc).toMatch(/\.drv-safe\{flex:1 1 100%;max-width:calc\(100% - 12px\);/);   // 줄바꿈 뒤 옆 버튼(오른쪽 열 시작 = HUD 오른쪽 끝 −2 px)과 겹침 0 expect(mdriveSrc).not.toMatch(/\.drv-safe\{[^}]*position:absolute/);
  expect(mdriveSrc).toMatch(/right: '44px', top: '86px', display: 'flex'/); expect(mdriveSrc).toMatch(/right: '44px', top: '138px', width: '72px'/);
});

test('B2 Main 폰 머리줄: 칩 묶음 줄바꿈·가로 스크롤 0·칩 축소 0(≤700·가로 폰)', async () => {
  const fsm = 'node:fs';   // 형식 선언 없는 node 모듈 — 이름을 변수로(tsc 해석 0, vitest 실행만). css ?raw 는 vitest 에서 빈 글
  const css: string = (await import(/* @vite-ignore */ fsm)).readFileSync(new URL('../../src/live.css', import.meta.url), 'utf8');
  const grp = [...css.matchAll(/\[data-main\] \.fh header>div\[style\*="justify-content: flex-end"\]\{([^}]*)\}/g)].map((m) => m[1]);
  expect(grp).toHaveLength(2);
  for (const g of grp) { expect(g).toMatch(/flex-wrap:wrap!important/); expect(g).not.toMatch(/nowrap|overflow-x:auto/); }
  expect(css.match(/\[data-main\] \.fh header>div\[style\*="justify-content: flex-end"\]>\*\{flex:0 0 auto!important\}/g)).toHaveLength(2);
  expect(css).not.toMatch(/\[data-main\] \.fh header\{[^}]*flex-wrap:nowrap/);
  expect(css).toMatch(/\.qd\{--qa:calc\(100vh - 194px\);scroll-margin-top:112px\}/);   // 가로 폰 머리줄 2줄(실측 105 px) → 2×2 화면 안
});

test('P2 Main 전체화면: STOP 옆 안전 한 줄 + ?', () => {
  const fs = quad.slice(quad.indexOf('function FsStop'));
  expect(fs).toMatch(/<SafeLine style=/); expect(fs.indexOf('lv-stop')).toBeLessThan(fs.indexOf('<SafeLine'));
});
