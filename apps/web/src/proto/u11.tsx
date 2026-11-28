// 시안 u11 오류 · 빈 화면 겹 부품. 시안 u11_1 ~ u11_5 는 u4 로봇 화면 위에 얹히는 겹이라 부품만 두고(붙일 자리는 PR 본문),
// u11_6 · u11_7 · u11_8 은 화면 전체 빈 칸. 글 · 클래스 · 순서는 시안 그대로, 값은 rt(조종권 · 연결) · 에이전트 장치 줄에서만 온다.
// 버튼은 기존 동작만 부른다(rt.respond · rt.cancel). Enter · Space 로는 고르지 않는다(Space = 정지 키, 시안 u11_1 문구).
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Device } from '../../../contracts/ts';
import { rt, useLive, type Link, type Live } from '../rt';
import { REPORT_STALE_MS } from '../go2model';
import './u11.css';

const I = (w: number, d: ReactNode) => <svg className="ic" viewBox="0 0 24 24" style={{ width: `${w}px`, height: `${w}px` }}>{d}</svg>;
const HAND = <path d="M8 13V5.5a1.5 1.5 0 0 1 3 0V11M11 10V4.5a1.5 1.5 0 0 1 3 0V11M14 10.5V6a1.5 1.5 0 0 1 3 0v8a6 6 0 0 1-6 6h-1a5 5 0 0 1-4-2l-2.5-3.5a1.5 1.5 0 0 1 2.4-1.8L8 14" />;
const SWAP = <><path d="M8 3 4 7l4 4" /><path d="M4 7h16" /><path d="m16 21 4-4-4-4" /><path d="M20 17H4" /></>;
const WARN = <><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" /><path d="M12 9v4" /><path d="M12 17h.01" /></>;
const CHECK = <><circle cx="12" cy="12" r="10" /><path d="m9 12 2 2 4-4" /></>;
const CLOCK = <><circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" /></>;
const WIFI_OFF = <><path d="M12 20h.01" /><path d="M8.5 16.429a5 5 0 0 1 7 0" /><path d="M5 12.859a10 10 0 0 1 5.17-2.69" /><path d="M19 12.859a10 10 0 0 0-2.007-1.523" /><path d="M2 8.82a15 15 0 0 1 4.177-2.643" /><path d="M22 8.82a15 15 0 0 0-11.288-3.764" /><path d="m2 2 20 20" /></>;
const PLUS = <><path d="M5 12h14" /><path d="M12 5v14" /></>;
export const DOG = <><path d="M4 13h11l3-3h2v4l-2 1H5z" /><path d="M6 15l-1 4M10 15v4M14 15l1 4M17 15l1 4" /></>;
const noKey = (e: { key: string; preventDefault: () => void }) => { if (e.key === 'Enter' || e.key === ' ') e.preventDefault(); };   // 고르지 않음 · 정지 키(Space)는 위로 그대로

