// WebSocket 링크 — 이 앱에서 WS 를 여는 곳은 여기 하나(소유자 하나). 명령 송신도 여기서만.
// 보내는 것: STOP·조종권·재개·리셋 + 조종 입력(cmd 20 Hz, 발행 타이머 하나) + 응답 받는 요청(사진·시뮬 시작).
// 묶음 3 경계: 받은 상태는 실행 중 형식 검사(타입 캐스트만 믿지 않음) — 실패면 st=null(미확인)·누름 폐기, 이전 상태로 조종하지 않음.
// STOP 은 명령 0 요청일 뿐 몸 정지가 아니다(시뮬 관측: STOP 뒤 약 3.6 s·0.32 m 더 움직임, 원인 미확인).
import { create } from 'zustand';
import type { ClientOp, ProviderKind, Reply, Status } from '@contracts';
import { refreshShared } from './shared';
import { num, ok, runId, sgn } from './fmt';
import { T } from './transport';


// provider: 지금 화면이 보는 실행 대상(계약 ProviderKind). 이 WS 로 명령을 보내는 건 simulation_gate 일 때만 — go2_direct 는 명령 미지원(capabilities.command=false)
type LinkState = { why: string | null; st: Status | null; lastMsg: number; firstVer: string | null; authEnd: boolean; tick: number; open: boolean; bad: string | null; viewOnly: boolean; gen: number; stGen: number; provider: ProviderKind; starting: string | null };   // starting: «조종 시작» 진행 단계 글(없으면 null)   // stGen: 마지막 유효 status 를 받은 연결 세대(= gen 이면 이 연결에서 서버 확인됨)   // gen: 연결 세대(열림·닫힘·대상 전환마다 +1)
// viewOnly: 이 화면이 «조종 시작»(take)을 누르기 전까지 cmd 를 보내지 않음. 처음 열 때·숨김·앱 pause/resume·재연결 뒤 다시 켜짐(서버 role 이 control 로 남아 있어도)
export const useLink = create<LinkState>(() => ({ why: null, st: null, lastMsg: 0, firstVer: null, authEnd: false, tick: 0, open: false, bad: null, viewOnly: true, gen: 0, stGen: -1, provider: 'simulation_gate', starting: null }));

let ws: WebSocket | null = null, started = false, sig: string | null = null;
const simOn = () => useLink.getState().provider === 'simulation_gate';   // 화면에 시뮬 상태·영상·길을 내보내도 되나(실기 대상이면 내부에서 받기만, 표시 0)
export let camURL: string | null = null;   // 마지막 카메라 프레임(새로 그린 img 의 첫 src)
const send = (o: ClientOp) => { if (ws && ws.readyState === 1) { ws.send(JSON.stringify(o)); return true; } return false; };

// ---- 누름 저장소 · 폐기 · 20 Hz 발행(하나) — live.js zones/keys/intent/dropAll 과 같은 규칙 ----
export type Axes = { fx: number; fy: number; fw: number };
const presses = new Map<string, { pid: number; p: Axes }>();   // 누르는 곳 id → 손가락(pointerId)·값. 곳마다 하나, 전체 둘까지
const dropFns = new Set<() => void>();            // 화면 쪽 손잡이 원위치·포인터 캡처 해제
export const onDrop = (f: () => void) => { dropFns.add(f); return () => { dropFns.delete(f); }; };
/** 모든 누름 폐기: 누르고 있던 손가락·키는 뗄 때까지 죽은 입력 */
export function dropAll() { presses.clear(); for (const f of dropFns) f(); }
const fin = (v: unknown): v is number => typeof v === 'number' && isFinite(v);
const c1 = (v: number) => Math.max(-1, Math.min(1, v));
let stopHeld = false;   // STOP 보낸 뒤 서버 latch=true 를 볼 때까지 cmd(0 포함) 안 보냄 — 같은 사건에 cmd 섞임 방지
/** 지금 cmd 를 보내도 되나(아니면 이유) — 링크·형식·판·조종권·잠금·대기·STOP·보기 전용 */
export function driveBlock(s = useLink.getState()): string | null {
  const st = s.st;
  if (s.provider !== 'simulation_gate') return '실기 모드 — 시뮬 명령 안 보냄(Go2 명령 미지원)';
  if (!s.open || !s.lastMsg || performance.now() - s.lastMsg > 1000) return s.why ? `링크 끊김 · ${s.why}` : '링크 끊김';
  if (s.bad || !st) return `상태 미확인(${s.bad || '없음'})`;
  if (s.firstVer && st.ver !== s.firstVer) return '새 판 — 새로고침';
  if (s.viewOnly) return '보기 전용 — «조종 시작»을 누르세요';
  if (stopHeld || st.latch) return 'STOP 잠금';
  if (st.role !== 'control') return '조종권 없음';
  if (st.reset_pending || st.resume_pending || st.sim_block) return st.sim_block || '리셋/재개 대기';
  return null;
}
const ax = (p: Axes): Axes | null => (fin(p.fx) && fin(p.fy) && fin(p.fw) ? { fx: c1(p.fx), fy: c1(p.fy), fw: c1(p.fw) } : null);
/** 누름 시작: 같은 곳 두 번째 손가락·세 번째 손가락 → 모두 폐기. 조종 불가·값 이상이면 false(화면은 눌림 표시 안 함) */
export function press(id: string, pid: number, p: Axes) {
  if (presses.has(id) || presses.size >= 2) { dropAll(); return false; }
  const a = ax(p); if (driveBlock() || !a) return false;
  presses.set(id, { pid, p: a }); return true;
}
/** 누른 채 움직임: 같은 손가락만, 값 이상이면 모두 폐기 */
export function move(id: string, pid: number, p: Axes) { const z = presses.get(id); if (!z || z.pid !== pid) return false; const a = ax(p); if (!a) { dropAll(); return false; } z.p = a; return true; }
/** 정상 손 뗌: 이 곳만 0 */
export const lift = (id: string, pid: number) => { if (presses.get(id)?.pid === pid) presses.delete(id); };
/** 취소·포착 잃음: 이 곳 손가락이면 모두 폐기 */
export const cancel = (id: string, pid: number) => { if (presses.get(id)?.pid === pid) dropAll(); };
export const pressed = (id: string) => presses.has(id);
/** 이 곳을 이 손가락이 지금 누르고 있나(폐기·STOP 뒤 낡은 손가락·hover 는 false) */
export const owns = (id: string, pid: number) => presses.get(id)?.pid === pid;
function tick20() {
  if (driveBlock()) { if (presses.size) dropAll(); return; }   // 막히면 보내지 않고 누름도 버림(손 떼고 다시 눌러야 새 입력)
  const a = { fx: 0, fy: 0, fw: 0 };
  for (const { p } of presses.values()) { a.fx += p.fx; a.fy += p.fy; a.fw += p.fw; }
  send({ op: 'cmd', fx: c1(a.fx), fy: c1(a.fy), fw: c1(a.fw) });   // 손 떼면 0(서버 need_neutral·0.3 s deadman)
}
/** STOP: 누름 폐기·발행 멈춤을 먼저, 그다음 송신 */
export const sendStop = () => { dropAll(); cancelStart(); if (useLink.getState().provider !== 'simulation_gate') return false; stopHeld = true; return send({ op: 'stop' }); };   // 실기 모드: 시뮬로 보내지 않음(화면이 이유 안내)
/** 조종권·재개·리셋·놓기 — 전부 누름 폐기 뒤 송신. take 만 보기 전용을 푼다 */
export const sendOp = (op: 'take' | 'release' | 'resume' | 'reset') => { dropAll(); if (useLink.getState().provider !== 'simulation_gate') return false; if (op === 'take') { hidSent = false; useLink.setState({ viewOnly: false }); } else if (op === 'release') { cancelStart(); useLink.setState({ viewOnly: true }); } else if (op === 'reset') cancelStart(); return send({ op }); };
/** 숨김·떠남·앱 pause: 누름 폐기 + 서버에 hidden(조종권 해제) + 보기 전용 */
// 배경 한 번에 pause·appStateChange·visibility·blur 로 3~4번 불림 → hidden 은 조종 중(take 뒤 또는 서버 role=control)일 때만 보냄(서버 drop 은 반복 무해)
let hidSent = false;   // 이 연결에서 마지막 take 뒤 hidden 을 이미 보냄
export function hide() { const s = useLink.getState(); dropAll(); cancelStart(); if (s.provider === 'simulation_gate' && !hidSent && (!s.viewOnly || s.st?.role === 'control')) hidSent = send({ op: 'hidden' }); useLink.setState({ viewOnly: true }); }

