import { beforeEach, expect, test, vi } from 'vitest';
// UI-SIMPLIFY v3 U1-a: 개발자 모드(URL 초기 우선·스위치 즉시·주소 dev 만 정합·저장/주소 막힘) + 칩/도움말 기반. 송신 0(dropAll 만).
const drop = vi.fn();
vi.mock('../../src/data/link', () => ({ dropAll: () => drop() }));
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import chipSrc from '../../src/app/chip.tsx?raw';
import devSrc from '../../src/data/dev.ts?raw';

const cls = new Set<string>();
let store: Record<string, string> = {}, blockStore = false, blockUrl = false, url = '';
const L = { pathname: '/', search: '', hash: '' };
const setUrl = (u: string) => { const m = u.match(/^([^?#]*)(\?[^#]*)?(#.*)?$/)!; url = u; L.pathname = m[1]; L.search = m[2] || ''; L.hash = m[3] || ''; };
Object.assign(globalThis, {
  location: L,
  document: { documentElement: { classList: { toggle: (c: string, on: boolean) => (on ? cls.add(c) : cls.delete(c)) } } },
  localStorage: { getItem: (k: string) => { if (blockStore) throw new Error('blocked'); return store[k] ?? null; }, setItem: (k: string, v: string) => { if (blockStore) throw new Error('blocked'); store[k] = v; } },
  history: { state: { keep: 1 }, replaceState: (_s: unknown, _t: string, u: string) => { if (blockUrl) throw new Error('blocked'); setUrl(u); } },
});
const D = await import('../../src/data/dev');
const { Chip, Help, TONE_ICON } = await import('../../src/app/chip');

beforeEach(() => { cls.clear(); store = {}; blockStore = blockUrl = false; drop.mockClear(); setUrl('/'); D.useDev.setState({ on: false }); });

test('초기값 우선순위: 유효한 URL dev > 저장값 1/0 > 꺼짐 · 모르는 값 무시', () => {
  expect(D.devInit('?dev=1', '0')).toBe(true);
  expect(D.devInit('?dev=0', '1')).toBe(false);
  expect(D.devInit('?dev=yes', '1')).toBe(true);     // 모르는 URL 값 → 저장값
  expect(D.devInit('?x=1', '0')).toBe(false);
  expect(D.devInit('', 'true')).toBe(false);          // 모르는 저장값 → 꺼짐
  expect(D.devInit('', null)).toBe(false);
  expect(D.devInit('?a=1&dev=1&dev=0', null)).toBe(true);   // 첫 dev
});

test('devSearch: dev 만 바꾸고 다른 쿼리 순서·인코딩 보존, 중복 dev 정리', () => {
  expect(D.devSearch('', true)).toBe('?dev=1');
  expect(D.devSearch('?a=%20b+c&dev=1&z', false)).toBe('?a=%20b+c&z&dev=0');
  expect(D.devSearch('?dev=1&dev=0&developer=1', true)).toBe('?developer=1&dev=1');
  // D1: 읽기와 같은 디코드 키 — 인코딩된 dev 도 지움, 다른 쿼리(인코딩된 비 dev 키 포함)는 원문·순서 그대로
  expect(D.devSearch('?%64ev=1', false)).toBe('?dev=0');
  expect(D.devSearch('?de%76=1&a=%20&dev=0&%64ev', true)).toBe('?a=%20&dev=1');
  expect(D.devSearch('?%64ev2=1&x=%64ev&b=%E0%A4%A&de%76=0', false)).toBe('?%64ev2=1&x=%64ev&b=%E0%A4%A&dev=0');
  // D2: 조각 맨 앞 ? 는 키의 일부(전체 search 와 같은 뜻) — 비 dev 키 ?dev·??dev 보존
  expect(D.devSearch('?a=1&?dev=keep&dev=1', false)).toBe('?a=1&?dev=keep&dev=0');
  expect(D.devSearch('??dev=1', true)).toBe('??dev=1&dev=1');
  expect(D.devSearch('?%3Fdev=1&??dev&?%64ev=2&%64ev=1&dev', false)).toBe('?%3Fdev=1&??dev&?%64ev=2&dev=0');
  for (const q of ['?a=1&?dev=keep&dev=1', '??dev=1', '?%3Fdev=1&??dev&?%64ev=2&%64ev=1&dev', '?x=%E0%A4%A&de%76=1#h'])   // 읽기와 정리가 같은 키를 dev 로 봄
    expect(new URLSearchParams(D.devSearch(q, false)).getAll('dev')).toEqual(['0']);
  expect(D.devInit('??dev=1', null)).toBe(false); expect(D.devInit('?a=1&?dev=1', null)).toBe(false);
});

test('devStart: URL 이 저장값보다 우선 · 저장 막힘이어도 URL 로 켜짐 · <html> 클래스', () => {
  setUrl('/?dev=1#/PcPlan?mission=a'); store['fh.dev'] = '0'; D.devStart();
  expect(D.useDev.getState().on).toBe(true); expect(cls.has('fh-dev')).toBe(true);
  setUrl('/#/Main'); store['fh.dev'] = '1'; D.devStart(); expect(D.useDev.getState().on).toBe(true);
  blockStore = true; setUrl('/#/Main'); D.devStart(); expect(D.useDev.getState().on).toBe(false); expect(cls.has('fh-dev')).toBe(false);
});

test('스위치: 입력 폐기 → 즉시 전환 · 저장값과 주소 dev 만 정합(경로·hash·다른 쿼리 보존) · URL 이 켠 채 고정 안 됨', () => {
  setUrl('/app/?q=1&dev=1#/PcPlan?mission=m1&dev=1'); D.devStart(); expect(D.useDev.getState().on).toBe(true);
  expect(D.setDev(false)).toBe(null);
  expect(drop).toHaveBeenCalledTimes(1); expect(D.useDev.getState().on).toBe(false); expect(cls.has('fh-dev')).toBe(false);
  expect(store['fh.dev']).toBe('0'); expect(url).toBe('/app/?q=1&dev=0#/PcPlan?mission=m1&dev=1');   // hash 안 dev 는 건드리지 않음
  D.devStart(); expect(D.useDev.getState().on).toBe(false);   // 새로 열어도 꺼짐(URL 이 다시 켜지 않음)
});

test('D1: 인코딩된 dev 로 켠 뒤 끄면 주소에 켜는 값이 남지 않아 재진입도 꺼짐 · 혼합 중복', () => {
  for (const [u, hash] of [['/?%64ev=1#/Main?dev=1', '#/Main?dev=1'], ['/?a=1&de%76=1&dev=1&%64%65%76=1#/Main', '#/Main']]) {
    setUrl(u); store['fh.dev'] = '1'; D.devStart(); expect(D.useDev.getState().on).toBe(true);
    expect(D.setDev(false)).toBe(null);
    expect(new URLSearchParams(L.search).getAll('dev')).toEqual(['0']); expect(L.hash).toBe(hash);   // hash 안 dev 무접촉
    D.devStart(); expect(D.useDev.getState().on).toBe(false);
  }
  expect(url).toBe('/?a=1&dev=0#/Main');
  // 주소 반영 실패: 이 탭은 꺼지지만 주소에 켜는 값이 남음 → 안내 글로 알림(재진입 시 URL 우선은 기존 규칙)
  setUrl('/?%64ev=1'); D.devStart(); blockUrl = true;
  const t = D.setDev(false); expect(D.useDev.getState().on).toBe(false); expect(t).toContain('주소'); expect(t).toContain('이 탭에만');
});

test('저장·주소가 막혀도 이 탭은 전환되고 알릴 글을 돌려줌', () => {
  blockStore = true; blockUrl = true;
  const t = D.setDev(true);
  expect(D.useDev.getState().on).toBe(true); expect(cls.has('fh-dev')).toBe(true);
  expect(t).toContain('이 탭에만'); expect(t).toContain('브라우저 저장'); expect(t).toContain('주소');
  blockUrl = false; expect(D.setDev(false)).toContain('브라우저 저장'); expect(url).toBe('/?dev=0');
});

test('개발자 모드는 표시만 — 송신·조종 경로 import 0', () => {
  expect(devSrc).toMatch(/import \{ dropAll \} from '\.\/link'/);
  expect(devSrc).not.toMatch(/sendOp|sendStop|startDrive|take|resume|location\.(reload|assign|replace)\(/);
  expect(chipSrc).not.toMatch(/preventDefault|stopPropagation|sendOp|sendStop/);   // 도움말 닫기가 STOP 첫 누름을 먹지 않음
});

test('칩: 톤별 모양 아이콘 + 짧은 글 · 이유는 별도 ? 단추와 연결된 숨은 전문', () => {
  expect(new Set(Object.values(TONE_ICON)).size).toBe(4);
  const html = renderToStaticMarkup(h(Chip, { tone: 'warn', text: '상태 확인 안 됨', why: '링크 상태가 들어오지 않음 — 꺼짐으로 단정하지 않음' }));
  expect(html).toContain('data-tone="warn"'); expect(html).toContain('▲'); expect(html).toContain('상태 확인 안 됨');
  const ctl = html.match(/aria-controls="([^"]+)"/)![1];
  expect(html).toContain(`id="${ctl}"`); expect(html).toMatch(/aria-expanded="false"/); expect(html).toMatch(/hidden=""/);
  expect(html).toContain('꺼짐으로 단정하지 않음');   // 전문은 DOM 에 남음(접근 가능)
  expect(html).toContain('aria-label="상태 확인 안 됨 · 설명"');
  expect(renderToStaticMarkup(h(Chip, { tone: 'off', text: '시뮬 꺼짐' }))).not.toContain('lv-q');   // 이유 없으면 ? 없음
  expect(renderToStaticMarkup(h(Help, { label: '설명', children: '본문' }))).toContain('type="button"');
});
