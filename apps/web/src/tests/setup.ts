import { beforeEach, vi } from 'vitest';
import { FakeWS } from './fakeWs';

// 시험마다 새 가짜 WebSocket(unstubAllGlobals 뒤에도 다시 끼운다)
beforeEach(() => { FakeWS.all = []; vi.stubGlobal('WebSocket', FakeWS); });

// SCEN-NODE-PREVIEW: React Flow(시나리오 노드 보기)가 쓰는 브라우저 기능 — jsdom 에 없을 때만 최소 대역
const g = globalThis as Record<string, unknown>;
g.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
g.DOMMatrixReadOnly ??= class { m22 = 1; };

// Node 24 의 fetch Response.blob() 은 jsdom 의 Blob 을 돌려주는데 jsdom Blob 에는 text · arrayBuffer 가 없다(브라우저에는 있음).
// 없을 때만 jsdom FileReader 로 채운다. 앱 코드는 그대로 브라우저 Blob 기능을 쓴다
if (typeof Blob !== 'undefined' && typeof FileReader !== 'undefined') {
  const read = <T,>(b: Blob, how: 'readAsText' | 'readAsArrayBuffer') => new Promise<T>((ok, fail) => {
    const r = new FileReader(); r.onload = () => ok(r.result as T); r.onerror = () => fail(r.error); r[how](b);
  });
  Blob.prototype.text ??= function (this: Blob) { return read<string>(this, 'readAsText'); };
  Blob.prototype.arrayBuffer ??= function (this: Blob) { return read<ArrayBuffer>(this, 'readAsArrayBuffer'); };
}