/** u11_1 조종권 요청 창(내가 조종 중일 때 rt.incoming). 남은 시간 막대 · 계속 조종 = 거절 · 넘기기 = 수락(rt.respond) */
export function TakeoverAsk({ robot, q, now, answer }: { robot: string; q: NonNullable<Live['incoming']>; now: number; answer: (accept: boolean) => void }) {
  const left = Math.max(0, q.until - now), s = Math.ceil(left / 1000);
  return <>
    <div className="veil" />
    <div className="g modal" style={{ width: '600px', zIndex: 6 }} role="dialog" aria-modal="true" aria-label="조종권 요청" data-takeover-ask>
      <div className="row" style={{ gap: '14px' }}><span style={{ width: '48px', height: '48px', borderRadius: '15px', background: 'var(--u11-ok-bg)', color: 'var(--u11-ok)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{I(24, HAND)}</span>
        <div><div style={{ fontSize: '20px', fontWeight: 800, color: '#1f2421' }}>{q.name} 님이 {robot} 조종권을 요청했습니다</div><div style={{ fontSize: '14.5px', fontWeight: 600, color: '#5e6662', marginTop: '4px' }}>넘겨주시겠습니까?</div></div></div>
      <div className="tbar"><i style={{ width: `${Math.round((left / q.ms) * 100)}%` }}></i></div>
      <div className="row" style={{ justifyContent: 'space-between', marginTop: '8px', fontSize: '12.5px', fontWeight: 600, color: '#5e6662' }}><span>{s} 초 안에 답하지 않으면 조종권을 넘기지 않습니다</span><span>Enter · Space 키로는 선택되지 않습니다</span></div>
      <div style={{ display: 'flex', gap: '10px', marginTop: '22px' }}>
        <button type="button" className="mbtn sec" style={{ flex: '1 1 0' }} onKeyDown={noKey} onClick={(e) => { if (e.detail) answer(false); }} data-keep>계속 조종</button>
        <button type="button" className="btnp mbtn" style={{ flex: '1 1 0' }} onKeyDown={noKey} onClick={(e) => { if (e.detail) answer(true); }} data-give>{I(18, SWAP)}넘기기</button></div>
      <p style={{ fontSize: '12.5px', color: '#5e6662', fontWeight: 600, marginTop: '14px' }}>넘기면 로봇을 그 자리에 세워 잠근 뒤 조종권이 넘어갑니다.</p>
    </div></>;
}

/** 옛 조종 화면(drive.tsx Drive)이 지금 그리고 있는 로봇. 그 화면은 자기 요청 창(.dv-ask)을 그리므로 PcAsk 는 비켜 준다 */
export const askShown = new Set<string>();
/** PC 시안 틀 어느 탭에서나 u11_1: 내가 조종 중인 로봇에 온 요청(rt.incoming). 답은 rt.respond 만. 남은 시간이 지나면 창을 내림(판정은 서버) */
export function PcAsk({ robots }: { robots: readonly { id: string; name: string }[] }) {
  const r = robots.find((x) => { const l = rt.get(x.id); return !!l.lease && !!l.incoming && !askShown.has(x.id); });
  const q = r ? rt.get(r.id).incoming : null;
  const [now, setNow] = useState(() => rt.now());
  useEffect(() => { if (!q) return; setNow(rt.now()); const t = setInterval(() => setNow(rt.now()), 250); return () => clearInterval(t); }, [q?.id]);
  if (!r || !q || q.until <= now) return null;
  return <TakeoverAsk robot={r.name} q={q} now={now} answer={(accept) => rt.respond(r.id, accept)} />;
}

/** 에이전트가 보낸 «화면 조종이 막힌 까닭» 줄(driveinput.tsx 와 같은 key) 중 리모컨 쪽이면 그 글(시안 u11_4). 글은 에이전트 것 그대로 */
export const remoteWhy = (devices?: readonly Device[] | null) => { const t = devices?.find((d) => d.key === 'go2-drive-input')?.label?.trim(); return t && t.startsWith('리모컨') ? t : null; };

export type LineKind = 'err' | 'amb' | 'ok';
export type DriveLineFacts = { kind: LineKind; title: string; sub: string; at: 'link' | 'remote' | 'ask' | 'handed' };
/** 조종 화면 위 한 줄(시안 .line1 over) 하나를 고른다: 서버 끊김 → 리모컨 우선 → 내 요청 기다림 → 넘겨줌 */
export function driveLine(o: { link: Link; l: Live; me: string; now: number; handedTo: string | null; fresh: boolean }): DriveLineFacts | null {
  const { link, l, now } = o;
  if (link.at === 'lost' || link.at === 'denied') return { kind: 'err', title: '서버와 연결이 끊겼습니다', sub: link.at === 'denied' ? '서버가 연결을 받지 않습니다' : '다시 연결하는 중입니다', at: 'link' };
  const remote = o.fresh ? remoteWhy(l.state?.devices) : null;
  if (remote) return { kind: 'amb', title: '리모컨이 우선입니다', sub: remote, at: 'remote' };
  if (l.outgoing && !l.lease) return { kind: 'amb', title: `${l.holder?.name || '조종하는 사람'} 님에게 조종권을 요청했습니다`, sub: l.outgoing.canceling ? '요청을 취소하는 중입니다' : `답을 기다리는 중 · ${Math.max(0, Math.ceil((l.outgoing.until - now) / 1000))} 초`, at: 'ask' };
  if (o.handedTo && !l.lease) return { kind: 'ok', title: `조종권을 ${o.handedTo} 님에게 넘겼습니다`, sub: '보기 전용입니다 · 정지 버튼은 계속 쓸 수 있습니다', at: 'handed' };
  return null;
}
/** 넘겨준 상대: 내가 수락(busy give)한 뒤 조종권자가 남(사람)이 되면 그 이름. 다시 내 조종권이 되면 지움 */
export function useHanded(l: Live, me: string) {
  const [to, setTo] = useState<string | null>(null), giving = useRef(false);
  useEffect(() => {
    if (l.busy === 'give') giving.current = true;
    if (l.lease) { giving.current = false; setTo(null); return; }
    if (giving.current && l.holder && l.holder.type === 'USER' && l.holder.id !== me) { giving.current = false; setTo(l.holder.name); }
  }, [l.busy, l.lease, l.holder?.id, l.holder?.type, me]);
  return to;
}
const LINE_IC: Record<DriveLineFacts['at'], ReactNode> = { link: WIFI_OFF, remote: WARN, ask: CLOCK, handed: CHECK };
/** 핫스팟으로 바꾸기 안내(폰 «주변 로봇 찾기» 와 같은 글). 웹은 Wi-Fi 를 바꾸지 못하므로 사람이 할 단계만 */
export const HOT_TOP = '이 앱은 폰 Wi-Fi 를 바꾸지 못합니다 · 아래 순서대로 폰 설정에서 직접 바꾸세요.';
export const HOT_STEPS = [
  '로봇 전원을 켜고 핫스팟이 보일 때까지 기다립니다.',
  '폰 설정 › Wi-Fi 에서 로봇 핫스팟을 고릅니다. 이름과 비밀번호는 로봇 설명서나 관리자에게 확인하세요. 에이전트를 돌리는 노트북도 같은 핫스팟에 붙여야 합니다.',
  '핫스팟에는 인터넷이 없을 수 있어 그동안 서버 연결이 끊길 수 있습니다.',
];
const HOT = <><path d="M16.247 7.761a6 6 0 0 1 0 8.478" /><path d="M19.075 4.933a10 10 0 0 1 0 14.134" /><path d="M4.925 19.067a10 10 0 0 1 0-14.134" /><path d="M7.753 16.239a6 6 0 0 1 0-8.478" /><circle cx="12" cy="12" r="2" /></>;
/** 서버 끊김 줄 오른쪽 «핫스팟으로 바꾸기»(시안 u11_5 #go-hot 단추 그대로). 제목은 끊긴 까닭을 지어내지 않고 지금 글 그대로(조정 22:27).
 *  누르면 펼치는 안내 칸은 시안 밖 · 새로 그림(줄 바로 아래 같은 너비) */
function HotBtn() {
  const [open, setOpen] = useState(false);
  return <>
    <span className="btns" style={{ marginLeft: 'auto', height: '40px', padding: '0 14px', fontSize: '13.5px' }} role="button" tabIndex={0} aria-expanded={open} aria-controls="line-hotspot" data-hot
      onClick={() => setOpen(!open)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); setOpen(!open); } }}>{I(16, HOT)}핫스팟으로 바꾸기</span>
    {open && <div id="line-hotspot" className="g" data-hotspot-guide style={{ position: 'absolute', left: 0, right: 0, top: '64px', padding: '14px 18px', borderRadius: '16px', fontSize: '13.5px', fontWeight: 600, lineHeight: 1.6 }}>
      <p>{HOT_TOP}</p><ol style={{ paddingLeft: '18px', marginTop: '6px' }}>{HOT_STEPS.map((t) => <li key={t}>{t}</li>)}<li>서버 연결이 돌아오면 이 줄이 사라집니다.</li></ol></div>}</>;
}
export function DriveLine({ f, children }: { f: DriveLineFacts; children?: ReactNode }) {
  return <div className={`line1 ${f.kind} over`} role="status" data-drive-line={f.at}>{I(19, LINE_IC[f.at])}{f.title}<small>{f.sub}</small>{f.at === 'link' && <HotBtn />}{children}</div>;
}

