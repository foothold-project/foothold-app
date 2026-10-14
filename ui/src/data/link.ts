// WebSocket 링크 — 이 앱에서 WS 를 여는 곳은 여기 하나(소유자 하나). 명령 송신도 여기서만.
// 보내는 것: STOP·조종권·재개·리셋 + 조종 입력(cmd 20 Hz, 발행 타이머 하나) + 응답 받는 요청(사진·시뮬 시작).
// 묶음 3 경계: 받은 상태는 실행 중 형식 검사(타입 캐스트만 믿지 않음) — 실패면 st=null(미확인)·누름 폐기, 이전 상태로 조종하지 않음.
// STOP 은 명령 0 요청일 뿐 몸 정지가 아니다(시뮬 관측: STOP 뒤 약 3.6 s·0.32 m 더 움직임, 원인 미확인).
import { create } from 'zustand';
import type { ClientOp, Reply, Status } from '@contracts';
import { refreshShared } from './shared';
import { num, ok, sgn } from './fmt';
import { T } from './transport';


type LinkState = { why: string | null; st: Status | null; lastMsg: number; firstVer: string | null; authEnd: boolean; tick: number; open: boolean; bad: string | null; viewOnly: boolean };
// viewOnly: 이 화면이 «조종권 받기»를 누르기 전까지 cmd 를 보내지 않음. 처음 열 때·숨김·앱 pause/resume·재연결 뒤 다시 켜짐(서버 role 이 control 로 남아 있어도)
export const useLink = create<LinkState>(() => ({ why: null, st: null, lastMsg: 0, firstVer: null, authEnd: false, tick: 0, open: false, bad: null, viewOnly: true }));

let ws: WebSocket | null = null, started = false, sig: string | null = null;
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
  if (!s.open || !s.lastMsg || performance.now() - s.lastMsg > 1000) return s.why ? `링크 끊김 · ${s.why}` : '링크 끊김';
  if (s.bad || !st) return `상태 미확인(${s.bad || '없음'})`;
  if (s.firstVer && st.ver !== s.firstVer) return '새 판 — 새로고침';
  if (s.viewOnly) return '보기 전용 — 조종권 받기를 누르세요';
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
export const sendStop = () => { stopHeld = true; dropAll(); return send({ op: 'stop' }); };
/** 조종권·재개·리셋·놓기 — 전부 누름 폐기 뒤 송신. take 만 보기 전용을 푼다 */
export const sendOp = (op: 'take' | 'release' | 'resume' | 'reset') => { dropAll(); if (op === 'take') { hidSent = false; useLink.setState({ viewOnly: false }); } else if (op === 'release') useLink.setState({ viewOnly: true }); return send({ op }); };
/** 숨김·떠남·앱 pause: 누름 폐기 + 서버에 hidden(조종권 해제) + 보기 전용 */
// 배경 한 번에 pause·appStateChange·visibility·blur 로 3~4번 불림 → hidden 은 조종 중(take 뒤 또는 서버 role=control)일 때만 보냄(서버 drop 은 반복 무해)
let hidSent = false;   // 이 연결에서 마지막 take 뒤 hidden 을 이미 보냄
export function hide() { const s = useLink.getState(); dropAll(); if (!hidSent && (!s.viewOnly || s.st?.role === 'control')) hidSent = send({ op: 'hidden' }); useLink.setState({ viewOnly: true }); }

