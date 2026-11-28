// 폰 조종(09 ADR-002 §3 — 02 기능 F-TO-01~05, 03 UX §5.7): 로봇 연결 → 조종(가로, 카메라 전체·양쪽 조이스틱·아래 줄 시트).
// 조종권·잠금·STOP 은 실시간 연결(rt.ts → 관제 서버)만 부른다 — 판정은 서버 중재기. 시뮬 로봇은 폰 ↔ 에이전트 직결(phone.ts·simdrive.tsx).
// 영상·지도·시나리오 제어는 자리만(가짜). 키보드(한 배치 · 11-28 17:25): W·↑ 전진, ← / → 옆걸음(조직 옆 상한이 허락할 때), A / D 회전, S·↓ 후진(조직 뒤 상한이 허락할 때 · 손잡이와 같은 규칙). Space = STOP 은 App 공통 층(모든 화면).
import { useEffect, useRef, useState, type CSSProperties, type MouseEvent, type PointerEvent, type ReactNode } from 'react';
import { ADMIN_LATER, ROLE_NAME, driveBlock, robotStatus, type Holder, type Robot, type Role, type Tone } from './fake';
import { CMD_MS, inputGen, metaCut, rt, useLive, useRt, type Live } from './rt';
import { PHONE_SHEETS, type SheetId } from './menu';
import { FallChip } from './go2status';
import { DriveInputNote } from './driveinput';
import { Chip, Scenario, inApp, type Ctx } from './screens';
import { Nearby } from './nearby';
import { AddRobot, ManageRobot } from './pairing';
import { NoRobot } from './screens/norobot';
import { TakeoverAsk } from './screens/takeover';
import { useTheme } from './theme';
import { simTune, useSim, useTuneSettings } from './phone';
import { COMBO_BLOCK, command, isSettings, permitted, REAL_WAIT, SIDE_BLOCK, TABLE, unknownCombo, type Tok } from './serverdrive';
import { ACTS, RESTART_ASK, RESTART_TEXT, actOff, actWhy, stickTok } from './robotact';
import { actionResultText } from './screens/actiontrial';
import { api } from './api';
import { STALLED, SimLaunch, field } from './simdrive';
import { GAITS, GAIT_KEYS, gaitKey, useGait } from './gait';
import './drive.css';
import './proto/ui.pv.css';
import './proto/light.pv.css';
import './screens/u1d.css';
import './screens/u1.app.css';
import { askShown } from './proto/u11';
import { keyCode } from './padkeys';

/** 남은 시간을 그리려고 on 인 동안 0.2 s 마다 다시 그림. 시각은 단조 시계 */
function useNow(on: boolean) {
  const [, tick] = useState(0);
  useEffect(() => { if (!on) return; const i = setInterval(() => tick((n) => n + 1), 200); return () => clearInterval(i); }, [on]);
  return rt.now();
}
const secs = (until: number, now: number) => Math.max(0, Math.ceil((until - now) / 1000));
const pct = (b: number | null) => (b == null ? '' : `${b}%`);
const clamp = (v: number) => Math.max(-1, Math.min(1, v));
/** 조직 속도 상한 밖 명령(손잡이 · 키) 까닭 한 줄 · PC 서버 경유 조종(serverdrive)과 같은 글 */
export const CAP_BLOCK = '조직 속도 상한을 넘는 명령입니다.';
/** 조종권 요청 창 단추는 마우스·터치로만(F-TO-04 규칙 4): 키보드로 생긴 click 은 detail 0 */
const pointerOnly = (f: () => void) => (e: MouseEvent) => { if (e.detail > 0) f(); };

function who(h: Holder | null, me: string) {
  if (!h) return '조종하는 사람 없음';
  if (h.type === 'RUN') return '시나리오 실행 중';
  return h.id === me ? '다른 창에서 조종 중(나)' : `${h.name}님 조종 중`;
}
/** 구독 안 하는 로봇은 목록 요약의 조종권자 + 받은 시각. 목록의 null 은 «없음»으로 단정하지 않는다(서버 목록 lease 가 아직 늘 null) */
export function holderText(l: Live, me: string, r: Robot) {
  if (r.unknown === 'summary') return r.holder ? `${who(r.holder, me)}(목록 ${r.listedAt})` : '조종권자 확인 안 됨';
  if (l.lease) return '조종 중(나)';
  if (l.releasing) return '이 창 — 반납 확인 중';
  if (l.busy) return '조종권 넘기는 중';
  if (r.unknown && !l.holder) return '조종권자 확인 안 됨';   // 연결 끊김(4403 포함)·첫 state 전: 비어 있는지 모름
  return who(l.holder, me);
}
function lockChip(l: Live, r: Robot): { tone: Tone; text: string } {
  if (r.unknown === 'summary') return { tone: 'off', text: '확인 안 됨' };
  if (l.failed) return { tone: 'bad', text: '정지 확인 실패' };
  if (l.busy) return { tone: 'warn', text: '정지 확인 중' };
  if (!l.state || l.state.connection !== 'ONLINE') return { tone: 'off', text: '상태 모름' };
  if (l.state.latched !== false) return { tone: 'bad', text: '정지 잠금' };
  if (!l.lease) return { tone: 'off', text: '보는 중' };
  return l.neutral ? { tone: 'ok', text: '움직일 수 있음' } : { tone: 'warn', text: '중립 확인 중' };
}
const BUSY_TEXT = { take: '로봇 정지를 확인한 뒤 조종권을 받습니다.', give: '조종권을 넘기는 중입니다. 로봇 정지를 확인하고 있습니다.' };

