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
test('U2-b 지도 캔버스(lean=Main 만): 가운데 위치 없음 하나 · 주황 띠 0 · 로봇 중심 회색+이유 · 축척만', () => {
  expect(mainSrc).toMatch(/<MapCanvas name="main" lean /);
  expect(canvasSrc).toMatch(/o\.small \|\| o\.lean \? '위치 없음'/);
  expect(canvasSrc).toMatch(/const why = !o\.lean && v\.mode === 'robot'/);           // 띠는 lean 아닐 때만(다른 화면 글 무변경)
  expect(canvasSrc).toMatch(/rb\.classList\.toggle\('lv-why', !!w\)/); expect(canvasSrc).toMatch(/if \(w\) toast\(w\)/);
  expect(canvasSrc).toMatch(/if \(!o\.small && o\.lean\) \{[^\n]*\n\s*if \(sb\) \{ const L = sb\.L;[^\n]*\n\s*g\.font = '12px sans-serif'; g\.fillStyle = C\.mut; g\.fillText\(sb\.t, 15 \+ L/);
});

// ── U2-b 보완(root «U2-b 보완 GO — code B1 HOLD»): 축척 길이 = 표시 거리 · 버튼 이유 상태별 · 좁은 칸 배치 · 라이다 라벨
const MC = await import('../../src/map/MapCanvas');
test('U2-b 보완 B1: 축척 막대 길이 = 표시 거리 × 실제 배율(k<4 반례 포함) · 못 맞추면 막대 0', () => {
  // codex 반례: 200 px 칸 · 범위 −10~10 m · 최저 배율 .25 → k ≈ 2.27 px/m. 옛 코드는 4 px 에 «1 m»(실제 1.76 m)
  const k = Math.min(200 / 22, 200 / 22) * 0.25, b = MC.scaleBar(k, Math.min(120, 200 / 2 - 40))!;
  expect(b.d).toBe(20); expect(b.t).toBe('20 m'); expect(b.L).toBeCloseTo(20 * k, 9); expect(b.L / k).toBeCloseTo(20, 9);
  expect(MC.scaleBar(40, 120)).toEqual({ d: 1, L: 40, t: '1 m' });                     // 보통 배율 = 1 m 그대로(길이 = k)
  expect(MC.scaleBar(300, 120)).toEqual({ d: 0.2, L: 60, t: '20 cm' });                // 크게 확대 = 칸 넘는 1 m 막대 대신 짧은 거리
  for (const bad of [0, -1, NaN, Infinity]) expect(MC.scaleBar(bad, 120)).toBeNull();
  expect(MC.scaleBar(5, 20)).toBeNull();                                                // 칸이 좁아 최소 길이도 못 그림 = 막대 0
  for (let k2 = 0.01; k2 < 5000; k2 *= 1.07) {                                          // 배율 전 범위: 막대 px 와 글 거리가 늘 같은 것을 말함
    const r = MC.scaleBar(k2, 120); if (!r) continue;
    expect(r.L).toBeCloseTo(r.d * k2, 9); expect(r.L).toBeGreaterThanOrEqual(24); expect(r.L).toBeLessThanOrEqual(120);
    expect(r.t).toBe(r.d < 1 ? `${Math.round(r.d * 100)} cm` : `${r.d} m`);
  }
  expect(canvasSrc).toMatch(/const sb = !o\.small && o\.lean && !rs\?\.noGrid \? scaleBar\(k,/);   // 층 나란히(복합 그림) = 축척 0
  expect(canvasSrc).not.toMatch(/Math\.max\(4, k\)/);
});

test('U2-b 보완 B2: 로봇 중심 버튼 이유 — 그림 없음 / 결속 없음 / 갱신 중 / 위치 없음 / 오래됨 구분 · 신선하면 빈 글 · blank 에도 갱신', () => {
  const R = (fresh: boolean) => ({ x: 0, y: 0, t: 0, fresh });
  expect(MC.robotWhy({ lean: true, blank: true, r: null })).toMatch(/^지도 그림 없음/);
  expect(MC.robotWhy({ lean: true, noRobot: true, r: null })).toMatch(/^이 지도에 결속된 위치 없음/);
  expect(MC.robotWhy({ lean: true, noRobot: true, upd: true, r: null })).toMatch(/^지도 갱신 중 — 위치 표시 잠시 끔/);
  expect(MC.robotWhy({ lean: true, r: null })).toMatch(/^위치 없음 —/);
  expect(MC.robotWhy({ lean: true, r: R(false) })).toMatch(/^위치 오래됨 —/);
  expect(MC.robotWhy({ lean: true, r: R(true) })).toBe('');
  expect(MC.robotWhy({ lean: false, noRobot: true, r: null })).toBe('');               // 다른 화면(lean 없음) 무변경
  for (const w of [MC.robotWhy({ lean: true, noRobot: true, r: null }), MC.robotWhy({ lean: true, blank: true, r: null })]) expect(w).not.toMatch(/^위치 없음|위치 오래됨|따라감/);
  const blankPath = canvasSrc.slice(canvasSrc.indexOf('if (o.blank != null && !o.raster)'), canvasSrc.indexOf('const rs = o.raster'));
  expect(blankPath).toMatch(/sync\(robotWhy\(\{ lean: o\.lean, blank: true, r: null \}\)\); return;/);
  expect(canvasSrc).toMatch(/sync\(robotWhy\(\{ lean: o\.lean, noRobot: o\.noRobot, upd: !!rs\?\.upd, r \}\)\);/);
  expect(canvasSrc).toMatch(/if \(w\) toast\(w\); f\(\); draw\(\);/);                    // 누름 = 토스트 + 보기만 전환(명령 0) 그대로
});


test('U2-b 지도 보기(overlay=Main 만): 라벨 + ? · 보는 지도 ≠ 실행 지도 + ?(원문) · 선택지에 GT 0', () => {
  expect(pickSrc).toMatch(/\{overlay \? <span[^>]*>지도 보기<Help label="지도 보기 · 설명">화면만 바뀜 · 시뮬은 그대로<\/Help>/);
  expect(pickSrc).toMatch(/\{diff && overlay && <span[^>]*>보는 지도 ≠ 실행 지도<Help [^>]*>\{diff\}<\/Help>/);
  const sel = pickSrc.slice(pickSrc.indexOf('{overlay ? <select'), pickSrc.indexOf('</select>'));
  expect(sel).not.toMatch(/GT|Gazebo|world/);
});

test('U2-b 관제 패널·보조 뷰: 실행 대상 전환 숨김 · 제목 짧게 · 칸 종류 구분 · 접힘 버튼 하나', () => {
  expect(code(mainSrc)).toMatch(/modePick: null/); expect(code(mainSrc)).not.toMatch(/<ModePick|시뮬 도면/);
  for (const l of ["'시뮬 외부 영상'", "'라이다 센서 기준 · 한 스캔'", "'점군 · 지도 기준 누적'"]) expect(quadSrc).toContain(`label: ${l}`);
  expect(quadSrc).not.toMatch(/로봇 기준\(한 스캔/); expect(quadSrc).not.toMatch(/점군: \$\{p\}/);   // 보완 ④: 몸 중심 오해 0 · «점군: 지도 누적:» 콜론 겹침 0
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
  const g = stageOf({ ...In0, st }); expect(g.i).toBe(3); expect(g.stop).toContain(NEU);   // 단계 번호는 그대로(i=3) · 막힘에 이유 원문
  expect(stageOf({ ...In0, st: { ...ST, reason: '' } as any }).stop).toBeNull();            // 막힘 풀림 = 서버가 '' → 조종 가능
  for (const x of [{ block: 'STOP 잠금' }, { st: { ...st, latch: true } }, { viewOnly: true }, { st: { ...st, role: 'view_other' } }, { linkOk: false }])
    expect(srvWhy({ ...In0, st, ...x } as any)).toBeNull();
  expect(code(mainSrc)).toMatch(/noTxt \? `이동하려면: \$\{noTxt\}` : sw \? `입력 적용 안 됨: \$\{sw\}` : ctl \?/);
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
  expect(mdriveSrc).toMatch(/\.drv-safe\{flex:1 1 100%;max-width:calc\(100% - 12px\);/);   // 줄바꿈 뒤 옆 버튼(오른쪽 열 시작 = HUD 오른쪽 끝 −2 px)과 겹침 0
  expect(mdriveSrc).not.toMatch(/\.drv-safe\{[^}]*position:absolute/);   // R ⑤: 3793b60 에선 이 줄이 // 주석 뒤에 붙어 실행 안 됨 → 별도 줄로
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

test('U2-b 보완 P2: Main 좁은 지도 칸 — lean 만 data-mapnarrow · 지도 보기 폭 확보 · 버튼 32 px 오른쪽 열(칸 안)', async () => {
  const fsm = 'node:fs';
  const css: string = (await import(/* @vite-ignore */ fsm)).readFileSync(new URL('../../src/live.css', import.meta.url), 'utf8');
  expect(canvasSrc).toMatch(/box\.dataset\.mapnarrow = mapNarrow\(o\.lean, o\.small, W, H\);/);   // M②: 식은 mapNarrow(아래 M② 시험)
  expect(canvasSrc.indexOf('box.dataset.mapnarrow')).toBeLessThan(canvasSrc.indexOf('if (o.blank != null && !o.raster)'));   // 그림 없음에도 배치 맞춤
  expect(pickSrc).toMatch(/className=\{overlay \? 'lv-mappick' : undefined\}/);
  expect(css).toMatch(/\[data-mapnarrow="1"\]>\.lv-mappick\{[^}]*max-width:calc\(100% - 84px\)!important/);
  expect(css).toMatch(/\[data-mapnarrow="1"\]>\.lv-mapbtns\{[^}]*width:68px/); expect(css).toMatch(/\[data-mapnarrow="1"\]>\.lv-mapbtns>\.lv-btn\{width:32px;min-height:32px/);
  expect(css).toMatch(/\[data-mapnarrow="1"\] \.lv-mapseg \.lv-btn\{min-height:32px/);
  // 세로 예산: 위 4 + 보기 방식 2칸 32·32 + 간격 4 + 확대·축소 32 = 104 ≤ 111(폰 2×2 실측 칸 높이)
  expect(4 + 32 + 32 + 4 + 32).toBeLessThanOrEqual(111);
});

// ── R 보완(root «379 재검토 HOLD·R보완 GO»): R1 «조종 가능» 표면 글 · R2 몸 정지 단정 0 · DirTag ? 창 기준 · N2 확인 중 톤
const DS = await import('../../src/data/drive_stage');
test('R1·R2: 서버가 입력을 적용 안 하는 동안 보이는 단계 글 «입력 막힘» · 막힘 = «입력 적용 안 됨 · 원문» · 몸 정지 단정 0 · 이유 없어지면 복귀', () => {
  const st = { ...ST, reason: NEU } as any, g = stageOf({ ...In0, st });
  expect(g.i).toBe(3); expect(DS.stepLabel(g)).toBe('입력 막힘'); expect(g.stop).toBe(`입력 적용 안 됨 · ${NEU}`);
  for (const t of [DS.stepLabel(g), g.stop!, g.next]) { expect(t).not.toMatch(/조종 가능|안 움직임|멈춤|정지함/); }
  const ok = stageOf({ ...In0, st: { ...ST, reason: '' } as any }); expect(DS.stepLabel(ok)).toBe('조종 가능'); expect(ok.label).toBeUndefined();   // 회복 = 기존 글
  for (const x of [{ st: { ...ST, role: 'view' } }, { st: { ...ST, latch: true } }, { block: 'STOP 잠금' }]) expect(stageOf({ ...In0, ...x } as any).label).toBeUndefined();   // 다른 단계 글 무변경
  const all = [mainSrc, mdriveSrc, F.SAFE_LINE].map(code).join('\n');
  expect(all).not.toMatch(/지금 안 움직임/); expect(code(mainSrc)).not.toMatch(/STEPS\[stg\.i\]/); expect(code(mdriveSrc)).not.toMatch(/STEPS\[stg\.i\]/);
  expect(code(mainSrc)).toMatch(/text=\{`단계 \$\{stepLabel\(stg\)\}`\}/); expect(code(mdriveSrc)).toMatch(/aria-label=\{`조종 단계 \$\{stepLabel\(stg\)\}/); expect(code(mdriveSrc)).toMatch(/\{stepLabel\(stg\)\}<\/span>/);
  // Main «조종 시작» 단추 글·설명: 표시만(startBlock·disabled 무변경)
  expect(code(mainSrc)).toMatch(/goT = L\.starting \?\? \(live \? \(sw \? '입력 막힘' : '조종 가능'\) : '조종 시작'\)/); expect(code(mainSrc)).toMatch(/disabled: !!sb,/);
  expect(code(mainSrc).indexOf('const sw = srvWhy(')).toBeLessThan(code(mainSrc).indexOf('const sb = startBlock(L)'));
});

test('R ③ DirTag 등 ? 팝오버: 활성 전체화면 요소 또는 body 로 portal(transform 조상 밖) · 서버 렌더는 제자리', async () => {
  const fsm = 'node:fs', rd = async (f: string) => (await import(/* @vite-ignore */ fsm)).readFileSync(new URL(f, import.meta.url), 'utf8') as string;
  const shell = await rd('../../src/app/shell.tsx');
  expect(shell).toMatch(/const topEl = \(\) => fsEl\(\) \|\| document\.body;/);
  expect(shell).toMatch(/export const InTop = [^\n]*useSyncExternalStore\(fsSub, topEl, \(\) => null\); return h \? createPortal\(children, h\) : <>\{children\}<\/>; \};/);
  expect(chipSrc).toMatch(/<InTop><span id=\{id\}[^\n]*className="lv-pop"[^\n]*<\/InTop>/); expect(code(chipSrc)).not.toMatch(/<InFs>/);
  expect(chipSrc).toMatch(/dropAll\(\);\n\s*const width/);   // 열 때 입력 폐기 그대로
});

test('N2: 관문 «확인 중»도 미확인 톤(warn) · 확인된 꺼짐만 off', () => {
  expect(code(mainSrc)).toMatch(/!rtt\.ok && <Chip tone="warn" text=\{rtt\.txt\.replace/); expect(code(mainSrc)).not.toMatch(/endsWith\('확인 중'\) \? 'off'/);
});

// ── M 보완 ①(670 P1, root «지도잔여 좁은M보완 GO»): 층 나란히 = link 연결당 지도 요청 하나 → 한 층씩 차례로 · 매 응답 뒤 재대조 · 첫 실패 중단
const MP = await import('../../src/data/maps');
const FL = (f: string) => ({ world_id: 'v5_building', building_id: 'v5', floor_id: f, map_version: 'gt-1', map_source: 'gt_raster' }) as any;
const RA = (f: string) => ({ img: null, res: 0.1, ox: -10, oy: -10, w: 200, h: 200, label: f }) as any;
// 가짜 link: 연결당 한 번에 하나(진행 중이면 «지도 요청 처리 중» — v2_link map_op 와 같은 규칙), 응답은 수동으로 풀어 줌
const fakeLink = (fail: Record<string, string> = {}) => {
  const q: Array<() => void> = [], calls: string[] = []; let busy = false, maxIn = 0, n = 0;
  const get = (m: any) => { calls.push(m.floor_id); if (busy) return Promise.resolve('지도 요청 처리 중'); busy = true; n++; maxIn = Math.max(maxIn, n);
    return new Promise<any>((res) => q.push(() => { busy = false; n--; res(fail[m.floor_id] ?? RA(m.floor_id)); })); };
  const flush = async () => { for (let i = 0; i < 20 && q.length; i++) { q.shift()!(); await new Promise((r) => setTimeout(r, 0)); } };
  return { get, flush, calls, max: () => maxIn };
};
test('M①: 두 층 GT 모두 정상 → 1층 다음 2층 순서 · 동시 요청 0 · 결과 2장(아래층부터)', async () => {
  const L = fakeLink(), p = MP.getFloors([FL('l1'), FL('l2')], () => true, L.get); await L.flush();
  const r = await p; expect(Array.isArray(r) && r.map((x: any) => x.label)).toEqual(['l1', 'l2']); expect(L.calls).toEqual(['l1', 'l2']); expect(L.max()).toBe(1);
  // 옛 방식(동시 2요청)은 같은 가짜 link 에서 둘째가 «처리 중»으로 거절 — 원결함 재현
  const O = fakeLink(), old = Promise.all([FL('l1'), FL('l2')].map(O.get)); await O.flush(); expect((await old)[1]).toBe('지도 요청 처리 중');
});
test('M①: 둘째 층 실패 → 층 이름 + 원문 · 부분 그림 0 · 재시도 0', async () => {
  const L = fakeLink({ l2: 'PNG 풀기 실패' }), p = MP.getFloors([FL('l1'), FL('l2')], () => true, L.get); await L.flush();
  expect(await p).toBe('2층 · PNG 풀기 실패'); expect(L.calls).toEqual(['l1', 'l2']);
  const E = fakeLink({ l1: '지도 없음' }), p2 = MP.getFloors([FL('l1'), FL('l2')], () => true, E.get); await E.flush();
  expect(await p2).toBe('1층 · 지도 없음'); expect(E.calls).toEqual(['l1']);   // 첫 실패에서 멈춤 — 둘째 층 요청 0
});
test('M①: 진행 중 선택 변경·새 연결(still 거짓) → null(버림) · 다음 층 요청 0', async () => {
  let ok = true; const L = fakeLink(), p = MP.getFloors([FL('l1'), FL('l2')], () => ok, L.get); ok = false; await L.flush();
  expect(await p).toBeNull(); expect(L.calls).toEqual(['l1']);
  // MapPick: 동시 요청 코드 0 · 최신 호출·선택·연결 세대 재대조 · 실패면 선택 유지 + 이유(자동 복귀 0)
  expect(code(pickSrc)).not.toMatch(/Promise\.all\(fs\.map\(getMap\)\)/);
  expect(code(pickSrc)).toMatch(/useEffect\(\(\) => \(\) => \{ allN\.current\+\+; \}, \[\]\);/);   // 화면 닫힘 = 남은 층 요청 0
  expect(code(pickSrc)).toMatch(/getFloors\(fs, \(\) => allN\.current === t0 && usePick\.getState\(\)\.sel === key && useLink\.getState\(\)\.gen === g0\)/);
  expect(code(pickSrc)).toMatch(/if \(rs === null\) return;\s*\n\s*if \(typeof rs === 'string'\) \{ setSerr\(rs\); return; \}\s*\n\s*setSaved\(stackFloors\(rs,/);
});

// ── M 보완 ②(670 P2 · Codex N3): Main 지도 칸 실제 영역에 맞춘 배치 — 지도 보기·전체 고정·로봇 중심·± 모두 칸 안 · 겹침 0 · 버튼 32 px 미만 0
test('M②: mapNarrow 크기별 — 폰 2×2 177×111 = 1 · 가로 4칸 354×65 = row · 좁고 낮음 162×101 = 1 · 큰 칸·PC·가로 2칸 = 기존 · 썸네일·다른 화면 = 기존', async () => {
  const { mapNarrow } = await import('../../src/map/MapCanvas');
  expect(mapNarrow(true, false, 177, 111)).toBe('1'); expect(mapNarrow(true, false, 354, 65)).toBe('row'); expect(mapNarrow(true, false, 162, 101)).toBe('1');
  for (const [w, h] of [[378, 520], [1428, 620], [410, 166], [832, 166], [684, 400]]) expect(mapNarrow(true, false, w, h)).toBe('');
  expect(mapNarrow(true, true, 354, 65)).toBe(''); expect(mapNarrow(false, false, 354, 65)).toBe('');
});
test('M②: CSS 예산 — row 한 줄(32 px · 지도 보기 100%−204) · PIP 크게 보기 지도 보기 폭에서 PIP 열 뺌 · 폰 세로 PIP = 44 px 92 px 열', async () => {
  const fsm = 'node:fs', css: string = (await import(/* @vite-ignore */ fsm)).readFileSync(new URL('../../src/live.css', import.meta.url), 'utf8');
  expect(css).toMatch(/\[data-mapnarrow="row"\]>\.lv-mapbtns\{[^}]*flex-direction:row/); expect(css).toMatch(/\[data-mapnarrow="row"\]>\.lv-mapbtns>\.lv-btn\{width:32px;min-height:32px/);
  expect(css).toMatch(/\[data-mapnarrow="row"\] \.lv-mapseg \.lv-btn\{min-height:32px/); expect(css).toMatch(/\[data-mapnarrow="row"\]>\.lv-mappick\{[^}]*max-width:calc\(100% - 204px\)!important;max-height:calc\(100% - 8px\);overflow:auto/);
  expect(css).toMatch(/\.qd\.f:not\(\.nopip\) \.qt\.on \.qb:not\(\[data-mapnarrow="1"\]\):not\(\[data-mapnarrow="row"\]\)>\.lv-mappick\{max-width:calc\(100% - var\(--tw\) - 206px\)!important\}/);
  const m = css.slice(css.indexOf('@media (max-width:700px){   /* 폰 세로 크게 보기 + PIP')); expect(m.length).toBeGreaterThan(0);
  expect(m).toMatch(/>\.lv-mapbtns\{width:92px;flex-direction:row;flex-wrap:wrap/); expect(m).toMatch(/>\.lv-mappick\{max-width:calc\(100% - var\(--tw\) - 122px\)!important\}/);
  expect(m.slice(0, m.indexOf('\n}'))).not.toMatch(/min-height:(?:\d|[0-3]\d|4[0-3])px|width:(?:\d|[0-3]\d|4[0-3])px;min-height/);   // 이 블록에서 버튼 44 px 미만 0(기존 크기 유지)
  // 예산(390 세로 크게 보기 + PIP): 칸 378 · --tw 104 → 버튼 열 오른쪽 끝 378−118=260 · 왼쪽 끝 168 / 지도 보기 8 + (378−104−122=152) = 160 < 168
  const W = 378, tw = 104, btnL = W - (tw + 14) - 92, pickR = 8 + (W - tw - 122); expect(pickR).toBeLessThan(btnL);
  // 예산(가로 4칸 354×65 row): 버튼 = 보기 방식 2×58 + 4 + 32 + 4 + 32 = 188 + 오른쪽 4 → 왼쪽 끝 354−192 / 지도 보기 4 + (354−204) = 154 < 162 · 높이 32 + 4 ≤ 65
  expect(4 + (354 - 204)).toBeLessThan(354 - 192); expect(4 + 32).toBeLessThanOrEqual(65);
});
