// 폰 지도 스캔 본체(u14_2): 담당 운영자가 폰으로 로봇을 움직이며 층 지도를 모은다. 입구(폰 조종 화면 시트 · ⋯ 메뉴)는 아직 붙이지 않았다(그 파일을 고치는 열린 PR 들 뒤).
// 요청은 PC 지도 탭 «지도 만들기»(mapmake.tsx)와 같은 길: 시작 · 끝내기(저장) · 취소 = api.slamDo start · save · cancel, 진행 = 1초마다 api.slam. 시작은 고른 층 + source=point_lio.
// 진행 값(스캔 시간 · 걸은 거리 · 모은 점)은 서버 MappingProgress 그대로이고 이상한 값은 칸째 뺀다. 서버에 멈춤(pause) 길이 없어 멈춤 단추를 두지 않는다.
// 위치 인식은 서버 location.confidence 수 그대로(좋음 · 나쁨으로 나눌 기준이 아직 없다). 이 파일은 주행 명령을 만들지 않는다(조종 · STOP 은 폰 조종 화면).
import { useEffect, useState } from 'react';
import type { MappingProgress } from '../../../contracts/ts';
import { api, type ApiFail } from '../api';
import type { Robot, User } from '../fake';
import type { Place } from './maps';
import { actFail, clock, failText, makers, meters, points } from './mapmake';
import { SlamView, useSlamLive } from './slammap';

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

/** 작은 지도: 받은 2D 조각 · 3D 칸을 놓기만(screens/slammap.tsx) */
function MiniMap({ robot, p }: { robot: string; p: MappingProgress }) {
  const pic = useSlamLive(robot, p);
  return <div style={{ position: 'relative', aspectRatio: '640 / 400', borderRadius: 8, overflow: 'hidden', border: '1px solid var(--line)' }} data-scan-map>
    <SlamView pic={pic} empty="아직 받은 지도가 없습니다." /></div>;
}

export function PhoneScan({ user, robot, places, cancel }: { user: User; robot: Robot; places: Place[]; cancel?: AbortSignal }) {
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

  if (!mine) return <section className="lv-card" aria-label="지도 스캔" data-scan><h2>지도 스캔 · {robot.name}</h2>
    <p className="lv-note">지도 스캔은 로봇의 담당 운영자만 할 수 있습니다.</p></section>;
  const p = prog && OPEN.has(prog.status) ? prog : null, conf = robot.location?.confidence;
  const walk = p ? WALK.filter(([k]) => ok(p[k])) : [];
  const said = prog ? (prog.status === 'FAILED' ? failText(prog) : prog.status === 'UNKNOWN' ? prog.reason || '로봇 상태를 확인하지 못했습니다. 끝내거나 취소하세요.' : STATE_TEXT[prog.status]) : null;
  return <section className="lv-card fh-form" aria-label="지도 스캔" data-scan style={{ gap: 10 }}>
    <div className="fh-row" style={{ alignItems: 'baseline', flexWrap: 'wrap' }}><h2 className="fh-grow">지도 스캔 · {robot.name}</h2>
      {p && <span className="lbl" data-scan-floor-name>{placeName(places.find((x) => x.floor.id === p.floor_id))}</span>}</div>
    {prog === undefined && !msg && <p className="lv-note" role="status">진행 상황을 확인하는 중…</p>}
    {said && <p className={`fh-msg${prog!.status === 'FAILED' || prog!.status === 'UNKNOWN' ? '' : ' ok'}`} role="status" data-scan-state>{said}</p>}
    {p && <>
      <MiniMap robot={robot.id} p={p} />
      {ok(conf) && <p className="lv-note" data-scan-conf>위치 인식 {conf.toFixed(2)}</p>}
      {walk.length > 0 && <div className="mx-sum" aria-label="스캔 진행" style={{ gridTemplateColumns: `repeat(${walk.length}, 1fr)` }}>
        {walk.map(([k, key, name, f]) => <span key={k} data-walk={key}><b>{f(p[k] as number)}</b>{name}</span>)}</div>}
      {ask ? <div className="fh-row" role="group" aria-label="확인" data-scan-ask style={{ flexWrap: 'wrap' }}><span className="fh-grow">지금까지 모은 것을 버리고 스캔을 취소할까요?</span>
          <button type="button" className="btn pri" disabled={busy} onClick={() => act('cancel')}>취소하기</button>
          <button type="button" className="btn" onClick={() => setAsk(false)}>돌아가기</button></div>
        : <div className="fh-row">
          <button type="button" className="btn" disabled={busy} onClick={() => setAsk(true)}>취소</button>
          {(p.status === 'RUNNING' || p.status === 'UNKNOWN' || p.status === 'FAILED') && <button type="button" className="btn pri fh-grow" disabled={busy} onClick={() => act('save')}>스캔 끝내기</button>}</div>}
    </>}
    {prog !== undefined && !p && <>
      <label className="fh-field"><span>층</span>
        <select className="inp" data-scan-floor value={floor} disabled={busy} onChange={(e) => setFloor(e.target.value)}>
          {places.map((x) => <option key={x.floor.id} value={x.floor.id}>{placeName(x)}</option>)}</select></label>
      {!robot.online && <p className="fh-msg" role="alert">로봇이 연결되어 있지 않습니다.</p>}
      <p className="lv-note">시작한 뒤 조종 화면으로 로봇을 천천히 움직이고, 다 돌면 «스캔 끝내기»를 누릅니다.</p>
      <button type="button" className="btn pri" disabled={busy || !robot.online || !floor} onClick={() => act('start')}>스캔 시작</button>
    </>}
    {msg && <p className="fh-msg" role="alert">{msg}</p>}
  </section>;
}
