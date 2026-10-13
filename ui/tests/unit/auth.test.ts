// 로그인 뒤 돌아갈 곳(next): 이 앱의 해시 경로만 — 다른 주소·로그인 화면·이상한 글자는 기본 화면으로
import { describe, expect, it, vi } from 'vitest';
vi.mock('../../src/data/link', () => ({ dropAll: () => {}, hide: () => {} }));
vi.stubGlobal('location', { protocol: 'https:', hash: '' }); vi.stubGlobal('navigator', { userAgent: 'node' });
const { safeNext } = await import('../../src/data/auth');

describe('safeNext', () => {
  it('앱 해시 경로만 통과', () => {
    expect(safeNext('#/MDrive', true)).toBe('#/MDrive');
    expect(safeNext('#/PcMap?draw=금지', false)).toBe('#/PcMap?draw=금지');
  });
  it('그 밖은 기본 화면', () => {
    for (const x of [null, '', 'https://evil.example/', '//evil.example', '/Main.dc.html', '#/MLogin?next=x', '#/PcLogin', '#//evil', '#/Main#x', '#/Main?a b', 'javascript:alert(1)'])
      expect([safeNext(x, true), safeNext(x, false)]).toEqual(['#/MDrive', '#/Main']);
  });
});
