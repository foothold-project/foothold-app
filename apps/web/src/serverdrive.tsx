// 실기 Go2 서버 경유 시험 조종(10-30 SERVER-DRIVE-WEB·ADD1 — ADR-002 예외: 서버가 켠 시험 로봇만, PC 웹만). 로봇 탭 상세 서랍에 붙는다.
// 허용 여부는 서버 목록의 server_drive_allowed 만 본다(웹은 추측하지 않음). 조종권·잠금 해제·STOP·명령은 rt.ts(화면 WS) 그대로 — 새 경로 없음.
// 명령은 서버·에이전트 표의 SI 값 9개만(그 밖 조합은 0), 누르는 동안만. 뗌·초점 잃음·가려짐·연결 끊김·STOP = 바로 0 + 안내, 다시 누를 때까지 재개 없음.
// 로봇 상세 서랍에는 작게(STOP·정지 단계·잠금 해제·조종 시작/끝내기), «조종 화면 열기» = 전체화면 모달(카메라·라이다 drivemedia.ts·조작부·상태줄, 다시 누르거나 Esc 로 복귀).
// 그 안에도 STOP 이 가장 크게. 키 조종은 패널이 열린 동안 그대로
import { useEffect, useRef, useState, type ButtonHTMLAttributes, type KeyboardEvent as KeyEv, type PointerEvent, type ReactNode } from 'react';
import { CMD_MS, GATE_STOP_TEXT, inputGen, metaCut, rt, stopReach, undelivered, useLive, type Live } from './rt';
import { typing, useStopPress } from './App';
import { Chip, DriveButton, inApp, type Ctx } from './screens';
import { STALLED } from './simdrive';
import { HeldTag, LidarMap } from './lidarmap';
import { REPORT_STALE_MS, go2Pose, type Pose } from './go2model';
import { DriveInputNote } from './driveinput';
import type { Look } from './lidar3d';
import { DEPTH_HINT, driveFeedHeld, driveFeedText, useDriveFeed, type DriveCh, type DriveFeed } from './drivemedia';
import { driveBlock, type Robot, type Tone } from './fake';
import { api } from './api';
import { ActionTrial } from './screens/actiontrial';
import { GAIT_KEYS, gaitKey, useGait } from './gait';
import { realCaps, simTune, useTuneSettings } from './phone';
import type { GaitName, OrgSettings, UnlockRefused } from '../../contracts/ts';
import orgSettingsSchema from '../../contracts/schema/OrgSettings.json';
import { keyCode } from './padkeys';

/** 누름 하나: up·down = 전후(W·↑ / S·↓), left·right = 옆걸음(← / →), rotl·rotr = 제자리 회전(A / D). 모든 조종 화면 한 배치(팀장 11-28 17:25 · Q · E 없음) */
export type Tok = 'up' | 'down' | 'left' | 'right' | 'rotl' | 'rotr';
/** 계약 JSON 스키마 중 OrgSettings 가 쓰는 낱말만(type·required·properties·additionalProperties·anyOf·minimum·maximum). 모르는 type 은 거절 */
type Schema = { type?: string; required?: string[]; properties?: Record<string, Schema>; additionalProperties?: boolean | Schema; anyOf?: Schema[]; minimum?: number; maximum?: number };
const plain = (o: unknown): o is Record<string, unknown> => !!o && typeof o === 'object' && !Array.isArray(o);
const fits = (f: Schema, v: unknown): boolean => {
  if (f.anyOf) return f.anyOf.some((x) => fits(x, v));
  if (f.type === 'boolean') return typeof v === 'boolean';
  if (f.type === 'number' || f.type === 'integer')
    return typeof v === 'number' && Number.isFinite(v) && (f.type !== 'integer' || Number.isInteger(v)) && v >= (f.minimum ?? -Infinity) && v <= (f.maximum ?? Infinity);
  if (f.type !== 'object' || !plain(v)) return false;
  const p = f.properties ?? {}, more = f.additionalProperties ?? true;
  return (f.required ?? []).every((k) => Object.prototype.hasOwnProperty.call(v, k)) && Object.entries(v).every(([k, x]) =>
    Object.prototype.hasOwnProperty.call(p, k) ? fits(p[k], x) : typeof more === 'boolean' ? more : fits(more, x));
};
/** 조직 설정은 계약(OrgSettings 스키마) 전체로 검증된 객체만 «받음» — 본문 없는 200·배열·필수 칸 빠짐·모르는 칸·타입 틀림(real_max_vx: "0")·범위 밖·
 *  model_overrides 안쪽 타입 틀림은 못 받음과 같다(RV-424·425·426 ①). 선택 칸이 빠지면 서버 기본값과 같은 상한으로 본다(realCaps) */
