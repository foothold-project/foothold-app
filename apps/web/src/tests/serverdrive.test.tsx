// 실기 서버 경유 시험 조종(serverdrive.tsx·drivemedia.ts, 10-30 SERVER-DRIVE-WEB·ADD1): 서버가 켠 로봇만 패널, 누르는 동안만·떼면 0,
// 초점 잃음·가려짐·끊김 → 0, STOP 우선, SI 값 9개 밖 없음, 카메라·라이다 칸·전체화면. 가짜 WebSocket 이 서버 중재기(drive.test 와 같은 흉내).
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScreenState } from '../../../contracts/ts';
import { App } from '../App';
import { ROBOTS, USERS, type Robot } from './fixtures';
import { FakeWS, fail, lease, state } from './fakeWs';
import { SD_NOTE, TRIAL, UNLOCK_WAIT_MS } from '../serverdrive';
import { NO_SIGNAL, RETRY_MS } from '../drivemedia';
import { toRobot } from '../fake';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null, box: HTMLDivElement, w: FakeWS, st: Record<string, ScreenState> = {};
const PARK = { id: 'u-park', name: '박OO' };
const ON = ROBOTS.map((r) => (r.id === 'r7' ? { ...r, serverDrive: true } : r));
function mount(user: string, robots: Robot[] = ON) {
  window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  location.hash = '#/fleet';
  box = document.createElement('div'); document.body.append(box);
  act(() => { root = createRoot(box); root.render(<App user={USERS.find((u) => u.id === user)} robots={robots} />); });
}
const unmount = () => { act(() => root!.unmount()); root = null; box.remove(); };
beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] }); });
afterEach(() => {
  act(() => root?.unmount()); root = null; box?.remove(); vi.useRealTimers(); vi.unstubAllGlobals();
  delete (document as { visibilityState?: string }).visibilityState;
});

const $ = (s: string) => box.querySelector<HTMLElement>(s);
const btn = (t: string) => [...box.querySelectorAll('button')].find((b) => b.textContent === t)!;
const row = (name: string) => [...box.querySelectorAll('[aria-label="로봇 목록"] button')].find((b) => b.textContent!.includes(name))!;
const click = (el: Element) => act(() => { (el as HTMLElement).click(); });
const tick = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });
const key = (type: 'keydown' | 'keyup', code: string) => act(() => { window.dispatchEvent(new KeyboardEvent(type, { code, bubbles: true, cancelable: true })); });
const ptr = (el: Element, type: string) => act(() => { el.dispatchEvent(Object.assign(new MouseEvent(type, { bubbles: true, cancelable: true }), { pointerId: 1 })); });
const push = (r: string, p: Partial<ScreenState> = {}) => { st[r] = { ...(st[r] ?? state(r)), ...p }; w.recv(st[r]); };
/** 화면 실시간 소켓(카메라·라이다 소켓 말고) */
const rtSock = () => FakeWS.all.filter((x) => x.url.endsWith('/api/v1/ws')).pop()!;
const mediaSock = (ch: string) => FakeWS.all.filter((x) => x.url.endsWith(`/api/v1/robots/r7/drive-media/${ch}`)).pop()!;
function serve(...ids: string[]) {
  w = rtSock(); st = {};
  w.auto = (m) => {
    w.recv({ t: 'reply', id: m.id, ok: true });
    const r = m.robot as string;
    if (m.t === 'lease.take') { w.recv(lease(r, PARK, `L${m.id}`)); w.recv({ t: 'lease.result', robot: r, request_id: null, result: 'ACCEPTED' }); }
    if (m.t === 'unlock') push(r, { latched: false });
    if (m.t === 'stop' && st[r]) push(r, { latched: true, stop_gen: st[r].stop_gen! + 1 });
    if (m.t === 'lease.release' || m.t === 'hidden') w.recv(lease(r, null));
  };
  act(() => { w.open(); ids.forEach((id) => push(id)); });
}
const axes = () => w.of('cmd').map((m) => (m.axes as number[]).join());
const lastAxes = () => axes()[axes().length - 1];
/** 서버·에이전트 허용 표 — 이 9개 밖은 나가면 안 된다 */
const ALLOWED = new Set(['0,0,0', '1.5,0,0', '-1.5,0,0', '0,1.5,0', '0,-1.5,0', '0,0,0.5', '0,0,-0.5', '1.5,0,0.5', '1.5,0,-0.5']);
/** 박OO 가 Go2-7(서버 허용) 을 골라 조종 시작 → 잠금 해제 → 중립까지 */
function ready() {
  mount('u-park'); serve('r7');
  click(row('Go2-7'));
  click(btn('조종 시작'));
  click(btn('② 잠금 해제'));
  tick(100);
  expect($('[data-server-drive]')!.textContent).toContain('움직일 수 있음');
}
const hold = (keys: string[]) => { keys.forEach((k) => key('keydown', k)); tick(60); const a = lastAxes(); [...keys].reverse().forEach((k) => key('keyup', k)); return a; };

