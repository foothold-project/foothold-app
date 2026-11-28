// 시안 u11 겹 · 빈 화면 부품: 조종권 요청 창(u11_1) · 조종 화면 위 한 줄(u11_2 ~ u11_5) · 빈 화면(u11_6 ~ u11_8).
// 값은 rt(조종권 · 연결) · 에이전트 장치 줄에서만 온다. 버튼은 rt.respond 만 부르고, Enter · Space 로는 고르지 않는다(Space = 정지 키).
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Live } from '../rt';
import { DriveLine, EmptyLog, EmptyMap, EmptyRobots, TakeoverAsk, driveLine, remoteWhy } from '../proto/u11';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null, box: HTMLDivElement;
const draw = (el: JSX.Element) => { box = document.createElement('div'); box.className = 'proto'; document.body.append(box); act(() => { root = createRoot(box); root.render(el); }); };
afterEach(() => { act(() => root?.unmount()); root = null; box?.remove(); });
const $ = (s: string) => box.querySelector<HTMLElement>(s)!;
const L = (o: Partial<Live> = {}): Live => ({ state: null, stateAt: 0, holder: null, lease: null, rev: 0, neutral: false, busy: null, failed: false, incoming: null, outgoing: null, cooldown: 0, stop: null, releasing: null, released: 0, runReq: null, ...o });
const OPEN = { at: 'open' as const };
const drive = (label: string) => ({ devices: [{ key: 'go2-drive-input', kind: 'OTHER', label, state: 'OK' }] }) as unknown as Live['state'];

describe('u11 겹 부품', () => {
  it('u11_1 조종권 요청 창: 시안 글 · 남은 초 · 막대 · 계속 조종 = 거절 · 넘기기 = 수락 · Enter/Space 는 고르지 않음', () => {
    const answer = vi.fn();
    draw(<TakeoverAsk robot="K-01" q={{ id: 'q1', name: '운영자 A', role: 'OPERATOR', until: 7_000, ms: 10_000 }} now={0} answer={answer} />);
    expect($('[data-takeover-ask]').textContent).toContain('운영자 A 님이 K-01 조종권을 요청했습니다넘겨주시겠습니까?');
    expect($('[data-takeover-ask]').textContent).toContain('7 초 안에 답하지 않으면 조종권을 넘기지 않습니다');
    expect($('.tbar i').style.width).toBe('70%');
    expect($('.veil')).not.toBeNull();
    for (const key of ['Enter', ' ']) {
      const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
      $('[data-give]').dispatchEvent(e);
      expect(e.defaultPrevented).toBe(true);
    }
    act(() => { $('[data-give]').click(); });   // 키보드 · 화면 읽기 click(detail 0)은 고르지 않음
    expect(answer).not.toHaveBeenCalled();
    act(() => { $('[data-keep]').dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })); });
    act(() => { $('[data-give]').dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })); });
    expect(answer.mock.calls).toEqual([[false], [true]]);
  });

  it('조종 화면 한 줄 고르기: 서버 끊김 → 리모컨(에이전트 글 그대로) → 내 요청 기다림 → 넘겨줌, 없으면 없음', () => {
    const base = { link: OPEN, me: 'u-me', now: 0, handedTo: null, fresh: true };
    expect(driveLine({ ...base, l: L() })).toBeNull();
    expect(driveLine({ ...base, link: { at: 'lost' }, l: L({ state: drive('리모컨 동작 중이라 화면 조종은 멈춰 있습니다') }) })).toMatchObject({ kind: 'err', title: '서버와 연결이 끊겼습니다', at: 'link' });
    expect(driveLine({ ...base, l: L({ state: drive('리모컨 동작 중이라 화면 조종은 멈춰 있습니다') }) })).toEqual({ kind: 'amb', title: '리모컨이 우선입니다', sub: '리모컨 동작 중이라 화면 조종은 멈춰 있습니다', at: 'remote' });
    expect(driveLine({ ...base, fresh: false, l: L({ state: drive('리모컨 동작 중이라 화면 조종은 멈춰 있습니다') }) })).toBeNull();   // 오래된 상태의 글은 안 씀
    expect(remoteWhy(drive('비상정지가 걸려 있습니다')!.devices)).toBeNull();
    expect(driveLine({ ...base, now: 2_100, l: L({ holder: { type: 'USER', id: 'u-a', name: '운영자 A' }, outgoing: { until: 10_000 } }) }))
      .toEqual({ kind: 'amb', title: '운영자 A 님에게 조종권을 요청했습니다', sub: '답을 기다리는 중 · 8 초', at: 'ask' });
    expect(driveLine({ ...base, handedTo: '운영자 A', l: L({ holder: { type: 'USER', id: 'u-a', name: '운영자 A' } }) }))
      .toEqual({ kind: 'ok', title: '조종권을 운영자 A 님에게 넘겼습니다', sub: '보기 전용입니다 · 정지 버튼은 계속 쓸 수 있습니다', at: 'handed' });
    draw(<DriveLine f={driveLine({ ...base, handedTo: '운영자 A', l: L() })!} />);
    expect($('.line1.ok.over[data-drive-line="handed"]').textContent).toBe('조종권을 운영자 A 님에게 넘겼습니다보기 전용입니다 · 정지 버튼은 계속 쓸 수 있습니다');
  });

  it('u11_6 ~ u11_8 빈 화면: 시안 그림 · 제목 · 글 · 단추(기록은 단추 없음)', () => {
    draw(<><EmptyRobots /><EmptyMap /><EmptyLog /></>);
    const t = (k: string) => [$(`[data-empty="${k}"] h2`).textContent, $(`[data-empty="${k}"] p`).textContent, $(`[data-empty="${k}"] .btnp`)?.textContent ?? null];
    expect(t('robots')).toEqual(['등록된 로봇이 없습니다', '폰에 뜬 QR 을 로봇 앞 카메라에 보여 주면 연결됩니다. 연결하면 여기에 보입니다.', '로봇 연결']);
    expect(t('map')).toEqual(['아직 지도가 없습니다', '로봇을 조종해 한 바퀴 걸으면 지도가 만들어집니다.', '로봇 탭으로']);
    expect(t('log')).toEqual(['아직 기록이 없습니다', '임무를 실행하거나 알림이 생기면 여기에 시간 순서로 남습니다.', null]);
    expect($('[data-empty="robots"] svg.art').children.length).toBeGreaterThan(0);
  });
});
