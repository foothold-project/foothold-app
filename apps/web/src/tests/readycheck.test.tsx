// 순서 점검(u2_4 · U2 순서 점검 · L66): 에이전트 Wi-Fi → 서버 → 에이전트 → 걷기 정책 → 몸통 → 센서 → 배터리 · 관절.
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
const head = () => box.querySelector('[data-check-head]')?.textContent ?? null;
const fold = () => box.querySelector<HTMLDetailsElement>('details[data-readycheck]')!;
/** 접힌 「자세히 점검」 펼치기(jsdom 은 summary 누름으로 열지 않아 open + toggle 을 직접) */
const unfold = () => act(() => { fold().open = true; fold().dispatchEvent(new Event('toggle')); });

describe('순서 점검 · 단계와 상태 셋', () => {
  it('일곱 단계 순서 · 다 받은 로봇: Wi-Fi · 걷기 정책만 서버에 값 없음, 나머지 확인됨', () => {
    render(robot());
    expect(steps()).toEqual([['wifi', 'none'], ['server', 'ok'], ['agent', 'ok'], ['policy', 'none'], ['body', 'ok'], ['sensors', 'ok'], ['power', 'ok']]);
    expect([...box.querySelectorAll('[data-check] [data-check-state]')].map((x) => x.textContent)).toEqual(['서버에 값 없음', '확인됨', '확인됨', '서버에 값 없음', '확인됨', '확인됨', '확인됨']);
    expect([...box.querySelectorAll('[data-check] .ck-name')].map((x) => x.textContent)).toEqual(['에이전트 Wi-Fi', '서버', '에이전트', '걷기 정책', '몸통', '센서', '배터리 · 관절']);   // 로봇 쪽 컴퓨터 프로그램은 다른 화면처럼 «에이전트» 한 말로
    expect(why('wifi')).toBe('에이전트가 붙은 Wi-Fi 이름은 서버가 아직 보내지 않습니다.');
    expect(why('policy')).toBe('걷기 정책 상태는 서버가 아직 보내지 않습니다.');
    expect(why('power')).toBe('배터리 84 % · 관절 값 받음');
  });

  it('처음엔 접힘(「자세히 점검 (7 단계)」), 막힌 단계가 없으면 접힌 줄은 아무것도 · 조종을 허락하는 말 없음', () => {
    render(robot());
    expect(fold().open).toBe(false);
    expect(fold().querySelector('summary')!.textContent).toBe('자세히 점검 (7 단계)');
    expect(head()).toBeNull();
    unfold();
    expect(box.textContent).not.toMatch(/조종 가능|준비됨|준비 완료|조종할 수 있/);
  });

  it('접힌 상태에서는 첫 막힘 한 줄만, 펼치면 그 한 줄은 빠지고 일곱 단계(첫 막힘 줄 표시)', () => {
    render(robot({ devices: [OK_DEV![0], { ...OK_DEV![1], state: 'MISSING' }] }));
    expect(head()).toBe('센서 막힘 · 라이다 없음');
    unfold();
    expect(head()).toBeNull();
    expect(box.querySelector('[data-check="sensors"]')!.hasAttribute('data-first')).toBe(true);
  });

  it('서버 연결이 없으면 서버 막힘이 머리 글(첫 막힘), 그 뒤 단계도 각자 판정', () => {
    render(robot(), false);
    expect(steps()[1]).toEqual(['server', 'blocked']);
    expect(why('server')).toBe('이 화면이 관제 서버와 연결되어 있지 않습니다.');
    expect(head()).toBe('서버 막힘 · 이 화면이 관제 서버와 연결되어 있지 않습니다.');
    expect(box.querySelector('[data-check="server"]')!.hasAttribute('data-first')).toBe(true);
    act(() => root?.unmount()); root = null; box.remove();
    render(robot({ online: false }), false);   // 서버 · 에이전트 둘 다 막힘 → 머리 글은 앞 단계(서버)
    expect(head()).toBe('서버 막힘 · 이 화면이 관제 서버와 연결되어 있지 않습니다.');
    expect(box.querySelectorAll('[data-first]')).toHaveLength(1);
  });

  it('에이전트: 끊김 · 연결 전은 막힘(까닭), 요약만 · 첫 상태 대기 · 서버 끊김은 서버에 값 없음', () => {
    const one = (p: Partial<Robot>) => { render(robot(p)); const x = [steps()[2][1], why('agent')]; act(() => root?.unmount()); root = null; box.remove(); return x; };
    expect(one({ online: false })).toEqual(['blocked', '에이전트와 연결이 끊겼습니다.']);
    expect(one({ online: false, status: null })).toEqual(['blocked', '에이전트가 아직 연결된 적이 없습니다.']);
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
    const mark = (k: string) => box.querySelector(`[data-check="${k}"] [data-check-mark]`)!.textContent;
    expect([mark('server'), mark('wifi'), mark('body')]).toEqual(['!', '·', '·']);   // 막힘 ! · 서버에 값 없음 · (줄표 꼴 기호 안 씀)
    act(() => root?.unmount()); root = null; box.remove();
    render(robot());
    expect(mark('server')).toBe('✓');
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
  it('내 로봇이면 「조종 준비」 칸 맨 아래에 접힌 「자세히 점검」, 남의 로봇(요약만)은 없음', async () => {
    const { App } = await import('../App');
    const { ROBOTS, USERS } = await import('./fixtures');
    window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
    location.hash = '#/fleet';
    const mine = ROBOTS.filter((x) => x.owner === 'u-park').map((x) => ({ ...x, serverDrive: false }));
    box = document.createElement('div'); document.body.append(box);
    act(() => { root = createRoot(box); root.render(<App user={USERS.find((u) => u.id === 'u-park')} robots={[...mine, ...ROBOTS.filter((x) => x.owner !== 'u-park')]} />); });
    expect(box.querySelector('[aria-label="조종 준비"]')).not.toBeNull();
    expect(box.querySelector('[aria-label="순서 점검"]')).toBeNull();   // 따로 칸이 아니라 「조종 준비」 칸 안 맨 아래 접힌 「자세히 점검」(한 사실은 한 곳)
    const prep = box.querySelector('[aria-label="조종 준비"]')!, d = prep.querySelector('details[data-readycheck]')!;
    expect(d).not.toBeNull();
    expect(prep.lastElementChild!.contains(d)).toBe(true);
    // 서버 단계는 같은 칸 1 단계 「서버 연결」 과 같은 값(이 화면의 실시간 연결). 시험에는 실시간 연결이 없어 둘 다 끊김
    expect(prep.querySelector('[data-step="1"]')!.classList.contains('done')).toBe(false);
    expect(d.querySelector<HTMLElement>('[data-check="server"]')!.dataset.state).toBe('blocked');
    const other = box.querySelector<HTMLButtonElement>('[aria-label="다른 로봇"] button')!;
    act(() => other.click());
    expect(box.querySelector('details[data-readycheck]')).toBeNull();
  });
});
