// 앱 틀: 해시 경로(#/화면?값) · 알림(toast) · STOP 버튼과 Space 단축키.
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { create } from 'zustand';
import { answerAsk, dropAll, linkView, sendStop, showSimStop, stopSim, useAsk, useLink, type AskAnchor } from '../data/link';
import { STOP_TIP } from '../data/facts';
import { stopBoxes, type Box, type Placed } from './chip';   // 순환 import(chip→shell) — 둘 다 최상위 실행에선 안 씀(함수 안 호출만)

// ---- 경로 ----
export const HOME = 'Main';   // B2 A1: PC 첫 화면 = 관제(기록은 메뉴) · 빈 hash·#/·#/?값 도 이 화면(main.tsx 와 메뉴 분기가 같은 값을 씀 — 055824d C1)
const sub = (f: () => void) => { addEventListener('hashchange', f); return () => removeEventListener('hashchange', f); };
export function useRoute() {
  const h = useSyncExternalStore(sub, () => location.hash);
  const [path, qs = ''] = h.replace(/^#\/?/, '').split('?');
  const q = new URLSearchParams(qs);
  // 같은 화면에서 값만 바꿀 때: 기록을 쌓지 않고 바꿈(live.js history.replaceState 와 같음)
  const setQ = (k: string, v: string) => { q.set(k, v); history.replaceState(null, '', `#/${path}?${q}`); dispatchEvent(new HashChangeEvent('hashchange')); };
  return { name: path || '', q, setQ };
}

// ---- 전체화면 안 표시(10-15): 네이티브 전체화면이면 그 요소 밖 DOM 은 안 보인다 → 확인창·알림을 현재 fullscreenElement 안으로 옮겨 그린다 ----
const fsSub = (f: () => void) => { document.addEventListener('fullscreenchange', f); return () => document.removeEventListener('fullscreenchange', f); };
const fsEl = () => { const e = document.fullscreenElement; return e && e !== document.documentElement && e !== document.body ? e : null; };   // 문서 전체(MDrive)면 원래 자리도 보임
// R(670 P2): ? 팝오버는 position:fixed — transform 조상(MDrive 틀 scale) 안에 있으면 fixed 가 그 틀 기준으로 풀려 화면 밖에 뜬다.
//   → 활성 전체화면 요소가 있으면 그 안, 없으면 document.body 로 그린다(좌표는 늘 실제 창 기준). 서버 렌더(시험) = 제자리
const topEl = () => fsEl() || document.body;
export const InTop = ({ children }: { children: React.ReactNode }) => { const h = useSyncExternalStore(fsSub, topEl, () => null); return h ? createPortal(children, h) : <>{children}</>; };
export const InFs = ({ children }: { children: React.ReactNode }) => { const h = useSyncExternalStore(fsSub, fsEl, () => null); /* 서버 렌더(시험) = 전체화면 없음 */ return h ? createPortal(children, h) : <>{children}</>; };

// ---- 알림 ----
const useToastS = create<{ t: string; n: number }>(() => ({ t: '', n: 0 }));
const show = (t: string) => useToastS.setState((s) => ({ t, n: s.n + 1 }));
/** 글 하나 또는 (저장처럼) 나중에 오는 결과 글 — 결과가 와야 띄운다 */
export const toast = (t: string | null | Promise<string | null>) => { if (t instanceof Promise) t.then((x) => x && show(x)); else if (t) show(t); };
/** 페이지 안 확인창(N1 «조종 시작» · 수동 진행 시작, 비차단). 화면을 덮지 않아 STOP(버튼·Space)은 그대로 눌리고, 누르면 이 창이 바로 닫힘(취소).
 *  초점은 «취소»(Enter 습관으로 시작되지 않게) · Escape = 취소 · 숨김/이탈/새 STOP/상태 변화도 취소(link.cancelStart·결속). */
// 확인창 단추 색은 여기서 정함(.btn 은 화면 테마 따라 밝은 MHome 에서 글자가 배경에 묻힘 — 670 QA P1). 창 배경은 늘 어두움
const ASK_B: React.CSSProperties = { minHeight: 36, padding: '6px 14px', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer' };
const ASK_NO: React.CSSProperties = { ...ASK_B, background: '#1C252D', color: '#E6EBEF', border: '1px solid #6B7a88' };
const ASK_OK: React.CSSProperties = { ...ASK_B, background: '#E6EBEF', color: '#0A0E12', border: '1px solid #E6EBEF' };
/** 확인창 자리(순수 — 시험용, 10-16 670 P2 «390 확인창이 STOP 덮음»). 폭 min(380, W−32) 가운데.
 *  확인창 가로 범위에 걸치는 보이는 STOP(+8)이 세로를 잘라 만든 빈 띠 안에만 놓는다(화면 가장자리 8):
 *  ① 머리줄 아래 56 에서 내용 전부 → ② 다른 띠에 내용 전부(56 에 가까운 것) → ③ 가장 넓은 띠가 need.min(단추 줄·여백·본문 최소) 이상이면 줄여서(본문만 안 스크롤)
 *  ④ 그것도 없거나 단추 줄이 폭에 안 들어가면 null = 자리 없음(STOP 을 덮는 자리·z-index 로 올리기 0). need.w = 단추 줄이 넘치지 않는 최소 폭 */
export const ASK_ANCHOR = 56;
export function placeAsk(W: number, H: number, need: { h: number; min: number; w: number }, stops: Box[], wd?: number): (Placed & { width: number }) | null {   // wd: 폭 지정(U1-R3 STOP 알림 가로확장) — 없으면 확인창 폭
  const G = 8, width = wd ?? Math.min(380, W - 32), left = (W - width) / 2;
  if (width < need.w || H - 2 * G < need.min) return null;
  const cut = stops.filter((s) => s.left - G < left + width && left < s.right + G).map((s) => [s.top - G, s.bottom + G]).sort((a, b) => a[0] - b[0]);
  const bands: [number, number][] = []; let y = G;
  for (const [a, b] of cut) { if (a > y) bands.push([y, Math.min(a, H - G)]); y = Math.max(y, b); }
  if (H - G > y) bands.push([y, H - G]);
  const full = bands.map(([a, b]) => ({ top: Math.min(Math.max(a, ASK_ANCHOR), b - need.h), a, b })).filter((c) => c.top >= c.a)
    .sort((p, q) => Math.abs(p.top - ASK_ANCHOR) - Math.abs(q.top - ASK_ANCHOR))[0];
  if (full) return { left, width, top: full.top, maxHeight: full.b - full.top };
  const big = bands.filter(([a, b]) => b - a >= need.min).sort((p, q) => (q[1] - q[0]) - (p[1] - p[0]))[0];
  return big ? { left, width, top: big[0], maxHeight: big[1] - big[0] } : null;
}
/** P2-B: 창을 연 단추(앵커)의 회피 사각형(순수 — 시험용). 앵커 없으면 [](STOP 만 피함 — 패드 누름 경로·무인자 호출).
 *  r0(여는 click 순간 자리)는 열린 동안 늘 피함 — 분리·숨김·전체화면 밖이어도(손가락이 있던 자리 · 보수, 자리 없음 취소가 늘 수 있음).
 *  원요소가 지금 연결·보임·크기>0·(전체화면이면 그 안)일 때만 현재 사각형도 — 현재 자리만 피하면 단추가 움직이기 전 두 번째 누름 자리가 확인창 위일 수 있음 */
export function askAvoid(a: AskAnchor | null, fs: Element | null, de?: Element | null): Box[] {
  if (!a) return [];
  const el = a.el, out: Box[] = [a.r0];
  if (!el.isConnected || (fs && fs !== de && !fs.contains(el)) || el.checkVisibility?.({ opacityProperty: true, visibilityProperty: true }) === false) return out;
  const { left, top, right, bottom } = el.getBoundingClientRect();
  if (right > left && bottom > top) out.push({ left, top, right, bottom });
  return out;
}
export const ASK_NOROOM = '확인창을 둘 자리가 없어 취소함(STOP 을 가리지 않음 · 보낸 것 0) — 창을 키우거나 돌린 뒤 다시 누르세요';
export const ASK_RESIZED = '화면 크기·전체화면이 바뀌어 시작 확인을 취소함(보낸 것 0) — 다시 누르세요';
/** 크기·전체화면 변화 = 열린 시작 확인창 취소(root GO · 670 4a78f44 «크기 바뀐 첫 rAF 프레임 옛 자리/STOP 겹침»).
 *  mine()(이 창 id 가 지금 열린 창)이 아니면 아무것도 안 함 — 옛 창 콜백이 새 창을 숨기거나 취소 0.
 *  맞으면 실제 창 DOM 을 먼저 숨김·클릭 불가로 쓰고 기존 answerAsk(false) + 안내. React 가 창을 지우는 시점은 다음 렌더 — 그 사이는 이 직접 숨김만 막음(실 paint 미측정) */
export function askGone(el: HTMLElement | null, mine: () => boolean): boolean {
  if (!mine()) return false;
  if (el) { el.style.visibility = 'hidden'; el.style.pointerEvents = 'none'; }
  answerAsk(false); toast(ASK_RESIZED); return true;
}
export function StartAsk() {
  const text = useAsk((s) => s.text), ok = useAsk((s) => s.ok), id = useAsk((s) => s.id), no = useRef<HTMLButtonElement | null>(null);
  const box = useRef<HTMLDivElement | null>(null), body = useRef<HTMLDivElement | null>(null), row = useRef<HTMLDivElement | null>(null);
  const [at, setAt] = useState<(Placed & { width: number }) | null>(null);
  // 배치만(10-16): 열린 동안 매 프레임 보이는 STOP·연 단추 사각형·필요 높이/폭을 재고, 바뀌었을 때만 다시 놓는다(머리줄 높이 변화·앵커 이동). 첫 자리는 그리기 전(layout effect)
  //   창 크기·전체화면이 바뀌면 다시 놓지 않고 취소(askGone) — resize·fullscreenchange 리스너 + tick 의 크기 비교(이벤트보다 rAF 가 먼저일 때). 본문 스크롤은 사유 아님
  //   자리가 없으면 STOP 을 덮지 않고 기존 취소 경로(answerAsk(false)) + 안내 — 확인 true·다시 열기·재시도 0
  // A1(670·715 78cc22e): 측정은 읽기만 — 매 프레임 임시 style 쓰기 0(옛 판은 본문을 잠깐 펼쳐 넘침 0 → 본문 scrollTop 이 0 으로 깎임)
  //   내용 전부 높이 = 창 높이 − 본문 칸 높이 + 본문 scrollHeight(줄어든 칸에서도 내용 전부). 크기가 바뀐 프레임은 옛 폭으로 재고 다음 프레임에 다시 맞춤
  // ponytail: 열린 동안 프레임마다 레이아웃 읽기(부하 미측정) — 오래 열린 창에 쓰면 ResizeObserver 로
  // 휴대폰 주소창 접힘도 innerHeight 를 바꿔 취소될 수 있음(실폰 미측정 · 예외 정책 0)
  useLayoutEffect(() => {
    if (text === null) { setAt(null); return; }
    let raf = 0, last = '', alive = true;
    const my = id, W0 = innerWidth, H0 = innerHeight;   // 리스너·rAF 수명 = 이 창(id) — cleanup 이 해제
    const mine = () => alive && useAsk.getState().id === my && useAsk.getState().text !== null;
    const gone = () => { if (askGone(box.current, mine)) { alive = false; cancelAnimationFrame(raf); } };
    const a = useAsk.getState().anchor;   // P2-B: 이 창(id)의 앵커 — 같은 글 재열기도 새 id 라 새 앵커·새 루프(옛 rAF 는 cleanup), 닫히면 answerAsk 가 참조를 버림
    const tick = () => {
      if (!mine()) return;   // R1(715 40625ca): 이 창(id)이 지금 열린 창일 때만 — 옛 창 tick 이 새 창 DOM 측정·배치(setAt)·자리 없음 취소/안내·다음 예약 0
      if (innerWidth !== W0 || innerHeight !== H0) { gone(); return; }
      const el = box.current, bd = body.current, rw = row.current;
      if (el && bd && rw) {
        const W = innerWidth, H = innerHeight, st = [...stopBoxes(), ...askAvoid(a, document.fullscreenElement, document.documentElement)], width = Math.min(380, W - 32);
        const r = el.getBoundingClientRect(), bh = bd.scrollHeight;
        const h = Math.ceil(r.height - bd.getBoundingClientRect().height + bh);
        const ov = rw.scrollWidth - rw.clientWidth;   // 단추 줄이 넘치면 > 0
        const w = ov > 0 ? Math.ceil(r.width + ov) : width;
        const need = { h, min: h - bh + Math.min(bh, 64), w };   // 본문 최소 = 제목 + 약 두 줄(64 px) — 단추 줄·여백·테두리는 전부
        const key = [W, H, h, need.min, w, ...st.flatMap((r) => [r.left, r.top, r.right, r.bottom])].join();
        if (key !== last) {
          last = key; const p = placeAsk(W, H, need, st);
          if (!p) { answerAsk(false); toast(ASK_NOROOM); return; }
          setAt(p);
        }
      }
      raf = requestAnimationFrame(tick);
    };
    addEventListener('resize', gone); document.addEventListener('fullscreenchange', gone);
    tick();
    return () => { alive = false; cancelAnimationFrame(raf); removeEventListener('resize', gone); document.removeEventListener('fullscreenchange', gone); };
  }, [text, id]);
  useEffect(() => {
    if (text === null) return;
    no.current?.focus();
    let alive = true; const my = id;   // R1: Escape 도 이 창(id)이 지금 열린 창일 때만 취소 — 옛 창 listener 가 새 창 답 0. STOP·Space 전역 취소는 별도 경로(그대로)
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape' && alive && useAsk.getState().id === my && useAsk.getState().text !== null) { e.preventDefault(); answerAsk(false); } };
    addEventListener('keydown', k); return () => { alive = false; removeEventListener('keydown', k); };
  }, [text, id]);   // 새 창(같은 글 포함)마다 «취소» 초점 다시
  if (text === null) return null;
  const [head, ...rows] = text.split('\n');
  // 자리 전(첫 그림)은 이전 자리(가운데·top 56) — layout effect 가 그리기 전에 옮기거나 닫는다
  return <InFs><div key={id} ref={box} role="alertdialog" aria-modal="false" aria-labelledby="fh-ask-h" data-start-ask="1" style={{ position: 'fixed', zIndex: 60, boxSizing: 'border-box',
    ...(at ? { left: at.left, top: at.top, width: at.width, maxHeight: at.maxHeight } : { left: '50%', top: ASK_ANCHOR, transform: 'translateX(-50%)', width: 'min(380px, calc(100vw - 32px))' }),
    display: 'flex', flexDirection: 'column', overflow: 'hidden',
    padding: '12px 14px', borderRadius: 10, background: 'rgba(8,11,14,.96)', color: '#E6EBEF', border: '1px solid #3a4652', fontSize: 13, boxShadow: '0 6px 24px rgba(0,0,0,.45)' }}>
    <div ref={body} data-ask-body="1" style={{ flex: '1 1 auto', minHeight: 0, overflowY: 'auto' }}>
      <div id="fh-ask-h" style={{ fontWeight: 600, fontSize: 14, marginBottom: 6 }}>{head}</div>
      {rows.map((r) => <div key={r} style={{ lineHeight: 1.45 }}>{r}</div>)}
    </div>
    <div ref={row} style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 10, flex: 'none' }}>
      <button type="button" style={ASK_NO} ref={no} onClick={() => answerAsk(false)}>취소</button>
      <button type="button" style={ASK_OK} data-ask-ok="1" onClick={() => answerAsk(true)}>{ok || '조종 시작'}</button>
    </div>
    <style>{'[data-start-ask] button:focus-visible{outline:2px solid #8CC8FF;outline-offset:2px}'}</style>
  </div></InFs>;
}
const useMerged = create<{ on: boolean }>(() => ({ on: false }));   // U1-R3: STOP 알림이 toast 원문을 합쳐 보이는 동안 원래 toast 는 숨김(읽는 면 하나 — 겹친 두 글 0)
export function Toast() {
  const { t, n } = useToastS(), hid = useMerged((x) => x.on);
  useEffect(() => { if (!t) return; const id = setTimeout(() => useToastS.setState({ t: '' }), 3500); return () => clearTimeout(id); }, [n]);
  return t ? <InFs><div role="status" data-live-toast="1" aria-hidden={hid || undefined} style={{ visibility: hid ? 'hidden' : 'visible', position: 'fixed', left: '50%', top: 96, transform: 'translateX(-50%)', zIndex: 50, maxWidth: '90vw', padding: '8px 14px', borderRadius: 8, background: 'rgba(8,11,14,.92)', color: '#E6EBEF', fontSize: 13, pointerEvents: 'none' }}>{t}</div></InFs> : null;
}

