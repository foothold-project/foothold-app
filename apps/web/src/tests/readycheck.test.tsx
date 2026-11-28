// 순서 점검(u2_4 · U2 순서 점검 · L66): Wi-Fi(Jetson) → 서버 → 로봇 프로그램 → 걷기 정책 → 몸통 → 센서 → 배터리 · 관절.
// 보기 전용: 단계마다 «확인됨 · 막힘(까닭) · 서버에 값 없음» 셋 중 하나. 조종을 허락하는 듯한 말(조종 가능 · 준비됨)은 쓰지 않는다.
// «다시 점검» 은 받는 값을 다시 받기만 한다(로봇에 명령 없음).
import { act } from 'react';
import { createRoot, type Root as ReactRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Go2RobotInfo } from '../../../contracts/ts';
import type { Robot } from '../fake';
import { ReadyCheck } from '../screens/readycheck';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const INFO = (p: Partial<Go2RobotInfo> = {}): Go2RobotInfo => ({ source: 'GO2_DDS', attitude: { roll: 0, pitch: 0, yaw: 0 }, error_code: 0, fallen: false, fallen_source: 'imu_tilt_estimate',
  joints: { received_at: '2026-11-28T00:00:00Z', age_s: 0.1, names: [], positions: [] }, ...p } as unknown as Go2RobotInfo);
const OK_DEV = [{ key: 'front', kind: 'CAMERA_RGB', label: '앞 카메라', state: 'OK' }, { key: 'l1', kind: 'LIDAR', label: '라이다', state: 'OK' }] as Robot['devices'];
const robot = (p: Partial<Robot> = {}): Robot => ({ id: 'r-a', name: 'K-01', owner: 'o1', battery: 84, online: true, seenAt: '', status: 'IDLE', devices: OK_DEV, robotInfo: INFO(), ...p });

let root: ReactRoot | null = null, box: HTMLDivElement;
function render(r: Robot, server = true, again = () => {}) {
  box = document.createElement('div'); document.body.append(box);
  act(() => { root = createRoot(box); root.render(<ReadyCheck r={r} server={server} again={again} />); });
}
afterEach(() => { act(() => root?.unmount()); root = null; box?.remove(); });
const steps = () => [...box.querySelectorAll<HTMLElement>('[data-check]')].map((li) => [li.dataset.check, li.dataset.state]);
const why = (k: string) => box.querySelector(`[data-check="${k}"] [data-check-why]`)?.textContent ?? '';
const head = () => box.querySelector('[data-check-head]')!.textContent;