describe('서버 경유 시험 조종 패널', () => {
  it('서버가 server_drive_allowed=true 로 준 실기 로봇에만, 담당 운영자 PC 에만 보인다', () => {
    expect(toRobot({ id: 'x', simulation: false, server_drive_allowed: true } as never).serverDrive).toBe(true);
    expect(toRobot({ id: 'x', simulation: false, server_drive: true } as never).serverDrive).toBe(false);   // 옛 가정 이름은 아님
    expect(toRobot({ id: 'x', simulation: false } as never).serverDrive).toBe(false);
    mount('u-park'); serve('r7'); click(row('Go2-7'));
    expect($('[data-server-drive]')!.textContent).toContain(TRIAL);
    expect($('[data-sd-stop]')).not.toBeNull();
    unmount();
    const k = FakeWS.all.length;
    mount('u-park', ROBOTS); serve('r7'); click(row('Go2-7'));   // 서버가 켜지 않음 → 보기만(카메라·라이다 연결도 없음)
    expect($('[data-server-drive]')).toBeNull();
    expect(FakeWS.all.slice(k).some((x) => x.url.includes('drive-media'))).toBe(false);
    unmount();
    mount('u-kim'); serve('r3', 'r7', 'r1'); click(row('Go2-7'));   // 총괄 → 보기만
    expect($('[data-server-drive]')).toBeNull();
  });

  it('키: 화살표 = 이동, A/D = 제자리 회전, ↑+A/D — 표의 SI 값 그대로, 그 밖 조합·W 는 0', () => {
    ready();
    expect(hold(['ArrowUp'])).toBe('1.5,0,0');
    expect(hold(['ArrowDown'])).toBe('-1.5,0,0');
    expect(hold(['ArrowLeft'])).toBe('0,1.5,0');
    expect(hold(['ArrowRight'])).toBe('0,-1.5,0');
    expect(hold(['KeyA'])).toBe('0,0,0.5');
    expect(hold(['KeyD'])).toBe('0,0,-0.5');
    expect(hold(['ArrowUp', 'KeyA'])).toBe('1.5,0,0.5');
    expect(hold(['KeyD', 'ArrowUp'])).toBe('1.5,0,-0.5');
    for (const k of [['ArrowDown', 'KeyA'], ['ArrowLeft', 'ArrowUp'], ['KeyA', 'KeyD'], ['KeyW'], ['KeyS'], ['KeyQ']]) expect(hold(k)).toBe('0,0,0');
    expect(lastAxes()).toBe('0,0,0');
    expect(axes().every((a) => ALLOWED.has(a))).toBe(true);
  });

  it('화면 단추 8개도 같은 표 — 누르는 동안만, 떼면 그 자리에서 0', () => {
    ready();
    const want: Record<string, string> = { up: '1.5,0,0', down: '-1.5,0,0', left: '0,1.5,0', right: '0,-1.5,0', rotl: '0,0,0.5', rotr: '0,0,-0.5', 'rotl+up': '1.5,0,0.5', 'rotr+up': '1.5,0,-0.5' };
    expect(box.querySelectorAll('[data-sd-move]').length).toBe(8);
    for (const [k, v] of Object.entries(want)) {
      const b = $(`[data-sd-move="${k}"]`)!;
      ptr(b, 'pointerdown'); expect(lastAxes()).toBe(v); tick(100); expect(lastAxes()).toBe(v);
      const n = axes().length;
      ptr(b, 'pointerup');
      expect(axes().length).toBe(n + 1); expect(lastAxes()).toBe('0,0,0');
      tick(100); expect(lastAxes()).toBe('0,0,0');
    }
    expect(axes().every((a) => ALLOWED.has(a))).toBe(true);
  });

  it('초점 잃음·가려짐 → 바로 0 + 안내, 자동 재개 없음', () => {
    ready();
    key('keydown', 'ArrowUp'); tick(60); expect(lastAxes()).toBe('1.5,0,0');
    act(() => { window.dispatchEvent(new Event('blur')); });
    expect(lastAxes()).toBe('0,0,0'); expect($('[data-sd-why]')!.textContent).toBe(SD_NOTE.blur);
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { code: 'ArrowUp', repeat: true, bubbles: true })); });   // 누르고 있던 키의 반복은 되살리지 않는다
    tick(200); expect(lastAxes()).toBe('0,0,0');
    key('keyup', 'ArrowUp');

    key('keydown', 'ArrowUp'); tick(60); expect(lastAxes()).toBe('1.5,0,0');
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(w.of('hidden').length).toBe(1);   // 조종권 반납(rt) — 그 뒤 cmd 없음
    const n = axes().length; tick(300); expect(axes().length).toBe(n);
    expect($('[data-sd-why]')!.textContent).toBe(SD_NOTE.hidden);
    expect(btn('조종 시작')).toBeTruthy();
  });

  it('연결이 끊기면 0 + 안내, 다시 연결돼도 조종권 없이 시작 단추부터', () => {
    ready();
    key('keydown', 'ArrowUp'); tick(60); expect(lastAxes()).toBe('1.5,0,0');
    act(() => { w.drop(1006); });
    expect($('[data-sd-why]')!.textContent).toBe(SD_NOTE.link);
    tick(1000);   // 다시 연결
    serve('r7');
    tick(200);
    expect(w.of('cmd').length).toBe(0);   // 새 연결에서 저절로 보내지 않는다
    expect(btn('조종 시작')).toBeTruthy();
  });

  it('STOP 은 패널에서 가장 크고, 누르면 입력 0 을 먼저 보내고 정지 — 그 뒤 키를 누르고 있어도 0', () => {
    ready();
    const stop = $('[data-sd-stop]')!, fwd = $('[data-sd-move="up"]')!;
    expect(parseInt(stop.style.minHeight)).toBeGreaterThan(parseInt(fwd.style.minHeight));
    key('keydown', 'ArrowUp'); tick(60); expect(lastAxes()).toBe('1.5,0,0');
    click(stop);
    const i = w.sent.findIndex((m) => m.t === 'stop');
    expect(i).toBeGreaterThan(-1);
    expect((w.sent.slice(0, i).filter((m) => m.t === 'cmd').pop()!.axes as number[]).join()).toBe('0,0,0');
    tick(300);
    expect(w.sent.slice(i).filter((m) => m.t === 'cmd').every((m) => (m.axes as number[]).join() === '0,0,0')).toBe(true);
    expect($('[data-sd-lock]')).not.toBeNull();   // 잠금 → «정지 확인 → 해제» 단계
    expect(fwd.hasAttribute('disabled')).toBe(true);
    key('keyup', 'ArrowUp');
  });

  it('Space(머리줄 STOP)도 입력을 바로 0 으로', () => {
    ready();
    const auto = w.auto!;
    w.auto = (m) => (m.t === 'stop' ? { ok: true } : auto(m));   // 서버 잠금 보고 전에도 화면이 먼저 0
    key('keydown', 'ArrowUp'); tick(60);
    key('keydown', 'Space');
    expect(w.of('stop').length).toBe(1);
    tick(200);
    expect(lastAxes()).toBe('0,0,0');
  });
});

