// 로그인 뒤 돌아갈 곳(next): 이 앱의 해시 경로만 — 다른 주소·로그인 화면·이상한 글자는 기본 화면으로
import { describe, expect, it, vi } from 'vitest';
vi.mock('../../src/data/link', () => ({ dropAll: () => {}, hide: () => {} }));
vi.stubGlobal('location', { protocol: 'https:', hash: '' }); vi.stubGlobal('navigator', { userAgent: 'node' });
const { safeNext, gateOrigin } = await import('../../src/data/auth');

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

// 네이티브 FhGateCoreTest.gateOriginSameRulesAsGateProfile 과 같은 표(4c43dcd) + 몇 개
describe('gateOrigin', () => {
  it('통과·정규화', () => {
    for (const [a, b] of [['https://127.0.0.1:18453', 'https://127.0.0.1:18453'], ['https://127.0.0.1:18453/', 'https://127.0.0.1:18453'],
      ['https://gate.example.org', 'https://gate.example.org'], ['https://gate.example.org:65535', 'https://gate.example.org:65535']])
      expect(gateOrigin(a)).toEqual({ origin: b });
  });
  it('거부', () => {
    for (const b of ['http://127.0.0.1:18453', 'https://u:p@127.0.0.1:18453', 'https://127.0.0.1:18453/#x', 'https://127.0.0.1:18453#', 'https://127.0.0.1:18453/?a=1',
      'https://127.0.0.1:18453/MDrive.dc.html', 'https://*.example.org', 'https://localhost:18453', 'wss://127.0.0.1:18453', 'capacitor://localhost',
      'https://127.0.0.1:443', 'HTTPS://127.0.0.1:18453', ' https://127.0.0.1:18453', 'https://127.0.0.1:18453 ', '', 'https://Gate.example.org',
      'https://gate.example.org:65536', 'https://gate.example.org:99999', 'https://gate.example.org:',
      'https://관문.example.org', 'https://a.localhost', 'https://g:018453', 'https://', 'https://-a.org', 'https://a..b'])
      expect(gateOrigin(b), b).toHaveProperty('why');
  });
});
