import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { PhoneRelayState } from '../../../contracts/ts';
import { PhoneRelay } from '../phoneRelay';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined, box: HTMLDivElement;
afterEach(() => { act(() => root?.unmount()); box?.remove(); vi.restoreAllMocks(); vi.useRealTimers(); });
const sample: PhoneRelayState = { source: 'PHONE', age_s: .1, valid_for_s: 2.9,
  battery: { soc: 75, updated_at: '2026-01-01T00:00:00Z' }, speed: .5,
  devices: [{ key: 'lidar', kind: 'LIDAR', label: '폰이 전한 라이다', state: 'OK' }] };

it('shows provenance and age, then hides values after three seconds without another packet', () => {
  vi.useFakeTimers();
  let at = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => at);
  box = document.createElement('div'); document.body.append(box); root = createRoot(box);
  act(() => root!.render(<PhoneRelay report={sample} receivedAt={0} />));
  expect(box.textContent).toContain('폰 경유 · 0초 전');
  expect(box.textContent).toContain('75%');
  at = 2000; act(() => { vi.advanceTimersByTime(2000); });
  expect(box.textContent).toContain('폰 경유 · 2초 전');
  at = 2901; act(() => { vi.advanceTimersByTime(901); });
  expect(box.textContent).toBe('폰 경유 · 모름');
  expect(box.textContent).not.toContain('정상');
});

it('clears values as soon as the server withdraws the relay snapshot', () => {
  box = document.createElement('div'); document.body.append(box); root = createRoot(box);
  act(() => root!.render(<PhoneRelay report={sample} receivedAt={performance.now()} />));
  expect(box.textContent).toContain('75%');
  act(() => root!.render(<PhoneRelay report={null} />));
  expect(box.textContent).toBe('폰 경유 · 모름');
});
