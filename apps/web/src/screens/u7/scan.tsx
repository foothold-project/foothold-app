// 지도 탭 지도 만들기 = 시안 u7_6_scan (걷는 중) · u7_7_lost (위치 잃음) · u7_8_process (저장 · GLIM 다듬는 중). 시안 body 틀 그대로, 값은 서버 지도 만들기 진행(GET /robots/{id}/slam)만.
// 모드 칩 = 로봇 실시간 state.gait(계약 GaitState) · 처리 화면 GLIM 칸 = 진행 glim_preview(0.25 m 칸).
// 동작은 옛 창과 같은 useMakeMap: 시작 · 저장(= 스캔 끝내기) · 취소. 서버에 없는 값(남은 시간 · 출발점까지 · 카메라 사진 · 3DGS · 닫은 바퀴 · 길 어긋남)은 「확인 안 됨」.
import { useMemo } from 'react';
import type { MapVersion, MappingProgress } from '../../../../contracts/ts';
import type { Robot, User } from '../../fake';
import { ServerDrive } from '../../serverdrive';
import { GAITS } from '../../gait';
import { useLive } from '../../rt';
import { BEFORE, GLIM_STAGE, MapBox, Sources, LIO_WHY, RECEIVED_TEXT, SLOW_TEXT, STALE_TEXT, clock, failText, meters, points, useMakeMap } from '../mapmake';
import type { Place } from '../maps';
import { SlamView, useSlamLive } from '../slammap';
import '../../proto/ui.pv.css';
import '../../proto/pc.pv.css';
import '../../proto/light.pv.css';
import './u7.css';

const NOPE = '확인 안 됨';
const light = () => typeof document !== 'undefined' && document.documentElement.dataset.theme === 'light';
const fin = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 0;
const Ic = ({ d, s = 17 }: { d: string; s?: number }) => <svg className="ic" viewBox="0 0 24 24" style={{ width: `${s}px`, height: `${s}px` }} dangerouslySetInnerHTML={{ __html: d }} />;
const I = {
  ok: '<path d="M20 6 9 17l-5-5"/>', now: '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
  robot: '<path d="M4 13h11l3-3h2v4l-2 1H5z"/><path d="M6 15l-1 4M10 15v4M14 15v4M17 15l1 4"/>', mode: '<path d="m8 3 4 8 5-5 5 15H2L8 3z"/>',
  pin: '<path d="M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0"/><circle cx="12" cy="10" r="3"/>',
  bat: '<path d="M10 14v-4"/><path d="M22 14v-4"/><path d="M6 14v-4"/><rect x="2" y="6" width="16" height="12" rx="2"/>',
  flag: '<path d="M4 22V4a1 1 0 0 1 .4-.8A6 6 0 0 1 8 2c3 0 5 2 7.333 2q2 0 3.067-.8A1 1 0 0 1 20 4v10a1 1 0 0 1-.4.8A6 6 0 0 1 16 16c-3 0-5-2-8-2a6 6 0 0 0-4 1.528"/>',
  box: '<path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>',
  pause: '<rect x="14" y="3" width="5" height="18" rx="1"/><rect x="5" y="3" width="5" height="18" rx="1"/>',
  warn: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  chip: '<path d="M12 20v2"/><path d="M12 2v2"/><path d="M17 20v2"/><path d="M17 2v2"/><path d="M2 12h2"/><path d="M2 17h2"/><path d="M2 7h2"/><path d="M20 12h2"/><path d="M20 17h2"/><path d="M20 7h2"/><path d="M7 20v2"/><path d="M7 2v2"/><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="8" y="8" width="8" height="8" rx="1"/>',
  cam: '<path d="m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5"/><rect x="2" y="6" width="14" height="12" rx="2"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
};

/** 위치 맞춤(Point-LIO): 신선 · 위치 유효 · 이유 없음 = 좋음, 이유 코드 = 나쁨(켜는 · 저장 중 자료 없음은 기다림), 그 밖 = 모름 */
export function lioOf(p: MappingProgress | null): 'ok' | 'bad' | null {
  const pl = (p?.sources && typeof p.sources === 'object' ? p.sources.point_lio : null) as Record<string, unknown> | null;
  if (!p || !pl || typeof pl !== 'object') return null;
  const code = typeof pl.reason_code === 'string' ? pl.reason_code : '', waiting = p.status !== 'RUNNING';
  if (pl.fresh === true && pl.position_valid === true && !code) return 'ok';
  if (code && !(waiting && (code === 'MISSING_DATA' || code === 'STALE'))) return 'bad';
  return null;
}