describe('서버 경유 카메라·라이다', () => {
  const video = (p: object = {}) => ({ t: 'media.video', version: 'media/1', channel: 'rgb', robot: 'r7', epoch: 1, episode_id: null, seq: 1, mime: 'image/jpeg', jpeg: 'AAAA', ...p });
  const cam = () => $('[data-sd-tile="rgb"] [data-sd-cam]')!;

  it('같은 서버의 drive-media 경로로 받기만(보내는 것 0), 자료 없으면 «신호 없음»', () => {
    mount('u-park'); serve('r7'); click(row('Go2-7'));
    const rgb = mediaSock('rgb'), lid = mediaSock('lidar');
    expect(rgb.url).toBe(`ws://${location.host}/api/v1/robots/r7/drive-media/rgb`);
    expect(lid).toBeTruthy();
    expect(cam().textContent).toBe(NO_SIGNAL.rgb);
    expect($('[data-sd-tile="lidar"]')!.textContent).toContain(NO_SIGNAL.lidar);
    act(() => { rgb.open(); rgb.recv(video()); });
    expect(cam().getAttribute('src')).toBe('data:image/jpeg;base64,AAAA');
    tick(2100);   // 2 s 넘게 새 프레임 없음 → 지난 그림을 보이지 않는다
    expect(cam().tagName).toBe('DIV'); expect(cam().textContent).toContain(NO_SIGNAL.rgb);
    act(() => { rgb.recv(video({ seq: 2 })); });
    expect(cam().tagName).toBe('IMG');
    act(() => { rgb.recv({ t: 'media.status', version: 'media/1', channel: 'rgb', robot: 'r7', epoch: 1, reason: 'No fresh source sample within 1 second' }); });
    expect(cam().textContent).toContain(NO_SIGNAL.rgb); expect(cam().textContent).toContain('1초 넘게');
    expect(rgb.sent.length + lid.sent.length).toBe(0);
  });

  it('epoch 가 바뀌면 그림을 비우고 순번을 새로 센다, 약속 위반(남의 로봇)은 닫고 2 s 뒤 다시', () => {
    mount('u-park'); serve('r7'); click(row('Go2-7'));
    const rgb = mediaSock('rgb');
    act(() => { rgb.open(); rgb.recv(video({ seq: 9 })); });
    expect(cam().tagName).toBe('IMG');
    act(() => { rgb.recv({ ...video({ epoch: 2, seq: 1 }), t: 'media.status', reason: 'RGB source is disabled' }); });   // 새 epoch 의 첫 자료가 상태 — 지난 그림 없음
    expect(cam().tagName).toBe('DIV');
    act(() => { rgb.recv(video({ epoch: 2, seq: 1 })); });   // 새 epoch 은 seq 1 부터 받는다
    expect(cam().tagName).toBe('IMG');
    act(() => { rgb.recv(video({ epoch: 2, seq: 2, robot: 'r3' })); });
    expect(rgb.readyState).toBe(3); expect(cam().tagName).toBe('DIV');
    const n = FakeWS.all.length;
    tick(RETRY_MS);
    expect(mediaSock('rgb')).not.toBe(rgb); expect(FakeWS.all.length).toBe(n + 1);
  });

  it('라이다: media.points 머리 + 바로 뒤 binary 만 그린다', () => {
    mount('u-park'); serve('r7'); click(row('Go2-7'));
    const lid = mediaSock('lidar'), xyz = new Float32Array([1, 2, 0.5, -1, 0, 0]);
    act(() => { lid.open(); lid.recv({ t: 'media.points', version: 'media/1', channel: 'lidar', robot: 'r7', epoch: 1, episode_id: null, seq: 1, source: 'l1', encoding: 'xyz_f32le', frame: 'lidar_link', count: 2, byte_length: 24, truncated: false });
      lid.onmessage?.({ data: xyz.buffer } as never); });
    expect($('[data-sd-tile="lidar"] [data-cloud]')!.getAttribute('data-cloud')).toBe('2');
    expect($('[data-sd-tile="lidar"]')!.textContent).not.toContain(NO_SIGNAL.lidar);
  });

  it('칸을 누르면 전체화면 — STOP 이 가장 크게 보이고 키 조종 그대로, 다시 누르거나 Esc 로 복귀', () => {
    ready();
    click($('[data-sd-tile="rgb"]')!);
    const full = $('[data-sd-full]')!, stop = full.querySelector<HTMLElement>('[data-sd-stop="full"]')!;
    expect(stop).toBeTruthy();
    const sizes = [...full.querySelectorAll<HTMLElement>('button')].filter((b) => b !== stop).map((b) => parseInt(b.style.minHeight) || 0);
    expect(parseInt(stop.style.minHeight)).toBeGreaterThan(Math.max(...sizes));
    key('keydown', 'ArrowUp'); tick(60); expect(lastAxes()).toBe('1.5,0,0');
    key('keyup', 'ArrowUp'); expect(lastAxes()).toBe('0,0,0');
    click(full.querySelector('[aria-label="카메라 작게 보기"]')!);
    expect($('[data-sd-full]')).toBeNull();
    click($('[data-sd-tile="lidar"]')!);
    expect($('[data-sd-full]')!.getAttribute('aria-label')).toBe('라이다 전체화면');
    key('keydown', 'Escape');
    expect($('[data-sd-full]')).toBeNull();
    click($('[data-sd-tile="lidar"]')!);
    click($('[data-sd-full] [data-sd-stop="full"]')!);   // 전체화면 안 STOP
    expect(w.of('stop').length).toBe(1);
  });
});