// ---- N1 «조종 시작»(10-15 현민님 결정): 확인 1회 → take → (서버가 이 기기 조종권 확인) → resume(stop_gen) 1회 → (서버가 잠금 해제 확인) ----
// 서버 Core 가 마지막 관문: resume 은 확인창을 연 순간의 status.stop_gen(잠금 세대)을 싣고, 서버 세대가 다르면 거부(CAS) — 확인 뒤 끼어든 STOP·잠금을 풀지 않는다.
// 결속(확인창~성공): 연결 세대·대상·판·episode·리셋·잠금 세대·형식·신선도(1 s)·시뮬 막힘·다른 기기 점유·(take 뒤) 조종권 — 하나라도 바뀌면 그 순간 취소(sticky, 되돌아와도 취소).
// 중단: STOP·숨김/이탈·반납·리셋 요청·새 시작 → startTok 이 바뀌어 다음 op 0. resume 은 한 번만(재시도 0). 성공해도 누름 폐기(서버 need_neutral 그대로).
// 확인창은 페이지 안(비차단): 확인 중에도 status 를 계속 받고 STOP(버튼·Space)은 그대로 눌리며, 누르면 확인창이 바로 닫힌다. Escape·취소·이탈 = 취소.
let startTok = 0;
export const useAsk = create<{ text: string | null; ok?: string }>(() => ({ text: null }));   // ok = 확인 단추 글(없으면 «조종 시작»)
let askDone: ((v: boolean) => void) | null = null, askOwner: unknown = null;
/** 페이지 안 확인창 답(취소·중단은 false). 열린 창이 없으면 아무것도 안 함 */
export function answerAsk(v: boolean) { const f = askDone; askDone = null; askOwner = null; if (useAsk.getState().text !== null) useAsk.setState({ text: null }); f?.(v); }
/** 페이지 안 확인창(비차단): 기다리는 동안 status·문서가 계속 들어오고 STOP 은 그대로 눌리며 STOP·숨김·새 확인창이면 false. 열린 다른 확인창은 취소 */
export const askPage = (t: string, ok?: string, owner?: unknown) => new Promise<boolean>((res) => { answerAsk(false); askDone = res; askOwner = owner ?? null; useAsk.setState({ text: t, ok }); });
/** E1: 그 주인(편집기·화면)이 연 확인창만 닫기(취소) — 화면 이탈·다른 계획 열기·복제 때. 다른 주인의 창(N1 조종 시작 등)·조종권은 건드리지 않음 */
export const dropAsk = (owner: unknown) => { if (owner != null && askOwner === owner) answerAsk(false); };
const askInPage = (t: string) => askPage(t);
export function cancelStart() { startTok++; answerAsk(false); if (useLink.getState().starting !== null) useLink.setState({ starting: null }); }
export const START_ASK = '조종을 시작할까요?\n· 로봇(시뮬) 주변과 시뮬 상태를 확인하세요\n· 확인하면 조종권을 받고 STOP 잠금을 풉니다\n· 그 뒤 손을 떼고 새로 눌러야 움직입니다 · STOP 은 언제든 즉시\n· 이 창이 열린 동안 STOP·리셋·연결 변화·다른 기기 점유가 생기면 취소됩니다';
export const START_CANCEL = '조종 시작 중단 — STOP·숨김·반납·리셋 요청(보낸 다음 단계 0)';
const halted = (w: string) => `조종 시작 중단 · ${w} — 보낸 다음 단계 0 · 다시 «조종 시작»`;
/** «조종 시작»을 지금 할 수 없는 이유(없으면 null) — 표시·버튼 비활성용. 서버 거부는 그대로 별도 */
export function startBlock(s = useLink.getState()): string | null {
  const st = s.st;
  if (s.provider !== 'simulation_gate') return '실기 모드 — 시뮬 조종 시작 안 함(Go2 명령 미지원)';
  if (!s.open || !s.lastMsg || performance.now() - s.lastMsg > 1000) return '링크 끊김';
  if (s.bad || !st || s.stGen !== s.gen) return '상태 미확인';
  if (typeof st.stop_gen !== 'number') return '서버가 잠금 세대(stop_gen)를 안 줌 — 옛 서버라 «조종 시작» 불가(서버 갱신 필요)';
  if (s.firstVer && st.ver !== s.firstVer) return '새 판 — 새로고침';
  if (s.starting !== null) return s.starting;
  if (st.role === 'view_other') return `다른 기기가 조종 중${st.holder ? ` · ${st.holder}` : ''}`;
  if (st.sim_block) return st.sim_block;
  if (st.reset_pending) return '시뮬 리셋 처리 중';
  if (st.resume_pending) return 'STOP 해제 확인 대기 중';
  if (st.role === 'control' && !s.viewOnly && !st.latch && !stopHeld) return '이미 조종 가능';
  return null;
}
/** 상태 조건 pred 를 만족하는 status 가 올 때까지(ms 안). 중단(live false)·시간 초과면 null */
function until(pred: (s: LinkState) => boolean, live: () => boolean, ms: number): Promise<LinkState | null> {
  return new Promise((res) => {
    const done = (v: LinkState | null) => { clearTimeout(t); un(); res(v); };
    const chk = (s: LinkState) => { if (!live()) done(null); else if (pred(s)) done(s); };
    const t = setTimeout(() => done(null), ms), un = useLink.subscribe(chk);
    chk(useLink.getState());   // 이미 만족(다음 status 를 기다리지 않음)
  });
}
const TAKE_MS = 3000, RESUME_ACK_MS = 1500, RESUME_DONE_MS = 4500;   // 서버 RESUME_TIMEOUT 3 s + 여유
/** «조종 시작» 전체. 반환 = 사람에게 보여 줄 결과 글(null = 확인창 취소, 보낸 것 0). ask 는 시험에서 바꿔 끼움 */
export async function startDrive(ask: (t: string) => boolean | Promise<boolean> = askInPage): Promise<string | null> {
  dropAll();
  const b0 = startBlock(); if (b0) return `조종 시작 안 됨 · ${b0}`;   // 진행 중 시작이 있으면 그것도 이유(겹쳐 시작 0)
  const s0 = useLink.getState(), k = { gen: s0.gen, prov: s0.provider, ver: s0.st!.ver, ep: s0.st!.episode, sg: s0.st!.stop_gen as number };
  const tok = ++startTok; let dead = '', took = false;
  const why = (s: LinkState): string => {   // 확인창을 연 순간과 달라진 것(없으면 '')
    const st = s.st;
    if (s.gen !== k.gen || s.provider !== k.prov) return '연결·대상 바뀜';
    if (s.bad || !st || s.stGen !== s.gen) return '상태 형식 오류·미확인';
    if (st.ver !== k.ver) return '새 판';
    if (st.episode !== k.ep) return '시뮬 리셋(episode 바뀜)';
    if (st.reset_pending) return '시뮬 리셋 처리 중';
    if (st.stop_gen !== k.sg) return '새 STOP·잠금(잠금 세대 바뀜)';
    if (st.sim_block) return st.sim_block;
    if (st.role === 'view_other') return `다른 기기가 조종 중${st.holder ? ` · ${st.holder}` : ''}`;
    if (took && st.role !== 'control') return '조종권 잃음';
    return '';
  };
  let prev = s0.lastMsg;   // 신선도: 받은 status 사이 간격이 1 s 를 넘은 적이 있으면(끊겼다 회복) 취소 — 회복 뒤 ACK 로 속행 0
  const un = useLink.subscribe((s) => {   // 모든 상태 변화마다 — 중간 변화도 놓치지 않음(sticky)
    if (dead || tok !== startTok) return;
    if (s.lastMsg !== prev) { if (s.lastMsg - prev > 1000) dead = '링크 끊김(1 s 넘게 상태 없음)'; prev = s.lastMsg; }
    dead ||= why(s); if (dead) answerAsk(false);
  });
  const live = () => tok === startTok && !dead && performance.now() - useLink.getState().lastMsg <= 1000;
  const gone = () => {   // 중단: 조종권이 확인 안 됐으면 보기 전용으로
    if (useLink.getState().st?.role !== 'control') useLink.setState({ viewOnly: true });
    return tok !== startTok ? START_CANCEL : halted(dead || '링크 끊김(1 s 넘게 상태 없음)');
  };
  try {
    useLink.setState({ starting: '확인 대기' });
    const yes = await ask(START_ASK);
    dropAll();   // 확인창 동안 누른 입력도 폐기
    if (tok !== startTok || dead) return gone();
    if (!yes) return null;
    const b1 = startBlock({ ...useLink.getState(), starting: null }); if (b1) return `조종 시작 안 됨 · ${b1}`;   // 끊김(신선도) 등
    let s = useLink.getState();
    if (!(s.st?.role === 'control' && !s.viewOnly)) {
      useLink.setState({ starting: '조종권 확인 중' });
      const t0 = performance.now(); sendOp('take');
      const r = await until((x) => x.lastMsg > t0 && (x.st?.role === 'control' || x.st?.role === 'view_other'), live, TAKE_MS);
      if (!live()) return gone();
      if (!r || r.st?.role !== 'control') { useLink.setState({ viewOnly: true }); return r ? '다른 기기가 조종 중 — 보기 전용(보낸 것: 조종권 요청뿐)' : '조종권 확인 못 함 — 보기 전용 · STOP 잠금 그대로'; }
      s = r;
    }
    took = true;
    if (s.st!.latch || stopHeld) {
      useLink.setState({ starting: 'STOP 해제 확인 중' });
      const t1 = performance.now(); dropAll(); send({ op: 'resume', stop_gen: k.sg });   // 서버가 세대 대조(CAS)
      const a = await until((x) => x.lastMsg > t1 && !!x.st && (x.st.resume_pending || !x.st.latch || x.st.role !== 'control'), live, RESUME_ACK_MS);
      if (!live()) return gone();
      if (!a) return 'STOP 해제 거부·응답 없음 — 조종권은 이 기기 · STOP 잠금 유지(사유는 이벤트)';
      const d = a.st!.resume_pending ? await until((x) => !!x.st && (!x.st.resume_pending || x.st.role !== 'control'), live, RESUME_DONE_MS) : a;
      if (!live()) return gone();
      if (!d || d.st!.role !== 'control' || d.st!.latch || d.st!.resume_pending) return 'STOP 해제 확인 안 됨(취소·시간 초과·다른 STOP) — STOP 잠금 유지';
    }
    dropAll();
    return '조종 가능 — 손 떼고 새로 누르면 움직임';
  } finally {
    un(); if (tok === startTok) { answerAsk(false); useLink.setState({ starting: null }); }
  }
}

