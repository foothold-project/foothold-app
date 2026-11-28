// 주변 로봇 찾기 · 망 막힘(wifi-off · other-subnet) 때 «핫스팟으로 바꾸기» 안내 (U2-05 · L67). 웹은 폰 Wi-Fi 를 바꾸지 못하므로 안내까지만.
import { act } from 'react';
import { createRoot, type Root as ReactRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { Nearby, detail, type Found } from '../nearby';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: ReactRoot | null = null, box: HTMLDivElement;
const $ = (s: string) => box.querySelector<HTMLElement>(s);
const btn = (t: string) => [...box.querySelectorAll('button')].find((b) => b.textContent === t) as HTMLButtonElement | undefined;
const HOT = '핫스팟으로 바꾸기 · 안내만';
function render() {
  box = document.createElement('div'); document.body.append(box);
  act(() => { root = createRoot(box); root.render(<Nearby robots={[]} close={() => {}} />); });
}
const send = (seq: string, problems: string[]) => act(() => { window.dispatchEvent(new CustomEvent('fh-nearby', { detail: { seq, scanning: false, items: [], problems } })); });
afterEach(() => { act(() => root?.unmount()); root = null; box?.remove(); });

describe('망 막힘 → 핫스팟 안내', () => {
  it('찾기 결과 전이거나 망 문제가 아니면 단추 없음', () => {
    render();
    expect(btn(HOT)).toBeUndefined();
    send('1', ['bt-perm', 'wifi-no-internet']);
    expect(btn(HOT)).toBeUndefined();
  });

  it.each(['wifi-off', 'other-subnet'])('%s → 단추(닫힘) · 누르면 안내 펼침, 앱이 Wi-Fi 를 못 바꾼다고 밝힘 · 링크 없음', (p) => {
    render();
    send('1', [p]);
    const b = btn(HOT)!;
    expect(b.getAttribute('aria-expanded')).toBe('false');
    expect($('[data-hotspot-guide]')).toBeNull();
    act(() => b.click());
    expect(b.getAttribute('aria-expanded')).toBe('true');
    const g = $('[data-hotspot-guide]')!;
    expect(b.getAttribute('aria-controls')).toBe(g.id);
    expect(g.textContent).toContain('이 앱은 폰 Wi-Fi 를 바꾸지 못합니다');
    expect([...g.querySelectorAll('li')].map((l) => l.textContent)).toEqual([
      '로봇 전원을 켜고 핫스팟이 보일 때까지 기다립니다.',
      '폰 설정 › Wi-Fi 에서 로봇 핫스팟을 고릅니다. 이름과 비밀번호는 로봇 설명서나 관리자에게 확인하세요. 에이전트를 돌리는 노트북도 같은 핫스팟에 붙여야 합니다.',
      '핫스팟에는 인터넷이 없을 수 있어 그동안 서버 연결이 끊길 수 있습니다.',
      '이 화면으로 돌아와 아래 «다시 찾기»를 누릅니다.',
    ]);
    expect(g.querySelector('a')).toBeNull();
    act(() => b.click());
    expect($('[data-hotspot-guide]')).toBeNull();
  });

  it('안내를 연 채 «다시 찾기» = 새 찾기(seq+1) · 안내 닫힘', () => {
    render();
    send('1', ['wifi-off']);
    act(() => btn(HOT)!.click());
    act(() => btn('다시 찾기')!.click());
    expect($('[data-nearby-scan]')!.getAttribute('data-nearby-scan')).toBe('2');
    expect($('[data-hotspot-guide]')).toBeNull();
    send('2', ['wifi-off']);
    expect(btn(HOT)!.getAttribute('aria-expanded')).toBe('false');
  });
});

describe('연결할 수 없는 에이전트 안내는 사용자 말', () => {
  it('로봇 ID 를 알리지 않은 에이전트: 개발 상태 말 대신 할 일', () => {
    const f: Found = { key: 'a', via: 'mdns', name: 'go2-a', host: '10.0.0.2', port: 8765 };
    const t = detail(f, []);
    expect(t).toBe('에이전트 발견: go2-a 10.0.0.2:8765 · 이 로봇은 폰 연결 정보를 알리지 않아 이 화면에서 연결할 수 없습니다. 관리자에게 로봇 설정 확인을 부탁하세요.');
    expect(t).not.toContain('준비 중');
  });
});
