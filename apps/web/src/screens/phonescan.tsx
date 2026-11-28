// 폰 지도 스캔 본체(u14_2): 담당 운영자가 폰으로 로봇을 움직이며 층 지도를 모은다. 입구는 scanentry.tsx(붙이기 끝 · ⋯ «지도 스캔»).
// 꼴 = 시안 u14_2 (proto/screens/u14_2_phone_scan.html): 왼쪽 위 로봇 칩(.tl) · 작은 지도(.sm) · 아래 진행 줄(.sp). 마크업은 시안 그대로, 단추 span 은 button.
// 시안의 조종 판(카메라 · 조이스틱 · 동작 단추 · 걸음 · 말하기 · 정지)은 이 칸이 아니라 폰 조종 화면 몫이라 그리지 않는다(정지는 폰 머리줄 STOP 그대로).
// 요청은 PC 지도 탭 «지도 만들기»(mapmake.tsx)와 같은 길: 시작 · 끝내기(저장) · 취소 = api.slamDo start · save · cancel, 진행 = 1초마다 api.slam. 시작은 고른 층 + source=point_lio.
// 진행 값(스캔 시간 · 걸은 거리 · 모은 점)은 서버 MappingProgress 그대로이고 이상한 값은 칸째 뺀다. 서버에 멈춤(pause) 길이 없어 시안의 멈춤 단추는 두지 않는다.
// 위치 인식은 서버 location.confidence 수 그대로(시안 「좋음」 같은 말로 나눌 기준이 아직 없다). 이 파일은 주행 명령을 만들지 않는다.
// 시안 밖(같은 결로 새로 그림): 시작 전 칸(층 고르기 · 스캔 시작, 시안 .dlg), 취소 확인(시안 .scrim + .dlg), 오른쪽 «취소» · «닫기»(시안 .col 단추), 상태 · 오류 한 줄(u142.app.css)
import { useEffect, useState, type ButtonHTMLAttributes, type CSSProperties, type ReactNode } from 'react';
import type { MappingProgress } from '../../../contracts/ts';
import '../proto/ui.pv.css';
import '../proto/light.pv.css';
import './u142.css';
import './u142.app.css';
import { api, type ApiFail } from '../api';
import type { Robot, User } from '../fake';
import { useTheme } from '../theme';
import type { Place } from './maps';
import { actFail, clock, failText, makers, meters, points } from './mapmake';
import { SlamGrid, useSlamLive } from './slammap';

/** 조회를 이어가는 상태(그 밖 = 끝남) · 진행 화면을 여는 상태 */
const LIVE = new Set(['STARTING', 'RUNNING', 'SAVING', 'FINALIZING', 'UNKNOWN']), OPEN = new Set([...LIVE, 'FAILED']);
const ok = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 0;
const WALK = [['elapsed_s', 'time', '스캔 시간', clock], ['distance_m', 'dist', '걸은 거리', meters], ['point_count', 'points', '모은 점', points]] as const;
const placeName = (p?: Place) => (p ? `${p.site.name} ${p.building.name} ${p.floor.name}` : '다른 층');
const STATE_TEXT: Partial<Record<MappingProgress['status'], string>> = {
  STARTING: '시작하는 중… 로봇이 지도 기능을 켜고 있습니다.', RUNNING: '스캔 중 · 로봇을 천천히 움직이세요.',
  SAVING: '지도를 저장하는 중… 마무리까지 시간이 걸릴 수 있습니다.', FINALIZING: '지도를 저장하는 중… 마무리까지 시간이 걸릴 수 있습니다.',
  SAVED: '스캔한 지도를 저장했습니다. PC 지도 탭에서 확인하세요.', CANCELLED: '스캔을 취소했습니다.',
};
export const SCAN_HINT = '시작한 뒤 조종 화면으로 로봇을 천천히 움직이고, 다 돌면 «스캔 끝내기»를 누릅니다.';

const Ic = ({ s, children }: { s: number; children: ReactNode }) => <svg className="ic" viewBox="0 0 24 24" style={{ width: `${s}px`, height: `${s}px` }} aria-hidden="true">{children}</svg>;
const X = <><path d="M18 6 6 18" /><path d="m6 6 12 12" /></>, BACK = <path d="m15 18-6-6 6-6" />;