type Args = { floor: string; user: User; robots: Robot[]; places: Place[]; cancel?: AbortSignal; made: (version: string, text: string) => void; approved: string | null; list: MapVersion[] | null };

/** p = 지금 층 지도 만들기. back = 층 화면(u7_3) 또는 지도 고르기(u7_1) · 지도 목록(u7_8 「지도 목록으로」) = toList.
 *  place = null 이면(u7_1 「+ 지도 만들기」) 머리줄 층 칩에서 floors 중 하나를 고른다(pick) · 고르기 전에는 스캔 시작을 막는다 */
export function ScanScreen({ a, place, back, toList, floors = [], pick }: { a: Args; place: Place | null; back: () => void; toList: () => void; floors?: Place[]; pick?: (floor: string) => void }) {
  const m = useMakeMap(a), { p, robot, busy, act, drive } = m;
  const pic = useSlamLive(m.rid, p, m.link), gait = useLive(m.rid).state?.gait?.gait ?? null;
  const mode = GAITS.find((x) => x.g === gait)?.name ?? NOPE;
  const st = p?.status ?? null, saving = st === 'SAVING' || st === 'FINALIZING', lio = lioOf(p), lost = st === 'RUNNING' && lio === 'bad';
  const title = place ? `${place.building.name} ${place.floor.name}` : '';
  const at = place!;   // 처리 화면(u7_8)은 이 층 세션일 때만(p) = 층이 정해져 있음
  const code = (p?.sources?.point_lio as { reason_code?: string } | undefined)?.reason_code;
  const gpv = p?.glim_preview ?? null;   // GLIM 칸만(로봇 화살표 · Point-LIO 조각은 기준이 달라 뺌) · 칸 검사 · 상한은 SlamView
  const gp = useMemo(() => (gpv && Array.isArray(gpv.cells) ? { cells: gpv.cells, res: gpv.resolution ?? 0.25 } : null), [gpv]);
  const glimPic = useMemo(() => ({ ...pic, pose: null }), [pic]);
  const g = (p?.sources?.glim ?? null) as { stage?: string; processed_chunks?: number; gpu?: boolean | null } | null;
  const step = (k: string, state: 'done' | 'now' | '', name: string, small: string) => <div key={k} className={`step ${state}`} data-step={k} data-state={state || 'wait'}>
    <i>{state === 'done' ? <Ic d={I.ok} s={15} /> : state === 'now' ? <Ic d={I.now} s={15} /> : null}</i><div>{name}<small>{small}</small></div></div>;
  const big = (k: string, name: string, v: unknown, f: (n: number) => string, unit: string) => <div data-scan-walk={k}><div className="mu2" style={{ fontSize: '12.5px', fontWeight: '600' }}>{name}</div>
    <div className="big">{fin(v) ? f(v) : NOPE}{fin(v) && <small>{unit}</small>}</div></div>;
  const chip = (k: string, d: string, text: string, small: string, warn?: boolean) => <span key={k} className="g dk st" style={{ position: 'relative', ...(warn ? { borderColor: 'rgba(242,183,5,.7)' } : {}) }} data-chip={k}><Ic d={d} />{text}<small>{small}</small></span>;
  const rbtn = (k: string, d: string, text: string, on: () => void, opt: { pri?: boolean; off?: boolean } = {}) => <div key={k} className="g dk btn" role="button" tabIndex={0} aria-disabled={opt.off || busy || undefined} data-scan-act={k}
    style={opt.pri ? { background: 'linear-gradient(180deg,rgba(0,195,137,.55),rgba(0,195,137,.40))', borderColor: 'rgba(0,195,137,.5)' } : undefined} onClick={() => { if (!opt.off && !busy) on(); }}><Ic d={d} s={18} />{text}</div>;
  // 옛 창의 안내 글은 그대로 옆 칸 아래 한 줄씩(시안 그 자리는 도움말 한 줄)
  const notes: [string, string, boolean][] = ([
    [m.open && !m.here, 'elsewhere', `이 로봇은 ${m.elsewhere ? `«${m.elsewhere.building.name} ${m.elsewhere.floor.name}»` : '다른 층'}에서 지도를 만드는 중입니다. 그 층에서 저장하거나 취소하세요.`, true],
    [!!m.got, 'received', RECEIVED_TEXT, false],
    [!place, 'nofloor', '머리줄에서 지도 만들 층을 고르세요.', false],
    [!!robot && !robot.online && !st, 'offline', '로봇이 연결되어 있지 않습니다.', true],
    [m.prog === undefined && !m.poll, 'checking', '진행 상황을 확인하는 중…', false],
    [st === 'STARTING', 'starting', '시작하는 중… 로봇이 지도 기능을 켜고 있습니다.', false],
    [m.slow, 'slow', SLOW_TEXT, true],
    [st === 'RUNNING' && !lost, 'running', `만드는 중 · ${m.how} 로봇을 천천히 움직이세요.`, false],
    [st === 'UNKNOWN' || st === 'FAILED', st === 'FAILED' ? 'failed' : 'unknown', p ? (st === 'UNKNOWN' && p.error_code !== 'LINK_LOST' && !p.reason ? '로봇 상태를 확인하지 못했습니다. 저장하거나 취소하세요.' : failText(p)) : '', true],
    [m.isStale && !m.msg && st !== 'FAILED', 'stale', STALE_TEXT, true],
    [!!m.msg, 'msg', m.msg?.text ?? '', !m.msg?.ok],
    [!!m.rej, 'rejected', `로봇이 보낸 자료 일부를 서버가 받지 않았습니다: ${m.rej?.reason ?? ''}`, false],
    [saving, 'saving', '지도를 저장하는 중… 마무리까지 시간이 걸릴 수 있습니다.', false],
    [busy, 'make-busy', '요청을 보내는 중… 답이 오면 단추가 다시 켜집니다.', false],
    [!!m.poll, 'poll', m.poll, true],
  ] as [boolean, string, string, boolean][]).flatMap(([on, k, t, bad]) => (on && t ? [[k, t, bad] as [string, string, boolean]] : []));
  const noteList = <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }} data-scan-notes>{notes.map(([k, t, bad]) =>
    <span key={k} role={bad ? 'alert' : 'status'} style={bad ? { color: '#ff4d4f' } : undefined} data-note={k} {...{ [`data-${k}`]: '' }}>{t}</span>)}
    {m.got?.map_version_id && <span role="button" tabIndex={0} style={{ textDecoration: 'underline', cursor: 'pointer' }} data-scan-received onClick={() => m.madeRef.current(m.got!.map_version_id!, RECEIVED_TEXT)}>받은 지도 보기</span>}</div>;

  if (saving && p) return <div className={`proto${light() ? ' light' : ''} u7`} aria-label="새 지도 처리 중" data-u7="u7_8_process">
    <div className="pane" style={{ left: '24px', top: '88px', right: '24px', height: '170px', padding: '26px 30px' }}>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: '22px' }}><span className="row" style={{ gap: '12px' }}><span className="g dk" style={{ position: 'relative', width: '36px', height: '36px', borderRadius: '11px', display: 'flex', alignItems: 'center', justifyContent: 'center' }} role="button" tabIndex={0} aria-label="지도로" data-u7-back onClick={back}><svg className="ic" viewBox="0 0 24 24" style={{ width: '18px', height: '18px' }}><path d="m15 18-6-6 6-6" /></svg></span><span className="ttl">새 지도 처리 중 · {title}</span></span><span className="mu2" style={{ fontSize: '13.5px', fontWeight: '600' }}>남은 시간 {NOPE} · 창을 닫아도 계속됩니다</span></div>
      <div className="row" style={{ alignItems: 'flex-start' }}>
        {([['scan', 'done', '지도 스캔', [ 'Point-LIO', fin(p.elapsed_s) && clock(p.elapsed_s), fin(p.distance_m) && meters(p.distance_m), fin(p.point_count) && `${points(p.point_count)} 점`].filter(Boolean).join(' · ')],
          ['glim', 'now', `GLIM 후처리${g?.gpu ? ' · GPU' : ''}`, [GLIM_STAGE[g?.stage ?? ''] ?? NOPE, fin(g?.processed_chunks) && `${g!.processed_chunks!.toLocaleString('ko-KR')} 조각 처리`].filter(Boolean).join(' · ')],
          ['3dgs', '', '실사 표면 만들기', `3DGS · ${NOPE}`], ['save', '', '실측 지도로 저장', `${at.building.name} · ${at.floor.name}`]] as const).map(([k, s2, name, small], i) =>
          <div key={k} className={`step ${s2}`} style={{ flex: '1', flexDirection: 'column', gap: '10px', padding: '0' }} data-step={k}>
            <div className="row" style={{ width: '100%', gap: '10px' }}><i>{s2 === 'done' ? <Ic d={I.ok} s={15} /> : s2 === 'now' ? <Ic d={I.now} s={15} /> : null}</i>
              <span style={{ flex: '1', height: '2px', background: s2 === 'done' ? '#00c389' : 'rgba(255,255,255,.12)', display: i === 3 ? 'none' : undefined }} /></div>
            <div style={{ paddingRight: '20px' }}>{name}<small>{small}</small></div></div>)}
      </div></div>
    <div className="pane" style={{ left: '24px', top: '282px', width: '930px', height: '580px', overflow: 'hidden', padding: '0' }}>
      <SlamView pic={pic} empty="받은 지도 칸이 없습니다." />
      <div className="g dk tl" style={{ left: '20px', top: '20px', height: '38px', padding: '0 14px', borderRadius: '12px', display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', fontWeight: '700' }}>보정 전 · Point-LIO 로 받은 것</div></div>
    <div className="pane" style={{ left: '978px', top: '282px', right: '24px', height: '580px', overflow: 'hidden', padding: '0' }}>
      {gp ? <div style={{ position: 'absolute', inset: '0' }} data-glim-pic="cells"><SlamView pic={glimPic} over={gp} hideBase empty="받은 GLIM 칸이 없습니다." /></div>
        : <p className="mu2" style={{ padding: '120px 24px', textAlign: 'center' }} data-glim-pic="none">GLIM 미리보기를 아직 받지 못했습니다</p>}
      <div className="g dk tl" style={{ left: '20px', top: '20px', height: '38px', padding: '0 14px', borderRadius: '12px', display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', fontWeight: '700' }}><Ic d={I.chip} s={16} />GLIM 으로 다듬은 것 · {GLIM_STAGE[g?.stage ?? ''] ?? NOPE}</div></div>
    <div className="pane" style={{ left: '24px', top: '886px', width: '930px', bottom: '24px', padding: '18px 20px', display: 'flex', gap: '18px' }}>
      <div style={{ width: '210px', flex: 'none' }}><div className="row" style={{ gap: '8px', fontSize: '14px', fontWeight: '700' }}><Ic d={I.cam} />카메라 사진</div>
        <div className="big" style={{ marginTop: '10px' }}>{NOPE}</div><div className="mu2" style={{ fontSize: '12.5px', marginTop: '4px' }}>실사 표면 층 (3DGS) 에 씁니다</div></div>
      <div style={{ flex: '1', borderRadius: '12px', border: '1px solid var(--line)' }} /></div>
    <div className="pane" style={{ left: '978px', top: '886px', right: '24px', bottom: '24px', padding: '22px 24px', display: 'flex', alignItems: 'center', gap: '44px' }}>
      <div><div className="mu2" style={{ fontSize: '12.5px', fontWeight: '600' }}>처리한 조각</div><div className="big" style={{ fontSize: '26px', marginTop: '6px' }}>{fin(g?.processed_chunks) ? g!.processed_chunks!.toLocaleString('ko-KR') : NOPE}</div></div>
      <div><div className="mu2" style={{ fontSize: '12.5px', fontWeight: '600' }}>길 어긋남</div><div className="big" style={{ fontSize: '26px', marginTop: '6px' }}>{NOPE}</div></div>
      <div><div className="mu2" style={{ fontSize: '12.5px', fontWeight: '600' }}>GPU</div><div className="big" style={{ fontSize: '26px', marginTop: '6px' }}>{g?.gpu === true ? '씀' : g?.gpu === false ? '안 씀' : NOPE}</div></div>
      <div style={{ marginLeft: 'auto', display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '10px' }}>
        <div className="btns" style={{ height: '46px', padding: '0 18px', fontSize: '14px' }} role="button" tabIndex={0} data-scan-tolist onClick={toList}>지도 목록으로</div>
        <span className="mu2" style={{ fontSize: '12px' }}>끝나면 {at.building.name} · {at.floor.name} 실측 지도로 저장됩니다</span>
        <span className="mu2" style={{ fontSize: '12px' }}>{noteList}</span>
        <div style={{ fontSize: '12px' }} data-scan-sources><Sources st={st} s={p.sources} /></div></div></div>
  </div>;

  return <div className={`proto${light() ? ' light' : ''} u7`} aria-label="지도 만들기" data-u7={lost ? 'u7_7_lost' : 'u7_6_scan'}>
    <div className="pane side"><span className="ttl">지도 만들기</span>
      <div style={{ marginTop: '10px' }}>
        {step('start', st === 'RUNNING' || saving ? 'done' : st === 'STARTING' ? 'now' : '', '스캔 시작', st === 'STARTING' ? '로봇이 지도 기능을 켜는 중' : st ? '로봇이 지도 기능을 켬' : BEFORE)}
        {step('scan', st === 'RUNNING' ? 'now' : saving ? 'done' : '', '지도 스캔', 'Point-LIO 실시간')}
        {step('glim', saving ? 'now' : '', 'GLIM 후처리', 'GPU 로 다듬기')}
        {step('save', '', '실측 지도로 저장', '지도 목록에 추가')}
      </div>
      <div style={{ height: '1px', background: 'var(--line)', margin: '16px 4px' }} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', padding: '0 6px' }}>
        {big('time', '걸은 시간', p?.elapsed_s, clock, '분 : 초')}{big('dist', '걸은 거리', p?.distance_m, (n) => meters(n).replace(/ m$/, ''), 'm')}
        {big('points', '모은 점', p?.point_count, points, lost ? '점 · 멈춤' : '점')}</div>
      <div style={{ padding: '0 6px', marginTop: '18px' }}><div className="mu2" style={{ fontSize: '12.5px', fontWeight: '600' }}>위치 맞춤</div>
        <div className="row" style={{ gap: '10px', marginTop: '8px' }} data-lio={lio ?? 'none'}><div style={{ flex: '1', height: '8px', borderRadius: '4px', background: 'rgba(255,255,255,.08)', overflow: 'hidden' }}>
          {lio && <div style={{ width: '100%', height: '100%', background: lio === 'ok' ? '#00c389' : '#f2b705' }} />}</div><b style={{ fontSize: '13.5px' }}>{lio === 'ok' ? '좋음' : lio === 'bad' ? '나쁨' : NOPE}</b></div>
        <div style={{ marginTop: '10px', fontSize: '12px' }} data-scan-sources><Sources st={st} s={p?.sources} /></div></div>
      <div style={{ position: 'absolute', left: '20px', right: '20px', bottom: '20px', fontSize: '12.5px', lineHeight: '1.55', color: 'var(--mu2)' }}>
        {notes.length || m.got?.map_version_id ? noteList : `${drive ? '오른쪽 조종 칸이나 리모컨으로' : '리모컨이나 폰 조종 화면으로'} 로봇을 천천히 걷게 하세요.`}</div>
    </div>
    <div className="head"><span className="g dk" style={{ position: 'relative', width: '44px', height: '44px', borderRadius: '13px', display: 'flex', alignItems: 'center', justifyContent: 'center' }} role="button" tabIndex={0} aria-label="지도로" data-u7-back onClick={back}>
      <svg className="ic" viewBox="0 0 24 24" style={{ width: '20px', height: '20px' }}><path d="m15 18-6-6 6-6" /></svg></span>
      <span className="ttl" style={{ fontSize: '24px', marginRight: '6px' }}>{place ? `새 지도 · ${title}` : '새 지도'}</span>
      {!place && <span className="g dk st" style={{ position: 'relative' }} data-chip="floor"><Ic d={I.pin} />
        <select value="" aria-label="지도 만들 층" style={{ background: 'transparent', color: 'inherit', border: 0, font: 'inherit' }} onChange={(e) => e.target.value && pick?.(e.target.value)}>
          <option value="">층 고르기</option>{floors.map((x) => <option key={x.floor.id} value={x.floor.id}>{`${x.site.name} ${x.building.name} ${x.floor.name}`}</option>)}</select>
        <small>지도 만들 층</small></span>}
      <span className="g dk st" style={{ position: 'relative' }} data-chip="robot"><Ic d={I.robot} />
        {!(m.here && !m.stuck) ? <select value={m.rid} aria-label="지도 만드는 로봇" disabled={busy} style={{ background: 'transparent', color: 'inherit', border: 0, font: 'inherit' }}
          onChange={(e) => { m.setRid(e.target.value); m.setProg(undefined); m.setMsg(null); m.setStale(false); }}>{m.mine.map((r) => <option key={r.id} value={r.id}>{r.name}{r.online ? '' : ' (연결 안 됨)'}</option>)}</select> : robot?.name ?? NOPE}
        <small>지도 만드는 로봇</small></span>
      {chip('mode', I.mode, mode, '모드')}
      {chip('lio', I.pin, lio === 'ok' ? '위치 잡힘' : lio === 'bad' ? '위치 잃음' : NOPE, 'Point-LIO', lio === 'bad')}
      {chip('bat', I.bat, robot?.battery != null ? `${Math.round(robot.battery)} %` : NOPE, `남은 시간 ${NOPE}`)}</div>
    <div className="view nr" style={{ right: '584px' }} data-scan-view>
      {p ? <MapBox robot={m.rid} p={p} link={m.link} given={pic} fill /> : <SlamView pic={pic} empty="아직 받은 지도가 없습니다." />}
      <div className="g dk tl" style={{ left: '20px', top: '20px', height: '38px', padding: '0 14px', borderRadius: '12px', display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', fontWeight: '700' }}>
        <i className="dot" />{st === 'RUNNING' ? '실시간 스캔 중' : st === 'STARTING' ? '시작하는 중' : st ? (p ? failText(p) : '') : '스캔 전'}</div>
      {lost ? <div className="tl" style={{ left: '50%', top: '20px', transform: 'translateX(-50%)', height: '52px', padding: '0 20px', borderRadius: '14px', display: 'flex', alignItems: 'center', gap: '10px', fontSize: '15px', fontWeight: '800', whiteSpace: 'nowrap', background: 'linear-gradient(180deg,rgba(242,183,5,.30),rgba(242,183,5,.18))', border: '1px solid rgba(242,183,5,.7)', color: '#fff', boxShadow: '0 10px 26px rgba(0,0,0,.35),inset 0 1px 0 rgba(255,255,255,.25)', backdropFilter: 'blur(20px)' }} data-lost>
          <span style={{ color: '#f2b705', display: 'flex' }}><Ic d={I.warn} s={20} /></span>위치를 놓쳤습니다<span style={{ fontWeight: '600', fontSize: '13.5px', color: '#ffffff' }}>{(code && LIO_WHY[code]) || '마지막으로 위치를 알던 곳으로 천천히 돌아가세요'}</span></div>
        : <div className="g dk tl" style={{ right: '20px', top: '20px', height: '48px', padding: '0 18px', borderRadius: '14px', display: 'flex', alignItems: 'center', gap: '10px', fontSize: '14px', fontWeight: '700', whiteSpace: 'nowrap' }}>
          <span style={{ color: 'var(--pr3)', display: 'flex' }}><Ic d={I.flag} s={18} /></span>출발점까지 {NOPE}<span className="mu2" style={{ fontWeight: '600', fontSize: '13px' }}>출발점으로 돌아와서 끝내면 지도가 더 정확해집니다</span></div>}
    </div>
    <div className="pane" style={{ right: '168px', top: '160px', width: '400px', height: '380px', overflow: 'hidden', padding: '0' }}>
      <div className="row" style={{ position: 'absolute', left: '18px', top: '16px', gap: '8px', fontSize: '13px', fontWeight: '700', zIndex: 2 }}><Ic d={I.box} s={16} />받은 3D 칸 {pic.n.toLocaleString('ko-KR')}</div>
      <div style={{ position: 'absolute', left: '0', right: '0', top: '44px', bottom: '0' }}><SlamView pic={pic} empty="3D 칸을 아직 받지 못했습니다" first3d /></div></div>
    <div className="pane" style={{ right: '168px', top: '556px', width: '400px', bottom: '24px', overflow: 'hidden', padding: '0' }}>
      {st === 'RUNNING' && drive && robot ? <div style={{ position: 'absolute', inset: '0', overflow: 'hidden', padding: '12px' }} data-make-drive><ServerDrive c={{ user: a.user }} r={robot} inline /></div>
        : <div className="g dk" style={{ left: '14px', top: '14px', height: '34px', padding: '0 12px', borderRadius: '11px', display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12.5px', fontWeight: '700' }}>
          <i style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#9aa19d' }} />카메라 사진 {NOPE}</div>}</div>
    <div className="rcol">
      {m.open && !m.here ? null : !st
        ? rbtn('start', I.ok, '스캔 시작', () => act('start'), { pri: true, off: !place || !robot?.online || m.prog === undefined })
        : <>{rbtn('pause', I.pause, '잠시 멈춤', () => {}, { off: true })}
          {!m.isStale && rbtn('finish', I.ok, m.stuck ? (m.asked || st === 'FAILED' ? '다시 저장' : '스캔 끝내기') : '스캔 끝내기', () => act('save'), { pri: true, off: !(st === 'RUNNING' || m.stuck) })}
          {m.ask ? rbtn('cancel-yes', I.x, '버리고 취소', () => act('cancel')) : rbtn('cancel', I.x, '취소', () => m.setAsk(true))}</>}
    </div>
  </div>;
}