/** 실행 대상 전환(화면 선택). 순서: 누름 폐기 → (시뮬 떠날 때) hidden = 조종권 해제 → 보기 전용 → 세대 +1(세대가 다른 늦은 응답·카메라·지도·점군 버림).
 *  돌아와도 조종권·STOP 해제 자동 복원 0(다시 «조종 시작»). 같은 대상이면 아무것도 안 함 */
export function setProvider(k: ProviderKind) {
  const s = useLink.getState(); if (s.provider === k) return;
  if (s.provider === 'simulation_gate') hide(); else dropAll();
  failPending('대상이 바뀜 — 요청 취소');
  camClear(); camT.length = 0; TRAIL.pts = []; TRAIL.last = null;   // 옛 대상의 영상·지나온 길 버림(해독 중인 옛 프레임은 신원 대조로 버림)
  useLink.setState((x) => ({ provider: k, viewOnly: true, gen: x.gen + 1, st: null, bad: null }));   // 옛 대상 상태 버림 — 시뮬 복귀는 다음 status 부터(낡은 값 0)
}

// ---- 받은 상태 실행 중 검사(계약 Status 중 명령 관문이 쓰는 칸) — 실패 이유 또는 null ----
const ROLES = new Set(['control', 'view_other', 'view']);
const nf = (v: unknown) => v === null || fin(v);
const age = (v: unknown) => v === null || (fin(v) && v >= 0);   // 나이는 음수면 미확인
const int = (v: unknown) => fin(v) && Number.isInteger(v);
const LIVE_ST = ['off', 'stale', 'unknown', 'reset', 'wait', 'bad', 'ok'];
const EVST = new Set(['ok', 'warn', 'bad']);
const SCOPE = (v: unknown) => v == null || v === 'experiment' || v === 'user_experience';   // 칸 없음·null = 미확인/옛 서버
export function checkStatus(m: any): string | null {
  if (!m || typeof m !== 'object' || m.op !== 'status') return 'op';
  if (typeof m.ver !== 'string' || !m.ver) return 'ver';
  if (!ROLES.has(m.role)) return 'role';
  for (const k of ['latch', 'resume_pending', 'reset_pending']) if (typeof m[k] !== 'boolean') return k;
  if (m.stop_gen !== undefined && !(int(m.stop_gen) && m.stop_gen >= 0)) return 'stop_gen';   // 칸 없음 = 옛 서버(«조종 시작»만 막힘), 있으면 0 이상 정수
  if (typeof m.sim_block !== 'string') return 'sim_block';
  if (!(m.episode === null || int(m.episode)) || !age(m.state_age) || !age(m.cam_age) || !int(m.docs_rev)) return 'episode/age/docs_rev';
  if (typeof m.reason !== 'string' || typeof m.me !== 'string' || !(m.holder === null || typeof m.holder === 'string')) return 'reason/me/holder';
  if (!Array.isArray(m.applied) || m.applied.length !== 3 || !m.applied.every(fin)) return 'applied';
  if (!Array.isArray(m.events) || !m.events.every((e: any) => e && typeof e.t === 'string' && EVST.has(e.st) && typeof e.text === 'string')) return 'events';
  const ss = m.sim_start;   // 화면이 읽는 칸만: ok·why·session(남은 시간) + (새 서버) ledger·last — 없으면 옛 서버(미확인)
  if (!ss || typeof ss !== 'object' || typeof ss.ok !== 'boolean' || typeof ss.why !== 'string' || !(ss.session === null || typeof ss.session === 'object')
    || !(ss.ledger == null || (typeof ss.ledger === 'object' && int(ss.ledger.used) && int(ss.ledger.max) && ss.ledger.used >= 0 && ss.ledger.used <= ss.ledger.max))
    || !(ss.last == null || (typeof ss.last === 'object' && typeof ss.last.t === 'string' && (ss.last.st === 'ok' || ss.last.st === 'bad') && typeof ss.last.text === 'string'))
    || !SCOPE(ss.usage_scope) || (ss.usage_scope === 'user_experience' && ss.ledger != null)) return 'sim_start';   // 사용자 체험인데 원장 숫자가 오면 모순
  const sp = m.sim_stop;    // 없으면 옛 서버(버튼 숨김). 있으면 화면이 읽는 칸 전부 검사
  if (sp !== undefined && sp !== null && (typeof sp !== 'object' || typeof sp.ok !== 'boolean' || typeof sp.why !== 'string' || typeof sp.busy !== 'boolean' || typeof sp.on !== 'boolean'
    || !(sp.ledger_left === null || int(sp.ledger_left)) || !(sp.ledger_kind == null || sp.ledger_kind === 'online' || sp.ledger_kind === 'map' || (sp.ledger_kind === 'user' && sp.ledger_left === null)) || !(sp.last === null || (typeof sp.last === 'object' && (sp.last.st === 'ok' || sp.last.st === 'bad') && typeof sp.last.text === 'string')))) return 'sim_stop';
  // 지도 칸(live_map·map_start·map_save): 틀리면 그 칸만 버림(조종 상태는 유지 — 지도 오류가 STOP·조종을 막지 않게)
  const ob = (x: any) => !!x && typeof x === 'object', lv = m.live_map, ms = m.map_start, sv = m.map_save;
  const one = (v: unknown, xs: string[]) => v == null || xs.includes(v as string), grid = (g: any) => ob(g) && int(g.seq) && [g.w, g.h].every((n) => int(n) && n >= 1 && n <= 2000)
    && fin(g.res) && g.res > 0 && Array.isArray(g.origin) && g.origin.length >= 2 && g.origin.every(fin)
    && (g.upd == null || typeof g.upd === 'boolean') && (g.stamp == null || fin(g.stamp));   // upd·stamp: 10-15 갱신 보유(옛 서버엔 없음)
  const keyed = (v: any) => !!(v.world_id && v.building_id && v.floor_id && v.mode && v.map_source && int(v.epoch));
  if (!(ob(lv) && LIVE_ST.includes(lv.st) && typeof lv.why === 'string' && one(lv.world_id, ['v5_single', 'v5_building', 'rooms_a']) && one(lv.building_id, ['v5', 'v5_single', 'rooms_a'])
    && one(lv.floor_id, ['f1', 'l1', 'l2']) && one(lv.mode, ['slam', 'static']) && one(lv.map_source, ['slam', 'gt_raster']) && (lv.map_version == null || typeof lv.map_version === 'string')
    && (lv.epoch == null || int(lv.epoch)) && (lv.grid == null || grid(lv.grid)) && (lv.pose_why == null || typeof lv.pose_why === 'string')
    && (lv.bound == null || (typeof lv.bound === 'boolean' && (!lv.bound || keyed(lv))))   // bound(상태 수준 결속) true 면 결속 칸 전부 있어야
    && (lv.st !== 'ok' || (grid(lv.grid) && keyed(lv))))) m.live_map = null;   // ok 인데 격자·결속 칸 빠짐 → 지도 칸만 버림
  else {
    if (lv.pose != null && (lv.grid?.upd === true || !(ob(lv.pose) && ['x', 'y', 'yaw'].every((k) => fin(lv.pose[k])) && (lv.pose.source === 'slam_tf' || lv.pose.source === 'gt_identity')))) lv.pose = null;   // 갱신 중(옛 그림) + 새 위치 조합 0
    if (lv.last_save != null && !(ob(lv.last_save) && typeof lv.last_save.ok === 'boolean' && (lv.last_save.map_version == null || typeof lv.last_save.map_version === 'string') && typeof lv.last_save.reason === 'string')) lv.last_save = null;
  }
  if (!(ob(ms) && typeof ms.ok === 'boolean' && typeof ms.why === 'string' && typeof ms.busy === 'boolean'
    && (ms.ledger === null || (ob(ms.ledger) && int(ms.ledger.used) && int(ms.ledger.max) && Array.isArray(ms.ledger.keys) && ms.ledger.keys.every((k: unknown) => typeof k === 'string')))
    && (ms.last == null || (ob(ms.last) && typeof ms.last.t === 'string' && typeof ms.last.text === 'string'))
    && SCOPE(ms.usage_scope) && !(ms.usage_scope === 'user_experience' && ms.ledger !== null))) m.map_start = null;
  if (!(ob(sv) && typeof sv.ok === 'boolean' && typeof sv.why === 'string' && typeof sv.busy === 'boolean')) m.map_save = null;
  // 보조 관제 뷰(points·follow): 형식이 틀리면 그 뷰만 버림(조종·STOP 관문과 무관). st 4가지 · seq null|양의 정수 · age_s null|유한 ≥0
  const vone = (x: any) => ob(x) && ['off', 'bad', 'stale', 'ok'].includes(x.st) && typeof x.why === 'string'
    && (x.seq === null || (int(x.seq) && x.seq > 0)) && (x.age_s === null || (fin(x.age_s) && x.age_s >= 0))
    && (x.prod == null || (ob(x.prod) && (x.prod.reason === null || typeof x.prod.reason === 'string') && (x.prod.enabled === null || typeof x.prod.enabled === 'boolean')
      && (x.prod.n_pub === null || (int(x.prod.n_pub) && x.prod.n_pub >= 0))))   // prod: 발행 쪽 진단(없으면 이전 서버)
    && (x.run == null || (ob(x.run) && runId(x.run.run_id) && int(x.run.epoch) && x.run.epoch >= 1
      && typeof x.run.world_id === 'string' && typeof x.run.building_id === 'string' && (x.run.mode === 'slam' || x.run.mode === 'static')));   // run: follow /2 결속 키(없으면 /1)
  if (m.views != null) { if (!ob(m.views)) m.views = null; else for (const k of ['points', 'follow', 'lidar']) if (!vone(m.views[k])) m.views[k] = null; }   // lidar 없음(이전 서버) = null
  if (m.sim !== null) {
    if (typeof m.sim !== 'object') return 'sim';
    for (const k of ['x', 'y', 'yaw', 'vx', 'vy', 'tilt_deg']) if (!nf(m.sim[k])) return `sim.${k}`;
    for (const k of ['fallen', 'body_still']) if (m.sim[k] !== null && typeof m.sim[k] !== 'boolean') return `sim.${k}`;
  }
  return null;
}
// 응답이 오는 요청(사진·시뮬 시작): 서버가 rid 로 답한다. 5 s 안에 답 없으면 실패로(live.js ask 와 같음)
let rid = 0; const pending = new Map<number, (m: Reply) => void>();
type AskOp = 'photo' | 'sim_start' | 'sim_stop' | 'map_list' | 'map_get' | 'map_live_get' | 'map_start' | 'map_save' | 'view_get' | 'height_get' | 'geom_get';
export const ask = (op: AskOp, extra: Record<string, string | boolean> = {}, ms = 5000) => new Promise<Reply>((res) => {   // ms: 서버 쪽 제한이 더 긴 op(map_save 10 s)만 늘림
  const id = ++rid, no = (text: string) => res({ op: 'reply', rid: id, ok: false, text }), g0 = useLink.getState().gen;
  if (useLink.getState().provider !== 'simulation_gate') return no('실기 모드 — 시뮬 요청 안 보냄');
  if (!send({ ...extra, op, rid: id } as ClientOp)) return no('링크 끊김 — 보내지 못함');
  const t = setTimeout(() => { pending.delete(id); no(`서버 응답 없음(${ms / 1000} s)`); }, ms);
  pending.set(id, (m) => { clearTimeout(t); if (useLink.getState().gen !== g0) no('연결·대상이 바뀜 — 늦은 응답 버림'); else res(m); });
});
// 연결이 끊기거나 대상이 바뀌면 걸린 요청을 그 자리에서 실패로 끝낸다(gen 올리기 전에 부름).
// 안 하면 죽은 연결로 보낸 요청의 5 s 시간초과가 새 연결의 정상 응답 «뒤에» 터져 결과를 덮는다(10-15 map_list 재현)
function failPending(text: string) { for (const [id, f] of pending) { pending.delete(id); f({ op: 'reply', rid: id, ok: false, text } as Reply); } }

