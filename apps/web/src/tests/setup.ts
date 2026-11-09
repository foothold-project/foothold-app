import { beforeEach, vi } from 'vitest';
import { FakeWS } from './fakeWs';

// 시험마다 새 가짜 WebSocket(unstubAllGlobals 뒤에도 다시 끼운다)
beforeEach(() => { FakeWS.all = []; vi.stubGlobal('WebSocket', FakeWS); });

// SCEN-NODE-PREVIEW: React Flow(시나리오 노드 보기)가 쓰는 브라우저 기능 — jsdom 에 없을 때만 최소 대역
const g = globalThis as Record<string, unknown>;
g.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
g.DOMMatrixReadOnly ??= class { m22 = 1; };
