import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it } from 'vitest';
import { Go2ReplayLink } from '../screens/sim';
import type { Robot } from '../fake';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let clear = () => {};
afterEach(() => clear());
it('실기 로봇이 있을 때만 선택 뒤 같은 출처 보기 링크를 제공한다', () => {
  const box = document.createElement('div'); document.body.append(box);
  const root = createRoot(box); clear = () => { act(() => root.unmount()); box.remove(); };
  const robot = { id: '00000000-0000-4000-8000-000000000001', name: '시험 실기', sim: false } as Robot;
  act(() => root.render(<Go2ReplayLink robots={[{ ...robot, sim: true }]} />));
  expect(box.textContent).toBe('');
  act(() => root.render(<Go2ReplayLink robots={[robot, { ...robot, id: 'simulated', sim: true }]} />));
  expect(box.querySelector('a')).toBeNull();
  const select = box.querySelector('select')!;
  expect(select.options.length).toBe(2);
  act(() => { select.value = robot.id; select.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(box.querySelector('a')!.getAttribute('href')).toBe(`/sim/index.html?from=web&policy=go2-demo&robot=${robot.id}`);
  expect(box.textContent).toContain('실기 보기 전용');
  act(() => root.render(<Go2ReplayLink robots={[]} />));
  expect(box.querySelector('a')).toBeNull();
});