// Gazebo 끄기(로봇 STOP 아님): 폐기 → 확인창 → sim_stop. 결과(ROS 세션 종료 확인/못 함)는 서버 이벤트로 따로 온다 → 토스트 글 | null(취소)
// 지금 켜진 쪽(runner) 원장만 말한다 — 지도 체험이면 지도 체험 원장, 기존 체험이면 기존 원장, 모르면 «미확인»(섞지 않음)
const ledgerLine = (x: { ledger_left: number | null; ledger_kind?: 'online' | 'map' | 'user' | null }) => {
  if (x.ledger_kind === 'user') return '\n· 사용자 체험 — 횟수 제한 없음(다시 켤 수 있음 · 동시 1개 · 30분 뒤 자동 종료)';
  const name = x.ledger_kind === 'map' ? '지도 시뮬 원장' : x.ledger_kind === 'online' ? '기존 체험(시뮬 시작) 원장' : '';
  if (!name || x.ledger_left === null) return '\n· 켜진 쪽 원장 미확인';
  return `\n· ${name} 남은 ${x.ledger_left}${x.ledger_left === 0 ? ' — 끄면 이 원장으로는 다시 켤 수 없습니다' : ''}`;
};

export async function stopSim(st: Status | null): Promise<string | null> {
  const x = st?.sim_stop; if (!x || !x.ok) return `Gazebo 끄기 안 됨 · ${x?.why || '서버 응답 없음'}`;
  dropAll();
  if (!confirm(`Gazebo 시뮬을 끌까요? (로봇 STOP 아님)\n· 조종 중이면 명령 0·STOP 잠금 뒤 조종권 반납\n· 자동 재시작 없음 — 다시 하려면 ${x.ledger_kind === 'map' ? '«지도 열기»' : '«시뮬 시작»'}을 직접 눌러야 합니다${x.ledger_kind === 'user' ? '' : ' · 기동 상한이 적용됩니다'}${ledgerLine(x)}`)) return null;
  return (await ask('sim_stop')).text || '응답 없음';
}
/** 시뮬 시작 확인 → 요청. 확인창 문구는 서버 usage_scope 대로: 사용자 체험 = 횟수 제한 없음 · 실험 = 실험 원장 1회 · 칸 없음 = 미확인(옛 서버) */
export async function startSimAsk(st: Status | null): Promise<string | null> {
  const ss = st?.sim_start; if (!ss || !ss.ok) return `시뮬 시작 안 됨 · ${ss?.why || '서버 응답 없음'}`;
  if (useLink.getState().provider !== 'simulation_gate') return '실기 대상 — 시뮬 시작 안 함(«시뮬(보조)»로 바꾼 뒤)';
  dropAll();
  const use = ss.usage_scope === 'user_experience' ? '사용자 체험 — 횟수 제한 없음(동시 1개)' : ss.usage_scope === 'experiment'
    ? `실험 원장 1회 사용${ss.ledger ? ` (지금 ${ss.ledger.used}/${ss.ledger.max})` : ''}` : '횟수 원장 사용 여부 미확인(옛 서버)';
  if (!confirm(`Gazebo 시뮬을 30분 동안 시작할까요?\n· ${use}\n· STOP 상태로 시작합니다(«조종 시작» 확인 뒤 조종)\n· 30분 뒤 자동 종료, 연장 없음`)) return null;
  return (await ask('sim_start')).text || '응답 없음';
}
export const showSimStop = (st: Status | null) => !!st?.sim_stop && (st.sim_stop.on || st.sim_stop.busy);