export const isSettings = (o: unknown): o is OrgSettings => fits(orgSettingsSchema as Schema, o);
export const KEY: Record<string, Tok> = { KeyW: 'up', ArrowUp: 'up', KeyS: 'down', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', KeyA: 'rotl', KeyD: 'rotr' };
/** 옆걸음(← / →)이 조직 속도 설정(옆 상한·빠른 조종 끔)에 막혀 0 을 보낼 때 까닭 한 줄. 폰(drive.tsx)·PC 같은 문구 */
export const SIDE_BLOCK = '옆걸음은 조직 속도 설정(옆 상한)이 허락하지 않아 입력을 0으로 보냅니다.';
/** 표에 없는 키 조합(W+Q·A+Q·W+S·Q+E 등)은 0. 말없이 멈추지 않게 까닭 한 줄(폰·PC 같은 문구) */
export const COMBO_BLOCK = '이 키 조합은 함께 보낼 수 없어 입력을 0으로 보냅니다.';
export const MAX_TURN_RATE = orgSettingsSchema.properties.real_max_wz.maximum;
/** 서버·에이전트 허용 표(SERVER-DRIVE-ADD1 A) — [vx m/s, vy m/s, wz rad/s]. 정확히 이 값만, 표 밖 조합은 0 */
export const TABLE: Record<string, [number, number, number]> = {
  '': [0, 0, 0], up: [1.5, 0, 0], down: [-1.5, 0, 0], left: [0, 1, 0], right: [0, -1, 0],
  rotl: [0, 0, MAX_TURN_RATE], rotr: [0, 0, -MAX_TURN_RATE], 'rotl+up': [1.5, 0, MAX_TURN_RATE], 'rotr+up': [1.5, 0, -MAX_TURN_RATE],
};
export function permitted(axes: [number, number, number], o: Partial<OrgSettings> | null) {
  const [vx, vy, wz] = axes, c = realCaps(o);
  return vx <= c.real_max_vx && vx >= -c.real_max_vx_back && Math.abs(vy) <= c.real_max_vy && Math.abs(wz) <= c.real_max_wz
    && !(o?.real_no_fast_server_drive && (vx || vy));
}
/** 실기에서 서버 경유 허용(목록 server_drive)·조직 속도 설정을 아직 확인하지 못함 — 그동안 입력은 0(RB-PHONE-REAL-TABLE-FIX, 폰·PC 같은 문구) */
export const REAL_WAIT = '서버 경유 조종 허용·조직 속도 설정을 확인하는 중이라 입력을 0으로 보냅니다.';
const id = (held: Iterable<Tok>) => [...held].sort().join('+');
export const command = (held: Iterable<Tok>) => TABLE[id(held)] ?? TABLE[''];
/** 누른 것이 있는데 표에 없는 조합인가 */
export const unknownCombo = (held: Iterable<Tok>) => { const k = id(held); return k !== '' && !(k in TABLE); };
/** 화면 단추 8개(+ 손 뗌 = 0) — 키와 같은 표 */
const PAD: [Tok[], string, string][] = [
  [['rotl', 'up'], '↑+A', `앞+왼쪽 회전 최대 ${MAX_TURN_RATE} rad/s`], [['up'], 'W·↑', '앞 1.5'], [['rotr', 'up'], '↑+D', `앞+오른쪽 회전 최대 ${MAX_TURN_RATE} rad/s`],
  [['left'], '←', '옆 왼쪽 1'], [['down'], 'S·↓', '뒤 1.5'], [['right'], '→', '옆 오른쪽 1'],
  [['rotl'], 'A', `제자리 왼쪽 최대 ${MAX_TURN_RATE} rad/s`], [['rotr'], 'D', `제자리 오른쪽 최대 ${MAX_TURN_RATE} rad/s`],
];
export const TRIAL = '실기 · 서버 경유 시험 · 미검증';
/** 입력 0 안내 — 화면이 보낸 0 일 뿐 로봇 정지 확인이 아니다(F-COM-01: 확인 없이 «멈췄습니다» 금지). 정지 확인은 stopLine 만 */
export const SD_NOTE = {
  blur: '창 초점을 잃어 조종 입력을 0으로 보냈습니다(로봇 정지 확인 아님). 다시 누르세요.',
  hidden: '창이 가려져 조종 입력을 0으로 보내고 조종권을 반납했습니다(로봇 정지 확인 아님). [조종 시작]부터 다시 하세요.',
  link: '서버 연결이 끊겨 입력 0이 로봇에 닿았는지 알 수 없습니다 — 현장에서 로봇을 확인하세요. 다시 연결되면 [조종 시작]부터 하세요.',
  stop: '조종 입력을 0으로 보냈습니다. 정지 확인은 STOP 옆 상태를 보세요 — 잠금 해제 뒤 새로 누르세요.',
};
/** STOP 상태 한 줄: 입력 0 보냄(요청 중) / 정지 요청 접수 / 로봇 정지 확인 / 실패. «로봇 정지 확인»은 이 STOP 뒤 이 소켓에서 받은 새 세대 잠금(rt stop.latched)
 *  + 지금 보고가 ONLINE·잠김·출력(applied) 0·수평 속도 0 일 때만 */
export function stopLine({ stop: p, state: s }: Pick<Live, 'stop' | 'state'>): { tone: Tone; text: string } | null {
  if (!p) return null;
  const why = p.why ? ` (${p.why})` : '';
  if (p.phase === 'failed') return { tone: 'bad', text: `정지 요청 실패 — 현장 확인${why}` };
  if (p.phase === 'unsure') return { tone: 'bad', text: `정지 접수 확인 못함 — 현장 확인${why}` };
  if (p.phase === 'sending') return { tone: 'warn', text: '입력 0 보냄 · 정지 요청 보내는 중' };
  if (stopReach(s) === 'gate') return { tone: 'bad', text: GATE_STOP_TEXT };
  const no = undelivered(p, s); if (no) return { tone: 'bad', text: no };
  if (p.latched && stopReach(s) === 'applied' && s?.connection === 'ONLINE' && s.latched === true && !!s.applied?.length && s.applied.every((v) => v === 0) && s.speed != null && s.speed < 0.05)
    return { tone: 'ok', text: '로봇 정지 확인 — 잠금·출력 0·수평 속도 0' };
  return { tone: 'warn', text: `정지 요청 접수${p.phase === 'fallback' ? '(대체 경로)' : ''} — 로봇 정지 확인 대기` };
}
/** 자세 멈춤(app-lx 검토 · 03:48): 일어서기 · 엎드리기 도중 STOP 을 받으면 몸이 그 자리에 붙잡히고 posture.state 는 TRANSITIONING 으로 남음.
 *  posture_result 가 STOPPED(계약 밖 · 서버가 보냄) 또는 FAILED 이면 «바꾸는 중» 이 아니라 멈춤으로 읽는다. 화면 글만 · 명령 · 이동 잠금은 그대로 */
export const POSTURE_HALTED = '자세 멈춤 · 일어서기나 엎드리기로 다시';
export const postureHalted = (s: { posture?: { state?: string | null } | null; posture_result?: { status: string } | null } | null | undefined) =>
  s?.posture?.state === 'TRANSITIONING' && (s.posture_result?.status === 'STOPPED' || s.posture_result?.status === 'FAILED');

/** 자세 단추(11-16): 일어서기·엎드리기 — 계약 ScreenPosture.action 으로 보내고, 결과는 로봇이 보고한 state.posture_result 로 안다 */
export const POSE = {
  up: { act: 'stand_up', name: '일어서기', doing: '일어서는 중…', done: '일어섰습니다.', fail: '일어서지 못했습니다' },
  down: { act: 'stand_down', name: '엎드리기', doing: '엎드리는 중…', done: '엎드렸습니다. 이제 전원을 꺼도 됩니다.', fail: '엎드리지 못했습니다' },
} as const;
type PoseKey = keyof typeof POSE;
const POSE_KEY = { stand_up: 'up', stand_down: 'down' } as const;
/** 로봇이 알린 자세 명령 거부·실패 사유(계약 PostureResult.code)를 쉬운 말로. 모르는 값은 현장 확인 안내 */
const POSE_WHY: Record<string, string> = {
  ROBOT_SLOW: '로봇 응답 느림. 잠시 뒤 다시 누르세요.',
  MOVING: '로봇이 움직이고 있습니다. 멈춘 뒤 다시 누르세요.',
  BUSY: '다른 자세 동작을 하는 중입니다. 끝난 뒤 다시 누르세요.',
  NOT_AUTHORIZED: '조종권이 없습니다. [조종 시작]부터 다시 하세요.', AUTHORITY_LOST: '동작 중에 조종권이 바뀌었습니다. [조종 시작]부터 다시 하세요.',
  LEASE_CHANGED: '동작 중에 조종권이 바뀌었습니다. [조종 시작]부터 다시 하세요.',
  STOPPED: '정지 요청으로 동작을 멈췄습니다. 현장에서 로봇을 확인하세요.', DISCONNECTED: '로봇 연결이 끊겼습니다. 현장에서 로봇을 확인하세요.',
  FEEDBACK_UNAVAILABLE: '로봇이 자세를 알려 주지 않습니다. 현장에서 로봇을 확인하세요.',
  TIMEOUT: '시간 안에 끝나지 않았습니다. 현장에서 로봇을 확인하세요.', SDK_REJECTED: '로봇이 동작을 받지 않았습니다. 잠시 뒤 다시 누르세요.',
  STOOD_NOT_WALKABLE: '로봇은 섰지만 걷기 허용 상태가 아닙니다. 현장에서 로봇 상태를 확인하세요.',
  LOWLEVEL_UNSUPPORTED: '저수준 (START) 제어 중에는 엎드리기만 쓸 수 있습니다.',
  RUNNER_NOT_CONNECTED: 'START 실행기와 아직 연결되지 않았습니다. 리모컨 L2+A 로 엎드리세요.',
  RUNNER_SEND_FAILED: 'START 실행기에 보내지 못했습니다. 리모컨 L2+A 로 엎드리세요.',
};
/** 20초(POSE_WAIT_MS) 안에 최종 결과가 없을 때 */
export const POSE_LOST = '로봇에서 결과를 받지 못했습니다. 현장에서 로봇을 확인하세요.';
export const poseWhy = (code?: string | null) => POSE_WHY[code ?? ''] ?? '로봇이 동작을 하지 못했습니다. 현장에서 로봇을 확인하세요.';
/** 자세 명령 뒤 이 시간 안에 로봇의 결과 보고가 없으면 «확인하지 못함». 로봇 쪽 동작 시한보다 길게(실기 동작 시간에 맞춰 고치는 값) */
export const POSE_WAIT_MS = 20000;
export const LYING_TEXT = '로봇이 엎드려 있습니다. «일어서기»를 누르면 걸을 수 있습니다.';
export const POWER_HINT = '전원을 끄기 전에 엎드리게 하세요.';
/** 잠금 해제 요청 뒤 이 시간 안에 잠금이 안 풀리면 «미확인» */
export const UNLOCK_WAIT_MS = 3000;
/** 에이전트 잠금 해제 거절(contracts UnlockRefused, #213): 사유 코드 그대로 + 넘은 축 값/기준 */
export function refusedText(r: UnlockRefused | null | undefined) {
  if (!r?.reason) return '';
  const ax = (r.axes ?? []).map((a) => `${a.axis} ${a.value} ${a.unit} > 기준 ${a.limit} ${a.unit}`).join(', ');
  return `거절 사유: ${r.reason}${ax ? ` — ${ax}` : ''}`;
}
/** 서로 다른 컴퓨터의 시각을 빼지 않고, 각 연결에서 측정한 왕복만 표시한다. */
export function ResponseLine({ state: s, screenMs }: { state: Live['state']; screenMs: number | null }) {
  const current = useRef({ state: s, screenMs }); current.current = { state: s, screenMs };
  const [sample, setSample] = useState(current.current);
  useEffect(() => { const timer = setInterval(() => setSample(current.current), 1000); return () => clearInterval(timer); }, []);
  const h = s?.connection === 'ONLINE' ? sample.state?.response_health : null;
  const ms = (value: number | null | undefined) => value == null ? '측정 대기' : `${Math.round(value)} ms`;
  return <div className="lbl mono" data-sd-latency>
    로봇 응답: {h?.last_timed_out ? '0.1초 넘음' : ms(h?.last_ms)}
    {h && h.sample_count > 0 && <> (최근 {h.sample_count}회 중앙값 {h.median_timed_out ? '시간 초과 포함' : ms(h.median_ms)})</>}
    {' · '}로봇 컴퓨터↔서버: {ms(s?.connection === 'ONLINE' ? sample.state?.latency_ms : null)}
    {' · '}서버↔이 화면: {ms(screenMs == null ? null : sample.screenMs)}
  </div>;
}
export function SlowResponse({ health }: { health: NonNullable<Live['state']>['response_health'] }) {
  if (!health?.slow) return null;
  const at = health.last_timeout_at ? new Date(health.last_timeout_at).toLocaleTimeString('ko-KR', { hour12: false }) : '모름';
  return <p className="dv-note" role="status" data-sd-slow>로봇 응답 느림 · 최근 3초 {health.timeout_count}회 · 마지막 {at}</p>;
}
/** 대화상자 밖을 inert(초점·누름 막음) — 대화상자 조상 줄의 형제 모두. 돌려줄 때 원래대로 */
function inertOutside(el: HTMLElement) {
  const done: Element[] = [];
  for (let n: HTMLElement | null = el; n && n !== document.body; n = n.parentElement)
    for (const x of n.parentElement?.children ?? []) if (x !== n && !x.hasAttribute('inert')) { x.setAttribute('inert', ''); done.push(x); }
  return () => done.forEach((x) => x.removeAttribute('inert'));
}
/** Tab·Shift+Tab 을 대화상자 안에서 돌림 */
function trapTab(e: KeyEv<HTMLElement>) {
  if (e.key !== 'Tab') return;
  const f = [...e.currentTarget.querySelectorAll<HTMLElement>('button:not([disabled]), summary, [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')].filter((el) => {
    const closed = el.closest('details:not([open])');
    return !closed || el.tagName === 'SUMMARY' && el.parentElement === closed;
  });
  if (!f.length) return;
  const i = f.indexOf(document.activeElement as HTMLElement);
  e.preventDefault(); f[e.shiftKey ? (i <= 0 ? f.length - 1 : i - 1) : (i + 1) % f.length].focus();
}
const CH_NAME: Record<DriveCh, string> = { rgb: '카메라', lidar: '라이다', depth: '뎁스' };
/** 조종 화면 큰 화면 고르기 — 채널 셋 + «상자»(라이다 받은 판을 5 cm 상자로, 11-20 RB-UNITREE-LOOK-FIX) */
type Big = DriveCh | 'box';
const BIG_NAME: Record<Big, string> = { ...CH_NAME, box: '상자' };
/** 뎁스 색(계약: OpenCV TURBO 역방향 — 가까움 빨강 → 멀리 파랑), 범례용 띠 */
const TURBO_R = 'linear-gradient(90deg,#7a0403,#e4460a,#faba39,#a4fc3b,#1bcfd4,#4686fb,#30123b)';
/** 뎁스 그림 아래 작은 범례 — 범위는 받은 프레임의 depth_min_m·depth_max_m(소수 한 자리) */
export const DepthLegend = ({ range: [a, b] }: { range: [number, number] }) => <div className="lbl mono" aria-label="뎁스 색 범례" data-sd-depth-legend
  style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', padding: '4px 8px', fontSize: 11, color: '#DDE5EC' }}>
  <span>가까움 {a.toFixed(1)} m</span><span aria-hidden="true" style={{ flex: 1, minWidth: 60, height: 8, borderRadius: 2, background: TURBO_R }} /><span>멀리 {b.toFixed(1)} m</span>
  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><span aria-hidden="true" style={{ width: 10, height: 10, background: '#000', border: '1px solid #DDE5EC' }} />거리 모름</span>
</div>;

/** 서버 경유 조종 패널을 붙일 수 있음: 서버 목록 server_drive_allowed(담당·기체번호·서버 전체 스위치·로봇 연결을 서버가 자동 확인, #323) + PC 웹 + 내 실기(총괄은 모든 실기 · 11/28).
 *  시뮬 · 데모 로봇(r.sim === true)은 서버가 server_drive_allowed 를 늘 거짓으로 준다(실기 전용 값) — 「내 것 && 연결됨」 으로 연다(총괄도 남의 시뮬은 막힘). 조종권 · 인증 · 주인은 서버 WS 가 다시 본다 */
const linked = (r: Robot) => (r.sim === true ? r.online : !!r.serverDrive);
export const canDrive = (c: Pick<Ctx, 'user' | 'phone'>, r: Robot) => linked(r) && !c.phone && !inApp()
  && (r.sim === true ? r.owner === c.user.id : r.owner === c.user.id || c.user.role === 'ORG_ADMIN');
/** 이 로그인 세션(사용자·세션 취소 신호)에서 한 번이라도 canDrive 였던 로봇 id — RB-PC-DRIVE-OFFLINE. 사용자가 바뀌거나 로그아웃(세션 신호 끝남)하면 비운다(RB-PC-DRIVE-OFFLINE-FIX) */
let drove = { user: '', cancel: undefined as AbortSignal | undefined, ids: new Set<string>() };
const droveIds = (c: Pick<Ctx, 'user' | 'cancel'>) => {
  if (drove.user !== c.user.id || drove.cancel !== c.cancel || c.cancel?.aborted) drove = { user: c.user.id, cancel: c.cancel, ids: new Set() };
  return drove.ids;
};
/** 세 칸 조종 화면을 둘 로봇(RB-PC-DRIVE-OFFLINE 11-19): 지금 canDrive, 또는 한 번 canDrive 였고 서버가 막는 까닭이 «로봇 연결 없음»(AGENT_OFFLINE) 하나뿐
 *  (담당·기체번호·서버 스위치는 그대로 맞음 — 서버 목록 server_drive_blocked). 조종 가능 여부는 여전히 canDrive·연결 상태가 정한다 */
export const keepDrive = (c: Pick<Ctx, 'user' | 'phone' | 'cancel'>, r: Robot) => {
  const ids = droveIds(c);
  if (canDrive(c, r)) return ids.add(r.id), true;
  const b = r.serverDriveBlocked;
  return ids.has(r.id) && b?.length === 1 && b[0] === 'AGENT_OFFLINE' && canDrive(c, { ...r, serverDrive: true });
};

/** 조종 논리 하나(조종권·키·누름 단추·deadman 0·STOP·잠금 해제·자세) — 작은 패널(ServerDrive)과 PC 로봇 탭 세 칸 화면(pcdrive.tsx)이 같이 쓴다.
 *  한 화면에 하나만 붙인다(키·조종권이 하나). esc = Esc 를 눌렀을 때(패널의 전체화면 닫기) */
export function useServerDrive(c: Pick<Ctx, 'user'>, r: Robot, esc?: { current: () => void }) {
  const settings = useTuneSettings(), settingsRef = useRef(settings); settingsRef.current = settings;
  // got = 이 화면이 조직 설정을 받음(그리고 지금 공용 설정이 검증된 객체 — simTune(null) 로 비면 못 받음). 받기 전(앞 화면이 남긴 값 포함)·못 받으면 입력은 0 — 기본 상한 1.5 로 보내 서버가 거절·STOP 하지 않게(폰 drive.tsx 와 같게)
  const [got, setGot] = useState(false), gotRef = useRef(got); gotRef.current = got;
  const l = useLive(r.id), link = rt.link().at, mine = !!l.lease, s = l.state;
  const [on, setOn] = useState(''), [why, setWhy] = useState('');
  const [, tick] = useState(0), [asked, setAsked] = useState<number | null>(null);   // asked = 잠금 해제 요청을 보낸 때(rt.now)
  // 누른 것(입력 세대 — rt inputGen): 물리 키(e.code)·화면 단추 포인터(pointerId)마다 누른 순간의 세대. 지금 세대가 아닌 것이 남아 있으면 명령 0
  const [g] = useState(inputGen), keys = useRef(new Map<string, number>()), pads = useRef(new Map<number, { n: number; t: Tok[]; el: HTMLElement }>());
  // 걷기 모드(u03): 누른 키 · 단추가 있거나 로봇이 0 아닌 명령을 적용 중이면 «움직이는 중» · 보내지 않고 까닭
  const gait = useGait(r.id, () => keys.current.size + pads.current.size > 0 || !!rt.get(r.id).state?.applied?.some((v) => v !== 0)), gaitRef = useRef(gait.press); gaitRef.current = gait.press;
  /** 화면이 Shift+1~4 를 가로챔(로봇 탭 PC: 시안 u4_7 확인 창을 먼저 연다) · 비어 있으면 바로 보냄(폰 · 옛 화면) */
  const gaitAsk = useRef<((g: GaitName) => void) | null>(null);
  // pose = 내가 보낸 자세 명령(결과가 올 때까지 두 단추 잠금), prev = 누를 때 보이던 앞 결과(같은 것을 내 결과로 읽지 않게)
  const [pose, setPose] = useState<{ k: PoseKey; prev: string | null; at: number } | null>(null), [poseMsg, setPoseMsg] = useState('');
  const posture = s?.posture?.state ?? null, res = s?.posture_result ?? null;
  // «실행 중» 보고도 요청마다 POSE_WAIT_MS 까지만 믿는다(REVIEW-365 B1: 최종 결과가 안 오면 단추가 영영 잠김). 내 요청이면 누른 때부터, 아니면 처음 본 때부터 — 250 ms 틱이 다시 그린다
  const run = useRef<{ id: string; at: number } | null>(null);
  if (res?.status === 'RUNNING' && run.current?.id !== res.request_id) run.current = { id: res.request_id, at: pose && res.request_id !== pose.prev ? pose.at : rt.now() };
  const running = res?.status === 'RUNNING' && rt.now() - run.current!.at < POSE_WAIT_MS ? POSE_KEY[res.action] : null;
  const lost = res?.status === 'RUNNING' && !running ? `${POSE[POSE_KEY[res.action]].fail} — ${POSE_LOST}` : '';
  const halted = !pose && !running && postureHalted(s);
  const poseNow: PoseKey | null = pose?.k ?? running, shifting = !!poseNow || posture === 'TRANSITIONING' || s?.action_result?.status === 'RUNNING';
  // 서 있을 때만 이동(자세 보고가 없는 옛 에이전트는 그대로). 엎드림·자세 모름·자세 바꾸는 중에는 이동 단추·키 잠금 — STOP 은 따로라 늘 살아 있다
  // off = 로봇 연결 끊김(서버 목록 허용 꺼짐 — 보통 AGENT_OFFLINE · 시뮬은 목록 연결 끊김, 또는 state OFFLINE). 어느 쪽이 먼저 와도 이동 잠금(RB-PC-DRIVE-OFFLINE-FIX)
  const off = !linked(r) || (!!s && s.connection !== 'ONLINE');
  // 끊김을 본 뒤 «조종 시작»을 새로 누르기 전 = 그 전에 보낸 조종권 요청은 무효. 늦게 승인이 와도 바로 반납·이동 잠금(RB-PC-DRIVE-OFFLINE-FIX2)
  const stale = useRef(false); if (off) stale.current = true;
  const ready = !off && !stale.current && mine && link === 'open' && s?.connection === 'ONLINE' && s.latched === false && !l.busy && !shifting && (posture == null || posture === 'STANDING');
  const readyRef = useRef(ready); readyRef.current = ready;
  const sync = () => g.sync(r.id, [settingsRef.current, readyRef.current]);
  /** 지금 세대에 누른 것. 앞 세대에 누른 키·단추가 아직 눌려 있으면 null(→ 0) */
  const pressed = (): Set<Tok> | null => {
    const n = sync(), out = new Set<Tok>();
    for (const [c, x] of keys.current) { if (x !== n) return null; out.add(KEY[keyCode(c)]); }
    for (const p of pads.current.values()) { if (p.n !== n) return null; p.t.forEach((t) => out.add(t)); }
    return out;
  };
  /** 틱과 즉시 전송이 같이 쓰는 한 길: 명령 공백(GAP_MS) 검사로 세대를 맞춘 뒤 보낸다(RV-426 ③) */
  const send = () => {
    g.tick(r.id);
    const t = pressed(), cmd = t && readyRef.current && gotRef.current && isSettings(settingsRef.current) ? command(t) : TABLE[''];
    const [vx, vy, wz] = permitted(cmd, settingsRef.current) ? cmd : TABLE['']; rt.cmd(r.id, [vx, wz], vy, !t);
  };
  /** 누름이 바뀜: 그리고 바로 한 번 보낸다(뗀 그 자리에서 0) */
  const changed = () => { setOn(id(pressed() ?? [])); if (rt.get(r.id).lease) send(); };
  /** 0 으로: 입력 세대를 올려 지금 누른 것을 모두 앞 세대로 — 떼고 새로 눌러야 움직인다. 바로 보낸다 + 안내 */
  const zero = useRef((note = '') => { g.bump(); changed(); if (note) setWhy(note); }).current;
  /** 누른 순간의 세대 — 공백 검사를 먼저(공백 뒤 새 누름은 새 세대) */
  const now = () => { g.tick(r.id); return sync(); };
  // 잠긴 동안·상한 밖 단추도 키처럼 누른 세대를 적는다(RV-426 ④) — 명령은 ready·permitted 일 때만 나간다
  const press = (e: PointerEvent<HTMLButtonElement>, t: Tok[]) => {
    e.currentTarget.setPointerCapture?.(e.pointerId); pads.current.set(e.pointerId, { n: now(), t, el: e.currentTarget });
    if (readyRef.current && permitted(command(t), settingsRef.current)) setWhy(''); changed();
  };
  const lift = (p: number) => { if (pads.current.delete(p)) changed(); };
  /** 손잡이(시안 u4 조이스틱): 끄는 동안 방향이 바뀌면 같은 누름 세대로 바꾸고, 빈 방향이면 놓음 */
  const stick = (p: number, el: HTMLElement, t: Tok[]) => {
    const was = pads.current.get(p);
    if (!t.length) return lift(p);
    if (was && id(was.t) === id(t)) return;
    pads.current.set(p, { n: was ? was.n : now(), t, el });
    const q = pressed();   // 키와 같은 까닭 한 줄(손잡이 옆걸음 · 상한 · 표 밖 조합)
    if (readyRef.current && q && unknownCombo(q)) setWhy(COMBO_BLOCK);
    else if (readyRef.current && q && !permitted(command(q), settingsRef.current)) setWhy(command(q)[1] ? SIDE_BLOCK : '조직 속도 상한을 넘는 명령입니다.');
    else if (readyRef.current) setWhy('');
    changed();
  };
  /** 누른 단추가 사라짐(작게 보기·전체화면 전환 등 — 놓음을 못 받음): 그 포인터를 지우고 세대 +1(RV-426 ⑥) */
  const gone = (el: HTMLElement) => { let hit = false; for (const [p, x] of pads.current) if (x.el === el) { pads.current.delete(p); hit = true; } if (hit) zero(); };

  useEffect(() => { setGot(false); const stop = new AbortController(); api.settings(stop.signal).then((o) => { if (isSettings(o)) { simTune(o); setGot(true); } }, () => {}); return () => stop.abort(); }, [r.id]);
  useEffect(() => { if (keys.current.size || pads.current.size) zero('조직 속도 설정이 바뀌어 입력을 0으로 보냈습니다. 다시 누르세요.'); }, [settings]);
  useEffect(() => rt.watch(r.id), [r.id]);   // 이 패널이 열린 동안만 조종권을 쥔다(닫으면 반납 — rt)
  useEffect(() => { const i = setInterval(() => tick((n) => n + 1), 250); return () => clearInterval(i); }, []);   // 마지막 응답 ms·신호 멈춤
  // 50 ms 마다(0 포함 — 조종권 심장 박동 겸). 잠금·넘김 중 0 과 새 중립은 rt.cmd 가 지킨다
  useEffect(() => {
    if (!mine) return;
    const i = setInterval(send, CMD_MS);
    return () => clearInterval(i);
  }, [mine, r.id]);
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code === 'Escape') return esc?.current();
      if (metaCut(e)) return cut();   // Cmd 동안은 keyup 이 안 올 수 있다 — 적은 키를 지우고 세대 +1(RV-429 ③)
      const t = KEY[keyCode(e.code)], k = keys.current;
      // 글 입력 중·반복(e.repeat)은 새 누름이 아니다 — 모르는 키면 앞 세대로 적어 뗄 때까지 0
      if (typing(e.target) || e.repeat) { if (t && !k.has(e.code)) { k.set(e.code, -1); changed(); } return; }
      const gk = gaitKey(e); if (gk) { e.preventDefault(); (gaitAsk.current ?? gaitRef.current)(gk); return; }   // Shift+1~4 걷기 모드 · 이동 키가 아님(입력칸 · 반복은 위에서 거름)
      if (e.code === 'Space') return zero(SD_NOTE.stop);   // STOP 은 App 머리줄이 보낸다 — 여기는 입력만 먼저 0
      if (!t) return;
      if (!e.ctrlKey && !e.altKey) e.preventDefault();   // Ctrl·Alt 조합도 같은 누름으로 적는다(브라우저 단축키는 막지 않음)
      k.set(e.code, now());   // 잠긴 동안 누른 것도 적는다 — 해제(ready)되면 세대가 올라 앞 세대가 된다
      const p = pressed();
      if (readyRef.current && p && unknownCombo(p)) { changed(); setWhy(COMBO_BLOCK); return; }
      if (readyRef.current && p && !permitted(command(p), settingsRef.current)) { changed(); setWhy(command(p)[1] ? SIDE_BLOCK : '조직 속도 상한을 넘는 명령입니다.'); return; }
      if (readyRef.current) setWhy(''); changed();
    };
    const up = (e: KeyboardEvent) => { if (metaCut(e)) cut(); else if (keys.current.delete(e.code)) changed(); };
    const cut = () => { if (keys.current.size) { keys.current.clear(); zero(); } };
    // 창 밖에서 뗀 키는 keyup 이 안 온다 — 적은 키를 모두 지우고 세대 +1(앞 세대는 이미 무시되므로 지워도 안전, RV-426 ⑦)
    const blur = () => { keys.current.clear(); zero(SD_NOTE.blur); };
    const hide = () => { if (document.visibilityState === 'hidden') { keys.current.clear(); zero(SD_NOTE.hidden); } };
    // 포인터 놓음은 창 전체에서도 받는다(단추가 사라져 캡처를 잃어도 — RV-426 ⑥)
    const pup = (e: Event) => lift((e as globalThis.PointerEvent).pointerId);
    addEventListener('keydown', down, true); addEventListener('keyup', up, true); addEventListener('blur', blur); document.addEventListener('visibilitychange', hide);
    addEventListener('pointerup', pup, true); addEventListener('pointercancel', pup, true);
    return () => {
      removeEventListener('keydown', down, true); removeEventListener('keyup', up, true); removeEventListener('blur', blur); document.removeEventListener('visibilitychange', hide);
      removeEventListener('pointerup', pup, true); removeEventListener('pointercancel', pup, true);
      zero();
    };
  }, []);
  useEffect(() => { if (!ready) zero(); }, [ready]);   // 움직일 수 없게 되면 누른 것을 버린다(자동 재개 없음)
  // 끊기면 0 을 보내고 조종권을 돌려준다 — 다시 연결돼도 «조종 시작»을 다시 누르고 새로 눌러야 움직인다(화면 안내와 같게)
  useEffect(() => { if (mine && (off || stale.current)) { zero(); rt.release(r.id); } }, [off, mine]);
  useEffect(() => { if (link === 'lost' || link === 'denied') zero(SD_NOTE.link); }, [link]);
  useEffect(() => { if (l.stop) zero(SD_NOTE.stop); }, [l.stop?.n]);   // 머리줄 STOP·Space 도
  useEffect(() => { if (s?.latched !== true || !mine) setAsked(null); }, [s?.latched, mine]);   // 풀렸거나 조종권이 없으면 해제 대기 끝
  useEffect(() => { if (l.notice) setAsked(null); }, [l.notice]);
  useEffect(() => {
    if (!pose || !res || res.request_id === pose.prev || res.action !== POSE[pose.k].act || res.status === 'RUNNING') return;
    // 저수준: 실행기에 보냄은 자세 완료가 아니다 (전원 꺼도 된다고 쓰지 않음)
    if (res.status === 'SUCCEEDED' && res.code === 'RUNNER_SENT') { setPose(null); setPoseMsg('START 실행기에 보냈습니다. 현장에서 로봇을 확인하세요.'); return; }
    setPose(null); setPoseMsg(res.status === 'SUCCEEDED' ? POSE[pose.k].done : `${POSE[pose.k].fail} — ${poseWhy(res.code)}`);
  }, [pose, res?.request_id, res?.status]);
  useEffect(() => { if (!mine) setPose(null); }, [mine]);
  useEffect(() => { if (res?.status === 'RUNNING') setPoseMsg(''); }, [res?.request_id]);   // 새 동작이 시작되면 앞 결과 글은 지운다
  useEffect(() => {
    if (!pose) return;
    const t = setTimeout(() => { setPose(null); setPoseMsg(`${POSE[pose.k].fail} — ${POSE_LOST}`); }, POSE_WAIT_MS);
    return () => clearTimeout(t);
  }, [pose]);
  const askPose = (k: PoseKey) => { zero(); setPoseMsg(''); setPose({ k, prev: res?.request_id ?? null, at: rt.now() }); rt.posture(r.id, POSE[k].act, (bad) => { if (bad) { setPose(null); setPoseMsg(`${POSE[k].fail} — ${bad}`); } }); };   // 서버가 해제 요청을 거절(rt.unlock notice) — 대기 아님

  const stopPress = useStopPress(() => { zero(SD_NOTE.stop); rt.stop(r.id); });   // pointerdown 즉시(RV-456 1)
  const stop = (big: boolean) => <button type="button" className="fh-stop" aria-label="비상 정지 — 이 로봇" data-sd-stop={big ? 'full' : 'panel'}
    style={big ? { minHeight: 120, minWidth: 320 } : { minHeight: 56, width: '100%' }} {...stopPress}>
    <svg width="30" height="30" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 2h8l6 6v8l-6 6H8l-6-6V8z" fill="none" stroke="#FFFFFF" strokeWidth="2" /><rect x="8" y="8" width="8" height="8" fill="#FFFFFF" /></svg>
    <span className="fh-stop-t"><span>STOP</span><small>정지 요청</small></span>
  </button>;
  const pad = mine && <div role="group" aria-label="조종(누르는 동안만)" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6 }}>
    {PAD.map(([t, k, text]) => { const no = !ready || !permitted(command(t), settings); return <PadButton key={k} gone={gone} data-sd-move={id(t)} aria-pressed={on === id(t)} aria-disabled={no}
      style={{ minHeight: 48, ...(no && { opacity: .55, cursor: 'not-allowed' }) }}
      onPointerDown={(e: PointerEvent<HTMLButtonElement>) => press(e, t)}
      onPointerUp={(e) => lift(e.pointerId)} onPointerCancel={(e) => lift(e.pointerId)} onLostPointerCapture={(e) => lift(e.pointerId)}
      onContextMenu={(e) => e.preventDefault()}><b className="mono">{k}</b> {text}</PadButton>; })}
  </div>;
  const age = s ? Math.round(rt.now() - l.stateAt) : null, stalled = !!s?.latched && s.safety_reason === 'OUTPUT_STALLED';
  const sl = stopLine(l), stopNote = sl && <span role="status" data-sd-stop-phase data-tone={sl.tone}><Chip {...sl} /></span>;
  const refused = refusedText(s?.unlock_refused);
  const late = asked != null && rt.now() - asked >= UNLOCK_WAIT_MS;
  const unlock = mine && s?.latched && <div className="fh-row" style={{ flexWrap: 'wrap' }} data-sd-lock>
    <span>① 정지 확인 — 서버 보고 수평 속도 {s.speed != null ? `${s.speed.toFixed(1)} m/s` : '모름'}</span>
    <span aria-hidden="true">→</span>
    <button type="button" className="btn pri" onClick={() => { setAsked(rt.now()); rt.unlock(r.id); }}>{asked != null ? '② 잠금 해제 다시' : '② 잠금 해제'}</button>
    {asked != null && <span role="status" data-sd-unlock={late ? 'unconfirmed' : 'wait'} className={late ? 'fh-msg' : 'lbl'} style={{ flexBasis: '100%' }}>
      {late ? `미확인 — 로봇이 정지 확인을 못 해 잠금이 그대로입니다. ${refused || '로봇이 완전히 멈췄는지(수직 흔들림 포함) 현장에서 확인한 뒤 다시 누르세요.'}`
        : `해제 대기 — 로봇이 정지를 확인하면 풀립니다.${refused ? ` ${refused}` : ''}`}</span>}
  </div>;
  const lock = !s || s.connection !== 'ONLINE' ? { tone: 'off' as const, text: '상태 모름' } : s.latched !== false ? { tone: 'bad' as const, text: '정지 잠금' }
    : !mine ? { tone: 'off' as const, text: '보는 중' } : posture === 'LYING' ? { tone: 'warn' as const, text: '엎드려 있음' } : halted ? { tone: 'warn' as const, text: '자세 멈춤' } : shifting ? { tone: 'warn' as const, text: '자세 바꾸는 중' }
    : posture === 'UNKNOWN' ? { tone: 'off' as const, text: '자세 모름' } : l.neutral ? { tone: 'ok' as const, text: '움직일 수 있음' } : { tone: 'warn' as const, text: '중립 확인 중' };
  const status = <div className="fh-row lbl mono" style={{ flexWrap: 'wrap', gap: 10 }} data-sd-status>
    <span>배터리 {s?.battery?.soc != null ? `${s.battery.soc}%` : '—'}</span>
    <span>수평 속도 {s?.speed != null ? `${s.speed.toFixed(1)} m/s` : '—'}</span>
    <span>잠금 {s?.latched == null ? '모름' : s.latched ? '잠김' : '풀림'}</span>
    <span>마지막 응답 {age != null ? `${age} ms 전` : '없음'}</span>
  </div>;
  const connection = rt.link();
  const freshState = rt.now()-l.stateAt < 3000 ? s : null;
  const latency = <ResponseLine state={freshState} screenMs={link === 'open' && connection.latencyAt != null && rt.now()-connection.latencyAt < 3000 ? connection.latencyMs ?? null : null} />;
  const notes = <><DriveInputNote devices={freshState?.devices} /><SlowResponse health={freshState?.connection === 'ONLINE' ? freshState.response_health : null} />{posture === 'LYING' && <p className="dv-note" role="status" data-sd-lying>{mine ? LYING_TEXT : '로봇이 엎드려 있습니다. [조종 시작] 뒤 «일어서기»를 누르면 걸을 수 있습니다.'}</p>}
    {posture === 'UNKNOWN' && mine && <p className="dv-note" role="status" data-sd-pose-unknown>로봇 자세를 아직 알 수 없어 이동 단추를 잠갔습니다. 현장에서 로봇을 확인한 뒤 «일어서기»를 누르세요.</p>}
    {ready && !(got && isSettings(settings)) && <p className="dv-note" role="status" data-real-wait>{REAL_WAIT}</p>}
    {why && <p className="dv-note" role="status" data-sd-why>{why}</p>}
    {l.notice && <p className="dv-note" role="status">{l.notice}</p>}
    {stalled && <p className="dv-note" role="status">{STALLED}</p>}</>;
  const wait = link !== 'open' ? '서버 연결이 끊겨 조종할 수 없습니다. 다시 연결되면 누르세요.'
    : l.releasing ? '조종권 반납을 확인하는 중입니다.'
    : l.busy ? '로봇 정지를 확인한 뒤 조종권을 받습니다.'
    : l.outgoing ? `${l.holder?.name || '조종하는 사람'}님에게 조종권을 요청했습니다.`
    : l.cooldown > rt.now() ? '잠시 뒤 다시 요청할 수 있습니다.'
    : l.holder?.type === 'RUN' ? '시나리오 실행 중에는 이 시험 화면에서 조종을 시작하지 않습니다.' : '';
  // 조종 시작/끝내기 — 조각으로 돌려주고 붙이는 쪽이 배치(같은 단추를 두 번 그리지 않게). 권한·기다릴 이유는 DriveButton 이 글로
  const hint = <span className="lbl fh-grow">W·↑ / S·↓ 앞뒤 1.5 m/s · ← / → 옆걸음 1.0 m/s · A / D 제자리 회전 최대 {MAX_TURN_RATE} rad/s · Space 정지 · {GAIT_KEYS}. 누르고 있으면 2초에 걸쳐 최고 속도까지 올라가고, 떼면 바로(약 0.3초) 멈춥니다. ↑+A/D로 전진하며 회전합니다. 다른 조합을 누르면 입력은 0입니다. 조직 상한을 넘는 단추는 비활성입니다.</span>;
  const end = <button type="button" className="btn" onClick={() => { zero(); rt.release(r.id); }}>조종 끝내기</button>;
  const take = () => { setWhy(''); stale.current = false; if (l.holder?.type === 'USER') rt.request(r.id); else rt.take(r.id); };
  const begin = <DriveButton c={c} r={r} label="조종 시작" wait={wait} onClick={take} />;
  const poseRow = mine && <div className="fh-row" role="group" aria-label="로봇 자세" style={{ flexWrap: 'wrap' }} data-sd-posture>
    {(['up', 'down'] as const).map((k) => <button key={k} type="button" className="btn" data-sd-pose={k} disabled={shifting || link !== 'open' || s?.connection !== 'ONLINE' || k === 'up' && s?.control === 'LOWLEVEL'}
      onClick={() => askPose(k)}>{POSE[k].name}</button>)}
    <span className="lbl">{POWER_HINT}</span>
    {(shifting || poseMsg || lost) && <span role="status" className="lbl" style={{ flexBasis: '100%' }} data-sd-pose-msg data-sd-pose-halted={halted ? '' : undefined}>{poseNow ? POSE[poseNow].doing : halted ? POSTURE_HALTED : shifting ? '자세를 바꾸는 중…' : poseMsg || lost}</span>}
  </div>;
  const trial = <ActionTrial robot={r} allowed={!!r.serverDrive && !r.sim} beforeSend={zero} />;
  const releasing = l.releasing?.why && <div className="fh-row" role="status"><span className="fh-why">조종권 반납을 확인하지 못했습니다. {l.releasing.why}</span>
    <button type="button" className="btn" onClick={() => rt.release(r.id)}>다시 시도</button></div>;
  return { gaitAsk, l, s, mine, off, link, posture, shifting, stalled, refused, age, lock, zero, stop, stopNote, unlock, pad, status, latency, notes, hint, end, begin, poseRow, gaitRow: gait.row, trial, releasing,
    take, takeWhy: driveBlock(c.user, r) ?? (wait || ''), stick, stopPress, why, on, ready, askPose, poseNow, poseMsg: poseMsg || lost, gait,
    unlockAsk: () => { setAsked(rt.now()); rt.unlock(r.id); }, unlockState: asked == null ? null : late ? 'unconfirmed' as const : 'wait' as const, stopLine: sl };
}

