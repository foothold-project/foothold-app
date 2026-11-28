// 폰 조종(09 ADR-002 §3 — 02 기능 F-TO-01~05, 03 UX §5.7): 로봇 연결 → 조종(가로, 카메라 전체·양쪽 조이스틱·아래 줄 시트).
// 조종권·잠금·STOP 은 실시간 연결(rt.ts → 관제 서버)만 부른다 — 판정은 서버 중재기. 시뮬 로봇은 폰 ↔ 에이전트 직결(phone.ts·simdrive.tsx).
// 카메라·라이다·뎁스는 서버 drive-media(PC 와 같은 drivemedia.ts · 받기만), 시나리오 제어는 자리만. 키보드(한 배치 · 11-28 17:25): W·↑ 전진, ← / → 옆걸음(조직 옆 상한이 허락할 때), A / D 회전, S·↓ 후진(조직 뒤 상한이 허락할 때 · 손잡이와 같은 규칙). Space = STOP 은 App 공통 층(모든 화면).
import { useEffect, useRef, useState, type CSSProperties, type MouseEvent, type PointerEvent, type ReactNode } from 'react';
import { ADMIN_LATER, ROLE_NAME, driveBlock, robotStatus, type Holder, type Robot, type Role, type Tone } from './fake';
import { CMD_MS, inputGen, metaCut, rt, runSay, undelivered, useLive, useRt, type Live } from './rt';
import { STATUS as RUN_STATUS } from './screens/missionrun';
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
import { COMBO_BLOCK, DriveView, allowedAxes, axesOf, command, isSettings, permitted, REAL_WAIT, SIDE_BLOCK, TABLE, tokStick, unknownCombo, type Tok } from './serverdrive';
import { driveFeedText, useDriveFeed, type DriveFeed } from './drivemedia';
import { LidarMap } from './lidarmap';
import type { GaitName, OrgSettings } from '../../contracts/ts';
import { MissionCards, MissionMap, missionChip, missionOn, useMission, type MapSight } from './screens/u1mission';
import { ACTS, RESTART_ASK, RESTART_TEXT, actOff, actWhy, stickTok, useRestartAsk } from './robotact';
import { actionResultText } from './screens/actiontrial';
import { api } from './api';
import { STALLED, SimLaunch, field } from './simdrive';
import { GAITS, GAIT_KEYS, GAIT_NOTE, gaitKey, useGait } from './gait';
import './drive.css';
import './proto/ui.pv.css';
import './proto/light.pv.css';
import './screens/u1d.css';
import './screens/u1.app.css';
import { askShown, remoteWhy } from './proto/u11';
import { hotJoint, jointName, tempLevel, type Level } from './proto/u5';
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
function lockChip(l: Live, r: Robot, down = false): { tone: Tone; text: string } {
  if (r.unknown === 'summary') return { tone: 'off', text: '확인 안 됨' };
  if (l.failed) return { tone: 'bad', text: '정지 확인 실패' };
  if (l.busy) return { tone: 'warn', text: '정지 확인 중' };
  if (down) return { tone: 'warn', text: '리모컨만' };   // 서버 실시간이 끊김(시안 u1_8): 앱 조종 길이 없고 리모컨만 남음
  if (!l.state || l.state.connection !== 'ONLINE') return { tone: 'off', text: '상태 모름' };
  if (l.state.latched !== false) return { tone: 'bad', text: l.state.latched ? '정지됨' : '정지 잠금' };   // 「정지됨」 은 로봇이 잠금을 알렸을 때만(시안 u1_3 · 모르면 정지 잠금)
  if (!l.lease) return { tone: 'off', text: '보는 중' };
  return l.neutral ? { tone: 'ok', text: '조종 중' } : { tone: 'warn', text: '중립 확인 중' };   // 「조종 중」 = 시안 u1_2
}
const NOT_LATCHED = '정지 요청됨 — 로봇이 아직 잠금을 알리지 않았습니다.';
/** 서버가 받았고 그 뒤 state 도 왔는데 로봇이 아직 잠금을 알리지 않음(stopText 의 그 줄) = 시안 u1_7 「명령이 닿지 않았습니다」 */
export const stopWaiting = (r: Robot, l: Live) => !!l.stop && stopText(r, l).endsWith(NOT_LATCHED);
/** STOP 결과 한 줄 — 서버가 받았는지와 로봇이 알린 잠금을 나눠 쓴다. 확인 안 된 «정지됨»은 쓰지 않는다(F-COM-01) */
export function stopText(r: Robot, l: Live) {
  const s = l.stop, st = l.state;
  if (!s) return '';
  if (s.phase === 'sending') return `■ ${r.name} 정지 요청을 보내는 중입니다.`;
  if (s.phase === 'failed') return `▲ ${r.name} 정지 요청을 보내지 못했습니다. ${s.why ?? ''} 현장에서 로봇을 직접 멈추세요.`;
  if (s.phase === 'unsure') return `▲ ${r.name} 정지 요청을 보냈지만 서버 접수를 확인하지 못했습니다. ${s.why ?? ''} 현장에서 로봇을 직접 멈추세요.`;
  const no = undelivered(s, st); if (no) return `▲ ${r.name} ${no}`;
  // 대체 경로로 보낸 뒤에는 다시 연결되어 요청 뒤 state 가 와야 로봇 확인을 본다
  if (s.phase === 'fallback' && !(st && l.stateAt > s.at)) return `■ ${r.name} 정지 요청됨(대체 경로) — 실시간 연결이 끊겨 로봇 확인은 보이지 않습니다. 현장을 확인하세요.`;
  if (!st || l.stateAt <= s.at) return `■ ${r.name} 정지 요청됨 — 서버가 받았습니다. 로봇 확인을 기다립니다.`;
  if (st.phone_relay && (st.connection !== 'ONLINE' || st.latched === null || st.applied === null))
    return `▲ ${r.name} 정지 요청됨 — 폰 경유 자료는 받았지만 직접 로봇 보고로 정지를 확인하지 못했습니다. 현장을 확인하세요.`;
  if (st.connection !== 'ONLINE') return `▲ ${r.name} 정지 요청 뒤 로봇 연결이 끊겼습니다. 지금 상태는 알 수 없습니다. 현장을 확인하세요.`;
  if (!st.latched) return `■ ${r.name} ${NOT_LATCHED}`;
  // applied 가 비었거나 없으면 출력 보고가 없는 것(현장 승인 관문이 닫힌 에이전트는 latched · applied [] 만 보냄). [].every 는 참이라 따로 거른다
  if (!st.applied?.length) return `▲ ${r.name} 정지 잠금 · 멈춤 출력은 확인되지 않았습니다 (현장 승인이 닫혀 있을 수 있음). 리모컨이나 현장에서 멈추세요.`;
  return st.applied.every((v) => v === 0) ? `■ ${r.name} 정지 잠금 · 로봇이 잠금과 멈춤 출력을 알렸습니다.` : `▲ ${r.name} 정지 잠금 · 출력이 아직 멈추지 않았습니다. 현장을 확인하세요.`;
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
/** 데모(목록 sim · demo true) 손 조종 = 로봇 탭과 같은 serverdrive axesOf(시뮬) 하나: 공용 식 apps/contracts/teleop.ts ·
 *  표에 없는 조합도 막지 않음(fe299a01 · 조합은 정책 몫) · 상한 검사 allowedAxes. 실기 고정 명령표(command · permitted)는 그대로 */
export const DEMO_RULE: { mark: boolean } = { mark: true };   // 후진 · 옆걸음 「시험 기능」 표시 — 팀장 확인 대기(app-lead 11-28 23:12)
/** 키 → 손잡이와 같은 입력 부호: 앞 +1 · 뒤 -1 · 왼 옆 +1 · 오른 옆 -1 · 왼 돌기 +1(실기 화면 손잡이 표시용) */
export const keyInput = (keys: Tok[]) => { const [vx, vy, wz] = command(keys); return { f: Math.sign(vx), s: Math.sign(vy), t: Math.sign(wz) }; };
/** 데모 키 → 화면 손잡이 자리(axesOf 가 보내는 것과 같은 tokStick) */
const demoKin = (keys: Tok[], o: Partial<OrgSettings> | null) => { const [f, s, t] = tokStick(keys, o, true); return { f, s, t }; };
/** 데모 후진 · 옆걸음 표시(app-lx 11-28 22:59 · DEMO_RULE.mark) */
export const DEMO_EXP = '시험 기능 · 후진과 옆걸음은 시뮬에서 시험 중입니다.';
export const REAL_STICK = '실기는 손잡이를 30 % 넘게 밀면 정해진 속도로 움직입니다. 한 손잡이는 큰 쪽 한 방향만 보냅니다.';
export { REAL_WAIT };
/** 설정을 모를 때 입력이 0 이 되는 순간만 뜨는 작은 알약(시안 밖 · 새로 그림 · app-lead 11-28 22:26). 10 초 넘게 모르면 위 띠 REAL_WAIT */
export const REAL_WAIT_PILL = '설정 확인 중 · 입력 0';
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
  const live = c.robots.some((r) => (!r.sim || r.demo === true) && (r.online || !!r.unknown));   // 상태 모름(실시간 끊김·첫 상태 전)은 «연결 없음»으로 단정하지 않는다 — 깜빡임 방지
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
    <div className="fh-row"><b>{r.name}</b>{r.sim && !r.demo && <Chip tone="off" text="시뮬" />}<Chip {...robotStatus(r)} /><FallChip x={r} /><span className="mono">{pct(r.battery)}</span></div>
    <span className="lbl">{holderText(l, c.user.id, r)}</span>
    {rel && <div className="fh-row" role="status" data-releasing><span className="fh-why">{rel.why ? `조종권 반납을 확인하지 못했습니다. ${rel.why}` : RELEASING}</span>
      {rel.why && <button type="button" className="btn" onClick={() => rt.release(r.id)}>다시 시도</button>}</div>}
    {r.sim && r.demo !== true ? <span className="lbl" data-sim-card>시뮬 로봇은 아래 «시뮬 로봇 띄우기»에서 로봇에 직접 연결합니다.</span>   // 서버 경유 조종 화면으로 보내지 않는다
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
  const demo = !!c.robot.sim && c.robot.demo === true;   // 데모 = 실기처럼 서버 경유(목록 server_drive 는 늘 거짓 · app-lx 11-28 22:41)
  const r = c.robot, me = c.user.id, l = useLive(r.id), mine = !!l.lease, link = rt.link().at, real = (!!r.serverDrive && !r.sim) || demo;
  const settings = useTuneSettings(), settingsRef = useRef(settings); settingsRef.current = settings;
  // got = 이 화면이 조직 설정을 받음. 받기 전(앞 화면이 남긴 값 포함)·못 받으면 실기 입력은 0 — 서버가 상한 밖이라 거절·STOP 하지 않게
  const [got, setGot] = useState(false), gotRef = useRef(got); gotRef.current = got;
  const [view, setView] = useState<'rgb' | 'depth' | 'map'>('rgb');
  // 카메라 · 라이다 · 뎁스(시안 u1_2): PC 로봇 탭과 같은 서버 drive-media 를 받기만. 서버 경유 실기 · 데모만 연다. 뎁스는 고른 동안만
  const fs = { rgb: useDriveFeed(r.id, 'rgb', real), lidar: useDriveFeed(r.id, 'lidar', real), depth: useDriveFeed(r.id, 'depth', real && view === 'depth') };
  const [mview, setMview] = useState<MapSight>('follow'), [d3, setD3] = useState(false);   // 임무 바탕 지도 시점(시안 u1_1 왼쪽 고르개 · 보이기만)
  useEffect(() => { if (!d3) return; const id = window.setTimeout(() => setD3(false), 3000); return () => clearTimeout(id); }, [d3]);
  const [ask, setAsk] = useState(false);   // 시나리오 일시정지 확인창(F-TO-03, 03 §2 U10)
  const [back, setBack] = useState(false), [side, setSide] = useState(false), [combo, setCombo] = useState(false);   // combo = 표에 없는 키 조합을 누르는 중   // side = 옆걸음 키를 누르는 중(막혔으면 까닭 한 줄)
  const [sheet, setSheet] = useState<SheetId | null>(null);   // 아래 줄 시트(조종권은 그대로, 입력은 0으로)
  const [chip, setChip] = useState(false), light = useTheme()[1];   // chip = 로봇 칩 펼침(시안 u1_10)
  const [tempShut, setTempShut] = useState<Level>(null);   // 관절 온도 띠(시안 u3_2)를 닫은 단계 · 그 단계 이하는 다시 띄우지 않음
  // 「다시 시작」 확인 창(u4_10 글): 연 때의 stop_gen · 조종권에 묶음(robotact useRestartAsk · reviewer H1)
  const restart = useRestartAsk(() => { const x = rt.get(r.id); return { mine: !!x.lease, latched: x.state?.latched, gen: x.state?.stop_gen, lease: x.lease }; });
  const [actMsg, setActMsg] = useState(''), [pending, setPending] = useState<string | null>(null), tm = useRef(0);   // 동작 까닭 · 결과 한 줄(2.6 초) · 접수된 요청 id
  const say = (m: string) => { setActMsg(m); clearTimeout(tm.current); tm.current = window.setTimeout(() => setActMsg(''), 2600); };
  const res = l.state?.action_result;
  useEffect(() => { if (pending && res?.request_id === pending && res.status !== 'RUNNING') { say(actionResultText(res)); setPending(null); } }, [res?.request_id, res?.status]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => clearTimeout(tm.current), []);   // 「다시 시작」 확인 창(시안 u4_10 과 같은 글) · 일어서기만 잠금 해제를 보낸다
  // 입력 세대(rt inputGen): 키(e.code)·스틱 손가락마다 누른 순간의 세대. 잠김·해제·조종권·시트/⋯·blur/숨김·STOP·설정·ready 가 바뀌면 +1.
  // 앞 세대에 누른 키·손가락이 아직 눌려 있으면 명령 전체 0 — 떼었다가 다시 눌러야 한다. sg = 스틱마다 아직 닿은 손가락 중 가장 앞 세대(없으면 null)
  const [gen] = useState(inputGen);
  const input = useRef({ keys: new Map<string, number>(), st: [[], []] as Tok[][], sg: [null, null] as (number | null)[], an: { f: 0, s: 0, t: 0 } });   // an = 데모 손잡이 비례 값(앞 + · 왼쪽 + · 왼쪽 돌기 +)   // st = 손잡이마다 보내는 낱말(robotact stickTok)
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
  const [exp, setExp] = useState(false), [kin, setKin] = useState({ f: 0, s: 0, t: 0 });   // kin = 누른 키의 손잡이 입력(화면 손잡이에 보이기만)   // 데모 후진 · 옆걸음을 보내는 중(시험 기능 표시)
  const cmdOf = (t: Tok[]) => (demo ? axesOf(t, settingsRef.current, true) : command(t)), allow = (a: [number, number, number]) => (demo ? allowedAxes(a, settingsRef.current, true) : permitted(a, settingsRef.current));
  const [zero, setZero] = useState(false), [long, setLong] = useState(false);   // zero = 누르는데 설정을 몰라 0 을 보냄 · long = 10 초 넘게 모름
  const stickSay = () => {
    const t = toks();
    setPadWhy(!readyRef.current || !t || !(input.current.st[0].length || input.current.st[1].length) ? ''
      : demo ? '' : unknownCombo(t) ? COMBO_BLOCK : !allow(cmdOf(t)) ? (cmdOf(t)[1] ? SIDE_BLOCK : CAP_BLOCK) : '');
  };

  /** 틱과 즉시 전송(놓음·blur·시트)이 같이 쓰는 한 길: 명령 공백(GAP_MS) 검사로 세대를 맞춘 뒤 보낸다(RV-426 ③⑨).
   *  이 화면은 실기만 연다(시뮬은 App 이 막고 simdrive 직결) — 비례는 없다. 서버 경유 확인 + 설정 받음 = 표 값, 그 밖(목록 갱신 전 등)은 0 */
  const send = () => {
    if (!rt.get(r.id).lease) return;
    gen.tick(r.id);
    const t = toks(), known = real && gotRef.current && isSettings(settingsRef.current), cmd = t && known ? (demo ? axesOf(keyToks(input.current.keys), settingsRef.current, true, [input.current.an.f, input.current.an.s, input.current.an.t]) : command(t)) : TABLE[''];
    setZero(!known && !!t && t.length > 0);
    const [vx, vy, wz] = allow(cmd) ? cmd : TABLE[''];   // 표 밖 · 조직 상한 밖이면 0
    setExp(demo && DEMO_RULE.mark && (vx < 0 || vy !== 0));
    rt.cmd(r.id, [vx, wz], vy, !t);
  };
  const sendRef = useRef(send); sendRef.current = send;
  /** 누른 순간의 세대 — 공백 검사를 먼저(공백 뒤 새 누름은 새 세대) */
  const now0 = () => { gen.tick(r.id); return sync(); };
  const nowRef = useRef(now0); nowRef.current = now0;
  // 걷기 모드(u03): 누른 키 · 스틱 손가락이 있거나 로봇이 0 아닌 명령을 적용 중이면 «움직이는 중» · 보내지 않고 까닭
  // 걷기 모드 확인 창(시안 u1_14 · PC 로봇 탭 u4_7 modeBind 와 같은 규칙): 연 때의 stop_gen · 조종권에 묶음 — 바뀌면 닫고, 바꾸기는 그때 다시 보고 같을 때만 press
  const [modeAsk, setModeAsk] = useState<GaitName | null>(null), askMode = (g: GaitName) => { pick(null); setModeAsk(g); modeBind.open(); };
  const modeBind = useRestartAsk(() => { const x = rt.get(r.id); return { mine: !!x.lease, latched: null, gen: x.state?.stop_gen, lease: x.lease }; });
  useEffect(() => { if (modeAsk && !modeBind.live) setModeAsk(null); }, [modeAsk, modeBind.live]);
  const gait = useGait(r.id, () => input.current.keys.size > 0 || input.current.sg.some((x) => x != null) || !!rt.get(r.id).state?.applied?.some((v) => v !== 0),
    (g) => askMode(g));   // 시트 단추 = 확인 창
  // Shift+1~4 도 그 모드를 고른 확인 창부터(PC 로봇 탭 99a0c9c2 와 같은 규칙). 조종권 없음 · 못 쓰는 모드면 원래 길(press)이 까닭을 알림
  const gaitRef = useRef(gait.press); gaitRef.current = (g: GaitName) => (rt.get(r.id).lease && gait.avail?.length !== 0 && (!gait.avail || gait.avail.includes(g)) ? askMode(g) : gait.press(g));

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
      setCombo(!demo && unknownCombo(keyToks(keys))); setKin(demo ? demoKin(keyToks(keys), settingsRef.current) : keyInput(keyToks(keys)));
    };
    const up = (e: KeyboardEvent) => {
      if (metaCut(e)) { if (keys.size) blur(); return; }
      const k = KEY[keyCode(e.code)]; if (k && keys.delete(e.code)) { if (k === 'b') setBack(held(keys, 'b')); setSide(held(keys, 'sl') || held(keys, 'sr')); setCombo(!demo && unknownCombo(keyToks(keys))); setKin(demo ? demoKin(keyToks(keys), settingsRef.current) : keyInput(keyToks(keys))); sendRef.current(); }   // 뗀 그 자리에서 한 번 보냄(RV-426 ⑨)
    };
    // 창 밖에서 뗀 키는 keyup 이 안 온다 — 적은 키를 모두 지우고 세대 +1, 바로 0(앞 세대는 이미 무시되므로 지워도 안전, RV-426 ⑦⑨)
    const blur = () => { keys.clear(); setBack(false); setSide(false); setCombo(false); setKin({ f: 0, s: 0, t: 0 }); gen.bump(); sendRef.current(); };
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
  const down = link === 'lost' || link === 'denied', lock = lockChip(l, r, down), ready = mine && (lock.text === '조종 중' || lock.text === '중립 확인 중'), stopHeld = !!l.state && l.state.latched !== false, speed = l.state?.speed, ok = got && isSettings(settings);   // stopHeld: 정지 잠금 중 = 조이스틱 · 동작 줄 숨김(시안 u1_3)
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
  // Damping(시안 u1_3 · PC 로봇 탭 robotu4 damp 와 같은 규칙 · 같은 길): 내 조종 · 정지 잠금 · 서 있을 때. 한 번 = 안내, 3 초 안에 한 번 더 = Damp(확인됨).
  // 처음 값은 -Infinity: 0 이면 페이지를 연 뒤 3 초 안의 첫 누름이 바로 Damp 가 된다(performance.now 는 페이지 시작부터 셈)
  const [arm, setArm] = useState(-Infinity), dampOn = mine && online && l.state?.latched === true && l.state?.posture?.state !== 'LYING';
  useEffect(() => { if (!dampOn) setArm(-Infinity); }, [dampOn]);   // 단추가 사라지면 한 번 누른 기록도 버림(다시 나타나 한 번에 Damp 가 나가지 않게 · 검토 낮음)
  const damp = () => {
    if (rt.now() - arm > 3000) { setArm(rt.now()); return say('한 번 더 누르면 엎드려 힘을 뺍니다'); }
    setArm(-Infinity); neutral(); rt.action(r.id, 'Damp', {}, true, (why, id) => { if (why) say(`거부 · ${why}`); else setPending(id ?? null); });
  };

  // 꼴 = 시안 u1_2(조종 판 안 시안 겹 .proto.pv.u1d · 마크업은 시안 그대로, 단추 div 는 button). 글 · 단추 · 동작 · 표지(data-*)는 옛 상태 판 그대로
  const why = mine ? null : driveBlock(c.user, r) ?? (wait || null), whyId = `why-${r.id}`;
  const gaitNow = GAITS.find((x) => x.g === l.state?.gait?.gait)?.name ?? '모름';
  const views = <div className="g dk row u1-views" role="group" aria-label="보기">
    {([['rgb', 'RGB'], ['depth', '뎁스'], ['map', '지도']] as const).map(([v, t]) =>
      <button key={v} type="button" aria-pressed={view === v} onClick={() => setView(v)}>{t}</button>)}
  </div>;
  const unknown = ready && !(real && ok);
  useEffect(() => { setLong(false); if (!unknown) return; const id = window.setTimeout(() => setLong(true), 10000); return () => clearTimeout(id); }, [unknown]);
  const ban = (cls: string, x: ReactNode, p: Record<string, string | boolean> = {}) => <p className={`ban ${cls}`} role="status" {...p}>{x}</p>;
  // 정지 잠금 중(시안 u1_3): 조이스틱 · 동작 줄은 숨긴다(visibility · u1.app.css). 지우지 않는 까닭: 누른 손가락 · 세대(RV-425)는 부품이 붙어 있어야 그대로 판정
  // 임무 화면(시안 u1_1 · u1_15 · 보이기만): 끝나지 않은 실행이 있고 내 조종이 아닐 때 바탕 층 지도 · 왼쪽 아래 카드 · 칩 글. 칩 글만 바꾸고 lock(조종 판정)은 그대로
  const mrun = !mine && missionOn(l.state?.run) ? l.state!.run! : null, mis = useMission(r.id, mrun?.run_id ?? ''), lockFirst = mrun && lock.text !== '보는 중' ? lock : null, chipBase = mrun && !lockFirst ? missionChip(mrun) : lock;   // 안전 표시: 정지 잠금 · 확인 중 · 상태 모름이면 임무 글보다 그 글이 먼저(칩 · 카드 줄)
  // 칩 글만(조종 판정 lock · ready 는 그대로): 정지 뒤 잠금 보고 전 「안 멈춤」(u1_7) → 정지 잠금 · 확인 중 · 모름 → 리모컨 우선 「리모컨 조종」(u1_9) → 관절 위험 「과열」(u3_2) → 임무 · 조종 글
  const hot = hotJoint(l.state ? { ...r, robotInfo: l.state.robot_info ?? null } : r), lv = tempLevel(hot?.t ?? null), remote = rt.now() - l.stateAt < 3000 ? remoteWhy(l.state?.devices) : null, calm = ['조종 중', '중립 확인 중', '보는 중'].includes(lock.text);
  const chipNow: { tone: Tone; text: string } = stopWaiting(r, l) ? { tone: 'bad', text: '안 멈춤' } : calm && remote ? { tone: 'warn', text: '리모컨 조종' } : calm && lv === 'crit' ? { tone: 'bad', text: '과열' } : chipBase;
  const RANK = { warn: 1, bad: 2, crit: 3 } as const, hotBand = (lv === 'bad' || lv === 'crit') && !(tempShut && RANK[tempShut] >= RANK[lv]) ? lv : null;
  useEffect(() => { if (lv !== 'bad' && lv !== 'crit') setTempShut(null); }, [lv]);   // 60 °C 아래로 내려가면 닫은 기록을 지움
  // 일시정지 · 이어 가기(시안 u1_1 · u1_11 · 제안 A · 새 명령 길 없음). 조종권 없는 임무 화면: 일시정지 = 「일시정지하고 조종」 창(조종권 받기), 일시정지된 임무 · 쥔 사람 없음 = 조종권 받기.
  // 내 조종권 · 내 임무 = PC RunCtl 과 같은 조건 · 같은 길(rt.run pause · resume): 실기 막음 · 정지 잠금이면 까닭
  const myRun = mine && missionOn(l.state?.run) ? l.state!.run! : null, rq = l.runReq, runBusy = !!rq && (rq.phase === 'sending' || rq.phase === 'sent');
  const runMain = myRun?.status === 'PAUSED' ? (['resume', '이어 가기'] as const) : (['pause', '일시정지'] as const);
  const runGate = !myRun ? '' : !r.sim ? '실기는 아직 화면에서 임무를 이어 갈 수 없습니다 · 멈추려면 STOP.' : l.state?.latched !== false ? '「다시 시작」 뒤 이어 갈 수 있습니다.' : '';
  const u1 = <div className={`proto pv u1d${light ? ' light' : ''}`} data-u1d data-stop-held={stopHeld ? '' : undefined} data-mission={mrun ? '' : undefined}>
    {mrun && <MissionMap m={mis} run={mrun} pose={l.state?.location ?? r.location} view={mview} />}
    {mrun && <div className="g u1-vcol" role="group" aria-label="지도 시점">
      {([['follow', '로봇', <path key="p" d="M12 3l7 16-7-4-7 4z" />], ['top', '평면', <><path d="M3 6l6-3 6 3 6-3v15l-6 3-6-3-6 3z" /><path d="M9 3v15M15 6v15" /></>]] as const).map(([v, t, ic]) =>
        <button key={v} type="button" className="btn" aria-pressed={mview === v} onClick={() => setMview(v)}><svg className="ic" viewBox="0 0 24 24">{ic}</svg>{t}</button>)}
      <button type="button" className="btn" aria-pressed={false} aria-disabled="true" title="3D 지도 준비 중" onClick={() => setD3(true)} data-view-3d-off><svg className="ic" viewBox="0 0 24 24"><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" /><path d="M12 12l8-4.5M12 12v9M12 12L4 7.5" /></svg>3D</button>
      {d3 && <p className="g u1-vnote" role="status">3D 지도 준비 중</p>}
    </div>}
    {!light && <div className="vig" />}
    <div className="tl">
      <button type="button" className="g dk row u1-chip" aria-expanded={chip} aria-controls="u1-pane" onClick={() => setChip(!chip)} style={{ left: '12px', top: '12px', height: '44px', padding: '0 12px 0 7px', gap: '9px' }}>
        <span className="u1-ico"><Ic s={17}><path d="M4 13h11l3-3h2v4l-2 1H5z" /><path d="M6 15l-1 4M10 15v4M14 15v4M17 15l1 4" /></Ic>
          {mine && <span className="op"><Ic s={10}><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></Ic></span>}</span>
        <span className="chipnum">{r.name}</span>{r.sim && !r.demo && <span className="tag">시뮬</span>}
        {r.battery != null && <span className="bat" style={{ marginLeft: 0, '--soc': `${Math.max(0, Math.min(100, r.battery))}%` } as CSSProperties}><i />{pct(r.battery)}</span>}
        <span className={`u1-st ${chipNow.tone}`}>{chipNow.text}</span>
        <Ic s={15}>{chip ? <path d="m6 15 6-6 6 6" /> : <path d="m6 9 6 6 6-6" />}</Ic>
      </button>
    </div>
    {/* 칩 펼침(시안 u1_10 .pane): 조종권자 · 속도 · 지연 · 걷기 모드. 닫혀 있으면 hidden */}
    <div className="g pane" id="u1-pane" aria-label="로봇 상태" hidden={!chip}>
      <div className="row" style={{ gap: '7px' }} data-pane-id><span className="tag">{r.sim ? (r.demo ? '데모' : '시뮬') : '실제'}</span><span style={{ fontSize: '11.5px', fontWeight: 700, color: 'var(--mu)' }}>{r.serial || '기체번호 없음'}</span></div>
      <div className="r"><span className="k">조종</span><span>{holderText(l, me, r)}</span></div>
      {r.online && speed != null && <div className="r"><span className="k">속도</span><span className="mono">{speed.toFixed(1)} m/s</span></div>}
      {r.online && l.state?.latency_ms != null && <div className="r"><span className="k">지연</span><span className="mono">{l.state.latency_ms} ms</span></div>}
      <div className="r"><span className="k">걷기</span><span>{gaitNow}</span></div>
      {hot && <div className="r" data-pane-temp><Ic s={15}>{THERMO}</Ic><span className="k">관절</span>최고 {Math.round(hot.t)} °C<span className="v">{lv ? TEMP_TEXT[lv] : '정상'}</span></div>}
      {/* 시트(시나리오 · 지도·목표 · 정책). 「자세」 는 아래 동작 일곱이 대신한다 */}
      <div className="r u1-sheets dv-sheets" aria-label="조종 메뉴">{PHONE_SHEETS.map((x) =>
        <button key={x.id} type="button" aria-expanded={sheet === x.id} onClick={() => { setChip(false); pick(sheet === x.id ? null : x.id); }}>{x.label}</button>)}</div>
    </div>
    {/* 작은 지도(시안 .mm 자리 · 꼴). 누르면 큰 보기를 지도 ↔ 영상으로. 반납 중에는 숨김(보기 단추로 같은 일) */}
    {!l.releasing && !mrun && <button type="button" className="g dk mm dv-mini" style={{ left: '12px', top: '64px', width: '140px', height: '96px', borderRadius: '16px', overflow: 'hidden', padding: 0 }}
      aria-label={view === 'map' ? '영상 크게' : '지도 크게'} onClick={() => setView(view === 'map' ? 'rgb' : 'map')}>
      {view === 'map' ? <Video fs={real ? fs : null} small /> : <MapView fs={real ? fs : null} />}</button>}
    {/* 오른쪽 줄(시안 .col): 첫 줄(연결 · ⋯)은 머리줄 겹 .u1-top, 아래로 걷기 모드(START 자리) · 보기 · 조종 */}
    <div className="col u1-col">
      <button type="button" className="g dk u1-mode" aria-expanded={sheet === 'policy'} onClick={() => pick(sheet === 'policy' ? null : 'policy')}>
        <b>{gaitNow}</b><span>{GAIT_NOTE[l.state?.gait?.gait ?? ''] ?? '걷기 모드'}</span></button>
      {!mrun && views}   {/* 임무 화면(시안 u1_1)은 보기 줄 대신 왼쪽 지도 시점(u1-vcol) */}
      {mine ? <button type="button" className="g dk btn" style={{ height: '44px', borderRadius: '14px' }} disabled={!!l.releasing} onClick={() => endDrive(r.id, c.go)}>
          <Ic s={18}><path d="M18 6 6 18" /><path d="m6 6 12 12" /></Ic>조종 끝내기</button>
        : <button type="button" className="g dk btn u1-go" style={{ height: '44px', borderRadius: '14px' }} disabled={!!why} aria-describedby={why ? whyId : undefined} onClick={() => start()}>
          <Ic s={18}><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="3" /></Ic>조종</button>}
      {mrun && mrun.status !== 'PAUSED' && l.holder?.type === 'RUN' && <button type="button" className="g dk btn" style={{ height: '44px', borderRadius: '14px' }} disabled={!!why} onClick={() => start()} data-u1-pause>일시정지</button>}
      {mrun && mrun.status === 'PAUSED' && !l.holder && <button type="button" className="g btn u1-resume" style={{ height: '44px', borderRadius: '14px' }} disabled={!!why} onClick={() => start()} data-u1-resume-take>이어 가기</button>}
    </div>
    {/* 「다시 시작」(시안 u1_3 자리 · 정지 위 92 × 48) = 잠금 해제. PC 로봇 탭처럼 확인 창(u4_10 글)을 거친다 */}
    {mine && l.state?.latched !== false && <button type="button" className="g dk btn u1-unlock" style={{ right: '12px', bottom: '88px', width: '92px', height: '48px', borderRadius: '14px', zIndex: 5 }} onClick={restart.open}>
      <Ic s={18}><path d="M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z" /></Ic>다시 시작</button>}
    {/* 말하기(시안 u1_2 · 정지 위 68 × 44). PC 로봇 탭 말하기와 같은 길: 서버 길이 없어 「준비 중」 글만(보냄 0). 「다시 시작」 이 그 자리를 쓰는 동안은 숨김(시안 u1_3) */}
    {!(mine && l.state?.latched !== false) && <button type="button" className="g dk btn u1-talk" style={{ right: '24px', top: '252px', width: '68px', height: '44px', borderRadius: '22px', zIndex: 5 }} onClick={() => say('말하기는 아직 서버에 없습니다')} data-u1-talk>
      <Ic s={18}><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></Ic>말하기</button>}
    {/* Damping(시안 u1_3 은 정지 자리를 Damping 으로 바꿈). 정지 단추(App 공통 층 · Space)는 늘 그 자리에 두고, Damping 은 「다시 시작」 위 같은 폭 · 시안 밖 자리 */}
    {dampOn && <button type="button" className="stop u1-damp" style={{ right: '12px', bottom: '144px', width: '92px', height: '56px', zIndex: 5 }} onClick={damp} data-u1-damp data-off-proto="damp-place">Damping<small>힘 빼기</small></button>}
    {/* 위 띠 줄(시안 .ban): 작은 지도와 오른쪽 줄 사이. red = 출력 지연, amb = 막은 까닭 · 리모컨 */}
    <div className="u1-says">{down
      /* 시안 u1_8: 서버가 끊기면 띠 하나. 시안 「점검」 → 「다시 연결」(rt.reconnect): 폰에 망 점검 화면(u2_5 · u9_4)이 없어 시안 밖 · 새로 그림 */
      ? <p className="ban amb" role="status">서버 연결 안 됨 <button type="button" className="banbt" data-off-proto="reconnect" onClick={() => rt.reconnect()}>다시 연결</button></p>
      : <>
      {hotBand && hot && <div className="g al" role="status" data-temp-band={hotBand}><span className="ico" style={hotBand === 'crit' ? { background: 'rgba(224,74,47,.12)', color: '#b8361f' } : { background: 'rgba(217,162,31,.14)', color: '#a86a00' }}><Ic s={17}>{THERMO}</Ic></span>
        <div style={{ flex: 1, minWidth: 0 }}><b>관절 온도 {Math.round(hot.t)} °C · {TEMP_TEXT[hotBand]}</b><p>{jointName(hot.j)} · 걷기는 계속됩니다</p></div>
        <button type="button" className="bt sbtn" onClick={() => setTempShut(hotBand)}>닫기</button></div>}   {/* 시안 u3_2 · 로봇은 스스로 멈추지 않는다(관제 u5_5 와 같은 뜻) */}
      {!mine && !mrun && ban('u1-who', holderText(l, me, r))}   {/* 임무 화면은 칩 · 카드가 같은 정보(시안 u1_1) */}
      {why && <p className={`ban ${driveBlock(c.user, r) ? 'amb' : 'u1-info'}`} role="status"><span id={whyId} className="fh-why" data-why>{why}</span>
        {l.outgoing && <button type="button" className="banbt" disabled={l.outgoing.canceling} onClick={() => rt.cancel(r.id)}>요청 취소</button>}</p>}
      {stalled && ban('red', STALLED, { 'data-stalled': true })}
      <DriveInputNote devices={rt.now() - l.stateAt < 3000 ? l.state?.devices : null} cls="ban amb" />
      {l.notice && ban('u1-info', l.notice)}
      {ready && (real && ok ? ban('u1-info', REAL_STICK, { 'data-real-stick': true }) : long && ban('u1-info', REAL_WAIT, { 'data-real-wait': true }))}
      {actMsg && ban('u1-info', actMsg, { 'data-act-msg': true })}
      {padWhy && mine && ban('amb', padWhy, { 'data-stick-why': true })}
      {back && mine && real && ok && !combo && !padWhy && !allow(cmdOf(['down'])) && ban('amb', CAP_BLOCK, { 'data-back-block': true })}
      {side && mine && real && ok && !combo && !allow(cmdOf(['left'])) && ban('amb', SIDE_BLOCK, { 'data-side-block': true })}
      {combo && mine && ban('amb', COMBO_BLOCK, { 'data-combo-block': true })}
      {exp && mine && ban('u1-info', DEMO_EXP, { 'data-demo-exp': true })}
      {myRun && <p className="ban u1-info dv-run" role="status" data-u1-runctl><span>임무 {RUN_STATUS[myRun.status]} · {myRun.progress.done}/{myRun.progress.total}</span>
        {runGate ? <span>{runGate}</span> : <button type="button" className="banbt" disabled={runBusy} onClick={() => rt.run(r.id, runMain[0], { run_id: myRun.run_id })}>{runMain[1]}</button>}</p>}
      {myRun && rq?.phase === 'rejected' && ban('amb', runSay(rq.code ?? '', r.name), { 'data-u1-run-why': true })}
      {r.mission && <p className="ban u1-info dv-run"><span>시나리오: {r.mission}</span><span data-run-stop>멈추려면 STOP</span></p>}
    </>}
    </div>
    {/* 손잡이(팀장 11-28 17:33 · PC 로봇 탭과 같은 robotact stickTok): 왼쪽 = 이동(앞 · 뒤 · 옆 · 큰 축 하나), 오른쪽 = 돌기. 문턱 0.3 */}
    {mine && <><Stick cls="stick" label="이동" both shown={[kin.f, kin.s]} on={ready} epoch={0} gen={gen} press={nowRef.current} set={(y, x) => { input.current.st[0] = stickTok('L', -x, -y); input.current.an.f = y; input.current.an.s = x; stickSay(); }} grip={(o) => { input.current.sg[0] = o; }} lift={send} />
      <Stick cls="stick" label="회전" shown={[0, kin.t]} on={ready} epoch={0} gen={gen} press={nowRef.current} set={(x) => { input.current.st[1] = stickTok('R', -x, 0); input.current.an.t = x; stickSay(); }} grip={(o) => { input.current.sg[1] = o; }} lift={send} /></>}
    {/* 설정 확인 알약: 시안 밖 · 새로 그림. 설정을 몰라 입력이 0 이 되는 순간만 동작 줄 위 가운데(10 초 넘으면 위 띠로) */}
    {unknown && zero && !long && <p className="u1-pill" role="status" data-real-wait-pill data-off-proto="settings-pill">{REAL_WAIT_PILL}</p>}
    {mrun && <MissionCards robot={r.id} m={mis} run={mrun} hold={lockFirst?.text} />}
    {/* 아래 동작 줄(시안 u1_2 .act 일곱): 지금 못 누르는 것(순정 확인 전 · 저수준 중 · START 중 일어서기)은 흐리게(.na), 눌러도 보내지 않고 까닭 */}
    <div className="act" aria-label="동작">{ACTS.map(([name, t, em, ic]) => {
      const off = actOff(name, lowlevel), running = l.state?.action_result?.status === 'RUNNING' ? l.state.action_result.action : null;   // 지금 하는 동작 = 로봇 보고(시안 .act .run 초록 테)
      return <button key={name} type="button" className={off ? 'na' : running === name ? 'run' : undefined} data-act={name} onClick={() => doAct(name)}>
        <span><Ic s={17}>{ic}</Ic></span>{t}{off && <em>{name === 'StandUp' ? em : lowlevel ? '저수준 중 안 됨' : '순정 확인 전'}</em>}</button>;
    })}</div>
    {/* 시나리오가 쥔 로봇 «조종 시작» 확인(시안 .scrim + .dlg · 가림막은 손가락을 막지 않음) */}
    {ask && l.holder?.type === 'RUN' && <><div className="scrim" />
      <div className="g dlg dv-ask" role="dialog" aria-labelledby="dv-run-t">
        <div className="h" id="dv-run-t">조종 시작</div>
        <div className="s">{r.name}이 시나리오를 실행 중입니다. 조종을 시작하면 시나리오가 일시정지됩니다.</div>
        <div className="bts"><button type="button" className="dsec" onClick={() => setAsk(false)}>취소</button><button type="button" className="dpri" onClick={() => start(true)}>일시정지하고 조종</button></div>
      </div></>}
    {modeAsk && modeBind.live && <><div className="scrim" />
      <div className="g dlg" role="dialog" aria-label="걷기 모드 바꾸기" data-u1-mode-ask>
        <div className="h">{GAITS.find((x) => x.g === modeAsk)!.name} Mode 로 바꿀까요?</div>
        <div className="s">{l.state?.gait?.gait ? `지금 ${gaitNow} Mode · ${GAIT_NOTE[l.state.gait.gait] ?? ''}.` : '지금 모드는 모릅니다.'} 바꾸는 동안 약 1 초 조종할 수 없습니다. 로봇이 멈춘 상태에서만 바뀝니다.</div>
        <div className="bts"><button type="button" className="dsec" onClick={() => { setModeAsk(null); modeBind.close(); }}>취소</button>
          <button type="button" className="dpri" onClick={() => { const g = modeAsk; setModeAsk(null); modeBind.go(() => gait.press(g)); }}>바꾸기</button></div>
      </div></>}
    {restart.live && <><div className="scrim" />
      <div className="g dlg" role="dialog" aria-label="다시 시작 확인" data-restart-ask>
        <div className="h">{RESTART_ASK(r.name)}</div>
        <div className="s">{RESTART_TEXT}</div>
        <div className="bts"><button type="button" className="dsec" onClick={restart.close}>취소</button>
          <button type="button" className="dpri" onClick={() => restart.go(() => rt.unlock(r.id))}>일어서기</button></div>
      </div></>}
  </div>;

  return <section className="dv ph" style={{ flexBasis: '100%' }} aria-label="조종" onContextMenu={(e) => e.preventDefault()}>
    <div className="dv-body">
      <div className={`dv-stage ${view}`}>
        {view === 'map' ? <MapView fs={real ? fs : null} big /> : <Video fs={real ? fs : null} depth={view === 'depth'} />}
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
const THERMO = <path d="M14 4v10.54a4 4 0 1 1-4 0V4a2 2 0 0 1 4 0Z" />;
/** 관절 온도 단계 글(관제 u5 tempLevel 과 같은 문턱 50 · 60 · 70 °C) */
const TEMP_TEXT: Record<Exclude<Level, null>, string> = { warn: '주의', bad: '경고', crit: '위험' };
const Ic = ({ s, children }: { s: number; children: ReactNode }) => <svg className="ic" viewBox="0 0 24 24" style={{ width: `${s}px`, height: `${s}px` }} aria-hidden="true">{children}</svg>;

/** RGB·뎁스·지도 칸. fs = 서버 drive-media 로 받은 자료(PC serverdrive DriveView · LidarMap 그대로). 받은 값이 없으면 «… 신호 없음 · 까닭» 만(가짜 그림 0 · critique 11-10).
 *  fs 가 없으면(서버 경유가 아닌 로봇) 연결 시도 없이 이유만. 지도 칸 = 라이다 한 판을 위에서 본 그림(지도 만들기는 지도 탭) */
export const REAL_RGB = '실기 영상 준비 중(미연결)';
export const REAL_DEPTH = '뎁스 영상 없음 · 기능 준비 중';
export const REAL_MAP = '지도·라이다 자료 없음 · 기능 준비 중';
type Fs = Record<'rgb' | 'lidar' | 'depth', DriveFeed>;
function Video({ fs, depth, small }: { fs: Fs | null; depth?: boolean; small?: boolean }) {
  if (fs) return <DriveView f={depth ? fs.depth : fs.rgb} ch={depth ? 'depth' : 'rgb'} big={!small} />;
  return <div className="dv-video" role="img" aria-label={depth ? '뎁스 영상' : 'RGB 영상'}>
    {!small && <span>{depth ? REAL_DEPTH : REAL_RGB}</span>}</div>;
}
function MapView({ fs, big }: { fs: Fs | null; big?: boolean }) {
  if (fs) return <LidarMap feed={fs.lidar} empty={driveFeedText(fs.lidar, 'lidar')} small={!big} start="top" bare />;
  return <div className="dv-video" role="img" aria-label="지도·라이다 없음" data-map-none>{big ? <span>{REAL_MAP}</span> : <span>지도 없음</span>}</div>;
}

/** 폰 엄지 조이스틱(03 §5.7): 왼쪽 전후(세로), 오른쪽 회전(가로). both = 세로·가로 두 축(시뮬 왼쪽 상하좌우, set 둘째 값 = 가로, 왼쪽 +).
 *  처음 잡은 손가락(pointerId) 하나만 쓴다 — 그 손가락을 떼기 전까지 다른 손가락은 무시, 떼면 값 0 이고 남은 손가락도 무시(RV-426 ⑩, 실기·시뮬 같게).
 *  잡은 순간의 세대(press(), 없으면 gen)를 적고 지금 세대일 때만 움직인다(on 이 아닐 때 잡으면 앞 세대 -1).
 *  grip = 잡은 손가락의 세대(없으면 null) — 조종 화면은 지금 세대가 아니면 명령 전체를 0 으로. lift = 뗀 뒤(바로 보내기).
 *  cls = 덧붙일 꼴(폰 실기 조종 화면은 시안 u1 .stick).
 *  epoch 가 바뀌거나 처음 붙거나 사라지면 쥔 포인터를 놓고 값 0(부모 축 값도 — RV-426 ⑤). children = 판 위 그림(화살표) */
export function Stick({ label, vertical, both, on, epoch, gen, press, set, grip, lift, children, cls, shown }: { shown?: [number, number]; cls?: string; label: string; vertical?: boolean; both?: boolean; on: boolean; epoch: number; gen: { current: number }; press?: () => number; set: (v: number, side: number) => void; grip?: (n: number | null) => void; lift?: () => void; children?: ReactNode }) {
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
    {/* shown = 키 입력을 같은 손잡이 자리에 보이기만(app-lead 11-28 23:12). 손가락으로 잡은 동안은 손가락 자리 */}
    {(() => { const p = !own.current && shown && (shown[0] || shown[1]) ? shown : k; return <i style={{ transform: `translate(${-p[1] * 36 || 0}px, ${-p[0] * 36 || 0}px)` }} />; })()}
    <span>{label}</span>
  </div>;
}