/** 화면 틀(시안 u14_2 바탕 + 왼쪽 위 로봇 칩 + 오른쪽 단추 줄). robot 이 없으면 칩 없이 */
export function ScanFrame({ robot, live, side, children }: { robot?: Robot; live?: boolean; side?: ReactNode; children?: ReactNode }) {
  const light = useTheme()[1];
  return <section className={`proto pv u142${light ? ' light' : ''}`} aria-label="지도 스캔" data-scan={robot ? '' : undefined} data-scan-panel>
    {robot && <div className="tl">
      <div className="g dk row" style={{ left: '12px', top: '12px', height: '44px', padding: '0 12px 0 7px', gap: '9px' }}>
        <span style={{ width: '30px', height: '30px', borderRadius: '10px', background: 'var(--pr)', position: 'relative', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: '#fff' }}>
          <Ic s={17}><path d="M4 13h11l3-3h2v4l-2 1H5z" /><path d="M6 15l-1 4M10 15v4M14 15v4M17 15l1 4" /></Ic>
          <span className="op"><Ic s={10}><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></Ic></span></span>
        <span className="chipnum">{robot.name}</span>
        {ok(robot.battery) && <span className="bat" style={{ marginLeft: 0, '--soc': `${Math.min(100, robot.battery)}%` } as CSSProperties} data-scan-bat><i />{robot.battery} %</span>}
        <span style={{ fontSize: '12px', marginLeft: '2px', fontWeight: 700, color: '#18a07e' }}>{live ? '지도 스캔 중' : '지도 스캔'}</span>
      </div>
    </div>}
    {side && <div className="col">{side}</div>}
    {children}
  </section>;
}
/** 오른쪽 단추(시안 .col 의 «지도로» 결) */
export const SideBtn = ({ ic, text, ...p }: { ic: ReactNode; text: string } & ButtonHTMLAttributes<HTMLButtonElement>) =>
  <button type="button" className="g dk btn" style={{ height: '44px', borderRadius: '14px' }} {...p}><Ic s={18}>{ic}</Ic>{text}</button>;
export const CLOSE_IC = BACK;

/** 작은 지도: 받은 2D 조각을 시안 .sm 칸에(screens/slammap.tsx SlamGrid · 칸 뜻 표는 작은 칸이라 뺌) */
function MiniMap({ robot, p, conf }: { robot: string; p: MappingProgress; conf?: number | null }) {
  const pic = useSlamLive(robot, p), any = pic.patches.length > 0;
  return <div className="sm" data-scan-map>
    <div style={{ position: 'absolute', inset: 0 }} data-slam-view="2d">{any ? <SlamGrid pic={pic} legend={false} /> : <p className="u142-empty">아직 받은 지도가 없습니다.</p>}</div>
    {ok(conf) && <div className="h" data-scan-conf>위치 인식 <b style={{ color: '#2fd39a' }}>{conf.toFixed(2)}</b></div>}
  </div>;
}