/** 로그아웃·주소 변경 직전: WS 닫고 다시 잇지 않음(새로 읽을 때까지) */
export function closeLink() { closed = true; dropAll(); ws?.close(); }
let closed = false;

export function startLink() {
  if (started) return; started = true;
  const open = async () => {
    if (closed || useLink.getState().authEnd) return;
    const u = await T.wsUrl().catch((e) => ({ why: String(e?.message || e) }));   // 웹: 같은 출처 /ws · 네이티브: 1회용 표 URL
    if (closed || useLink.getState().authEnd) return;
    if ('why' in u) { useLink.setState({ why: u.why }); setTimeout(open, 1000); return; }   // tls·net 등 원인은 연결 표시로(숨기지 않음)
    const w = ws = new WebSocket(u.url); w.binaryType = 'blob';
    w.onopen = () => { dropAll(); hidSent = false; useLink.setState((s) => ({ open: true, viewOnly: true, why: null, gen: s.gen + 1 })); };   // 재연결은 보기 전용부터
    w.onmessage = (e) => {
      if (typeof e.data !== 'string') {   // 카메라 JPEG: 받은 fps 세기 + 해독 끝난 최신 프레임만 img[data-live-cam] 에(camShow · 프레임마다 React 다시 그리지 않음)
        if (!simOn()) return;            // 실기 대상: 시뮬 영상 표시 0
        camT.push(performance.now()); CAM.recv++; camShow(e.data as Blob, camTag());
        return;
      }
      let m: any; try { m = JSON.parse(e.data); } catch { m = null; }
      if (m?.op === 'reply') { const f = fin(m.rid) ? pending.get(m.rid) : null; if (f && typeof m.ok === 'boolean') { pending.delete(m.rid); f(m as Reply); } return; }
      const bad = checkStatus(m);
      if (bad) { dropAll(); if (simOn()) useLink.setState({ st: null, bad, lastMsg: performance.now() }); return; }   // 미확인: 이전 st 로 조종 계속하지 않음
      const st = m as Status;
      if (st.latch) stopHeld = false;   // 서버가 STOP 잠금을 확인 — 이후는 latch 규칙이 막음
      const s2 = [st.role, st.latch, st.stop_gen, st.reset_pending, st.resume_pending, st.episode, st.sim_block, st.sim_stop?.busy, st.ver, st.state_age != null && st.state_age <= 1].join('|');
      if (s2 !== sig) { dropAll(); sig = s2; }   // 조종권·STOP·리셋·에피소드·시뮬·판·상태 신선도 변화 → 낡은 누름 폐기
      refreshShared(st.docs_rev, (st.events || [])[0]);   // 공유 기록(임무·사진 목록) 갱신 신호 — 대상과 무관
      if (!simOn()) return;   // 실기 대상: 시뮬 status 는 화면 상태(st·지나온 길·신선도)로 내보내지 않음
      if (st.episode !== useLink.getState().st?.episode || (st.reset_pending && !useLink.getState().st?.reset_pending)) camClear();   // 회차 변경·리셋 시작 = 영상 경계
      track(st);
      useLink.setState((s) => ({ st, bad: null, lastMsg: performance.now(), firstVer: s.firstVer ?? st.ver, stGen: s.gen }));
    };
    w.onclose = (e) => {
      dropAll(); sig = null; if (ws === w) ws = null; failPending('연결 끊김 — 응답 못 받음'); camClear();
      useLink.setState((s) => ({ open: false, viewOnly: true, gen: s.gen + 1 }));   // 끊기는 즉시 «끊김» 표시(1 s 기다리지 않음)
      if (e.code === 4401) { useLink.setState({ authEnd: true }); return; }   // 로그인 끝남: 다시 잇지 않음 → 화면이 로그인으로
      if (!closed) setTimeout(open, 1000);
    };
  };
  T.onEnded(() => { useLink.setState({ authEnd: true }); closeLink(); });   // 네이티브: 세션 끝·주소 없음·잠김 → 로그인 화면(자동 take/resume 없음)
  open();
  setInterval(() => useLink.setState((s) => ({ tick: s.tick + 1 })), 500);   // 메시지가 끊겨도 «끊김 N s» 표시가 갱신되게
  setInterval(tick20, 50);   // cmd 발행은 이 타이머 하나(20 Hz)
  lifecycle();
}