// ---- STOP: 누르는 순간(pointerdown) 보냄. 명령 0 요청일 뿐 몸 정지가 아님 ----
// U1(10-16 현민님 «STOP 누르면 화면에 알림»): 송신은 그대로 먼저·즉시(확인창 0). 알림은 송신 뒤 기록만 남기고 StopNote 가 비차단으로 그린다(누름 가로채기·초점·전송·조종권·N1 무관).
//   단계: 실패(보내지 못함) / 보냄·서버 확인 대기 / 서버 확인(잠금 켜짐) / 링크 끊김(미확인) / 시간 초과(미확인). 어느 단계도 «몸 정지»라 하지 않는다.
export const STOP_FAIL_REAL = '실기 모드 — Go2 비상 정지 미연결(명령 미지원) · 로봇 리모컨으로 정지하세요';
export const STOP_FAIL_LINK = '링크 끊김 — STOP 을 보내지 못함(서버 와치독이 명령 0 유지)';
export const STOP_WAIT_MS = 2000, STOP_SHOW_MS = 4000;   // 서버 status 는 100 ms 마다 — 2 s 안 확인이 없으면 미확인으로(조정 지점)
const BODY = ' · 몸이 멈췄는지 화면에서 확인';
export const STOP_MSG = {
  wait: `STOP 보냄 — 서버 확인 기다리는 중${BODY}`,
  ok: `STOP 뒤 받은 서버 상태에서 잠금 확인(수신 당시 · 지금 상태 아님)${BODY}`,   // U1-R1: 고정 글이라 과거 관측만 — 현재 잠금·명령 0 유지·이 누름 처리·몸 정지 주장 0
  lost: `STOP 보낸 뒤 링크 끊김 — 서버 확인 못 함(잠금 미확인) · 다시 STOP${BODY}`,
  late: `STOP 서버 확인 없음(${STOP_WAIT_MS / 1000}초) — 잠금 미확인 · 다시 STOP${BODY}`,
};
export type StopRec = { seq: number; t: number; sent: boolean; fail: string; gen: number; sg: number | undefined };
export type StopPhase = 'fail' | 'wait' | 'ok' | 'lost' | 'late';
export const useStopN = create<{ r: StopRec | null }>(() => ({ r: null }));
/** 순수(시험용): 누름 기록 + 지금 링크 상태 → 단계·글.
 *  확인 = 같은 연결(gen)에서 보낸 뒤(lastMsg > t) 받은 유효 status 가 latch 이고 잠금 세대가 보낼 때보다 큼(보낼 때 세대를 몰랐으면 latch 만).
 *  세대는 다른 기기 STOP·reset·episode 변경으로도 오르고, 끝 단계 글은 고정되므로 «그때 받은 상태에서 잠금»까지만 말한다(U1-R1 — 이 누름 처리·지금 잠금 아님) */