/** 시안 u4 조종 화면 위 한 줄(u11_2 ~ u11_5): 그 로봇의 rt 값만 읽어 driveLine 이 고른 줄 하나, 없으면 아무것도 안 그림.
 *  리모컨 줄은 에이전트 장치 줄 글 그대로이고, 1 초 넘게 지난 상태의 글은 쓰지 않는다(REPORT_STALE_MS). 요청 기다림 줄의 남은 초는 250 ms 마다 다시 셈 */
export function useRobotLine(id: string, me: string): DriveLineFacts | null {
  const l = useLive(id), handedTo = useHanded(l, me), [, tick] = useState(0), waiting = !!l.outgoing;
  useEffect(() => { if (!waiting) return; const t = setInterval(() => tick((n) => n + 1), 250); return () => clearInterval(t); }, [waiting]);
  const now = rt.now();
  return driveLine({ link: rt.link(), l, me, now, handedTo, fresh: !!l.state && now - l.stateAt < REPORT_STALE_MS });
}
/** 줄 하나만 그리는 짧은 꼴. 자리의 다른 글을 비켜야 하는 화면은 useRobotLine 값으로 DriveLine 을 직접 그린다 */
export function RobotLine({ id, me }: { id: string; me: string }) {
  const f = useRobotLine(id, me);
  return f ? <DriveLine f={f} /> : null;
}