// ---- 받은 상태 실행 중 검사(계약 Status 중 명령 관문이 쓰는 칸) — 실패 이유 또는 null ----
const ROLES = new Set(['control', 'view_other', 'view']);
const nf = (v: unknown) => v === null || fin(v);
const age = (v: unknown) => v === null || (fin(v) && v >= 0);   // 나이는 음수면 미확인
const int = (v: unknown) => fin(v) && Number.isInteger(v);
const EVST = new Set(['ok', 'warn', 'bad']);
export function checkStatus(m: any): string | null {
  if (!m || typeof m !== 'object' || m.op !== 'status') return 'op';
  if (typeof m.ver !== 'string' || !m.ver) return 'ver';
  if (!ROLES.has(m.role)) return 'role';
  for (const k of ['latch', 'resume_pending', 'reset_pending']) if (typeof m[k] !== 'boolean') return k;
  if (typeof m.sim_block !== 'string') return 'sim_block';
  if (!(m.episode === null || int(m.episode)) || !age(m.state_age) || !age(m.cam_age) || !int(m.docs_rev)) return 'episode/age/docs_rev';
  if (typeof m.reason !== 'string' || typeof m.me !== 'string' || !(m.holder === null || typeof m.holder === 'string')) return 'reason/me/holder';
  if (!Array.isArray(m.applied) || m.applied.length !== 3 || !m.applied.every(fin)) return 'applied';
  if (!Array.isArray(m.events) || !m.events.every((e: any) => e && typeof e.t === 'string' && EVST.has(e.st) && typeof e.text === 'string')) return 'events';
  const ss = m.sim_start;   // 화면이 읽는 칸만: ok·why·session(남은 시간)
  if (!ss || typeof ss !== 'object' || typeof ss.ok !== 'boolean' || typeof ss.why !== 'string' || !(ss.session === null || typeof ss.session === 'object')) return 'sim_start';
  const sp = m.sim_stop;    // 없으면 옛 서버(버튼 숨김). 있으면 화면이 읽는 칸 전부 검사
  if (sp !== undefined && sp !== null && (typeof sp !== 'object' || typeof sp.ok !== 'boolean' || typeof sp.why !== 'string' || typeof sp.busy !== 'boolean' || typeof sp.on !== 'boolean'
    || !(sp.ledger_left === null || int(sp.ledger_left)) || !(sp.last === null || (typeof sp.last === 'object' && (sp.last.st === 'ok' || sp.last.st === 'bad') && typeof sp.last.text === 'string')))) return 'sim_stop';
  if (m.sim !== null) {
    if (typeof m.sim !== 'object') return 'sim';
    for (const k of ['x', 'y', 'yaw', 'vx', 'vy', 'tilt_deg']) if (!nf(m.sim[k])) return `sim.${k}`;
    for (const k of ['fallen', 'body_still']) if (m.sim[k] !== null && typeof m.sim[k] !== 'boolean') return `sim.${k}`;
  }
  return null;
}
// 응답이 오는 요청(사진·시뮬 시작): 서버가 rid 로 답한다. 5 s 안에 답 없으면 실패로(live.js ask 와 같음)
let rid = 0; const pending = new Map<number, (m: Reply) => void>();
export const ask = (op: 'photo' | 'sim_start' | 'sim_stop') => new Promise<Reply>((res) => {
  const id = ++rid, no = (text: string) => res({ op: 'reply', rid: id, ok: false, text });
  if (!send({ op, rid: id })) return no('링크 끊김 — 보내지 못함');
  const t = setTimeout(() => { pending.delete(id); no('서버 응답 없음(5 s)'); }, 5000);
  pending.set(id, (m) => { clearTimeout(t); res(m); });
});

// Gazebo 끄기(로봇 STOP 아님): 폐기 → 확인창 → sim_stop. 결과(ROS 세션 종료 확인/못 함)는 서버 이벤트로 따로 온다 → 토스트 글 | null(취소)
export async function stopSim(st: Status | null): Promise<string | null> {
  const x = st?.sim_stop; if (!x || !x.ok) return `Gazebo 끄기 안 됨 · ${x?.why || '서버 응답 없음'}`;
  dropAll();
  if (!confirm(`Gazebo 시뮬을 끌까요? (로봇 STOP 아님)\n· 조종 중이면 명령 0·STOP 잠금 뒤 조종권 반납\n· 자동 재시작 없음 — 다시 하려면 «시뮬 시작»을 직접 눌러야 하고 기존 기동 상한이 적용됩니다${x.ledger_left === 0 ? '\n· 남은 기동 0 — 끄면 다시 켤 수 없습니다' : ''}`)) return null;
  return (await ask('sim_stop')).text || '응답 없음';
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
    w.onopen = () => { dropAll(); hidSent = false; useLink.setState({ open: true, viewOnly: true, why: null }); };   // 재연결은 보기 전용부터
    w.onmessage = (e) => {
      if (typeof e.data !== 'string') {   // 카메라 JPEG: fps 세기 + 화면의 img[data-live-cam] 에 바로 넣음(프레임마다 React 다시 그리지 않음)
        camT.push(performance.now()); if (camURL) URL.revokeObjectURL(camURL); camURL = URL.createObjectURL(e.data as Blob);
        for (const img of document.querySelectorAll<HTMLImageElement>('img[data-live-cam]')) img.src = camURL;
        return;
      }
      let m: any; try { m = JSON.parse(e.data); } catch { m = null; }
      if (m?.op === 'reply') { const f = fin(m.rid) ? pending.get(m.rid) : null; if (f && typeof m.ok === 'boolean') { pending.delete(m.rid); f(m as Reply); } return; }
      const bad = checkStatus(m);
      if (bad) { dropAll(); useLink.setState({ st: null, bad, lastMsg: performance.now() }); return; }   // 미확인: 이전 st 로 조종 계속하지 않음
      const st = m as Status;
      if (st.latch) stopHeld = false;   // 서버가 STOP 잠금을 확인 — 이후는 latch 규칙이 막음
      const s2 = [st.role, st.latch, st.reset_pending, st.resume_pending, st.episode, st.sim_block, st.ver, st.state_age != null && st.state_age <= 1].join('|');
      if (s2 !== sig) { dropAll(); sig = s2; }   // 조종권·STOP·리셋·에피소드·시뮬·판·상태 신선도 변화 → 낡은 누름 폐기
      track(st);
      useLink.setState((s) => ({ st, bad: null, lastMsg: performance.now(), firstVer: s.firstVer ?? st.ver }));
      refreshShared(st.docs_rev, (st.events || [])[0]);
    };
    w.onclose = (e) => {
      dropAll(); sig = null; if (ws === w) ws = null;
      useLink.setState({ open: false, viewOnly: true });   // 끊기는 즉시 «끊김» 표시(1 s 기다리지 않음)
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
    add('resume', () => { dropAll(); useLink.setState({ viewOnly: true }); });   // 복귀: 누름 0 + 보기 전용(다시 «조종권 받기»)
  }
}