/** 끝내기(머리줄·조종 판 같은 길): 입력 0 → 조종권 반납(확인은 rt releasing, 확인되면 App 이 로봇 연결로). 조종권이 없으면 바로 로봇 연결 */
export function endDrive(id: string, go: Ctx['go']) {
  const l = rt.get(id);
  if (l.releasing) return;
  rt.cmd(id, [0, 0]);
  if (l.lease) rt.release(id); else go('drive');
}
/** 실기 조종 안내: 비례가 아니라 켜짐/꺼짐 */
export const REAL_STICK = '실기는 손잡이를 30 % 넘게 밀면 정해진 속도로 움직입니다. 한 손잡이는 큰 쪽 한 방향만 보냅니다.';
export { REAL_WAIT };
const RELEASING = '조종권 반납을 확인하는 중입니다. 확인되면 다시 누르세요.';

export function Drive(c: Ctx) {
  return c.open ? <Screen {...c} /> : <Connect {...c} />;
}

/** 로봇 연결(ADR-002 §3.2): 위 = 내 로봇 목록 → [연결](조종 화면), 못 하면 [보기만] + 이유. 아래 = 시뮬 로봇 띄우기(simdrive.tsx — 직결)
 *  «+ 로봇 연결하기»: 연결된 실기가 없으면 목록 위에 크게, 있으면 목록 아래 작게 → 앱 안은 고르기: «새 로봇 추가»(운영 관리자 — pairing.tsx, ROBOT-PAIRING) · «주변 로봇 찾기»(nearby.tsx).
 *  앱 밖은 고를 것이 «새 로봇 추가»뿐(단추도 운영 관리자만)이라 메뉴 없이 바로 새 로봇 추가(RB-EASY-PAIR).
 *  총괄도 로봇을 붙인다(11/28 · 서버 #544). 내가 담당인 실기 카드에는 «관리», 총괄이 보는 남 담당 실기는 2 차 전이라 까닭 한 줄 */
export function Connect(c: Pick<Ctx, 'user' | 'robots' | 'go'> & Partial<Pick<Ctx, 'refresh' | 'cancel' | 'phone'>>) {
  useRt();
  const s = useSim(), light = useTheme()[1];
  const [view, setView] = useState<'menu' | 'pair' | 'nearby' | null>(null), app = inApp();   // 운영 관리자 · 총괄 모두 붙임(11/28)
  const [simWant, setSimWant] = useState(false);   // 로봇 없음 화면(u13_4)의 «시뮬 로봇 띄우기» → 아래 시뮬 띄우기 칸
  const live = c.robots.some((r) => !r.sim && (r.online || !!r.unknown));   // 상태 모름(실시간 끊김·첫 상태 전)은 «연결 없음»으로 단정하지 않는다 — 깜빡임 방지
  const add = (pri: boolean) => <button type="button" className={`btn${pri ? ' pri' : ''}`} onClick={() => setView(app ? 'menu' : 'pair')} data-robot-connect>+ 로봇 연결하기</button>;
  const refresh = c.refresh ?? (() => {});
  // 폰 · 로봇 0대 · 시뮬도 고르기 단계에 아무것도 없으면 시안 u13_4. 시뮬을 띄우는 중 · 띄운 시뮬 · 정리할 자리가 있으면 그 칸이 보이는 옛 배치
  const bare = !!c.phone && !c.robots.length && view === null && !simWant && !s.real && s.step === 'pick' && !s.mine.length && !s.cleanup.length;
  if (bare) return <NoRobot role={c.user.role} light={light} add={() => setView(app ? 'menu' : 'pair')} sim={() => setSimWant(true)} />;
  return <>
    {view === 'nearby' || (s.real && s.step !== 'drive') ? <Nearby robots={c.robots} close={() => setView(null)} />
      : view === 'pair' ? <AddRobot user={c.user} mine={c.robots.map((r) => r.id)} close={() => setView(null)} refresh={refresh} cancel={c.cancel} />
      : view === 'menu' ? <section className="lv-card" style={{ flexBasis: '100%' }} aria-label="로봇 연결하기">
        <div className="fh-row"><h2 className="fh-grow">로봇 연결하기</h2><button type="button" className="btn" onClick={() => setView(null)}>닫기</button></div>
        <button type="button" className="btn pri" onClick={() => setView('pair')} data-pair-start>새 로봇 추가</button>
        <span className="lbl">노트북 화면의 QR 또는 6자리 코드로 등록합니다. 다시 설치한 로봇도 여기서 다시 연결합니다.</span>
        {app ? <button type="button" className="btn" onClick={() => setView('nearby')}>주변 로봇 찾기</button>
          : <p className="lv-note" data-robot-connect-note>주변 로봇 찾기(Wi-Fi·블루투스)는 FOOTHOLD Android 앱에서만 됩니다 — 브라우저는 블루투스·같은 망 기기를 찾을 수 없습니다.</p>}
      </section>
      : <section className="lv-card" style={{ flexBasis: '100%' }} aria-label="내 로봇">
      <h2>내 로봇</h2>
      {/* 한 사실은 한 곳: 남 담당 실기 관리(2 차) 까닭은 카드마다가 아니라 목록 머리 아래 한 번 */}
      {c.user.role === 'ORG_ADMIN' && c.robots.some((r) => !r.sim && r.owner !== c.user.id) && <p className="lbl" data-admin-later>{ADMIN_LATER}</p>}
      {!live && add(true)}
      {c.robots.length ? <ul className="dv-cards">{c.robots.map((r) => <Card key={r.id} c={c} r={r} refresh={refresh} />)}</ul>
        : <p className="lv-note">{c.user.role === 'ORG_ADMIN' ? '로봇이 없습니다. «+ 로봇 연결하기»로 노트북 화면의 코드를 넣어 로봇을 등록하세요.' : NO_ROBOT}</p>}
      {live && add(false)}
    </section>}
    <SimLaunch me={c.user.id} />
  </>;
}
/** 담당 로봇 0대 안내(운영 관리자) */
export const NO_ROBOT = '담당 로봇이 없습니다. «+ 로봇 연결하기»로 노트북 화면의 코드를 넣어 로봇을 등록하세요.';
function Card({ c, r, refresh }: { c: Pick<Ctx, 'user' | 'go' | 'cancel'>; r: Robot; refresh: () => void }) {
  const why = driveBlock(c.user, r), id = `why-${r.id}`, l = rt.get(r.id), rel = l.releasing, own = !r.sim && r.owner === c.user.id;
  const [manage, setManage] = useState(false);
  return <li className="card dv-card">
    <div className="fh-row"><b>{r.name}</b>{r.sim && <Chip tone="off" text="시뮬" />}<Chip {...robotStatus(r)} /><FallChip x={r} /><span className="mono">{pct(r.battery)}</span></div>
    <span className="lbl">{holderText(l, c.user.id, r)}</span>
    {rel && <div className="fh-row" role="status" data-releasing><span className="fh-why">{rel.why ? `조종권 반납을 확인하지 못했습니다. ${rel.why}` : RELEASING}</span>
      {rel.why && <button type="button" className="btn" onClick={() => rt.release(r.id)}>다시 시도</button>}</div>}
    {r.sim ? <span className="lbl" data-sim-card>시뮬 로봇은 아래 «시뮬 로봇 띄우기»에서 로봇에 직접 연결합니다.</span>   // 서버 경유 조종 화면으로 보내지 않는다
      : <><button type="button" className={`btn${why ? '' : ' pri'}`} aria-describedby={why ? id : undefined} onClick={() => c.go('drive', r.id)}>{why ? '보기만' : '연결'}</button>
        {why && <span id={id} className="fh-why" data-why>{why}</span>}</>}
    {/* 담당 실기의 관리 메뉴. 총괄이 보는 남 담당 실기는 서버 2 차 전이라 열지 않는다(까닭은 목록 머리 아래 한 번) */}
    {own && <>
      <details className="dv-fold" onToggle={(e) => setManage(e.currentTarget.open)}><summary className="btn">관리</summary>{manage && <ManageRobot r={r} refresh={refresh} cancel={c.cancel} />}</details></>}
  </li>;
}