// ---- 앱 생명주기 어댑터(한 곳·한 번 등록) — 모바일 계약(mobile/README «A 에뮬레이터 검증 기록»):
// 백그라운드 순서 App.pause → document.pause → appStateChange:false → visibilitychange hidden(1965 ms 늦은 사례) → pause 에서 바로 숨김.
// 원격 A 페이지엔 @capacitor/core 없음 → window.Capacitor.Plugins.App 이 있을 때만. Activity 재생성 = 페이지 다시 읽힘 → 매 로드 등록, 시작은 보기 전용.
function lifecycle() {
  document.addEventListener('visibilitychange', () => { if (document.hidden) hide(); });
  addEventListener('pagehide', hide);
  addEventListener('hashchange', dropAll);   // 경로 전환 순간 누름 폐기(화면 unmount 의 hide 보다 먼저) — 같은 화면 쿼리 변경도 다시 눌러야 함
  addEventListener('blur', hide);
  screen.orientation?.addEventListener('change', dropAll);
  document.addEventListener('fullscreenchange', dropAll); document.addEventListener('webkitfullscreenchange', dropAll);   // 전체화면 들어감·나옴: 누르던 손가락 폐기
  document.addEventListener('focusin', (e) => { const t = e.target as HTMLElement | null; if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) dropAll(); });   // 입력칸으로 가면 누르던 조종부터 폐기
  const App = (window as any).Capacitor?.Plugins?.App;
  // 네이티브가 페이지 로드마다 removeAllListeners(Bridge.reset) — 여기선 로드당 한 번(started 가드)만. addListener 는 Promise: 거부를 삼킨다
  const add = (k: string, f: (x: any) => void) => { try { Promise.resolve(App.addListener(k, f)).catch(() => {}); } catch { /* 플러그인 없음: 문서 이벤트로 */ } };
  if (App?.addListener) {
    add('pause', hide);
    add('appStateChange', (x: { isActive?: boolean }) => { if (x?.isActive === false) hide(); });
    add('resume', () => { dropAll(); cancelStart(); useLink.setState({ viewOnly: true }); });   // 복귀: 누름 0 + 진행 중 «조종 시작» 중단 + 보기 전용(다시 «조종 시작»)
  }
}

