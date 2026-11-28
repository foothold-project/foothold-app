// 조이스틱(시안 u9_7): 스틱 → 손잡이 규칙(stickTok) → 조이스틱 전용 키 keydown / keyup. 바뀐 것만 보냄 · 끊기면 모두 뗌 · 1 순위 = 번호가 가장 앞
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PAD_ALIAS, PAD_CODE, firstPad, keyCode, padToks, pollPad } from '../gamepad';

const pad = (index: number, axes: number[]) => ({ id: `pad${index}`, index, connected: true, axes, buttons: [], mapping: 'standard', timestamp: 0 });
let list: (ReturnType<typeof pad> | null)[] = [];
const seen: string[] = [];
const rec = (e: Event) => seen.push(`${e.type === 'keydown' ? '+' : '-'}${(e as KeyboardEvent).code}`);
addEventListener('keydown', rec); addEventListener('keyup', rec);
const use = (l: typeof list) => { list = l; Object.defineProperty(navigator, 'getGamepads', { configurable: true, value: () => list }); };
afterEach(() => { use([]); pollPad(); seen.length = 0; vi.restoreAllMocks(); });

describe('스틱 → 낱말', () => {
  it('왼쪽 = 큰 축 하나(위 앞 · 아래 뒤 · 옆걸음) · 오른쪽 = 가로 돌기 · 문턱 0.3 · 두 스틱은 합침', () => {
    expect(padToks(pad(0, [0, -0.8, 0, 0]))).toEqual(['up']);
    expect(padToks(pad(0, [0.5, -0.7, 0, 0]))).toEqual(['up']);   // 대각은 더 크게 민 쪽
    expect(padToks(pad(0, [-0.9, 0.2, 0, 0]))).toEqual(['left']);
    expect(padToks(pad(0, [0, 0.6, 0, 0]))).toEqual(['down']);
    expect(padToks(pad(0, [0, 0, 0.6, 0.9]))).toEqual(['rotr']);   // 오른쪽 세로는 안 씀
    expect(padToks(pad(0, [0.2, -0.29, 0.25, 0]))).toEqual([]);
    expect(padToks(pad(0, [0, -1, -1, 0]))).toEqual(['up', 'rotl']);
    expect(padToks(pad(0, [NaN, -1, 0]))).toEqual(['up']);   // 축이 모자라거나 값이 없으면 0
  });
  it('조이스틱 키는 같은 뜻 자판 키로 읽힘(↑ 전진 · ↓ 후진 · ← → 옆걸음 · A D 회전), 자판 키는 그대로', () => {
    expect(Object.values(PAD_CODE).map(keyCode)).toEqual(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyA', 'KeyD']);
    expect(keyCode('KeyW')).toBe('KeyW');
    expect(Object.keys(PAD_ALIAS).every((c) => c.startsWith('Pad'))).toBe(true);   // 자판 키와 이름이 겹치지 않음
  });
});

describe('읽기 → 키', () => {
  it('1 순위 = 연결된 것 중 번호가 가장 앞 · 바뀐 키만 보냄 · 가운데로 돌리면 뗌 · 끊기면 모두 뗌', () => {
    use([null, pad(2, [0, 0, 0, 0]), pad(1, [0, -1, 0, 0])]);
    expect(firstPad()!.index).toBe(1);
    pollPad(); pollPad();
    expect(seen).toEqual(['+PadUp']);
    list[2]!.axes = [0, -1, 1, 0]; pollPad();
    expect(seen).toEqual(['+PadUp', '+PadRotR']);
    list[2]!.axes = [0, 0, 1, 0]; pollPad();
    expect(seen.slice(2)).toEqual(['-PadUp']);
    use([]); pollPad();
    expect(seen.slice(3)).toEqual(['-PadRotR']);
  });
  it('탭이 숨으면 누른 키를 모두 뗌', () => {
    use([pad(0, [0, -1, 0, 0])]); pollPad();
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    pollPad();
    expect(seen).toEqual(['+PadUp', '-PadUp']);
  });
  it('조이스틱이 없는 브라우저(getGamepads 없음 · 던짐)도 조용히 0', () => {
    Object.defineProperty(navigator, 'getGamepads', { configurable: true, value: () => { throw new Error('x'); } });
    expect(firstPad()).toBeNull(); pollPad(); expect(seen).toEqual([]);
  });
});