export function stopPhase(r: StopRec, s: ReturnType<typeof useLink.getState>, now: number): [StopPhase, string] {
  if (!r.sent) return ['fail', r.fail];
  const st = s.st, g = st?.stop_gen;
  if (s.gen === r.gen && s.stGen === s.gen && s.lastMsg > r.t && st?.latch && (r.sg === undefined || (typeof g === 'number' && g > r.sg))) return ['ok', STOP_MSG.ok];
  if (s.gen !== r.gen || !s.open) return ['lost', STOP_MSG.lost];
  return now - r.t > STOP_WAIT_MS ? ['late', STOP_MSG.late] : ['wait', STOP_MSG.wait];
}
export const stopNow = () => {
  const s0 = useLink.getState(), sg = s0.st?.stop_gen, t = performance.now();   // 보내기 전 세대·시각(응답은 같은 동기 처리 안에 오지 않음)
  const sent = sendStop(), fail = sent ? '' : useLink.getState().provider !== 'simulation_gate' ? STOP_FAIL_REAL : STOP_FAIL_LINK;
  useStopN.setState((x) => ({ r: { seq: (x.r?.seq ?? 0) + 1, t, sent, fail, gen: useLink.getState().gen, sg: typeof sg === 'number' ? sg : undefined } }));
};
/** 순수(시험용) U1-R3: 알림 자리 — 자리 없다고 버리지 않는다. hs = 숨은 측정 요소로 잰 높이(c 가운데 폭·알림만 / ct 가운데 폭·알림+toast 원문 / f 가로확장 W−16·알림+toast).
 *  ① 가운데 · STOP·확인창·toast 피함 → ①′ 가운데 · STOP·확인창만 피함 + toast 원문을 알림 안에 합침(merge — 겹쳐도 읽힘) → ② 가로확장 + 합침
 *  → ③ 글 전부 들어갈 띠가 없으면 가장 큰 빈 띠(높이 ≥ NOTE_MINH, STOP·확인창 피함)에 높이 = 띠 · 알림 본문만 스크롤(clip) → null = 한 줄 띠도 없는 극단 viewport(측정 범위 밖) */