export function PhoneScan({ user, robot, places, cancel, close, pick }: { user: User; robot: Robot; places: Place[]; cancel?: AbortSignal; close?: () => void; pick?: ReactNode }) {
  const mine = makers(user, [robot]).length > 0;
  const [prog, setProg] = useState<MappingProgress | null | undefined>(), [n, setN] = useState(0), [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(''), [ask, setAsk] = useState(false);
  const [floor, setFloor] = useState(() => (places.find((x) => x.floor.id === robot.location?.floor_id) ?? places[0])?.floor.id ?? '');
  // 1초마다 조회(진행 중인 동안만). 언마운트는 AbortSignal 로 진행 중 요청까지 거둔다
  useEffect(() => {
    if (!mine) return;
    const ac = new AbortController(), off = () => ac.abort();
    let t: ReturnType<typeof setTimeout> | undefined;
    cancel?.addEventListener('abort', off);
    const go = async () => {
      try {
        const x = (await api.slam(robot.id, ac.signal)) ?? null;
        if (ac.signal.aborted) return;
        setProg(x);
        if (x && LIVE.has(x.status)) t = setTimeout(go, 1000);
      } catch (e) {
        const f = e as ApiFail;
        if (f.code === 'CANCELED' || ac.signal.aborted) return;
        setMsg(`진행 상황을 받지 못했습니다. ${f.message}`);
        if (f.status === 0 || f.status >= 500) t = setTimeout(go, 1000);
      }
    };
    go();
    return () => { ac.abort(); clearTimeout(t); cancel?.removeEventListener('abort', off); };
  }, [robot.id, n, mine]);
  const act = async (op: 'start' | 'save' | 'cancel') => {
    if (busy) return;
    setBusy(true); setMsg(''); setAsk(false);
    try { setProg(await api.slamDo(robot.id, op, op === 'start' ? { floor_id: floor, source: 'point_lio' } : { session_id: prog!.session_id }, cancel)); }
    catch (e) { const f = e as ApiFail; if (f.code !== 'CANCELED') setMsg(actFail(f)); }
    finally { setBusy(false); setN((k) => k + 1); }
  };

  const p = mine && prog && OPEN.has(prog.status) ? prog : null, conf = robot.location?.confidence;
  const side = <>{pick}{p && !ask && <SideBtn ic={X} text="취소" disabled={busy} onClick={() => setAsk(true)} data-scan-cancel />}
    {close && <SideBtn ic={BACK} text="닫기" onClick={close} data-scan-close />}</>;
  if (!mine) return <ScanFrame robot={robot} side={side}>
    <div className="g dlg"><div className="h">지도 스캔 · {robot.name}</div><div className="s">지도 스캔은 로봇의 담당 운영자만 할 수 있습니다.</div></div></ScanFrame>;
  const walk = p ? WALK.filter(([k]) => ok(p[k])) : [];
  const said = prog ? (prog.status === 'FAILED' ? failText(prog) : prog.status === 'UNKNOWN' ? prog.reason || '로봇 상태를 확인하지 못했습니다. 끝내거나 취소하세요.' : STATE_TEXT[prog.status]) : null;
  const end = p && (p.status === 'RUNNING' || p.status === 'UNKNOWN' || p.status === 'FAILED');
  return <ScanFrame robot={robot} live={!!p} side={side}>
    {p && <MiniMap robot={robot.id} p={p} conf={conf} />}
    <div className="u142-says">
      {p && <span className="u142-say" data-scan-floor-name>{placeName(places.find((x) => x.floor.id === p.floor_id))}</span>}
      {prog === undefined && !msg && <p className="u142-say" role="status">진행 상황을 확인하는 중…</p>}
      {said && <p className={`u142-say${prog!.status === 'FAILED' || prog!.status === 'UNKNOWN' ? ' bad' : ''}`} role="status" data-scan-state>{said}</p>}
      {msg && <p className="u142-say bad" role="alert">{msg}</p>}
    </div>
    {p && <div className="sp" aria-label="스캔 진행">
      {walk.map(([k, key, name, f]) => <div className="k" key={k} data-walk={key}>{f(p[k] as number)}<small>{name}</small></div>)}
      <div className="bb">{end && <button type="button" className="p2" id="go-end" disabled={busy} onClick={() => act('save')}><Ic s={15}><path d="M20 6 9 17l-5-5" /></Ic>스캔 끝내기</button>}</div>
    </div>}
    {p && ask && <><div className="scrim" />
      <div className="g dlg" role="group" aria-label="확인" data-scan-ask>
        <div className="h">스캔 취소</div><div className="s">지금까지 모은 것을 버리고 스캔을 취소할까요?</div>
        <div className="bts"><button type="button" className="dsec" onClick={() => setAsk(false)}>돌아가기</button>
          <button type="button" className="dpri" disabled={busy} onClick={() => act('cancel')}>취소하기</button></div></div></>}
    {prog !== undefined && !p && <div className="g dlg" aria-label="스캔 시작">
      <div className="h">지도 스캔 · {robot.name}</div>
      <div className="s">{SCAN_HINT}</div>
      <label className="u142-field"><span>층</span>
        <select data-scan-floor value={floor} disabled={busy} onChange={(e) => setFloor(e.target.value)}>
          {places.map((x) => <option key={x.floor.id} value={x.floor.id}>{placeName(x)}</option>)}</select></label>
      {!robot.online && <p className="u142-line" role="alert">로봇이 연결되어 있지 않습니다.</p>}
      <div className="bts"><button type="button" className="dpri" disabled={busy || !robot.online || !floor} onClick={() => act('start')}>스캔 시작</button></div>
    </div>}
  </ScanFrame>;
}
