// 실기 Go2 자세·상태 번호·넘어짐 추정(go2status.tsx pickInfo·RobotInfo·FallChip) — 표시만. 값 있음/없음/NaN→null/폰 경유/시뮬 숨김/끊김
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it } from 'vitest';
import type { Go2RobotInfo, PhoneRelayState } from '../../../contracts/ts';
import type { Robot } from '../fake';
import { FallChip, RobotInfo, pickInfo } from '../go2status';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined, box: HTMLDivElement;
afterEach(() => { act(() => root?.unmount()); box?.remove(); root = undefined; });
const show = (el: JSX.Element) => { box = document.createElement('div'); document.body.append(box); root = createRoot(box); act(() => root!.render(el)); return box; };

const info = (p: Partial<Go2RobotInfo> = {}): Go2RobotInfo => ({ source: 'GO2_DDS', attitude: { roll: 0.1, pitch: -0.05 }, error_code: 0, fallen: false, fallen_source: 'imu_tilt_estimate', ...p });
const relay = (ri: Go2RobotInfo | null, age = 0.1): PhoneRelayState => ({ source: 'PHONE', age_s: age, valid_for_s: 2.9, battery: null, speed: null, devices: [], robot_info: ri });
const R = (p: Partial<Robot> = {}): Robot => ({ id: 'r', name: 'Go2', owner: 'o', battery: 50, online: true, seenAt: '', status: 'IDLE', sim: false, ...p });
const text = (r: Robot, now?: number) => { const s = pickInfo(r, now); return s ? show(<RobotInfo {...s} />).textContent : null; };

it('직접 값: 부호 붙인 도·상태 번호 원값·0 은 정상 범위', () => {
  expect(text(R({ robotInfo: info() }))).toBe('자세roll +5.7° · pitch -2.9°상태 번호0(정상 범위)넘어짐 추정아님');
  act(() => root!.unmount()); box.remove();
  expect(text(R({ robotInfo: info({ error_code: 100 }) }))).toContain('상태 번호100넘어짐');
  expect(box.querySelector('[data-robot-info]')!.getAttribute('data-robot-info')).toBe('direct');
});

it('넘어짐 의심 = 경고 토큰 Chip + 글자(색만 아님), 목록에는 그때만 작은 Chip', () => {
  const r = R({ robotInfo: info({ fallen: true }) });
  const el = show(<><RobotInfo {...pickInfo(r)!} /><FallChip x={r} /></>);
  const chips = el.querySelectorAll('[data-tone="warn"]');
  expect([...chips].map((c) => c.textContent)).toEqual(['▲의심(기울기 추정)', '▲넘어짐 의심']);
  act(() => root!.render(<FallChip x={R({ robotInfo: info() })} />));
  expect(el.textContent).toBe('');
  act(() => root!.render(<FallChip x={R({ robotInfo: info({ fallen: null }) })} />));
  expect(el.textContent).toBe('');
});

it('NaN 등으로 서버가 거른 null 은 그 값만 «모름», 옛 agent(robot_info 없음)는 전부 «모름»', () => {
  expect(text(R({ robotInfo: info({ attitude: { roll: null, pitch: 0 }, error_code: null, fallen: null }) })))
    .toBe('자세roll 모름 · pitch +0.0°상태 번호모름넘어짐 추정모름');
  act(() => root!.unmount()); box.remove();
  expect(text(R({ robotInfo: undefined }))).toBe('자세모름상태 번호모름넘어짐 추정모름');
});

it('폰 경유: 직접 값이 없을 때만, «폰 경유» 라벨로 — 둘 다 있으면 직접 값', () => {
  const ph = info({ attitude: { roll: -0.2, pitch: 0 }, error_code: 7 });
  expect(pickInfo(R({ robotInfo: info(), phoneRelay: relay(ph), phoneRelayAt: 0 }), 0)!.via).toBeUndefined();
  const s = pickInfo(R({ online: false, robotInfo: null, phoneRelay: relay(ph), phoneRelayAt: 0 }), 500)!;
  expect(s).toMatchObject({ via: '폰 경유', v: { roll: -0.2, code: 7 } });
  expect(show(<RobotInfo {...s} />).textContent).toContain('roll -11.5° · pitch +0.0°폰 경유');
  // 폰 값이 낡으면(3초) 쓰지 않는다 → 끊김
  expect(pickInfo(R({ online: false, robotInfo: null, phoneRelay: relay(ph, 2.5), phoneRelayAt: 0 }), 1000)).toEqual({ v: null, why: '모름(끊김)' });
});

it('시뮬은 숨김, 끊김·실시간 끊김은 «모름(끊김)», 첫 state 전·연결 전은 «모름», 남의 로봇은 «확인 안 됨»', () => {
  expect(pickInfo(R({ sim: true, robotInfo: info() }))).toBeNull();
  expect(pickInfo(R({ online: false, robotInfo: info() }))).toEqual({ v: null, why: '모름(끊김)' });
  expect(pickInfo(R({ online: false, unknown: 'link' }))).toEqual({ v: null, why: '모름(끊김)' });
  expect(pickInfo(R({ online: false, unknown: 'wait' }))).toEqual({ v: null, why: '모름' });
  expect(pickInfo(R({ online: false, status: null }))).toEqual({ v: null, why: '모름' });
  expect(pickInfo(R({ online: false, unknown: 'summary' }))).toEqual({ v: null, why: '확인 안 됨' });
  expect(text(R({ online: false, robotInfo: info() }))).toBe('자세모름(끊김)상태 번호모름(끊김)넘어짐 추정모름(끊김)');
});