export const NOTE_MINH = 40, STOP_READ_MS = 12000;   // 한 줄+여백 · 잘린(clip) 알림 표시 시간(스크롤해 읽을 시간 — 조정 지점)
export type NotePos = Placed & { width: number; merge: boolean; clip: boolean };
export function placeNote(W: number, H: number, hs: { c: number; ct: number; f: number }, hard: Box[], soft: Box[]): NotePos | null {
  const mt = soft.length > 0, A = (h: number, min: number, st: Box[], wd?: number) => placeAsk(W, H, { h, min, w: 0 }, st, wd);
  const a = A(hs.c, hs.c, [...hard, ...soft]); if (a) return { ...a, merge: false, clip: false };
  const b = A(hs.ct, hs.ct, hard); if (b) return { ...b, merge: mt, clip: false };
  // 가로확장: 글 전부 들어가면 그대로(②) · 아니면 가장 큰 띠에 본문 스크롤(③) → 그다음 가운데 폭 본문 스크롤. placeAsk 가 «전부 들어감»을 먼저 찾음
  for (const [h, wd] of [[hs.f, W - 16], [hs.ct, undefined]] as const) { const p = A(h, Math.min(h, NOTE_MINH), hard, wd); if (p) return { ...p, merge: mt, clip: p.maxHeight < h }; }
  return null;
}
const NOTE_CSS = 'box-sizing:border-box;padding:8px 12px;border-left:4px solid;font-size:13px;line-height:1.4;white-space:pre-line;';   // 알림과 숨은 측정 요소가 같은 글자 상자
/** STOP 결과 알림(비차단): 초점 0·role=status. 자리는 placeNote(STOP·확인창 가림 0 · 자리 없음이어도 합침·가로확장·본문 스크롤로 읽힘). 활성 전체화면이면 그 안(InFs).
 *  pointer 는 잘린(clip) 알림만 받음(본문 스크롤 — STOP·확인창 위가 아님), 그 밖은 0. 다시 누르면 새 기록으로 바뀜.
 *  끝 단계(실패·확인·끊김·초과)는 그 순간 글로 고정, 끝 단계에 들어간 실제 시각(performance.now — seq 결속)부터 STOP_SHOW_MS(잘림이면 STOP_READ_MS) 뒤 사라짐(U1-R2) */