/** 화면 이동 단추 — 사라질 때(unmount) gone 으로 알린다. 잠긴 동안에도 누름을 받아야 해서 disabled 대신 aria-disabled(누른 세대만 적고 명령은 0) */
function PadButton({ gone, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { gone: (el: HTMLElement) => void }) {
  const el = useRef<HTMLButtonElement>(null), cb = useRef(gone); cb.current = gone;
  useEffect(() => { const b = el.current; return () => { if (b) cb.current(b); }; }, []);
  return <button ref={el} type="button" className="btn" {...p} />;
}

/** inline = 작은 패널에도 조작부를 둔다(지도 만들기 창 — 실시간 지도를 보면서 바로 조종, 11-13) */
export function ServerDrive({ c, r, inline }: { c: Pick<Ctx, 'user'>; r: Robot; inline?: boolean }) {
  const [full, setFull] = useState<Big | null>(null), dlg = useRef<HTMLDivElement>(null), opener = useRef<HTMLElement | null>(null);
  const feeds: Record<DriveCh, DriveFeed> = { rgb: useDriveFeed(r.id, 'rgb'), lidar: useDriveFeed(r.id, 'lidar'), depth: useDriveFeed(r.id, 'depth', full === 'depth') };   // 뎁스는 고른 동안만 연다
  /** 전체화면 닫기는 이것 하나(Esc·작게 보기): 눌린 이동 키를 버리고 바로 0 을 보낸 뒤 닫는다(#214 r1) */
  const fullRef = useRef(full); fullRef.current = full;
  const esc = useRef(() => {});
  const d = useServerDrive(c, r, esc), { mine, lock, stop, stopNote, unlock, pad, status, latency, notes } = d;
  const closeFull = esc.current = () => { if (!fullRef.current) return; d.zero(); setFull(null); };
  // 전체화면 = 모달: 열 때 «작게 보기»로 초점, 밖은 inert, 닫을 때 연 칸으로 초점 복귀
  useEffect(() => {
    if (!full || !dlg.current) return;
    const back = opener.current, undo = inertOutside(dlg.current);
    dlg.current.querySelector<HTMLElement>('[data-sd-small]')?.focus();
    return () => { undo(); back?.focus(); };
  }, [!!full]);

  const go2 = go2Pose(d.s, !!d.s && rt.now() - d.l.stateAt < REPORT_STALE_MS);   // 3D 속 Go2 관절각(없거나 오래되면 null = 선 자세)
  const view = (ch: Big, big: boolean) => (ch === 'box' ? <DriveView f={feeds.lidar} ch="lidar" big={big} look="boxes" go2={go2} /> : <DriveView f={feeds[ch]} ch={ch} big={big} go2={go2} />);
  const box = (children: ReactNode, h?: number) => <div style={{ position: 'relative', flex: 1, minHeight: h, background: '#070A0C', borderRadius: 8, overflow: 'hidden' }}>{children}</div>;
  const open = (ch: Big) => (e: { currentTarget: HTMLElement }) => { opener.current = e.currentTarget; setFull(ch); };
  // 조종 시작/끝내기 한 줄 — 작은 패널과 조종 화면 중 보이는 쪽 하나에만(같은 id 두 번 없게)
  const control = <>
    {mine ? <div className="fh-row">{d.hint}{d.end}</div> : d.begin}
    {d.poseRow}
    {d.gaitRow}
    {d.trial}
    {d.releasing}
  </>;

  // 상세 서랍 안은 작게: 상태·STOP·정지 단계·잠금 해제·조종 시작/끝내기 + «조종 화면 열기». 영상·라이다·조작부·상태줄은 조종 화면(전체화면 모달, #214)에서
  return <section className="card" aria-label="서버 경유 시험 조종" data-server-drive style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 10, borderColor: 'var(--warn)' }}>
    <div className="fh-row" style={{ flexWrap: 'wrap' }}><Chip tone="warn" text={TRIAL} /><Chip {...lock} /></div>
    {!full && latency}
    {stop(false)}
    {stopNote}
    {unlock}
    {!full && inline && pad}
    {!full && control}
    <button type="button" className="btn pri" data-sd-open onClick={open((feeds.lidar.frame as string) === 'odom' ? 'lidar' : 'rgb')}>조종 화면 열기 — 카메라·라이다·조작부</button>
    {notes}
    {full && <div role="dialog" aria-modal="true" aria-label={`${BIG_NAME[full]} 전체화면`} data-sd-full ref={dlg} onKeyDown={trapTab}
      style={{ position: 'fixed', inset: 0, zIndex: 1000, display: 'flex', flexDirection: 'column', gap: 8, padding: 12, background: 'var(--bg)', overflow: 'hidden' }}>
      {/* 머리줄(STOP)은 스크롤하지 않음 — 아래 본문만 스크롤해 어떤 스크롤 위치·상태(잠금 해제 미확인 포함)에서도 STOP 이 보이고 눌림(#216 B1) */}
      <div className="fh-row" style={{ flexWrap: 'wrap', alignItems: 'center', flex: 'none' }} data-sd-full-head>
        <Chip tone="warn" text={TRIAL} /><Chip {...lock} />{status}<span className="fh-grow" style={{ flex: 1 }} />
        <button type="button" className="btn" data-sd-small onClick={closeFull}>작게 보기(Esc)</button>{stop(true)}
      </div>
      {latency}
      <div data-sd-full-body style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
      {(stopNote || unlock) && <div className="fh-row" style={{ flexWrap: 'wrap', justifyContent: 'flex-end' }} data-sd-full-state>{stopNote}{unlock}</div>}
      <div className="fh-row" role="group" aria-label="보기">{(['rgb', 'lidar', 'box', 'depth'] as const).map((ch) =>
        <button key={ch} type="button" className="btn" aria-pressed={full === ch} data-sd-ch={ch} onClick={() => setFull(ch)}>{BIG_NAME[ch]}</button>)}</div>
      {box(view(full, true), 200)}{/* 영상을 눌러도 닫지 않는다(11-11 — 키보드 조종 중 창을 눌러 초점을 되찾다 닫히고 멈추는 일 방지). 닫기는 «작게 보기»·Esc */}
      {notes}
      {pad}
      {control}
      </div>
    </div>}
  </section>;
}

