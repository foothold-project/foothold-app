// 폰 홈 «+ 로봇 연결하기» → 주변 로봇 찾기(nearby.tsx): 앱 이벤트 해석·합치기·중복 빼기·권한 거부 안내·앱 밖 안내.
import { act } from 'react';
import { createRoot, type Root as ReactRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Connect } from '../drive';
import type { Robot, Role } from '../fake';
import { NO_APP_MS, PROBLEM, detail, merge, parse, type Found } from '../nearby';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const robot = (id: string, online: boolean, sim = false): Robot => ({ id, name: `로봇-${id}`, owner: 'o1', battery: null, online, seenAt: '', status: null, sim });
const agent = (key: string, host: string, rid?: string): Found => ({ key, via: 'mdns', name: `go2-${key}`, host, port: 8765, rid, agent: `ws://${host}:8765/phone/ws` });
const addr = (host: string): Found => ({ key: `addr:${host}`, via: 'addr', name: `Go2 기본 주소 ${host}`, host, port: 9991 });
const ble = (name: string): Found => ({ key: `ble:${name}`, via: 'ble', name, rssi: -60 });

describe('parse·merge·detail', () => {
  it('다른 seq·모양 틀린 값은 버리고, 틀린 항목만 뺀다', () => {
    expect(parse({ seq: '1', scanning: true, items: [], problems: [] }, '2')).toBeNull();
    expect(parse(null, '1')).toBeNull();
    expect(parse({ seq: '1', items: 'x', problems: [] }, '1')).toBeNull();
    const s = parse({ seq: '1', scanning: false, items: [agent('a', '10.0.0.2'), { key: 'k', via: 'evil', name: 'x' }, { via: 'ble', name: 'Go2_1' }, ble('Go2_7')], problems: ['bt-perm', 3] }, '1')!;
    expect(s.items.map((i) => i.key)).toEqual(['a', 'ble:Go2_7']);
    expect(s.problems).toEqual(['bt-perm']);
    expect(s.scanning).toBe(false);
  });

  it('같은 rid 에이전트는 하나, 에이전트가 보인 주소의 기본 주소 응답은 빼고, 에이전트 → 기본 주소 → 블루투스 순', () => {
    const m = merge([ble('Go2_1'), addr('192.168.12.1'), addr('192.168.123.18'), agent('a', '192.168.123.18', 'r1'), agent('b', '192.168.12.9', 'r1'), agent('c', '10.0.0.3'), agent('c', '10.0.0.3')]);
    expect(m.map((i) => i.key)).toEqual(['a', 'c', 'addr:192.168.12.1', 'ble:Go2_1']);
  });

  it('누른 항목 안내: 내 조직 로봇 / 에이전트 발견(등록 준비 중) / Go2 만(설치 필요)', () => {
    const robots = [robot('r1', false)];
    expect(detail(agent('a', '10.0.0.2', 'r1'), robots)).toContain('이미 내 조직에 등록된 로봇입니다(로봇-r1)');
    expect(detail(agent('a', '10.0.0.2'), robots)).toBe('에이전트 발견: go2-a 10.0.0.2:8765 — 연결 등록은 서버 준비 중입니다.');
    expect(detail(ble('Go2_1'), robots)).toContain('FOOTHOLD 에이전트가 아직 없음(설치 필요)');
    expect(detail(addr('192.168.12.1'), robots)).toContain('FOOTHOLD 에이전트가 아직 없음(설치 필요)');
  });
});