/** 아래 줄 시트(조종 화면 위에 열림 — 화면은 그대로, STOP 이 있는 머리줄은 덮지 않음) */
export function Sheet({ title, close, children }: { title: string; close: () => void; children: ReactNode }) {
  return <section className="fh-sheet" role="dialog" aria-label={title} data-sheet>
    <div className="fh-row"><h2 className="fh-grow">{title}</h2><button type="button" className="btn" onClick={close}>닫기</button></div>
    {children}
  </section>;
}
const Later = ({ text }: { text: string }) => <p className="lv-note">준비 중입니다. {text}</p>;
const SHEET: Record<SheetId, (c: Ctx) => JSX.Element> = {
  scenario: (c) => <Scenario {...c} />,
  goal: () => <Later text="지도 위에 목표를 찍어 보내는 기능은 다음 단계에서 열립니다." />,
  policy: () => <p className="dv-note" data-gait-wait>조종 시작 뒤 걷기 모드를 바꿀 수 있습니다. {GAIT_KEYS}</p>,   // 조종 중이면 Screen 이 걷기 모드 칸을 그린다(u03)
};

/** 물리 키(e.code) → 방향. 누른 키는 e.code 마다 누른 순간의 입력 세대로 적는다(rt inputGen) */
export const KEY: Record<string, string> = { KeyW: 'f', ArrowUp: 'f', KeyS: 'b', ArrowDown: 'b', KeyA: 'l', KeyD: 'r', ArrowLeft: 'sl', ArrowRight: 'sr' };
const held = (keys: Map<string, number>, d: string) => [...keys.keys()].some((c) => KEY[keyCode(c)] === d);
/** 누른 키 → 서버 명령표 낱말. 표에 없는 조합이면 0 + COMBO_BLOCK · 상한 밖이면 0 + 까닭(손잡이와 같은 규칙) */
const TOK = { f: 'up', b: 'down', l: 'rotl', r: 'rotr', sl: 'left', sr: 'right' } as const;
const keyToks = (keys: Map<string, number>) => [...new Set([...keys.keys()].map((c) => TOK[KEY[keyCode(c)] as keyof typeof TOK]).filter(Boolean))];

