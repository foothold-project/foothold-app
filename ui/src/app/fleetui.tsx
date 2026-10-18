// 새 기획(10-18) 공용 부품 — #/Fleet·#/MapEditor(PC 틀)·#/Field 가 같이 씀.
// STOP 은 기존 stopProps(stopNow) 그대로 — 새 명령 경로 0. 색은 브랜드 토큰만(새 색 0).
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { BrandLogo } from './BrandLogo';
import { LiveStatus } from './status';
import { stopProps } from './shell';
import { PHONE } from '../data/auth';
import { themeClass } from '../data/fmt';
import { useDocs } from '../data/shared';
import { ctx } from '../data/scratch';
import { CSS } from '../screens/PcMap.view';
import { type Analysis, type ProjectMeta, type RRes, type Scene, type Listing, SH, listProjects, rcall } from '../data/rehearsal';

// ---- 화면 폭(반응형 단계) ----
const wsub = (f: () => void) => { addEventListener('resize', f); return () => removeEventListener('resize', f); };
export const useWidth = () => useSyncExternalStore(wsub, () => innerWidth, () => 1440);

// ---- 값 출처 꼬리표: 다섯 가지만(SPEC 8) ----
export type Src = 'live_sim' | 'live_real' | 'plan' | 'geo' | 'unmeasured';
const SRC_KO: Record<Src, string> = { live_sim: '연결됨 · 시뮬', live_real: '연결됨 · 실기', plan: '계획', geo: '기하', unmeasured: '미측정' };
export function SourceTag({ k }: { k: Src }) {
  const live = k === 'live_sim' || k === 'live_real';
  return <span data-src={k} style={{ display: 'inline-flex', alignItems: 'center', height: 22, padding: '0 8px', borderRadius: 999, fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap',
    border: `1px ${k === 'plan' ? 'dashed' : 'solid'} ${live ? 'var(--accent)' : 'var(--line2)'}`, color: live ? 'var(--accent)' : 'var(--muted)', background: live ? 'var(--acc-bg)' : 'transparent' }}>{SRC_KO[k]}</span>;
}

// ---- 모드(리허설 | 현장 관제): 사용자 고른 값만 localStorage 편의 기억(실패 = 기본값) ----
export type Mode = 'rehearsal' | 'live';
const MKEY = 'fh.fleet.mode';
export const savedMode = (): Mode | null => { try { const v = localStorage.getItem(MKEY); return v === 'rehearsal' || v === 'live' ? v : null; } catch { return null; } };
export const saveMode = (m: Mode) => { try { localStorage.setItem(MKEY, m); } catch { /* 기억 못 해도 화면은 그대로 */ } };
export function ModeSwitch({ mode, set }: { mode: Mode; set: (m: Mode) => void }) {
  const b = (m: Mode, t: string) => <button type="button" className="tool" aria-pressed={mode === m} onClick={() => set(m)} style={{ minHeight: 44 }}>{t}</button>;
  return <div role="group" aria-label="모드" style={{ display: 'flex', gap: 2, padding: 2, border: '1px solid var(--line)', borderRadius: 8 }}>{b('rehearsal', '리허설')}{b('live', '현장 관제')}</div>;
}
// 연결 로봇 수 = 신선한 몸 상태(linkView.s)가 있을 때만 1. linkOk 는 관문 status WS 신선도라 Gazebo 꺼짐·몸 상태 없음도 참 → 그때는 0대 + «관문 연결 · 몸 상태 미확인»(root 10-18).
// direct = 실기 Go2 선택(직접 연결 미구현 · linkView 가 linkOk=false). 상태칩·STOP 은 기존 그대로 — 이 값은 «몇 대» 글에만.
export type LiveN = { n: 0 | 1; txt: string };
export const liveOf = (v: { linkOk: boolean; s: unknown }, direct: boolean): LiveN =>
  v.s ? { n: 1, txt: '연결됨 · 시뮬' } : v.linkOk ? { n: 0, txt: '관문 연결 · 몸 상태 미확인' } : direct ? { n: 0, txt: '실기 Go2 선택됨 · 미연결(직접 연결 준비 중)' } : { n: 0, txt: '연결 없음' };