describe('폰 홈 «내 로봇» 카드', () => {
  let root: ReactRoot | null = null, box: HTMLDivElement;
  const ua = vi.spyOn(navigator, 'userAgent', 'get');
  const $ = (s: string) => box.querySelector<HTMLElement>(s);
  const btn = (t: string) => [...box.querySelectorAll('button')].find((b) => b.textContent === t) as HTMLButtonElement | undefined;
  const flush = () => act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });
  async function render(robots: Robot[], app: boolean, role: Role = 'OPERATOR') {
    ua.mockReturnValue(app ? 'Mozilla/5.0 (Linux; Android 14) FootholdApp/1.2.2-dev' : 'Mozilla/5.0 (Linux; Android 14)');
    box = document.createElement('div'); document.body.append(box);
    act(() => { root = createRoot(box); root.render(<Connect user={{ id: 'o1', name: '이운영', role }} robots={robots} go={() => {}} />); });
    await flush();
  }
  const send = (detail: unknown) => act(() => { window.dispatchEvent(new CustomEvent('fh-nearby', { detail })); });
  beforeEach(() => { vi.stubGlobal('fetch', async () => new Response('{}', { status: 404 })); });
  afterEach(() => { act(() => root?.unmount()); root = null; box?.remove(); vi.unstubAllGlobals(); vi.useRealTimers(); });

  it('앱 안 + 연결된 실기 0 → 본문이 «+ 로봇 연결하기» 단추(연결 전 로봇·시뮬만 online 이어도)', async () => {
    await render([robot('r1', false), robot('s1', true, true)], true);
    expect(btn('+ 로봇 연결하기')?.className).toBe('btn pri');
    expect(box.textContent).not.toContain('보기만');
  });

  it('앱 안 + 연결된 실기 있음 → 카드 그대로 + 아래 작은 단추', async () => {
    await render([robot('r1', true)], true);
    expect(box.textContent).toContain('로봇-r1');
    expect(btn('+ 로봇 연결하기')?.className).toBe('btn');
  });

  it('앱 안 + 상태 모름(실시간 끊김·첫 상태 전) → 목록 그대로 + 작은 단추(연결 없음으로 단정 안 함)', async () => {
    await render([{ ...robot('r1', false), unknown: 'link' }], true);
    expect(box.textContent).toContain('로봇-r1');
    expect(btn('+ 로봇 연결하기')?.className).toBe('btn');
  });

  it('앱 밖 → 카드 그대로 + 못 하는 이유만(단추 0)', async () => {
    await render([robot('r1', false)], false);
    expect(btn('+ 로봇 연결하기')).toBeUndefined();
    expect($('[data-robot-connect-note]')?.textContent).toContain('Android 앱에서만');
    expect(box.textContent).toContain('보기만');
  });

  it('누르면 찾기 표시 → 앱 결과·권한 거부 안내 → 항목 누름 → 다시 찾기 = 새 seq', async () => {
    await render([robot('r1', false)], true);
    act(() => btn('+ 로봇 연결하기')!.click());
    const sec = $('[data-nearby-scan]')!;
    expect(sec.getAttribute('data-nearby-scan')).toBe('1');
    expect($('[data-nearby]')?.dataset.nearby).toBe('scanning');
    send({ seq: '0', scanning: false, items: [ble('Go2_old')], problems: [] });   // 지난 찾기 — 무시
    expect(box.textContent).not.toContain('Go2_old');
    send({ seq: '1', scanning: true, items: [ble('Go2_49077'), agent('a', '192.168.12.18', 'r1')], problems: ['bt-perm'] });
    expect($('[data-nearby-problem="bt-perm"]')?.textContent).toBe(PROBLEM['bt-perm']);
    expect(btn('다시 찾기')!.disabled).toBe(true);
    const rows = [...box.querySelectorAll('[aria-expanded]')];
    expect(rows.map((r) => r.textContent)).toEqual(['go2-a○Wi-Fi에이전트 발견 · 내 조직 로봇 · 192.168.12.18', 'Go2_49077○블루투스에이전트 없음 · 신호 -60 dBm']);
    act(() => (rows[1] as HTMLButtonElement).click());
    expect($('[data-nearby-detail]')?.textContent).toContain('설치 필요');
    send({ seq: '1', scanning: false, items: [ble('Go2_49077')], problems: [] });
    expect($('[data-nearby]')?.dataset.nearby).toBe('done');
    act(() => btn('다시 찾기')!.click());
    expect($('[data-nearby-scan]')?.getAttribute('data-nearby-scan')).toBe('2');
    expect(box.textContent).not.toContain('Go2_49077');
    act(() => btn('닫기')!.click());
    expect($('[data-nearby-scan]')).toBeNull();
    expect(btn('+ 로봇 연결하기')).toBeDefined();
  });

  it('옛 앱(찾기 모름): 3초 답 없으면 업데이트 안내', async () => {
    vi.useFakeTimers();
    await render([], true);
    act(() => btn('+ 로봇 연결하기')!.click());
    act(() => { vi.advanceTimersByTime(NO_APP_MS); });
    expect($('[data-nearby]')?.dataset.nearby).toBe('old');
    expect(btn('다시 찾기')!.disabled).toBe(false);
  });
});