/** 카메라·라이다·뎁스 한 칸 그림(받은 feed 그대로 — 없으면 «…신호 없음» + 까닭, 받았던 그림은 끊겨도 흐리게 남기고 «마지막 그림 · N초 전»). 패널 전체화면과 세 칸 화면 가운데 칸이 같이 쓴다.
 *  look·go2 = 3D 점/상자·Go2 관절각(RB-UNITREE-LOOK-FIX). 11-25 RB-SLAM-WEB2: «로봇 지도»(Unitree 내장 지도) 고르기는 없앰 — 지도는 지도 탭 «지도 만들기» */
export function DriveView({ f, ch, big, look, go2 }: { f: DriveFeed; ch: DriveCh; big: boolean; look?: Look; go2?: Pose }) {
  const text = driveFeedText(f, ch), held = driveFeedHeld(f), pic = !text || !!held, dim = held ? 0.55 : undefined;
  if (ch === 'lidar') return <LidarMap small={!big} feed={f} empty={text} look={look} go2={go2} />;
  if (ch === 'depth') return !pic || !f.range ? <div className="dv-video" role="img" aria-label="뎁스 카메라" data-sd-depth><span style={{ padding: 12, textAlign: 'center' }}>{text}<br />{DEPTH_HINT}</span></div>
    : <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column' }}>
      <img src={f.img} alt={`뎁스 카메라${held ? '(마지막 그림)' : ''} — 가까움 빨강, 멀리 파랑, 검정은 거리 모름`} draggable={false} style={{ flex: 1, minHeight: 0, width: '100%', objectFit: 'contain', opacity: dim }} data-sd-depth />
      <DepthLegend range={f.range} /><HeldTag text={held} /></div>;
  return !pic ? <div className="dv-video" role="img" aria-label="카메라" data-sd-cam><span>{text}</span></div>
    : <><img className="dv-video" src={f.img} alt={held ? '카메라(마지막 그림)' : '카메라'} draggable={false} style={{ width: '100%', height: '100%', objectFit: 'contain', opacity: dim }} data-sd-cam /><HeldTag text={held} /></>;
}