export function ModeBand({ mode, live }: { mode: Mode; live: LiveN }) {
  const r = mode === 'rehearsal';
  return <div role="status" data-mode={mode} style={{ padding: '8px 16px', fontSize: 13, background: r ? 'var(--paper-2, var(--panel2))' : 'var(--acc-bg)',
    borderTop: r ? '2px dashed var(--line)' : '3px solid var(--accent)', color: 'var(--text)' }}>
    {r ? '리허설 · 계획과 2D 기하 검토만 · STOP은 기존 연결 대상에 요청'
      : live.n ? '현장 관제 · 연결 로봇 1대(시뮬)' : `현장 관제 · 연결 로봇 0대 · ${live.txt}`}
  </div>;
}

/** 폰(또는 600px 미만)에서 PC 화면을 열면 — 지우지 않고 안내 띠만 */
export function PcOnlyBand() {
  const w = useWidth();
  if (!PHONE && w >= 600) return null;
  return <div role="note" style={{ padding: '10px 16px', fontSize: 14, background: 'var(--warn-bg)', borderBottom: '1px solid var(--line)' }}>
    PC 화면입니다 · 현장에서는 <a href="#/Field" style={{ color: 'var(--accent)', fontWeight: 600 }}>현장 모드</a></div>;
}

// ---- PC 틀: 머리(로고·제목·상태칩·STOP 원래 마크업) + 주 메뉴 + 본문 ----
// ── 주 메뉴(10-18 design-nav.md 1f6f5465 N3·N4): 순서·아이콘 = 다른 PC 화면 8곳과 같게. 그림은 PcMap.view 84–145행 SVG 그대로 복사(새 그림 0) ──
const I = (c: React.ReactNode) => <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">{c}</svg>;
const NAV: [string, string, React.ReactNode][] = [
  ['Main', '관제', I(<><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3" /></>)],
  ['PcMissions', '임무', I(<><path d="M4 19l5-14 5 9 3-4 3 9" /><circle cx="9" cy="5" r="1.5" /></>)],
  ['PcHistory', '기록', I(<><rect x="4" y="3" width="16" height="18" rx="2" /><path d="M8 8h8M8 12h8M8 16h5" /></>)],
  ['PcMap', '지도', I(<><path d="M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2z" /><path d="M9 4v14M15 6v14" /></>)],
  ['PcRobot', '로봇', I(<><rect x="6" y="4" width="12" height="14" rx="3" /><path d="M9 21h6M12 18v3M9 9h.01M15 9h.01" /></>)],
  ['Fleet', '전체 관제', I(<><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 10h18M9 10v10" /></>)],
  ['MapEditor', '지도 편집', I(<><path d="M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2z" /><path d="M14 14l4-4 2 2-4 4h-2z" /></>)],
];
const SET_ICON = I(<><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M2 12h3M19 12h3M4.9 19.1L7 17M17 7l2.1-2.1" /></>);
// ──────────────────────────────────────────────────────────────
export function PcFrame({ cur, title, sub, head, children }: { cur: string; title: string; sub?: string; head?: React.ReactNode; children: React.ReactNode }) {
  const D = useDocs();
  return <>
    <style>{CSS}</style>
    <div id="dc-root"><div className={themeClass(true)} style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', background: 'var(--bg)', color: 'var(--text)', fontSize: 14 }}>
      <PcOnlyBand />
      <header style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '10px 14px', padding: '10px 16px', borderBottom: '1px solid var(--line)', background: 'var(--panel)' }}>
        <BrandLogo h={20} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {sub && <span style={{ fontSize: 12, color: 'var(--muted)' }}>{sub}</span>}
          <h1 style={{ margin: 0, fontSize: 17, fontWeight: 600 }}>{title}</h1>
        </div>
        {head}
        <div style={{ flex: 1 }} />
        <LiveStatus D={D} />
        <button type="button" {...stopProps} style={{ height: 52, minWidth: 136, padding: '0 18px', border: 0, borderRadius: 8, background: 'var(--stop)', color: '#FFFFFF', display: 'flex', alignItems: 'center', gap: 10, boxShadow: '0 0 0 3px rgba(215,38,30,.22)' }}>
          <svg width="26" height="26" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 2h8l6 6v8l-6 6H8l-6-6V8z" fill="none" stroke="#FFFFFF" strokeWidth="2" /><rect x="8" y="8" width="8" height="8" fill="#FFFFFF" /></svg>
          <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', lineHeight: 1.1 }}><span style={{ fontWeight: 700, fontSize: 19, letterSpacing: '.08em' }}>STOP</span><span style={{ fontSize: 11 }}>스페이스 · 명령 0 요청 · 잠금</span></span>
        </button>
      </header>
      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        <nav aria-label="주 메뉴" style={{ flex: '0 0 76px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, padding: '12px 6px', borderRight: '1px solid var(--line)', background: 'var(--panel)' }}>
          {NAV.map(([h, t, ic]) => <a key={h} className={`nav${cur === h ? ' cur' : ''}`} href={`#/${h}`} aria-current={cur === h ? 'page' : undefined} style={{ minHeight: 44, justifyContent: 'center', textAlign: 'center' }}>{ic}{t}</a>)}
          <div style={{ flex: 1 }} />
          <a className="nav" href="#/PcSettings" style={{ minHeight: 44, justifyContent: 'center' }}>{SET_ICON}설정</a>
        </nav>
        <main style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>{children}</main>
      </div>
    </div></div>
  </>;
}

// ---- /api/rehearsal 읽기 훅: 요청 번호로 마지막 것만 그림(빠른 전환 · 옛 응답 버림) · 자동 재시도 0 ----
type Load<D> = { st: 'idle' | 'loading' | 'ok' | 'err'; data: D | null; code: number; error: string };
const IDLE = { st: 'idle', data: null, code: 0, error: '' } as const;
function useSeqLoad<D>(key: string | null, run: () => Promise<RRes<D>>) {
  const [s, set] = useState<Load<D>>(IDLE), seq = useRef(0);
  const go = useCallback(() => {
    const my = ++seq.current, cx = ctx.n;
    if (key == null) { set(IDLE); return; }
    set((o) => ({ ...o, st: 'loading' }));
    // 옛 요청·로그아웃/관문 변경(dropScratch) 앞의 응답은 버림
    run().then((r) => { if (my !== seq.current || cx !== ctx.n) return; set(r.ok ? { st: 'ok', data: r.data, code: 200, error: '' } : { st: 'err', data: null, code: r.code, error: r.error }); });
  }, [key]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { go(); return () => { seq.current++; }; }, [go]);
  return { ...s, reload: go };
}
export const useProjects = () => useSeqLoad<Listing>('list', () => listProjects());
export const useProject = (id: string | null) => useSeqLoad<{ project: ProjectMeta; scene: Scene }>(id, () => rcall({ op: 'get', id }, SH.get));
export const useSavedAnalysis = (id: string | null, rev: number | null) => useSeqLoad<Analysis>(id && rev ? `${id}@${rev}` : null, () => rcall({ op: 'analyze', id, rev }, SH.analyze));

/** 목록 실패 글(오류와 빈 목록 구분). 503 은 저장소 이상·계산 시간 상한·처리 중 모두일 수 있어 단정하지 않고 서버 원문을 그대로 붙임(root 10-18) */
export const listErr = (code: number, error: string) => `리허설 저장소를 불러오지 못했습니다(서버 응답 ${code || '없음'})${code === 503 ? ' · 서버가 지금 처리하지 못함(저장소 이상 또는 계산 시간 상한 — 원문 참고)' : ''} · ${error}`;