// ponytail: 보이는 동안 프레임마다 자리 재기 — 오래 띄우게 되면 ResizeObserver 로
export function StopNote() {
  const r = useStopN((x) => x.r), s = useLink(), tt = useToastS((x) => x.t);
  const [, setTick] = useState(0);   // 다시 그리기 신호만 — 시각은 렌더마다 performance.now()(U1-R2: 멈춘 시계 값으로 끝 단계 시각을 적지 않음)
  const fin = useRef<{ seq: number; p: [StopPhase, string]; t: number } | null>(null), txt = useRef('');
  const [at, setAt] = useState<{ seq: number; v: NotePos | null } | null>(null);
  const now = performance.now();
  let p: [StopPhase, string] | null = null;
  if (r) {   // 렌더 중 ref 고정 — 같은 ref 라 StrictMode 이중 렌더도 같은 결과
    if (fin.current?.seq === r.seq) p = fin.current.p;
    else { p = stopPhase(r, s, now); if (p[0] !== 'wait') fin.current = { seq: r.seq, p, t: now }; }
  }
  txt.current = p ? p[1] : '';
  const pos = r && at?.seq === r.seq ? at.v : null;
  const on = !!r && !(fin.current?.seq === r.seq && now - fin.current.t > (pos?.clip ? STOP_READ_MS : STOP_SHOW_MS));
  useEffect(() => {   // 링크 메시지가 끊겨도 단계(초과·사라짐)가 넘어가게 다시 그림
    if (!on) return;
    const id = setInterval(() => setTick((n) => n + 1), 200); return () => clearInterval(id);
  }, [on, r?.seq]);
  const merged = on && !!pos?.merge && !!tt;
  useLayoutEffect(() => { useMerged.setState({ on: merged }); }, [merged]);   // 그리기 전에 원래 toast 숨김/복귀
  useLayoutEffect(() => () => useMerged.setState({ on: false }), []);
  useLayoutEffect(() => {
    if (!on || !r) { setAt(null); return; }
    let raf = 0, last = '';
    const seq = r.seq, m = document.createElement('div');   // 숨은 측정 요소 — 폭·글을 바꿔 높이만 잼(보이는 알림 폭이 바뀌어도 자리 판단이 오락가락하지 않게)
    m.setAttribute('data-stop-measure', '1'); m.setAttribute('aria-hidden', 'true'); m.style.cssText = `${NOTE_CSS}position:fixed;left:0;top:0;visibility:hidden;pointer-events:none`;
    const hAt = (w: number, t: string) => { m.style.width = `${w}px`; m.textContent = t; return Math.ceil(m.getBoundingClientRect().height); };
    const rects = (q: string) => [...document.querySelectorAll(q)].map((e) => e.getBoundingClientRect()).filter((b) => b.width > 0 && b.height > 0);
    const tick = () => {
      const host = topEl(); if (m.parentNode !== host) host.appendChild(m);   // 전체화면 들고 남 = 같은 글꼴 환경에서 잼
      const hard = [...stopBoxes(), ...rects('[data-start-ask]')], soft = rects('[data-live-toast]');
      const W = innerWidth, H = innerHeight, t = txt.current, t2 = useToastS.getState().t, both = t2 && soft.length ? `${t}\n${t2}` : t;   // 보이는 toast 가 있을 때만 합칠 글로 잼
      const key = [W, H, t, t2, ...[...hard, ...soft].flatMap((b) => [b.left, b.top, b.right, b.bottom])].join();
      if (key !== last) { last = key; const cw = Math.min(380, W - 32); setAt({ seq, v: placeNote(W, H, { c: hAt(cw, t), ct: hAt(cw, both), f: hAt(W - 16, both) }, hard, soft) }); }
      raf = requestAnimationFrame(tick);
    };
    tick(); return () => { cancelAnimationFrame(raf); m.parentNode?.removeChild(m); };
  }, [on, r?.seq]);
  if (!on || !p) return null;
  const bad = p[0] !== 'ok' && p[0] !== 'wait', clip = !!pos?.clip;
  return <InFs><div role="status" aria-live="polite" data-stop-note={p[0]} data-stop-clip={clip ? '1' : undefined} style={{ position: 'fixed', zIndex: 51 /* toast(50) 위 — 합친 글이 늦게 뜬 toast 에 덮이지 않게 */, boxSizing: 'border-box',
    pointerEvents: clip ? 'auto' : 'none', overflowY: clip ? 'auto' : 'hidden', overscrollBehavior: 'contain', whiteSpace: 'pre-line',
    left: pos?.left ?? 0, top: pos?.top ?? 0, width: pos?.width ?? 'min(380px,calc(100vw - 32px))', maxHeight: pos?.maxHeight, visibility: pos ? 'visible' : 'hidden',
    padding: '8px 12px', borderRadius: 8, background: 'rgba(8,11,14,.94)', color: '#E6EBEF', fontSize: 13, lineHeight: 1.4,
    borderLeft: `4px solid ${bad ? '#FF8A80' : p[0] === 'ok' ? '#8CC8FF' : '#C9D3DB'}` }}>{merged ? `${p[1]}\n${tt}` : p[1]}</div></InFs>;
}
// 글자 입력 중(입력칸·여러 줄·고르기·편집 가능 영역·한글 조합 중)인 키는 단축키로 쓰지 않는다. STOP 버튼은 언제나 동작.
const typing = (e: KeyboardEvent) => { const t = e.target as HTMLElement | null; return !!(e.isComposing || e.keyCode === 229 || (t && t.nodeType === 1 && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)))); };
export function useStopKey() {
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (!typing(e) && e.code === 'Space') { e.preventDefault(); stopNow(); } };
    addEventListener('keydown', k); return () => removeEventListener('keydown', k);
  }, []);
}
/** live.js stopBtn(): 누르는 순간(pointerdown)·Enter 에 STOP. 이름표 없는 보조 STOP 버튼에도 쓴다 */
export const stopOn = { onPointerDown: stopNow, onKeyDown: (e: React.KeyboardEvent) => { if (e.key === 'Enter') stopNow(); } } as const;
export const stopProps = { 'aria-label': '비상 정지', title: STOP_TIP, ...stopOn } as const;   // B2 R05: 효과 설명 한 문구(facts)
/** live.js openDrawer(): 오른쪽(PC)·머리줄 아래 서랍. Esc·닫기로 닫음. (휴대폰 가로 조종 화면 배치는 묶음 3 에서) */
export function Drawer({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  const x = useRef<HTMLButtonElement>(null), close = useRef(onClose); close.current = onClose;   // 다시 그릴 때마다 초점을 뺏지 않게 처음 한 번만
  const [bot, setBot] = useState(12);
  useEffect(() => {
    dropAll();   // 메뉴·서랍이 열리는 순간 조종 입력 폐기(네이티브 blur 를 가정하지 않음) — 모든 화면 공통
    x.current?.focus(); const k = (e: KeyboardEvent) => { if (e.key === 'Escape') close.current(); };
    // 서랍 아래쪽(휴대폰 하단)에 있는 STOP 을 덮지 않게 그 위에서 끝냄 — 머리줄 STOP(PC)은 top 84 위라 해당 없음
    const fit = () => { const t = [...document.querySelectorAll('[aria-label="비상 정지"]')].map((e) => e.getBoundingClientRect()).filter((r) => r.width && r.top > 184).map((r) => r.top); setBot(t.length ? Math.max(12, innerHeight - Math.min(...t) + 8) : 12); };
    fit(); addEventListener('keydown', k); addEventListener('resize', fit); return () => { removeEventListener('keydown', k); removeEventListener('resize', fit); };
  }, []);
  return <div className="lv-drawer" role="dialog" aria-label={title} style={{ right: 12, top: 84, bottom: bot, width: 'min(440px,calc(100vw - 24px))' }}>
    <div className="lv-row"><h2>{title}</h2><button ref={x} type="button" aria-label={`${title} 닫기 (Esc)`} onClick={onClose}>닫기</button></div>
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>{children}</div></div>;
}
/** live.js why(): 미연결 기능 버튼 — 누르면 이유만 알리고 아무것도 하지 않는다 */
export const whyProps = (text: string) => ({ 'aria-disabled': 'true' as const, title: text, className: 'lv-why', onClick: (e: React.MouseEvent) => { e.preventDefault(); e.stopPropagation(); toast(text); } });

/** Gazebo 끄기(로봇 STOP 아님) — 관제·조종·지도 화면 공용. STOP 과 떨어진 줄에 둔다. 서버가 거부하면(다른 기기 조종 중 등) 이유를 늘 보이게(화면에서 조건 완화 0) */
export function SimOff({ className = 'btn', style }: { className?: string; style?: React.CSSProperties }) {
  const L = useLink(), st = L.st, x = st?.sim_stop;
  if (L.provider !== 'simulation_gate' || !linkView(L).linkOk || !showSimStop(st) || !x) return null;
  return <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', ...style }}>
    <button type="button" className={className} disabled={x.busy} title={x.why || 'Gazebo 시뮬 끄기(로봇 STOP 아님)'} style={{ opacity: x.ok ? undefined : 0.55 }}
      onClick={async () => { const t = await stopSim(st); if (t) toast(t); }}>{x.busy ? 'Gazebo 종료 확인 중' : 'Gazebo 끄기(시뮬 종료)'}</button>
    {!x.ok && !x.busy && x.why && <small role="status" style={{ color: 'var(--warn, #FFB547)', fontSize: 11 }}>{`끄기 안 됨 · ${x.why}`}</small>}</span>;
}
