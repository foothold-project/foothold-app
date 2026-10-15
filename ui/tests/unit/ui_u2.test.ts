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