/** F-TO-02~05: 조종 화면 */
function Screen(c: Ctx) {
  const r = c.robot, me = c.user.id, l = useLive(r.id), mine = !!l.lease, link = rt.link().at, real = !!r.serverDrive && !r.sim;
  const settings = useTuneSettings(), settingsRef = useRef(settings); settingsRef.current = settings;
  // got = 이 화면이 조직 설정을 받음. 받기 전(앞 화면이 남긴 값 포함)·못 받으면 실기 입력은 0 — 서버가 상한 밖이라 거절·STOP 하지 않게
  const [got, setGot] = useState(false), gotRef = useRef(got); gotRef.current = got;
  const [view, setView] = useState<'rgb' | 'depth' | 'map'>('rgb');
  const [ask, setAsk] = useState(false);   // 시나리오 일시정지 확인창(F-TO-03, 03 §2 U10)
  const [back, setBack] = useState(false), [side, setSide] = useState(false), [combo, setCombo] = useState(false);   // combo = 표에 없는 키 조합을 누르는 중   // side = 옆걸음 키를 누르는 중(막혔으면 까닭 한 줄)
  const [sheet, setSheet] = useState<SheetId | null>(null);   // 아래 줄 시트(조종권은 그대로, 입력은 0으로)
  const [chip, setChip] = useState(false), light = useTheme()[1];   // chip = 로봇 칩 펼침(시안 u1_10)
  // 「다시 시작」 확인 창: 연 때의 stop_gen · 조종권(lease)에 묶는다(reviewer H1). 잠금 풀림 · stop_gen 바뀜 · 조종권 바뀜이면 열림 자체를 닫고,
  // 「일어서기」 는 그때와 지금 stop_gen 이 같을 때만 unlock 을 보낸다 — 다른 곳에서 풀린 뒤 새 STOP 에 창이 저절로 다시 뜨지 않게
  const [restartAsk, setRestartAsk] = useState<{ gen: number | null | undefined; lease: string | null } | null>(null);
  const askLive = !!restartAsk && mine && l.state?.latched !== false && l.state?.stop_gen === restartAsk.gen && l.lease === restartAsk.lease;
  useEffect(() => { if (restartAsk && !askLive) setRestartAsk(null); }, [restartAsk, askLive]);
  const [actMsg, setActMsg] = useState(''), [pending, setPending] = useState<string | null>(null), tm = useRef(0);   // 동작 까닭 · 결과 한 줄(2.6 초) · 접수된 요청 id
  const say = (m: string) => { setActMsg(m); clearTimeout(tm.current); tm.current = window.setTimeout(() => setActMsg(''), 2600); };
  const res = l.state?.action_result;
  useEffect(() => { if (pending && res?.request_id === pending && res.status !== 'RUNNING') { say(actionResultText(res)); setPending(null); } }, [res?.request_id, res?.status]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => clearTimeout(tm.current), []);   // 「다시 시작」 확인 창(시안 u4_10 과 같은 글) · 일어서기만 잠금 해제를 보낸다
  // 입력 세대(rt inputGen): 키(e.code)·스틱 손가락마다 누른 순간의 세대. 잠김·해제·조종권·시트/⋯·blur/숨김·STOP·설정·ready 가 바뀌면 +1.
  // 앞 세대에 누른 키·손가락이 아직 눌려 있으면 명령 전체 0 — 떼었다가 다시 눌러야 한다. sg = 스틱마다 아직 닿은 손가락 중 가장 앞 세대(없으면 null)
  const [gen] = useState(inputGen);
  const input = useRef({ keys: new Map<string, number>(), st: [[], []] as Tok[][], sg: [null, null] as (number | null)[] });   // st = 손잡이마다 보내는 낱말(robotact stickTok)
  const readyRef = useRef(false);
  const sync = () => gen.sync(r.id, [settingsRef.current, readyRef.current]);
  /** 시트·⋯ 가 조이스틱을 가리면 입력을 0으로: 세대를 올려 바로 0을 보낸다 — 누르던 포인터·키는 떼고 새로 눌러야 쓴다 */
  const neutral = () => { gen.bump(); setBack(false); setSide(false); send(); };
  const pick = (s: SheetId | null) => { neutral(); setSheet(s); };
  const now = useNow(!!l.incoming || !!l.outgoing || l.cooldown > rt.now());
  useEffect(() => { askShown.add(r.id); return () => { askShown.delete(r.id); }; }, [r.id]);   // 이 화면이 요청 창을 그린다(PC 시안 틀의 PcAsk 는 비켜 줌)
  /** 지금 세대 입력만 → 명령표 낱말(키 + 두 손잡이). 앞 세대 입력이 남아 있으면 null(→ 0). 키 S · ↓ 는 down(뒤 상한 밖이면 0 + 까닭) */
  const toks = (): Tok[] | null => {
    const { keys: k, st, sg } = input.current, n = sync();
    if ([...k.values(), ...sg].some((x) => x != null && x !== n)) return null;
    return [...new Set<Tok>([...keyToks(k), ...st[0], ...st[1]])];
  };
  /** 손잡이 까닭 한 줄(PC 로봇 탭 useServerDrive stick 과 같은 순서): 표 밖 조합 · 옆 상한 · 그 밖 상한 */
  const [padWhy, setPadWhy] = useState('');
  const stickSay = () => {
    const t = toks();
    setPadWhy(!readyRef.current || !t || !(input.current.st[0].length || input.current.st[1].length) ? ''
      : unknownCombo(t) ? COMBO_BLOCK : !permitted(command(t), settingsRef.current) ? (command(t)[1] ? SIDE_BLOCK : CAP_BLOCK) : '');
  };

  /** 틱과 즉시 전송(놓음·blur·시트)이 같이 쓰는 한 길: 명령 공백(GAP_MS) 검사로 세대를 맞춘 뒤 보낸다(RV-426 ③⑨).
   *  이 화면은 실기만 연다(시뮬은 App 이 막고 simdrive 직결) — 비례는 없다. 서버 경유 확인 + 설정 받음 = 표 값, 그 밖(목록 갱신 전 등)은 0 */
  const send = () => {
    if (!rt.get(r.id).lease) return;
    gen.tick(r.id);
    const t = toks(), cmd = t && real && gotRef.current && isSettings(settingsRef.current) ? command(t) : TABLE[''];
    const [vx, vy, wz] = permitted(cmd, settingsRef.current) ? cmd : TABLE[''];   // 표 밖 · 조직 상한 밖이면 0
    rt.cmd(r.id, [vx, wz], vy, !t);
  };
  const sendRef = useRef(send); sendRef.current = send;
  /** 누른 순간의 세대 — 공백 검사를 먼저(공백 뒤 새 누름은 새 세대) */
  const now0 = () => { gen.tick(r.id); return sync(); };
  const nowRef = useRef(now0); nowRef.current = now0;
  // 걷기 모드(u03): 누른 키 · 스틱 손가락이 있거나 로봇이 0 아닌 명령을 적용 중이면 «움직이는 중» · 보내지 않고 까닭
  const gait = useGait(r.id, () => input.current.keys.size > 0 || input.current.sg.some((x) => x != null) || !!rt.get(r.id).state?.applied?.some((v) => v !== 0));
  const gaitRef = useRef(gait.press); gaitRef.current = gait.press;

  // 키보드(F-TO-05). 요청 창이 떠 있어도 방향키는 조종
  useEffect(() => {
    const keys = input.current.keys;
    const down = (e: KeyboardEvent) => {
      if (metaCut(e)) { if (keys.size) blur(); return; }   // Cmd 동안은 keyup 이 안 올 수 있다 — 적은 키를 지우고 세대 +1(RV-429 ③)
      const gk = gaitKey(e); if (gk) { if (!field(e.target) && !e.repeat) { e.preventDefault(); gaitRef.current(gk); } return; }   // Shift+1~4 걷기 모드 · 입력칸 초점이면 무시
      const k = KEY[keyCode(e.code)]; if (!k) return;
      if (field(e.target)) { if (!keys.has(e.code)) { keys.set(e.code, -1); sendRef.current(); } return; }   // 글 입력칸: 글자는 그대로, 조종은 아님. 뗄 때까지 앞 세대(0)
      if (!e.ctrlKey && !e.altKey) e.preventDefault();   // Ctrl·Alt 조합도 같은 누름으로 적는다(브라우저 단축키는 막지 않음)
      if (!e.repeat) keys.set(e.code, nowRef.current());
      else if (!keys.has(e.code)) keys.set(e.code, -1);   // 반복은 새 누름이 아니다 — 모르는 키면 앞 세대로 적어 뗄 때까지 0
      if (k === 'b') setBack(true);
      if (k === 'sl' || k === 'sr') setSide(true);
      setCombo(unknownCombo(keyToks(keys)));
    };
    const up = (e: KeyboardEvent) => {
      if (metaCut(e)) { if (keys.size) blur(); return; }
      const k = KEY[keyCode(e.code)]; if (k && keys.delete(e.code)) { if (k === 'b') setBack(held(keys, 'b')); setSide(held(keys, 'sl') || held(keys, 'sr')); setCombo(unknownCombo(keyToks(keys))); sendRef.current(); }   // 뗀 그 자리에서 한 번 보냄(RV-426 ⑨)
    };
    // 창 밖에서 뗀 키는 keyup 이 안 온다 — 적은 키를 모두 지우고 세대 +1, 바로 0(앞 세대는 이미 무시되므로 지워도 안전, RV-426 ⑦⑨)
    const blur = () => { keys.clear(); setBack(false); setSide(false); setCombo(false); gen.bump(); sendRef.current(); };
    const hide = () => { if (document.visibilityState === 'hidden') blur(); };
    addEventListener('keydown', down, true); addEventListener('keyup', up, true); addEventListener('blur', blur); document.addEventListener('visibilitychange', hide);
    return () => { removeEventListener('keydown', down, true); removeEventListener('keyup', up, true); removeEventListener('blur', blur); document.removeEventListener('visibilitychange', hide); };
  }, [r.id]);
  // 이 화면이 이 로봇을 연 동안만 조종권을 쥔다: 떠나면 반납, 숨기면 정지·잠금·반납(F-TO-03) — rt 가 처리
  useEffect(() => rt.watch(r.id), [r.id]);
  // 머리줄 ⋯ 메뉴(App 의 details)가 열려도 입력 0 — toggle 은 거품이 없어 잡기 단계로 받는다
  const neutralRef = useRef(neutral); neutralRef.current = neutral;
  useEffect(() => {
    const f = (e: Event) => { if ((e.target as HTMLDetailsElement).open) neutralRef.current(); };
    document.addEventListener('toggle', f, true); return () => document.removeEventListener('toggle', f, true);
  }, []);
  // 실기는 조직 속도 상한(서버와 같은 값)을 받아 permitted 로 거른다 — PC 조종(serverdrive)과 같은 길
  useEffect(() => {
    setGot(false); if (!real) return;   // got 과 함께 지금 공용 설정이 검증된 객체여야 받음(simTune(null) 로 비면 못 받음)
    const stop = new AbortController(); api.settings(stop.signal).then((o) => { if (isSettings(o)) { simTune(o); setGot(true); } }, () => {}); return () => stop.abort();
  }, [r.id, real]);
  // 입력은 50 ms 마다(0 포함) — 조종권 심장 박동 겸. 손을 떼면 바로 0(입력이 끊기면 로봇도 0.3 s 뒤 멈춘다)
  useEffect(() => {
    if (!mine) return;
    const i = setInterval(() => sendRef.current(), CMD_MS);
    return () => clearInterval(i);
  }, [mine, r.id]);

  const start = (pauseRun = false) => {
    setAsk(false);
    if (rt.get(r.id).releasing) return;   // 반납 확인 전에는 요청·받기를 보내지 않는다(내게 요청하게 됨)
    if (l.holder?.type === 'RUN' && !pauseRun) return setAsk(true);
    if (l.holder?.type === 'USER') rt.request(r.id);
    else rt.take(r.id);
  };
  const wait = link !== 'open' ? '서버 연결이 끊겨 조종할 수 없습니다. 다시 연결되면 누르세요.'
    : l.releasing ? (l.releasing.why ? '반납 확인 못함 — [다시 시도]' : '반납 확인 중')   // 자세한 이유는 머리줄 아래 한 곳(320 에서 보기 단추를 밀지 않게 짧게)
    : l.outgoing?.canceling ? '요청을 취소하는 중입니다.'
    : l.busy ? BUSY_TEXT[l.busy]
    : l.outgoing ? `${l.holder?.name || '조종하는 사람'}님에게 요청했습니다. (${secs(l.outgoing.until, now)}초)`
    : l.cooldown > now ? `${secs(l.cooldown, now)}초 뒤 다시 요청할 수 있습니다.` : '';
  const q = mine && l.incoming && l.incoming.until > now ? l.incoming : null;
  // ready 에는 «중립 확인 중»도 넣는다 — 중립은 이번 세대 입력으로 정해지므로 세대 키(sync)에 넣으면 그 입력이 앞 세대가 된다(RV-426 ⑧)
  const lock = lockChip(l, r), ready = mine && (lock.text === '움직일 수 있음' || lock.text === '중립 확인 중'), speed = l.state?.speed, ok = got && isSettings(settings);
  readyRef.current = ready; sync();   // 그릴 때도 세대를 맞춘다(조이스틱 누름이 새 세대를 보게)
  // 잠금 사유 OUTPUT_STALLED(에이전트 출력 지연 → 0·STOP·잠금) — 폰 시뮬 조종(simdrive.tsx)과 같은 문구. 잠금 해제·STOP 동작은 그대로
  const stalled = l.state?.connection === 'ONLINE' && !!l.state.latched && l.state.safety_reason === 'OUTPUT_STALLED';
  // 동작 일곱(시안 u1 .act): PC 로봇 탭(robotu4 act)과 같은 규칙 · 같은 길(robotact 막음 → rt.action). 결과는 로봇 보고(state.action_result)
  const lowlevel = l.state?.control === 'LOWLEVEL', online = l.state?.connection === 'ONLINE';
  const doAct = (name: (typeof ACTS)[number][0]) => {
    if (!mine) return say('조종 시작 후 사용할 수 있습니다.');
    const no = actWhy(name, lowlevel); if (no) return say(no);
    if (!online) return say('로봇과 서버 연결을 확인하세요.');
    neutral(); say('서버 접수를 기다리고 있습니다.');
    rt.action(r.id, name, {}, false, (why, id) => { if (why) say(`거부 · ${why}`); else { setPending(id ?? null); say('서버 접수 · 로봇의 결과를 기다리고 있습니다.'); } });
  };

  // 꼴 = 시안 u1_2(조종 판 안 시안 겹 .proto.pv.u1d · 마크업은 시안 그대로, 단추 div 는 button). 글 · 단추 · 동작 · 표지(data-*)는 옛 상태 판 그대로
  const why = mine ? null : driveBlock(c.user, r) ?? (wait || null), whyId = `why-${r.id}`;
  const gaitNow = GAITS.find((x) => x.g === l.state?.gait?.gait)?.name ?? '모름';
  const views = <div className="g dk row u1-views" role="group" aria-label="보기">
    {([['rgb', 'RGB'], ['depth', '뎁스'], ['map', '지도']] as const).map(([v, t]) =>
      <button key={v} type="button" aria-pressed={view === v} onClick={() => setView(v)}>{t}</button>)}
  </div>;
  const ban = (cls: string, x: ReactNode, p: Record<string, string | boolean> = {}) => <p className={`ban ${cls}`} role="status" {...p}>{x}</p>;
  const u1 = <div className={`proto pv u1d${light ? ' light' : ''}`} data-u1d>
    {!light && <div className="vig" />}
    <div className="tl">
      <button type="button" className="g dk row u1-chip" aria-expanded={chip} aria-controls="u1-pane" onClick={() => setChip(!chip)} style={{ left: '12px', top: '12px', height: '44px', padding: '0 12px 0 7px', gap: '9px' }}>
        <span className="u1-ico"><Ic s={17}><path d="M4 13h11l3-3h2v4l-2 1H5z" /><path d="M6 15l-1 4M10 15v4M14 15v4M17 15l1 4" /></Ic>
          {mine && <span className="op"><Ic s={10}><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></Ic></span>}</span>
        <span className="chipnum">{r.name}</span>{r.sim && <span className="tag">시뮬</span>}
        {r.battery != null && <span className="bat" style={{ marginLeft: 0, '--soc': `${Math.max(0, Math.min(100, r.battery))}%` } as CSSProperties}><i />{pct(r.battery)}</span>}
        <span className={`u1-st ${lock.tone}`}>{lock.text}</span>
        <Ic s={15}>{chip ? <path d="m6 15 6-6 6 6" /> : <path d="m6 9 6 6 6-6" />}</Ic>
      </button>
    </div>
    {/* 칩 펼침(시안 u1_10 .pane): 조종권자 · 속도 · 지연 · 걷기 모드. 닫혀 있으면 hidden */}
    <div className="g pane" id="u1-pane" aria-label="로봇 상태" hidden={!chip}>
      <div className="r"><span className="k">조종</span><span>{holderText(l, me, r)}</span></div>
      {r.online && speed != null && <div className="r"><span className="k">속도</span><span className="mono">{speed.toFixed(1)} m/s</span></div>}
      {r.online && l.state?.latency_ms != null && <div className="r"><span className="k">지연</span><span className="mono">{l.state.latency_ms} ms</span></div>}
      <div className="r"><span className="k">걷기</span><span>{gaitNow}</span></div>
      {/* 시트(시나리오 · 지도·목표 · 정책). 「자세」 는 아래 동작 일곱이 대신한다 */}
      <div className="r u1-sheets dv-sheets" aria-label="조종 메뉴">{PHONE_SHEETS.map((x) =>
        <button key={x.id} type="button" aria-expanded={sheet === x.id} onClick={() => { setChip(false); pick(sheet === x.id ? null : x.id); }}>{x.label}</button>)}</div>
    </div>
    {/* 작은 지도(시안 .mm 자리 · 꼴). 누르면 큰 보기를 지도 ↔ 영상으로. 반납 중에는 숨김(보기 단추로 같은 일) */}
    {!l.releasing && <button type="button" className="g dk mm dv-mini" style={{ left: '12px', top: '64px', width: '140px', height: '96px', borderRadius: '16px', overflow: 'hidden', padding: 0 }}
      aria-label={view === 'map' ? '영상 크게' : '지도 크게'} onClick={() => setView(view === 'map' ? 'rgb' : 'map')}>
      {view === 'map' ? <Video small /> : <MapView />}</button>}
    {/* 오른쪽 줄(시안 .col): 첫 줄(연결 · ⋯)은 머리줄 겹 .u1-top, 아래로 걷기 모드(START 자리) · 보기 · 조종 */}
    <div className="col u1-col">
      <button type="button" className="g dk u1-mode" aria-expanded={sheet === 'policy'} onClick={() => pick(sheet === 'policy' ? null : 'policy')}>
        <b>{gaitNow}</b><span>걷기 모드</span></button>
      {views}
      {mine ? <button type="button" className="g dk btn" style={{ height: '44px', borderRadius: '14px' }} disabled={!!l.releasing} onClick={() => endDrive(r.id, c.go)}>
          <Ic s={18}><path d="M18 6 6 18" /><path d="m6 6 12 12" /></Ic>조종 끝내기</button>
        : <button type="button" className="g dk btn u1-go" style={{ height: '44px', borderRadius: '14px' }} disabled={!!why} aria-describedby={why ? whyId : undefined} onClick={() => start()}>
          <Ic s={18}><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="3" /></Ic>조종</button>}
    </div>
    {/* 「다시 시작」(시안 u1_3 자리 · 정지 위 92 × 48) = 잠금 해제. PC 로봇 탭처럼 확인 창(u4_10 글)을 거친다 */}
    {mine && l.state?.latched !== false && <button type="button" className="g dk btn u1-unlock" style={{ right: '12px', bottom: '88px', width: '92px', height: '48px', borderRadius: '14px', zIndex: 5 }} onClick={() => setRestartAsk({ gen: l.state?.stop_gen, lease: l.lease ?? null })}>
      <Ic s={18}><path d="M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z" /></Ic>다시 시작</button>}
    {/* 위 띠 줄(시안 .ban): 작은 지도와 오른쪽 줄 사이. red = 출력 지연, amb = 막은 까닭 · 리모컨 */}
    <div className="u1-says">
      {!mine && ban('u1-who', holderText(l, me, r))}
      {why && <p className={`ban ${driveBlock(c.user, r) ? 'amb' : 'u1-info'}`} role="status"><span id={whyId} className="fh-why" data-why>{why}</span>
        {l.outgoing && <button type="button" className="banbt" disabled={l.outgoing.canceling} onClick={() => rt.cancel(r.id)}>요청 취소</button>}</p>}
      {stalled && ban('red', STALLED, { 'data-stalled': true })}
      <DriveInputNote devices={rt.now() - l.stateAt < 3000 ? l.state?.devices : null} cls="ban amb" />
      {l.notice && ban('u1-info', l.notice)}
      {ready && (real && ok ? ban('u1-info', REAL_STICK, { 'data-real-stick': true }) : ban('u1-info', REAL_WAIT, { 'data-real-wait': true }))}
      {actMsg && ban('u1-info', actMsg, { 'data-act-msg': true })}
      {padWhy && mine && ban('amb', padWhy, { 'data-stick-why': true })}
      {back && mine && real && ok && !combo && !padWhy && !permitted(TABLE.down, settings) && ban('amb', CAP_BLOCK, { 'data-back-block': true })}
      {side && mine && real && ok && !combo && !permitted(TABLE.left, settings) && ban('amb', SIDE_BLOCK, { 'data-side-block': true })}
      {combo && mine && ban('amb', COMBO_BLOCK, { 'data-combo-block': true })}
      {/* 일시정지·중단 단추는 아직 없다 — 누를 수 없는 단추 대신 멈추는 길만(critique 11-10) */}
      {r.mission && <p className="ban u1-info dv-run"><span>시나리오: {r.mission}</span><span data-run-stop>멈추려면 STOP</span></p>}
    </div>
    {/* 손잡이(팀장 11-28 17:33 · PC 로봇 탭과 같은 robotact stickTok): 왼쪽 = 이동(앞 · 뒤 · 옆 · 큰 축 하나), 오른쪽 = 돌기. 문턱 0.3 */}
    {mine && <><Stick cls="stick" label="이동" both on={ready} epoch={0} gen={gen} press={nowRef.current} set={(y, x) => { input.current.st[0] = stickTok('L', -x, -y); stickSay(); }} grip={(o) => { input.current.sg[0] = o; }} lift={send} />
      <Stick cls="stick" label="회전" on={ready} epoch={0} gen={gen} press={nowRef.current} set={(x) => { input.current.st[1] = stickTok('R', -x, 0); stickSay(); }} grip={(o) => { input.current.sg[1] = o; }} lift={send} /></>}
    {/* 아래 동작 줄(시안 u1_2 .act 일곱): 지금 못 누르는 것(순정 확인 전 · 저수준 중 · START 중 일어서기)은 흐리게(.na), 눌러도 보내지 않고 까닭 */}
    <div className="act" aria-label="동작">{ACTS.map(([name, t, em, ic]) => {
      const off = actOff(name, lowlevel);
      return <button key={name} type="button" className={off ? 'na' : undefined} data-act={name} onClick={() => doAct(name)}>
        <span><Ic s={17}>{ic}</Ic></span>{t}{off && <em>{name === 'StandUp' ? em : lowlevel ? '저수준 중 안 됨' : '순정 확인 전'}</em>}</button>;
    })}</div>
    {/* 시나리오가 쥔 로봇 «조종 시작» 확인(시안 .scrim + .dlg · 가림막은 손가락을 막지 않음) */}
    {ask && l.holder?.type === 'RUN' && <><div className="scrim" />
      <div className="g dlg dv-ask" role="dialog" aria-labelledby="dv-run-t">
        <div className="h" id="dv-run-t">조종 시작</div>
        <div className="s">{r.name}이 시나리오를 실행 중입니다. 조종을 시작하면 시나리오가 일시정지됩니다.</div>
        <div className="bts"><button type="button" className="dsec" onClick={() => setAsk(false)}>취소</button><button type="button" className="dpri" onClick={() => start(true)}>일시정지하고 조종</button></div>
      </div></>}
    {askLive && <><div className="scrim" />
      <div className="g dlg" role="dialog" aria-label="다시 시작 확인" data-restart-ask>
        <div className="h">{RESTART_ASK(r.name)}</div>
        <div className="s">{RESTART_TEXT}</div>
        <div className="bts"><button type="button" className="dsec" onClick={() => setRestartAsk(null)}>취소</button>
          <button type="button" className="dpri" onClick={() => { const a = restartAsk; setRestartAsk(null); const now = rt.get(r.id); if (a && now.state?.latched !== false && now.state?.stop_gen === a.gen && now.lease === a.lease) rt.unlock(r.id); }}>일어서기</button></div>
      </div></>}
  </div>;

  return <section className="dv ph" style={{ flexBasis: '100%' }} aria-label="조종" onContextMenu={(e) => e.preventDefault()}>
    <div className="dv-body">
      <div className={`dv-stage ${view}`}>
        {view === 'map' ? <MapView big /> : <Video depth={view === 'depth'} />}
        {c.scan}{/* 지도 스캔 겹(시안 u14_2): 시안 겹 · 조종권 요청 창보다 아래 */}
        {u1}
        {q && <TakeoverAsk id="dv-ask-t" title={`${[ROLE_NAME[q.role as Role], q.name].filter(Boolean).join(' ') || '다른 사람'} 님이 ${r.name} 조종권을 요청했습니다`}
          left={secs(q.until, now)} bar={(Math.max(0, q.until - now) / q.ms) * 100}
          give={pointerOnly(() => rt.respond(r.id, true))} keep={pointerOnly(() => rt.respond(r.id, false))} />}
        {sheet && <Sheet title={PHONE_SHEETS.find((x) => x.id === sheet)!.label} close={() => pick(null)}>{sheet === 'policy' && gait.row || SHEET[sheet](c)}</Sheet>}
      </div>
    </div>
  </section>;
}
const Ic = ({ s, children }: { s: number; children: ReactNode }) => <svg className="ic" viewBox="0 0 24 24" style={{ width: `${s}px`, height: `${s}px` }} aria-hidden="true">{children}</svg>;

