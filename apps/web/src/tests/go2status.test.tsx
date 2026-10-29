// Go2 상태 전용(go2status.tsx): 본문 거름·신선도(늦음/끊김)·«—» 표시·코드 401·통로(window.fhGo2Status)·주변 찾기 mode.
import { act } from 'react';
import { createRoot, type Root as ReactRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Go2View, NO_APP_MS, body, conn, cut, deg, manualUrl } from '../go2status';
import { detail, parse } from '../nearby';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ok = { v: 1, kind: 'go2-readonly', connection: 'ONLINE', read_only: true, motion_enabled: false, gate: 'READ_ONLY', battery: { soc: 87, voltage: 28.4 }, attitude: { roll: 0.1, pitch: null }, fallen: false, mode: 0, error_code: null,
  sources: { lowstate: { fresh: true, age_s: 0.2 }, sportmodestate: { fresh: true, age_s: 0.3 } } };
const URL = 'http://192.168.12.18:9610/go2/status';
type W = Window & { fhGo2Status?: { seq: string; url: string; code: string } };

describe('본문·신선도·표시', () => {
  it('상태 전용 계약이 아니면 버리고, 숫자 아닌 값은 null(0 아님)', () => {
    expect(body(ok)).toEqual({ connection: 'ONLINE', soc: 87, voltage: 28.4, roll: 0.1, pitch: null, fallen: false, mode: 0, error: null,
      sources: { lowstate: { fresh: true, age: 0.2 }, sportmodestate: { fresh: true, age: 0.3 } } });
    expect(body({ ...ok, sources: undefined })?.sources.lowstate).toEqual({ fresh: null, age: null });
    expect(body({ ...ok, motion_enabled: true })).toBeNull();
    expect(body({ ...ok, kind: 'agent' })).toBeNull();
    expect(body({ ...ok, connection: 'GOOD' })).toBeNull();
    expect(body({ ...ok, battery: { soc: 'x', voltage: Infinity } })?.soc).toBeNull();
  });
  it('2초 넘으면 늦음, 10초 넘으면 끊김, 서버·폰 중 나쁜 쪽', () => {
    expect(conn('ONLINE', 500)).toBe('ONLINE');
    expect(conn('ONLINE', 2001)).toBe('STALE');
    expect(conn('ONLINE', 10001)).toBe('OFFLINE');
    expect(conn('STALE', 100)).toBe('STALE');
    expect(conn(undefined, null)).toBe('OFFLINE');
  });
  it('끊긴 곳: 서버만 나쁘면 노트북↔로봇, 폰 쪽이 같거나 나쁘면 폰↔노트북', () => {
    expect(cut('ONLINE', 500)).toEqual(['ONLINE', null]);
    expect(cut('STALE', 500)).toEqual(['STALE', 'robot']);
    expect(cut('OFFLINE', 2500)).toEqual(['OFFLINE', 'robot']);
    expect(cut('STALE', 2500)).toEqual(['STALE', 'phone']);
    expect(cut('ONLINE', 10001)).toEqual(['OFFLINE', 'phone']);
  });
  it('각도·주소', () => {
    expect(deg(null)).toBe('—');
    expect(deg(Math.PI / 2)).toBe('90.0°');
    expect(manualUrl(' 192.168.12.18 ')).toBe(URL);
    expect(manualUrl('10.0.0.300')).toBeNull();
    expect(manualUrl('8.8.8.8')).toBeNull();
    expect(manualUrl('172.32.0.1')).toBeNull();
  });
  it('주변 찾기 mode: 찾기 시험 = 실제 연결 아님, 상태 전용 안내', () => {
    const s = parse({ seq: '1', scanning: false, items: [{ key: 'a', via: 'mdns', name: 'Go2 EDU (검색 시험)', host: '10.0.0.2', mode: 'discovery-only' }, { key: 'b', via: 'mdns', name: 'g', mode: 'evil' }], problems: ['wifi-no-internet'] }, '1')!;
    expect(s.items.map((i) => i.mode)).toEqual(['discovery-only', undefined]);
    expect(detail(s.items[0], [])).toContain('찾기 시험 신호 — 실제 연결 아님');
    expect(detail({ key: 'c', via: 'mdns', name: 'g', host: '10.0.0.3', port: 9610, mode: 'go2-readonly' }, [])).toContain('상태 전용 에이전트');
  });
});