// ── u11_6 ~ u11_8 빈 화면(시안 .pane.empty · 그림은 시안 svg 그대로) ──
/** 시안 u11_6 ~ u11_8 빈 화면 그림(svg 속 문자열 그대로). 지도 탭(u7 고르기) 빈 칸도 같은 그림을 쓴다 */
export const ART: Record<'robots' | 'map' | 'log', string> = {"robots": "<g stroke=\"rgba(255,255,255,.07)\" stroke-width=\"1\"><path d=\"M160 310 l-200 100\" /><path d=\"M200 290 l-200 100\" /><path d=\"M240 270 l-200 100\" /><path d=\"M280 250 l-200 100\" /><path d=\"M320 230 l-200 100\" /><path d=\"M360 210 l-200 100\" /><path d=\"M400 190 l-200 100\" /><path d=\"M400 310 l200 100\" /><path d=\"M360 290 l200 100\" /><path d=\"M320 270 l200 100\" /><path d=\"M280 250 l200 100\" /><path d=\"M240 230 l200 100\" /><path d=\"M200 210 l200 100\" /><path d=\"M160 190 l200 100\" /></g><ellipse cx=\"280\" cy=\"300\" rx=\"200\" ry=\"26\" fill=\"rgba(0,195,137,.08)\"/><g stroke=\"rgba(255,255,255,.30)\" stroke-width=\"1.6\" stroke-dasharray=\"5 6\" fill=\"none\"><rect x=\"130\" y=\"40\" width=\"300\" height=\"270\" rx=\"24\"/></g><image href=\"../assets/real/go2_34_tight.png?v=1128042956\" x=\"150\" y=\"62\" width=\"260\" height=\"236\" preserveAspectRatio=\"xMidYMid meet\" opacity=\".78\"/>", "map": "<g stroke=\"rgba(255,255,255,.07)\" stroke-width=\"1\"><path d=\"M160 310 l-200 100\" /><path d=\"M200 290 l-200 100\" /><path d=\"M240 270 l-200 100\" /><path d=\"M280 250 l-200 100\" /><path d=\"M320 230 l-200 100\" /><path d=\"M360 210 l-200 100\" /><path d=\"M400 190 l-200 100\" /><path d=\"M400 310 l200 100\" /><path d=\"M360 290 l200 100\" /><path d=\"M320 270 l200 100\" /><path d=\"M280 250 l200 100\" /><path d=\"M240 230 l200 100\" /><path d=\"M200 210 l200 100\" /><path d=\"M160 190 l200 100\" /></g><ellipse cx=\"280\" cy=\"300\" rx=\"200\" ry=\"26\" fill=\"rgba(0,195,137,.08)\"/><g fill=\"none\" stroke-linejoin=\"round\"><path d=\"M120 200l160-80 160 80-160 80z\" fill=\"rgba(255,255,255,.03)\" stroke=\"rgba(255,255,255,.25)\" stroke-width=\"1.6\" stroke-dasharray=\"6 6\"/><path d=\"M180 200l100-50 100 50\" stroke=\"rgba(0,195,137,.6)\" stroke-width=\"2.2\" stroke-linecap=\"round\"/><circle cx=\"380\" cy=\"200\" r=\"9\" fill=\"#00c389\" stroke=\"#fff\" stroke-width=\"2.5\"/><circle cx=\"380\" cy=\"200\" r=\"22\" fill=\"none\" stroke=\"rgba(0,195,137,.35)\" stroke-width=\"1.6\"/></g>", "log": "<g stroke=\"rgba(255,255,255,.07)\" stroke-width=\"1\"><path d=\"M160 310 l-200 100\" /><path d=\"M200 290 l-200 100\" /><path d=\"M240 270 l-200 100\" /><path d=\"M280 250 l-200 100\" /><path d=\"M320 230 l-200 100\" /><path d=\"M360 210 l-200 100\" /><path d=\"M400 190 l-200 100\" /><path d=\"M400 310 l200 100\" /><path d=\"M360 290 l200 100\" /><path d=\"M320 270 l200 100\" /><path d=\"M280 250 l200 100\" /><path d=\"M240 230 l200 100\" /><path d=\"M200 210 l200 100\" /><path d=\"M160 190 l200 100\" /></g><ellipse cx=\"280\" cy=\"300\" rx=\"200\" ry=\"26\" fill=\"rgba(0,195,137,.08)\"/><g fill=\"none\" stroke-linecap=\"round\"><rect x=\"170\" y=\"110\" width=\"220\" height=\"180\" rx=\"18\" fill=\"rgba(255,255,255,.04)\" stroke=\"rgba(255,255,255,.25)\" stroke-width=\"1.6\"/><path d=\"M200 150h120M200 190h160M200 230h90\" stroke=\"rgba(255,255,255,.16)\" stroke-width=\"10\"/><circle cx=\"380\" cy=\"270\" r=\"34\" fill=\"rgba(0,195,137,.10)\" stroke=\"#00c389\" stroke-width=\"2\"/><path d=\"M380 254v16l10 8\" stroke=\"#00c389\" stroke-width=\"2.2\"/></g>"};
export function EmptyPane({ kind, title, why, act, control }: { kind: 'robots' | 'map' | 'log'; title: string; why: string; act?: { label: string; href: string }; control?: boolean }) {
  return <div className="pane empty" data-empty={kind} data-empty-control={control || undefined} aria-label={title}><svg className="art" viewBox="0 0 560 340" aria-hidden="true" dangerouslySetInnerHTML={{ __html: ART[kind] }} />
    <h2>{title}</h2><p>{why}</p>
    {act && <a className="btnp" href={act.href}>{I(18, kind === 'robots' ? PLUS : DOG)}{act.label}</a>}</div>;
}
export const EmptyRobots = ({ control }: { control?: boolean }) => <EmptyPane control={control} kind="robots" title="등록된 로봇이 없습니다" why="폰에 뜬 QR 을 로봇 앞 카메라에 보여 주면 연결됩니다. 연결하면 여기에 보입니다." act={{ label: '로봇 연결', href: '#/fleet' }} />;
export const EmptyMap = () => <EmptyPane kind="map" title="아직 지도가 없습니다" why="로봇을 조종해 한 바퀴 걸으면 지도가 만들어집니다." act={{ label: '로봇 탭으로', href: '#/fleet' }} />;
export const EmptyLog = () => <EmptyPane kind="log" title="아직 기록이 없습니다" why="임무를 실행하거나 알림이 생기면 여기에 시간 순서로 남습니다." />;