/** 실기 RGB·뎁스·지도: 실기 영상 어댑터·지도·라이다 자료가 아직 없다 — 연결·명령 시도 없이 이유만(가짜 그림 0).
 *  예전 지도 칸은 고정 벽·계산한 라이다 점을 그려 실제 센서로 읽힐 수 있었다(critique 11-10) — 받은 값이 없으면 그리지 않는다 */
export const REAL_RGB = '실기 영상 준비 중(미연결)';
export const REAL_DEPTH = '뎁스 영상 없음 · 기능 준비 중';
export const REAL_MAP = '지도·라이다 자료 없음 · 기능 준비 중';
function Video({ depth, small }: { depth?: boolean; small?: boolean }) {
  return <div className="dv-video" role="img" aria-label={depth ? '뎁스 영상' : 'RGB 영상'}>
    {!small && <span>{depth ? REAL_DEPTH : REAL_RGB}</span>}</div>;
}
function MapView({ big }: { big?: boolean }) {
  return <div className="dv-video" role="img" aria-label="지도·라이다 없음" data-map-none>{big ? <span>{REAL_MAP}</span> : <span>지도 없음</span>}</div>;
}

/** 폰 엄지 조이스틱(03 §5.7): 왼쪽 전후(세로), 오른쪽 회전(가로). both = 세로·가로 두 축(시뮬 왼쪽 상하좌우, set 둘째 값 = 가로, 왼쪽 +).
 *  처음 잡은 손가락(pointerId) 하나만 쓴다 — 그 손가락을 떼기 전까지 다른 손가락은 무시, 떼면 값 0 이고 남은 손가락도 무시(RV-426 ⑩, 실기·시뮬 같게).
 *  잡은 순간의 세대(press(), 없으면 gen)를 적고 지금 세대일 때만 움직인다(on 이 아닐 때 잡으면 앞 세대 -1).
 *  grip = 잡은 손가락의 세대(없으면 null) — 조종 화면은 지금 세대가 아니면 명령 전체를 0 으로. lift = 뗀 뒤(바로 보내기).
 *  cls = 덧붙일 꼴(폰 실기 조종 화면은 시안 u1 .stick).
 *  epoch 가 바뀌거나 처음 붙거나 사라지면 쥔 포인터를 놓고 값 0(부모 축 값도 — RV-426 ⑤). children = 판 위 그림(화살표) */
