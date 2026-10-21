import { beforeEach, vi } from 'vitest';
import { FakeWS } from './fakeWs';

// 시험마다 새 가짜 WebSocket(unstubAllGlobals 뒤에도 다시 끼운다)
beforeEach(() => { FakeWS.all = []; vi.stubGlobal('WebSocket', FakeWS); });