describe('순서 점검 · 단계와 상태 셋', () => {
  it('일곱 단계 순서 · 다 받은 로봇: Wi-Fi · 걷기 정책만 서버에 값 없음, 나머지 확인됨', () => {
    render(robot());
    expect(steps()).toEqual([['wifi', 'none'], ['server', 'ok'], ['agent', 'ok'], ['policy', 'none'], ['body', 'ok'], ['sensors', 'ok'], ['power', 'ok']]);
    expect([...box.querySelectorAll('[data-check] [data-check-state]')].map((x) => x.textContent)).toEqual(['서버에 값 없음', '확인됨', '확인됨', '서버에 값 없음', '확인됨', '확인됨', '확인됨']);
    expect(why('wifi')).toBe('로봇 쪽 Wi-Fi 이름은 서버가 아직 보내지 않습니다.');
    expect(why('policy')).toBe('걷기 정책 상태는 서버가 아직 보내지 않습니다.');
    expect(why('power')).toBe('배터리 84 % · 관절 값 받음');
  });

  it('막힌 단계가 없으면 머리 글은 막힘이 없다는 사실과 값 없는 단계 수만 · 조종을 허락하는 말 없음', () => {
    render(robot());
    expect(head()).toBe('막힌 단계가 없습니다 · 서버에 값 없는 단계 2 개');
    expect(box.textContent).not.toMatch(/조종 가능|준비됨|준비 완료|조종할 수 있/);
  });

  it('서버 연결이 없으면 서버 막힘이 머리 글(첫 막힘), 그 뒤 단계도 각자 판정', () => {
    render(robot(), false);
    expect(steps()[1]).toEqual(['server', 'blocked']);
    expect(why('server')).toBe('이 화면이 관제 서버와 연결되어 있지 않습니다.');
    expect(head()).toBe('서버 막힘 · 이 화면이 관제 서버와 연결되어 있지 않습니다.');
    expect(box.querySelector('[data-check="server"]')!.hasAttribute('data-first')).toBe(true);
    act(() => root?.unmount()); root = null; box.remove();
    render(robot({ online: false }), false);   // 서버 · 로봇 프로그램 둘 다 막힘 → 머리 글은 앞 단계(서버)
    expect(head()).toBe('서버 막힘 · 이 화면이 관제 서버와 연결되어 있지 않습니다.');
    expect(box.querySelectorAll('[data-first]')).toHaveLength(1);
  });

  it('로봇 프로그램: 끊김 · 연결 전은 막힘(까닭), 요약만 · 첫 상태 대기 · 서버 끊김은 서버에 값 없음', () => {
    const one = (p: Partial<Robot>) => { render(robot(p)); const x = [steps()[2][1], why('agent')]; act(() => root?.unmount()); root = null; box.remove(); return x; };
    expect(one({ online: false })).toEqual(['blocked', '로봇 쪽 노트북 프로그램과 연결이 끊겼습니다.']);
    expect(one({ online: false, status: null })).toEqual(['blocked', '로봇 쪽 노트북 프로그램이 아직 연결된 적이 없습니다.']);
    expect(one({ unknown: 'summary' })[0]).toBe('none');
    expect(one({ unknown: 'wait' })[0]).toBe('none');
    expect(one({ unknown: 'link' })[0]).toBe('none');
  });

  it('로봇이 끊기면 몸통 · 센서 · 배터리 · 관절은 지금 값이 아니라 서버에 값 없음(마지막 값으로 확인됨 하지 않음)', () => {
    render(robot({ online: false }));
    expect(steps().slice(4).map((x) => x[1])).toEqual(['none', 'none', 'none']);
    expect(why('sensors')).toBe('로봇이 연결되어 있지 않아 지금 값이 없습니다.');
  });

  it('몸통: 넘어짐 의심이면 막힘(기울기 추정), 자세 값이 없거나 넘어짐 모름이면 서버에 값 없음', () => {
    const one = (p: Partial<Robot>) => { render(robot(p)); const x = [steps()[4][1], why('body')]; act(() => root?.unmount()); root = null; box.remove(); return x; };
    expect(one({ robotInfo: INFO({ fallen: true }) })).toEqual(['blocked', '넘어짐 의심 (기울기로 추정한 값)']);
    expect(one({ robotInfo: null })[0]).toBe('none');
    expect(one({ robotInfo: INFO({ fallen: null }) })[0]).toBe('none');
    expect(one({ sim: true })[0]).toBe('none');
  });

  it('센서: 카메라 · 라이다 중 없음 · 오류가 있으면 막힘(이름), 장치 목록이 비면 서버에 값 없음', () => {
    const one = (p: Partial<Robot>) => { render(robot(p)); const x = [steps()[5][1], why('sensors')]; act(() => root?.unmount()); root = null; box.remove(); return x; };
    expect(one({ devices: [OK_DEV![0], { ...OK_DEV![1], state: 'MISSING' }] })).toEqual(['blocked', '라이다 없음']);
    expect(one({ devices: [{ ...OK_DEV![0], state: 'ERROR' }, OK_DEV![1]] })).toEqual(['blocked', '앞 카메라 오류']);
    expect(one({ devices: [...OK_DEV!, { key: 'b', kind: 'BATTERY', label: '배터리', state: 'ERROR' }] })[0]).toBe('ok');
    expect(one({ devices: [] })[0]).toBe('none');
    expect(one({ unknown: 'summary' })[0]).toBe('none');   // 요약만 받은 로봇은 online 이어도 장치 값을 지금 값으로 쓰지 않음
  });

  it('배터리 · 관절: 둘 다 받으면 확인됨(값만, 기준 없이 막지 않음), 하나라도 없으면 서버에 값 없음', () => {
    const one = (p: Partial<Robot>) => { render(robot(p)); const x = [steps()[6][1], why('power')]; act(() => root?.unmount()); root = null; box.remove(); return x; };
    expect(one({ battery: 9 })).toEqual(['ok', '배터리 9 % · 관절 값 받음']);
    expect(one({ battery: null })).toEqual(['none', '배터리 값 없음 · 관절 값 받음']);
    expect(one({ robotInfo: INFO({ joints: undefined }) })).toEqual(['none', '배터리 84 % · 관절 값 없음']);
  });

  it('상태는 글 + 기호(색만으로 구분 0)', () => {
    render(robot({ online: false }), false);
    expect([...box.querySelectorAll('[data-check] [data-check-mark]')].every((m) => m.getAttribute('aria-hidden') === 'true')).toBe(true);
    expect(box.querySelectorAll('[data-check] [data-check-state]')).toHaveLength(7);
  });
});

describe('다시 점검', () => {
  it('누르면 받는 값을 다시 받는 함수만 한 번 부름', () => {
    const again = vi.fn();
    render(robot(), true, again);
    const b = [...box.querySelectorAll('button')].find((x) => x.textContent === '다시 점검')!;
    act(() => b.click());
    expect(again).toHaveBeenCalledTimes(1);
    expect(box.querySelectorAll('button')).toHaveLength(1);
  });
});

describe('운영 관리자 로봇 탭 자리', () => {
  it('내 로봇이면 「조종 준비」 옆에 「순서 점검」, 남의 로봇(요약만)은 없음', async () => {
    const { App } = await import('../App');
    const { ROBOTS, USERS } = await import('./fixtures');
    window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
    location.hash = '#/fleet';
    const mine = ROBOTS.filter((x) => x.owner === 'u-park').map((x) => ({ ...x, serverDrive: false }));
    box = document.createElement('div'); document.body.append(box);
    act(() => { root = createRoot(box); root.render(<App user={USERS.find((u) => u.id === 'u-park')} robots={[...mine, ...ROBOTS.filter((x) => x.owner !== 'u-park')]} />); });
    expect(box.querySelector('[aria-label="조종 준비"]')).not.toBeNull();
    const card = box.querySelector('[aria-label="순서 점검"]')!;
    expect(card).not.toBeNull();
    expect(card.parentElement).toBe(box.querySelector('[aria-label="조종 준비"]')!.parentElement);
    const other = box.querySelector<HTMLButtonElement>('[aria-label="다른 로봇"] button')!;
    act(() => other.click());
    expect(box.querySelector('[aria-label="순서 점검"]')).toBeNull();
  });
});