export function Stick({ label, vertical, both, on, epoch, gen, press, set, grip, lift, children, cls }: { cls?: string; label: string; vertical?: boolean; both?: boolean; on: boolean; epoch: number; gen: { current: number }; press?: () => number; set: (v: number, side: number) => void; grip?: (n: number | null) => void; lift?: () => void; children?: ReactNode }) {
  const [k, setK] = useState<[number, number]>([0, 0]);   // [세로, 가로]
  const el = useRef<HTMLDivElement>(null), own = useRef<{ id: number; n: number } | null>(null);   // 잡은 손가락·잡은 세대
  const cb = useRef({ set, grip, lift }); cb.current = { set, grip, lift };
  const drop = () => {
    const o = own.current; own.current = null;
    if (o && el.current?.hasPointerCapture?.(o.id)) el.current.releasePointerCapture(o.id);
    cb.current.set(0, 0); cb.current.grip?.(null);
  };
  useEffect(() => { drop(); setK([0, 0]); }, [epoch]);
  useEffect(() => () => { drop(); cb.current.lift?.(); }, []);
  const move = (e: PointerEvent<HTMLDivElement>) => {
    const b = e.currentTarget.getBoundingClientRect();
    const y = clamp((b.top + b.height / 2 - e.clientY) / (b.height / 2)), x = clamp((b.left + b.width / 2 - e.clientX) / (b.width / 2));
    setK(both ? [y, x] : vertical ? [y, 0] : [0, x]); set(both || vertical ? y : x, both ? x : 0);
  };
  const end = (e: PointerEvent<HTMLDivElement>) => { if (own.current?.id !== e.pointerId) return; own.current = null; setK([0, 0]); set(0, 0); grip?.(null); lift?.(); };
  return <div ref={el} className={`dv-stick ${vertical || both ? 'v' : 'h'}${cls ? ` ${cls}` : ''}`} aria-label={`${label} 조이스틱`} aria-disabled={!on}
    onPointerDown={(e) => {
      if (own.current) return;   // 이미 잡은 손가락이 있으면 무시
      own.current = { id: e.pointerId, n: on ? press?.() ?? gen.current : -1 }; grip?.(own.current.n);
      e.currentTarget.setPointerCapture?.(e.pointerId); if (on) move(e);
    }}
    onPointerMove={(e) => { const o = own.current; if (o?.id === e.pointerId && o.n === gen.current) move(e); }}
    onPointerUp={end} onPointerCancel={end} onLostPointerCapture={end}>
    {children}
    <i style={{ transform: `translate(${-k[1] * 36}px, ${-k[0] * 36}px)` }} />
    <span>{label}</span>
  </div>;
}