describe('상태 보기 화면', () => {
  let root: ReactRoot | null = null, box: HTMLDivElement;
  const $ = (s: string) => box.querySelector<HTMLElement>(s);
  afterEach(() => { act(() => root?.unmount()); root = null; box?.remove(); vi.useRealTimers(); });
  const send = (detail: unknown) => act(() => { window.dispatchEvent(new CustomEvent('fh-go2', { detail })); });
  function render() {
    box = document.createElement('div'); document.body.append(box);
    act(() => { root = createRoot(box); root.render(<Go2View name="Go2 EDU" url={URL} close={() => {}} />); });
  }
  function enter(code: string) {
    const i = $('[data-go2-code]') as HTMLInputElement;
    act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(i, code); i.dispatchEvent(new Event('input', { bubbles: true })); });
    act(() => { (box.querySelector('form') as HTMLFormElement).requestSubmit(); });
  }

  it('코드(앞 0 보존) → 통로 설정 → 값 표시 → 2초 늦음 → 10초 끊김(값 지움) → 401 이면 코드 버림 → 닫으면 통로 지움', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'] });
    render();
    expect([...box.querySelectorAll('button')].some((b) => /STOP|정지|조종/.test(b.textContent ?? ''))).toBe(false);
    enter('01234567');
    expect((window as W).fhGo2Status).toEqual({ seq: '1', url: URL, code: '01234567' });
    expect(box.innerHTML).not.toContain('01234567');
    send({ seq: '0', status: 200, body: { ...ok, battery: { soc: 11, voltage: 1 } } });   // 지난 seq — 무시
    send({ seq: '1', status: 200, body: ok });
    expect($('[data-go2-view]')?.dataset.go2View).toBe('ONLINE');
    expect(box.textContent).toContain('온라인 · 상태 전용');
    expect($('[data-go2-src]')?.textContent).toBe('배터리·자세 받는 중 · 모드·오류 받는 중');
    // 응답은 오는데 노트북이 Go2 토픽을 못 받음 → 노트북↔로봇 끊김(폰 Wi-Fi 탓 아님), 토픽별 끊김
    send({ seq: '1', status: 200, body: { ...ok, connection: 'STALE', mode: null, sources: { lowstate: { fresh: true, age_s: 0.1 }, sportmodestate: { fresh: false, age_s: 4.25 } } } });
    expect($('[data-go2-view]')?.dataset.go2View).toBe('STALE');
    expect($('[data-go2-cut]')?.dataset.go2Cut).toBe('robot');
    expect(box.textContent).toContain('늦음 · 노트북↔로봇 자료 끊김');
    expect(box.textContent).not.toContain('폰↔노트북');
    expect($('[data-go2-src]')?.textContent).toBe('배터리·자세 받는 중 · 모드·오류 끊김(4.3초 전)');
    send({ seq: '1', status: 200, body: { ...ok, connection: 'OFFLINE', sources: { lowstate: { fresh: false, age_s: 12 }, sportmodestate: { fresh: false, age_s: null } } } });
    expect(box.textContent).toContain('오프라인 · 노트북↔로봇 자료 끊김');
    expect($('[data-go2-src]')?.textContent).toContain('모드·오류 끊김(받은 적 없음)');
    send({ seq: '1', status: 200, body: ok });
    expect(box.textContent).toContain('87% · 28.4 V');
    expect(box.textContent).toContain('피치 —');
    act(() => { vi.advanceTimersByTime(2500); });
    expect($('[data-go2-view]')?.dataset.go2View).toBe('STALE');
    expect($('[data-go2-cut]')?.dataset.go2Cut).toBe('phone');
    expect(box.textContent).toContain('늦음 · 폰↔노트북 2초 넘게 응답 없음');
    expect(box.textContent).toContain('87%');
    act(() => { vi.advanceTimersByTime(8000); });
    expect($('[data-go2-view]')?.dataset.go2View).toBe('OFFLINE');
    expect(box.textContent).not.toContain('87%');
    expect(box.textContent).toContain('오프라인 · 폰↔노트북 응답 없음');
    send({ seq: '1', status: 0, why: 'other-subnet' });
    expect($('[data-go2-why]')?.textContent).toContain('같은 Wi-Fi 에 있어야');
    send({ seq: '1', status: 429, retry: 60 });
    expect($('[data-go2-why]')?.textContent).toContain('60초 뒤');
    send({ seq: '1', status: 401 });
    expect($('[data-go2-view]')?.dataset.go2View).toBe('code');
    expect((window as W).fhGo2Status).toBeUndefined();
    expect($('[data-go2-why]')?.textContent).toContain('현장 코드');
    enter('76543210');
    expect((window as W).fhGo2Status?.seq).toBe('2');
    act(() => root?.unmount()); root = null;
    expect((window as W).fhGo2Status).toBeUndefined();
  });

  it('옛 앱: 첫 응답이 앱 제한 3초 + 시작 지연을 넘겨도(4.5초) 답 없으면 미지원 안내', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'] });
    render();
    enter('12345678');
    expect(NO_APP_MS).toBeGreaterThanOrEqual(4500);
    act(() => { vi.advanceTimersByTime(3400); });
    expect($('[data-go2-old]')).toBeNull();   // 3초 제한 + 0.4초 늦은 첫 응답 자리 — 아직 옛 앱이라 하지 않음
    act(() => { vi.advanceTimersByTime(NO_APP_MS - 3400); });
    expect($('[data-go2-old]')).not.toBeNull();
  });
});
