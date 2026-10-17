// 접속 프로필·QR 주소·관문 검사 판정 — 비밀 0, 주소 형식은 gateOrigin 규칙 그대로
import { describe, expect, it, vi } from 'vitest';
vi.mock('../../src/data/link', () => ({ dropAll: () => {}, hide: () => {}, closeLink: () => {} }));
vi.stubGlobal('location', { protocol: 'https:', hash: '' }); vi.stubGlobal('navigator', { userAgent: 'node' });
const { kindOf, parseProfiles, addProfile, originFromText, healthOk, stepsOf } = await import('../../src/data/gate_profile');

describe('kindOf', () => {
  it('주소 대역으로 종류(포트 무관)', () => {
    expect(kindOf('https://100.101.2.3:9000')).toBe('tailscale');
    expect(kindOf('https://pc.tail1234.ts.net:8453')).toBe('tailscale');
    for (const o of ['https://192.168.0.5:8453', 'https://10.0.0.2', 'https://172.20.1.1:1', 'https://go2pc.local:8453']) expect(kindOf(o)).toBe('lan');
    for (const o of ['https://100.128.0.1:8453', 'https://8.8.8.8', 'https://example.com:8453', 'https://172.32.0.1']) expect(kindOf(o)).toBe('other');
  });
});

describe('profiles', () => {
  it('형식 틀린 항목·중복·나쁜 origin 은 버림, 최대 8', () => {
    const ok = { id: 'a', name: 'LAN', kind: 'lan', origin: 'https://192.168.0.5:8453' };
    const raw = JSON.stringify({ v: 1, profiles: [ok, ok, { ...ok, id: 'b', origin: 'http://192.168.0.6' }, { ...ok, id: 'c', origin: 'https://u:p@h.example' },
      { ...ok, id: 'd', kind: 'x', origin: 'https://h.example' }, { ...ok, id: 'e', origin: 'https://h.example/path' }, { ...ok, id: 'f', name: 'x'.repeat(41), origin: 'https://g.example' }] });
    expect(parseProfiles(raw).map((p) => p.id)).toEqual(['a']);
    for (const bad of [null, '', 'x', '{"v":2,"profiles":[]}', '{"v":1}']) expect(parseProfiles(bad)).toEqual([]);
  });
  it('추가: 같은 주소는 앞으로, 8개 상한, 이름에 비밀 없음', () => {
    let l = [] as ReturnType<typeof parseProfiles>;
    for (let i = 0; i < 10; i++) l = addProfile(l, `https://192.168.0.${i + 1}:8453`, i);
    expect(l.length).toBe(8); expect(l[0].origin).toBe('https://192.168.0.10:8453');
    l = addProfile(l, 'https://192.168.0.5:8453', 99); expect(l[0].origin).toBe('https://192.168.0.5:8453'); expect(l.length).toBe(8);
    expect(l[0].name).toBe('LAN · 192.168.0.5:8453');
  });
});

describe('originFromText (QR·붙여넣기)', () => {
  it('평문 origin 만', () => {
    expect(originFromText(' https://192.168.0.5:8453/ ')).toEqual({ origin: 'https://192.168.0.5:8453' });
    for (const bad of ['', 'fhgate:1?o=https%3A%2F%2Fh', 'https://h.example/?t=abc', 'https://user:pw@h.example', 'https://h.example/#/MLogin', 'http://h.example', 'WIFI:S:x;P:y;;', 'https://h.example/api'])
      expect('why' in originFromText(bad)).toBe(true);
  });
});

describe('healthOk', () => {
  it('정확한 두 키만', () => {
    expect(healthOk(200, '{"app":"foothold-gate","api":1}')).toBe(true);
    for (const [s, b] of [[200, '<html>'], [404, '{"app":"foothold-gate","api":1}'], [200, '{"app":"foothold-gate","api":1,"x":1}'], [200, '{"app":"foothold-gate","api":"1"}'], [200, '{"app":"other","api":1}'], [200, '{"app":"foothold-gate","api":0}'], [200, '[]']] as const)
      expect(healthOk(s, b)).toBe(false);
  });
});

describe('stepsOf', () => {
  it('실패 칸 뒤는 미확인, 저장≠확인', () => {
    expect(stepsOf(null, false, false)).toEqual(['bad', 'unk', 'unk', 'unk']);
    expect(stepsOf(null, true, false)).toEqual(['ok', 'unk', 'unk', 'unk']);
    expect(stepsOf({ ok: false, step: 'tls', why: '' }, true, false)).toEqual(['ok', 'ok', 'bad', 'unk']);
    expect(stepsOf({ ok: false, step: 'gate', why: '' }, true, true)).toEqual(['ok', 'ok', 'brw', 'bad']);
    expect(stepsOf({ ok: false, step: 'none', why: '' }, true, false)).toEqual(['ok', 'unk', 'unk', 'unk']);
    expect(stepsOf({ ok: true, ms: 5 }, true, false)).toEqual(['ok', 'ok', 'ok', 'ok']);
  });
  it('웹: https 페이지·검사 성공이어도 인증서는 «브라우저 처리·신뢰 미확인»(확인됨 0)', () => {
    expect(stepsOf({ ok: true, ms: 5 }, true, true)).toEqual(['ok', 'ok', 'brw', 'ok']);
    expect(stepsOf(null, true, true)).toEqual(['ok', 'unk', 'brw', 'unk']);
    expect(stepsOf({ ok: false, step: 'busy', why: '' }, true, true)).toEqual(['ok', 'unk', 'brw', 'unk']);
    expect(stepsOf({ ok: false, step: 'reach', why: '' }, true, true)).toEqual(['ok', 'bad', 'brw', 'unk']);
    expect(stepsOf(null, false, true)).toEqual(['bad', 'unk', 'unk', 'unk']);
    for (const h of [null, { ok: true, ms: 1 }, { ok: false, step: 'gate', why: '' }] as const) expect(stepsOf(h as any, true, true)[2]).not.toBe('ok');
  });
});