// ---- 카메라 fps(최근 2 s 받은 프레임 수) · 지나온 길(GT) — live.js camFrames·TRAIL·track() 와 같은 규칙 ----
const camT: number[] = [], camS: number[] = [];   // 받은 시각 · 화면에 넣은 시각(최근 2 s)
// 10-15 ②: 받자마자 img.src 를 바꾸고 이전 URL 을 바로 해제하던 방식은, 해독이 다음 프레임보다 늦으면 진행 중 해독이 새 src 로 취소돼 화면이 멈춘 것처럼 보일 수 있다.
//   → 해독(Image.decode)이 끝난 프레임만 넣고, 넣은 «뒤에» 이전 URL 해제. 해독 중 새 프레임은 최신 1장만 대기(latest-only — 쌓기 0, 건너뛴 수는 CAM.skip).
//   표시 상한은 서버 push 10 Hz(v2_link push 100 ms, 그 사이 새 프레임은 최신 1장만) — 이 앞단(producer·WS)의 간격은 여기서 못 고친다.
export const CAM = { recv: 0, shown: 0, skip: 0, fail: 0, old: 0 };
// 받은 순간의 신원(연결 세대·대상·회차·도착 시각)을 프레임과 함께 들고 다니고, 화면에 넣기 직전 지금과 대조 — 다르거나 도착 뒤 CAM_MAX_MS 넘게 걸린 해독은 버림(CAM.old)
const CAM_MAX_MS = 1000;
type CamTag = { gen: number; prov: ProviderKind; ep: number | null; t: number; edge: number };
let camEdge = 0;   // 영상 경계 번호: camClear 마다 +1 — 그 전에 받은(해독 중 포함) 프레임은 영구 무효(리셋이 같은 회차로 끝나도 옛 해독 promote 0)
let camBusy = false, camNext: { b: Blob; k: CamTag } | null = null;
const camTag = (): CamTag => { const s = useLink.getState(); return { gen: s.gen, prov: s.provider, ep: s.st?.episode ?? null, t: performance.now(), edge: camEdge }; };
const camLive = (k: CamTag) => { const s = useLink.getState(); return k.edge === camEdge && s.open && s.gen === k.gen && s.provider === k.prov && s.provider === 'simulation_gate' && s.stGen === s.gen && !!s.st && !s.st.reset_pending && (s.st.episode ?? null) === k.ep && performance.now() - k.t <= CAM_MAX_MS; };
/** 영상 경계(연결 닫힘·대상 전환·회차 변경·리셋): 대기 프레임·지금 그림 버림(해독 중인 것은 promote 직전 대조로 버림) */
export function camClear() {
  camEdge++; camNext = null; if (camURL) URL.revokeObjectURL(camURL); camURL = null; camS.length = 0;
  for (const img of document.querySelectorAll<HTMLImageElement>('img[data-live-cam]')) img.removeAttribute('src');
}
function camShow(b: Blob, k: CamTag) {
  if (camBusy) { if (camNext) CAM.skip++; camNext = { b, k }; return; }   // 해독 중: 최신 1장만 대기(그 신원 그대로)
  camBusy = true; const u = URL.createObjectURL(b), im = new Image(); im.src = u;
  im.decode().then(() => {
    if (!camLive(k)) { URL.revokeObjectURL(u); CAM.old++; return; }   // 그새 연결·대상·회차·리셋이 바뀌었거나 너무 늦은 해독 → 버림
    const old = camURL; camURL = u; CAM.shown++; camS.push(performance.now());
    for (const img of document.querySelectorAll<HTMLImageElement>('img[data-live-cam]')) img.src = u;
    if (old) URL.revokeObjectURL(old);
  }, () => { URL.revokeObjectURL(u); CAM.fail++; })
    .finally(() => { camBusy = false; const n = camNext; camNext = null; if (n) camShow(n.b, n.k); });   // 대기분은 받을 때 신원으로(새 신원 붙이기 0)
}
export const TRAIL = { pts: [] as number[][], ep: null as number | null, last: null as null | { x: number; y: number; yaw: number | null; fallen: boolean | null; t: number } };
function track(m: Status) {
  if (m.episode !== TRAIL.ep) { TRAIL.pts = []; TRAIL.ep = m.episode; }   // 새 에피소드면 지나온 길을 새로
  const s = m.sim && m.state_age != null && m.state_age <= 1 ? m.sim : null;
  if (!s || !fin(s.x) || !fin(s.y)) return;
  TRAIL.last = { x: s.x, y: s.y, yaw: s.yaw, fallen: s.fallen, t: performance.now() };
  const p = TRAIL.pts[TRAIL.pts.length - 1];
  if (!p || Math.hypot(p[0] - s.x, p[1] - s.y) > 0.02) TRAIL.pts.push([s.x, s.y]);
  if (TRAIL.pts.length > 2000) TRAIL.pts.shift();
}

