// 로봇 탭 u4 틀(11/28 · 시안 proto/screens/u4_1 · u4_4 · u4_5): 왼쪽 .rail 로봇 목록 · 머리 .hdr(이름 · 칸 다섯 · 조종/점검/로봇 설정) ·
// 가운데 .stage3d(고른 로봇 Go2 3D, 지금 받은 자세 그대로) · 오른쪽 .right(조종 = 보기 · 조종 줄 · 조종 칸, 점검 = 순서 점검).
// 이 파일은 배치와 표시만: 조종 · STOP · 조종권 경로는 serverdrive/pcdrive 그대로(조종이 허용된 로봇의 «조종»은 기존 PcDrive). 값은 서버 · 실시간 state 에 있는 것만.
import { useState, type ReactNode } from 'react';
import { rt } from '../rt';
import { holderText } from '../drive';
import { Go2Figure, JOINTS, REPORT_STALE_MS, go2Pose, jointName, useGo2Motion } from '../go2model';
import { go2Temps } from '../pcdrive';
import { FallChip } from '../go2status';
import { NO_SIGNAL } from '../drivemedia';
import { ownerName, robotStatus, type Robot } from '../fake';
import { Seen, attn, linkText, pct, type Ctx } from '../screens';
import { PhoneRelay } from '../phoneRelay';
import './robotframe.css';

export type Tab = 'drive' | 'check';
const POSTURE: Record<string, string> = { STANDING: '서 있음', LYING: '엎드림', TRANSITIONING: '바뀌는 중', UNKNOWN: '모름' };
const deg = (v: number | null | undefined) => (v == null ? '—' : `${Math.round(v)} °C`);

/** 받은 state 가 지금 것인지(남의 로봇 요약 · 서버 끊김은 없음) */
function live(r: Robot) {
  const l = rt.get(r.id), s = r.unknown ? null : l.state, fresh = !!s && rt.now() - l.stateAt < REPORT_STALE_MS;
  return { l, s, fresh, ago: s ? (rt.now() - l.stateAt) / 1000 : 0 };
}

const DogIcon = () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
  <path d="M4 10h11l3-3h2v3l-2 2v2H6l-2 2v3M8 14v5M15 14v5" /></svg>;

/** .rail 한 줄(.rcard): 아이콘 · 이름 · 한 줄(연결 · 담당 · 임무 · 주의) · 배터리. sub = 운영 관리자가 보는 남의 로봇(«보는 중») */
export function RailCard({ x, on, open, watching }: { x: Robot; on: boolean; open: (id: string) => void; watching?: boolean }) {
  const st = robotStatus(x), a = attn(x);
  const line = [st.text === linkText(x) ? '' : st.text, linkText(x), ownerName(x) + (watching ? ' · 보는 중' : ''), x.mission, a && `▲ ${a}`].filter(Boolean).join(' · ');
  return <li><button type="button" className="rcard" aria-pressed={on} data-robot-row={x.id} data-tone={st.tone} onClick={() => open(x.id)} title={st.text}>
    <span className="av"><DogIcon /></span>
    <span className="rc-main"><b>{x.name}</b><FallChip x={x} /><small data-link-text>{line}</small><small className="rc-seen"><Seen x={x} /><PhoneRelay report={x.phoneRelay} receivedAt={x.phoneRelayAt} compact /></small></span>
    <span className="rc-bat">{pct(x.battery)}</span>
  </button></li>;
}

/** .hdr: 이름 + 칸 다섯(연결 · 자세 · 배터리 · 관절 온도 · 조종자) + 조종/점검 + 로봇 설정(창) */
export function Head({ c, r, tab, setTab, settings }: { c: Ctx; r: Robot; tab: Tab; setTab: (t: Tab) => void; settings?: () => void }) {
  const { l, s, fresh, ago } = live(r), temps = go2Temps(s, fresh, ago), lost = !!r.status && !r.online;
  const cell = (k: string, v: ReactNode, small: ReactNode, bad = false) => <span className={`u4-g st${bad ? ' bad' : ''}`} data-cell={k}>{v}<small>{small}</small></span>;
  const hot = temps && temps.hot >= 0 ? temps.joints[temps.hot] : null;
  return <div className="hdr" data-robot-head>
    <h2 className="ttl">{r.name}</h2>
    {cell('link', linkText(r), r.unknown === 'summary' ? '요약만' : s ? `${ago.toFixed(1)}초 전 보고` : '보고 없음', lost)}
    {cell('posture', POSTURE[s?.posture?.state ?? ''] ?? '—', '자세')}
    {cell('battery', pct(r.battery), '배터리')}
    {cell('temp', deg(hot), hot == null ? '관절 온도 없음' : `최고 관절 ${jointName(JOINTS[temps!.hot])}`)}
    {cell('holder', holderText(l, c.user.id, r), '조종자')}
    <div className="seg2" role="group" aria-label="로봇 보기">
      <button type="button" aria-pressed={tab === 'drive'} onClick={() => setTab('drive')} data-seg="drive">조종</button>
      <button type="button" aria-pressed={tab === 'check'} onClick={() => setTab('check')} data-seg="check">점검</button>
      {settings && <button type="button" aria-pressed={false} onClick={settings} data-seg="settings" data-open-settings>로봇 설정</button>}
    </div>
  </div>;
}