// ---- 카메라 fps(최근 2 s 받은 프레임 수) · 지나온 길(GT) — live.js camFrames·TRAIL·track() 와 같은 규칙 ----
const camT: number[] = [];
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
  const age = s.lastMsg ? (performance.now() - s.lastMsg) / 1000 : null, linkOk = s.open && age != null && age < 1, st = s.st;
  const sim = linkOk && st?.sim && st.state_age != null && st.state_age <= 1 ? st.sim : null;   // 신선한 시뮬 상태만(아니면 null = 미확인)
  const camOk = !!(linkOk && st && st.cam_age != null && st.cam_age < 2), now = performance.now();
  while (camT.length && now - camT[0] > 2000) camT.shift();
  return {
    linkOk, s: sim, fresh: !!(sim && TRAIL.last),
    camOk, camTxt: camOk ? `${(camT.length / 2).toFixed(0)} fps · ${st!.cam_age!.toFixed(1)} s` : sim?.camera === 'off' ? '꺼짐(시뮬)' : '미연결',
    robot: TRAIL.last ? { ...TRAIL.last, fresh: !!sim } : null, latch: !!(linkOk && st?.latch), simBlock: linkOk ? st?.sim_block || '' : '',
    linkTxt: s.authEnd ? '로그인 끝남 · 다시 로그인 필요' : !linkOk ? (age == null ? '연결 중' : `끊김 ${age.toFixed(0)} s`) : s.bad ? `상태 미확인(형식 ${s.bad})` : st!.sim_block || '정상',
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
// 상태 상세: 서버가 준 원값 그대로(가공·추정 없음) — live.js stateRows
export function stateRows(s: LinkState): [string, string][] {
  const v = linkView(s), st = s.st, r: [string, string][] = [['링크', v.linkTxt], ['조종권', v.roleTxt], ['STOP 잠금', v.linkOk ? String(v.latch) : '미확인(링크 끊김)'], ['보낸 명령', v.sent],
    ['서버 이유', st?.reason || '—'], ['state_age s', st ? num(st.state_age, 2) : '미확인'], ['cam_age s', st ? num(st.cam_age, 2) : '미확인'],
    ['episode', st ? String(st.episode) : '미확인'], ['배터리', '미연결(시뮬에 값 없음)'], ['이 기기', st?.me || '미확인'],
    ['조종 중인 기기', st?.holder || '없음'], ['시뮬 세션(RL 상태)', sessTxt(st) || '미확인'], ['화면 판', `${s.firstVer || '미확인'} (서버 지금 ${st?.ver || '미확인'})`]];
  for (const [k, x] of Object.entries(st?.sim || {})) r.push([`sim.${k}`, typeof x === 'string' ? x : JSON.stringify(x)]);
  return r;
}