// live.js view() 의 링크·잠금·조종권·시뮬·카메라 글(같은 규칙). 끊기면 «꺼짐»이 아니라 «미확인».
export function linkView(s: LinkState) {
  if (s.provider !== 'simulation_gate') return {   // 실기 대상: 시뮬 값 0 — 모든 칸 «미연결»(Go2 직접 연결 없음)
    linkOk: false, s: null, fresh: false, camOk: false, camTxt: '미연결(실기)', robot: null, latch: false, simBlock: '',
    linkTxt: '실기 Go2 — 미연결(직접 연결 기초만)', roleTxt: '실기 — 명령 미지원', newVer: false, body: '몸 상태 미연결(실기)', sent: '미확인(실기 명령 0)',
  };
  const age = s.lastMsg ? (performance.now() - s.lastMsg) / 1000 : null, linkOk = s.open && age != null && age < 1, st = s.st;
  const sim = linkOk && st?.sim && st.state_age != null && st.state_age <= 1 ? st.sim : null;   // 신선한 시뮬 상태만(아니면 null = 미확인)
  const camOk = !!(linkOk && st && st.cam_age != null && st.cam_age < 2 && camURL && !st.reset_pending), now = performance.now();   // 표시할 해독 프레임이 있을 때만(경계 뒤 새 프레임 전엔 이유 글)
  while (camT.length && now - camT[0] > 2000) camT.shift();
  while (camS.length && now - camS[0] > 2000) camS.shift();
  return {
    linkOk, s: sim, fresh: !!(sim && TRAIL.last),
    camOk, camTxt: camOk ? `받음 ${(camT.length / 2).toFixed(0)} · 표시 ${(camS.length / 2).toFixed(0)} fps · ${st!.cam_age!.toFixed(1)} s` : sim?.camera === 'off' ? '꺼짐(시뮬)'
      : linkOk && st?.reset_pending ? '리셋 중 — 새 회차 프레임 대기' : linkOk && st && st.cam_age != null && st.cam_age < 2 ? '새 프레임 대기(연결·회차 바뀜)' : '미연결',
    robot: TRAIL.last ? { ...TRAIL.last, fresh: !!sim } : null, latch: !!(linkOk && st?.latch), simBlock: linkOk ? st?.sim_block || '' : '',
    linkTxt: s.authEnd ? '로그인 끝남 · 다시 로그인 필요' : !linkOk ? (age == null ? '연결 중' : `끊김 ${age.toFixed(0)} s`) : s.bad ? `상태 미확인(형식 ${s.bad})` : !st ? '상태 수신 대기' : st.sim_block || '정상',   // B2 발견(기존 결함): 대상 전환 직후 st=null·lastMsg 신선 → st! 접근으로 화면 전체가 꺼지던 것. 값 없음 = 대기(«정상» 대체 0)
    roleTxt: st?.role === 'control' ? '조종권 · 이 기기' : st?.role === 'view_other' ? `다른 기기가 조종 중${st.holder ? ` · ${st.holder}` : ''}` : '보기 전용',
    newVer: !!(st && s.firstVer && st.ver && st.ver !== s.firstVer),
    body: !sim ? '몸 상태 미연결' : sim.fallen === true ? '넘어짐' : sim.fallen == null ? '넘어짐 미확인'
      : sim.body_still === true ? '몸 정지' : `실측 ${ok(sim.vx) && ok(sim.vy) ? Math.hypot(sim.vx, sim.vy).toFixed(2) + ' m/s' : '속도 미확인'}`,
    // 서버가 지금 보내는 명령(누가 조종하든 같은 값). 링크가 끊기면 모름.
    sent: linkOk && st ? `앞 ${sgn(st.applied[0])} m/s · 회전 ${sgn(st.applied[2])} rad/s` : '미확인',
  };
}

// 시뮬 세션(RL session_status.sh 원값): 실행/켜지는 중/꺼짐 + 남은 시간. 안전 준비 판정 아님
export const sessTxt = (st: Status | null) => { const x = st?.sim_start?.session; if (!x) return '';
  return `${({ running: '실행 중', starting: '켜지는 중', idle: '꺼짐' } as Record<string, string>)[x.result || ''] || x.result || '미확인'}${x.remaining_s == null ? '' : ` · 남은 ${Math.max(0, Math.round(x.remaining_s / 60))}분${x.ends_at ? `(종료 ${String(x.ends_at).slice(11, 16)})` : ''}`}`; };
// 시뮬 시작 안내(진단): 기존 평지 체험 남은 횟수 · 최근 시작 결과 · 지도 체험 별도 횟수 — 서버가 검증해 준 값만, 없으면 «미확인»(0·허용으로 쓰지 않음)
export function startTxt(st: Status | null) {
  const ss = st?.sim_start, lg = ss?.ledger, ml = st?.map_start?.ledger, last = ss?.last, UX = '횟수 제한 없음(동시 1개 · 30분 뒤 자동 종료)';
  return {
    left: ss?.usage_scope === 'user_experience' ? `사용자 체험 · ${UX}` : lg ? `기존 평지 체험 남은 ${lg.max - lg.used}/${lg.max}` : '기존 평지 체험 남은 횟수 미확인',
    last: last ? `최근 시작 결과 ${last.t} · ${last.st === 'ok' ? '요청 처리됨(켜짐 판정은 영상·상태로)' : '안 켜짐'} · ${last.text}` : '',
    map: st?.map_start?.usage_scope === 'user_experience' ? `지도 시뮬 · ${UX}` : ml && ml.used >= 0 && ml.used <= ml.max ? `지도 시뮬 남은 ${ml.max - ml.used}/${ml.max}(별도 횟수 · 성공 보장 아님)` : '지도 시뮬 남은 횟수 미확인',
  };
}
// 상태 상세: 서버가 준 원값 그대로(가공·추정 없음) — live.js stateRows
export function stateRows(s: LinkState): [string, string][] {
  const v = linkView(s), st = s.st, r: [string, string][] = [['링크', v.linkTxt], ['조종권', v.roleTxt], ['STOP 잠금', v.linkOk ? String(v.latch) : '미확인(링크 끊김)'], ['보낸 명령', v.sent],
    ['서버 이유', st?.reason || '—'], ['state_age s', st ? num(st.state_age, 2) : '미확인'], ['cam_age s', st ? num(st.cam_age, 2) : '미확인'], ['영상 프레임(이 화면)', `받음 ${CAM.recv} · 표시 ${CAM.shown} · 건너뜀 ${CAM.skip} · 늦음·경계 버림 ${CAM.old} · 해독 실패 ${CAM.fail}`],
    ['episode', st ? String(st.episode) : '미확인'], ['배터리', '미연결(시뮬에 값 없음)'], ['이 기기', st?.me || '미확인'],
    ['조종 중인 기기', st?.holder || '없음'], ['시뮬 세션(RL 상태)', sessTxt(st) || '미확인'], ['화면 판', `${s.firstVer || '미확인'} (서버 지금 ${st?.ver || '미확인'})`]];
  for (const [k, x] of Object.entries(st?.sim || {})) r.push([`sim.${k}`, typeof x === 'string' ? x : JSON.stringify(x)]);
  return r;
}