/** .stage3d: 고른 로봇 Go2 3D(받은 관절 · 자세 그대로, 끌어서 돌려 보기). 보고가 없으면 그림만 흐리고 한 줄 */
export function Stage({ r }: { r: Robot }) {
  const { s, fresh, ago } = live(r), pose = go2Pose(s, fresh), temps = go2Temps(s, fresh, ago), motion = useGo2Motion(s?.robot_info, pose);
  const sp = s?.speed;
  return <section className="stage3d" aria-label="로봇 3D" data-robot-3d={r.id} data-stale={pose ? undefined : ''}>
    <div className="s3-fig"><Go2Figure pose={pose} motion={motion} temps={temps?.joints} /></div>
    {!pose && <span className="u4-g s3-none" role="status">{r.unknown === 'summary' ? '남의 로봇은 서버가 실시간 자세를 보내지 않습니다' : '로봇 보고 없음 · 자세를 지어내지 않습니다'}</span>}
    <div className="foot">
      <span className="u4-g tag" style={{ color: sp ? 'var(--u4-pr3)' : undefined }} data-foot="speed">{sp == null ? '속도 보고 없음' : sp > 0.05 ? `걷는 중 · ${sp.toFixed(1)} m/s` : '제자리'}</span>
      <span className="mu2">받은 관절 값으로 그린 모습입니다</span>
    </div>
  </section>;
}

type V = 'map' | 'rgb' | 'lidar' | 'depth';
const VSEL: [V, string][] = [['map', '지도'], ['rgb', '카메라'], ['lidar', '라이다'], ['depth', '깊이']];
/** .views: 지도 · 카메라 · 라이다 · 깊이(보기 고르기) + 작은 카메라 창 + 임무 카드 + 오른쪽 아래 «조종 화면 열기».
 *  영상은 조종 화면(서버 경유)에서만 받는다. 여기는 없는 까닭 한 줄 */
export function Views({ r, map, why, drive }: { r: Robot; map: ReactNode; why: string; drive?: ReactNode }) {
  const [v, setV] = useState<V>('map');
  return <section className="views" aria-label="로봇 보기">
    <div className={`v-body${v === 'map' ? '' : ' full'}`}>{v === 'map' ? <section className="fl-map" aria-label="지도">{map}</section> : <p className="mu2" style={{ padding: '120px 24px' }} data-no-signal={v}>{NO_SIGNAL[v]} · {why}</p>}</div>
    <div className="u4-g vsel" role="group" aria-label="보기">{VSEL.map(([id, t]) => <button key={id} type="button" aria-pressed={v === id} onClick={() => setV(id)} data-view={id}>{t}</button>)}</div>
    <div className="small" data-cam-inset><span>앞 카메라 영상 없음<br />{why}</span><span className="cl">앞 카메라</span></div>
    <div className="u4-g job" data-job>{r.mission ? <><b>{r.mission}</b><span>진행 단계 · 남은 거리는 서버가 아직 보내지 않습니다</span></> : <><b>임무 없음</b><span>이 로봇에 실행 중인 임무가 없습니다</span></>}</div>
    {drive && <div className="vslot">{drive}</div>}
  </section>;
}

/** .ctl + .deck(조종 전): 조종 시작 · 말하기 · 키 안내 · 자세 단추. 조종이 열리기 전에는 흐리게 + 까닭 한 줄(입력 없음) */
export function Deck({ why, nodrive }: { why: string; nodrive?: boolean }) {
  return <>
    <div className="ctl" data-ctl>
      <span className="u4-g" aria-disabled="true">조종 전</span>
      <span className="u4-g talk" aria-disabled="true" data-talk title="웹 말하기는 서버 길이 아직 없습니다">말하기</span>
      <span className="u4-g keys"><span><kbd>↑</kbd><kbd>↓</kbd>앞뒤</span><span><kbd>←</kbd><kbd>→</kbd>옆걸음</span><span><kbd>A</kbd><kbd>D</kbd>돌기</span><span><kbd>Space</kbd>정지</span></span>
    </div>
    <div className="deck dim" data-deck>
      <p className="why" data-deck-why data-admin-nodrive={nodrive || undefined}>{why}</p>
      <p className="mu2 d-ctl" style={{ margin: 0, fontSize: 12.5 }}>조종 화면에서 키와 자세 단추(일어서기 · 엎드리기)를 씁니다. 말하기 · 걷기 모드 전환 · 앉기 · 기지개 · 악수 · 하트 · 인사는 웹에 서버 명령이 아직 없습니다.</p>
    </div>
  </>;
}