// UIUX-1101 1·2·4: STOP 단계 구분(확인 없이 «멈췄습니다» 금지)·잠금 해제 대기/미확인·전체화면 모달(상태·초점 가두기·배경 inert)
describe('UIUX-1101 정지·해제 안내와 전체화면', () => {
  const phase = () => $('[data-sd-stop-phase]')?.textContent ?? '';
  it('STOP 요청이 거절되면 «정지 요청 실패 — 현장 확인», 어디에도 «멈췄습니다» 없음 — 전체화면에도 STOP 옆에 보임', () => {
    ready();
    const auto = w.auto!;
    w.auto = (m) => (m.t === 'stop' ? fail('ROBOT_OFFLINE', '거절') : auto(m));
    act(() => push('r7', { speed: 1.5, latched: false, applied: [1.5, 0, 0] }));
    click($('[data-sd-stop]')!); tick(100);
    expect(phase()).toContain('정지 요청 실패 — 현장 확인');
    expect(box.textContent).not.toContain('멈췄습니다');
    click($('[data-sd-tile="rgb"]')!);
    const st = $('[data-sd-full] [data-sd-full-state]')!;
    expect(st.textContent).toContain('정지 요청 실패 — 현장 확인');
    expect(box.textContent).not.toContain('멈췄습니다');
  });

  it('접수만으로는 «확인 대기», 이 STOP 뒤 잠금·출력 0·수평 속도 0 보고가 와야 «로봇 정지 확인»', () => {
    ready();
    const auto = w.auto!;
    w.auto = (m) => (m.t === 'stop' ? { ok: true } : auto(m));   // 서버 접수만, 로봇 보고 아직
    click($('[data-sd-stop]')!); tick(10);
    expect(phase()).toContain('정지 요청 접수 — 로봇 정지 확인 대기');
    act(() => push('r7', { latched: true, stop_gen: 2, applied: [0.3, 0, 0], speed: 0.4 })); tick(10);   // 잠겼지만 아직 움직임
    expect(phase()).toContain('확인 대기');
    act(() => push('r7', { latched: true, stop_gen: 2, applied: [0, 0, 0], speed: 0 })); tick(10);
    expect(phase()).toContain('로봇 정지 확인');
    expect($('[data-sd-why]')!.textContent).toBe(SD_NOTE.stop);
    expect(SD_NOTE.stop + SD_NOTE.blur + SD_NOTE.hidden + SD_NOTE.link).not.toContain('멈췄습니다');
  });

  it('잠금 해제: 요청 뒤 «해제 대기» → 안 풀리면 «미확인 — 로봇이 정지 확인을 못 함», 거절 사유가 오면 축 값·기준까지', () => {
    mount('u-park'); serve('r7');
    const auto = w.auto!;
    w.auto = (m) => (m.t === 'unlock' ? { ok: true } : auto(m));   // 서버 전달은 성공, 로봇 잠금 그대로
    click(row('Go2-7')); click(btn('조종 시작'));
    expect($('[data-sd-status]')!.textContent).toContain('수평 속도');
    click(btn('② 잠금 해제')); tick(10);
    expect($('[data-sd-unlock]')!.getAttribute('data-sd-unlock')).toBe('wait');
    expect($('[data-sd-unlock]')!.textContent).toContain('해제 대기');
    tick(UNLOCK_WAIT_MS);
    expect($('[data-sd-unlock]')!.textContent).toContain('미확인 — 로봇이 정지 확인을 못 해');
    act(() => push('r7', { unlock_refused: { reason: 'NOT_STILL', at: '2026-11-01T00:00:00Z', axes: [{ axis: 'vz', value: 0.12, limit: 0.05, unit: 'm/s' }] } } as never)); tick(300);
    expect($('[data-sd-unlock]')!.textContent).toContain('거절 사유: NOT_STILL — vz 0.12 m/s > 기준 0.05 m/s');
    act(() => push('r7', { latched: false })); tick(10);
    expect($('[data-sd-unlock]')).toBeNull();
  });

  it('전체화면은 모달: 열면 «작게 보기»에 초점, 배경 inert, Tab·Shift+Tab 은 안에서 돌고, 닫으면 연 칸으로 초점 복귀 · 잠금 해제도 안에서', () => {
    ready();
    click($('[data-sd-stop]')!); tick(100);   // 잠김
    const tile = $('[data-sd-tile="rgb"]')!; tile.focus(); click(tile);
    const full = $('[data-sd-full]')!;
    expect(full.getAttribute('aria-modal')).toBe('true');
    expect(document.activeElement).toBe(full.querySelector('[data-sd-small]'));
    expect($('[data-sd-stop="panel"]')!.closest('[inert]')).not.toBeNull();   // 배경(패널 STOP·조종 끝내기)
    expect(btn('조종 끝내기').closest('[inert]')).not.toBeNull();
    expect(full.closest('[inert]')).toBeNull();
    expect(full.querySelector('[data-sd-lock] button')!.textContent).toBe('② 잠금 해제');   // 작게 보기 없이 해제
    const f = [...full.querySelectorAll<HTMLElement>('button:not([disabled])')];
    const tab = (shift = false) => act(() => { document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: shift, bubbles: true, cancelable: true })); });
    f[0].focus(); tab(true); expect(document.activeElement).toBe(f[f.length - 1]);
    tab(); expect(document.activeElement).toBe(f[0]);
    key('keydown', 'Escape');
    expect($('[data-sd-full]')).toBeNull();
    expect(box.querySelector('[inert]')).toBeNull();
    expect(document.activeElement).toBe(tile);
  });
});
