// 지도 탭 «지도 만들기»(RB-SLAM-WEB 11-12, 계약 apps/server/MAPPING.md): 담당 운영자가 실기 로봇을 움직이며 이 층 지도를 그린다.
// 11-13 RB-MAP-VIEW-WEB: 그리는 동안(RUNNING) 서버가 이 PC 조종을 허용한 로봇이면(fleet 와 같은 canDrive) 창 안에 같은 조종 패널(ServerDrive — STOP 포함)을 붙인다. 아니면 지금처럼 폰 조종 화면.
// 시작·저장·취소는 POST /robots/{id}/slam/{start|save|cancel}, 진행은 1초마다 GET /robots/{id}/slam(창이 열려 있는 동안만 — 닫거나 층을 바꿔도 서버 세션은 계속).
// 화면 글에 «SLAM» 을 쓰지 않는다. 이 파일은 주행 명령을 만들지 않는다(운전은 ServerDrive 또는 폰 조종 화면).
import { useEffect, useRef, useState } from 'react';
import type { MapVersion, MappingPreview, MappingProgress } from '../../../contracts/ts';
import { ApiFail, api } from '../api';
import type { Robot, User } from '../fake';
import { Note, type Msg, type Place } from './maps';
import { ServerDrive, canDrive } from '../serverdrive';
import { usePhone } from '../App';

/** 완료를 알린 세션(같은 SAVED 를 두 번 알리지 않게 — 화면 메모리에만, 그 층에서 알릴 때만 넣는다) */
const told = new Set<string>();
const LIVE = new Set(['RUNNING', 'SAVING']), OPEN = new Set(['RUNNING', 'SAVING', 'FAILED']);
const OFF = '로봇이 연결되어 있지 않습니다.';
export const STALE_TEXT = '다른 사람이 이 층 지도를 바꿨습니다. 취소하고 다시 시작하세요.';
const LINK_LOST = '연결이 끊겨 그리기를 멈췄습니다. 지금까지 그린 것을 저장하거나 취소하세요.';
export const MADE = '로봇으로 만든 지도와 시뮬 지형을 만들었습니다.';

/** 이 사람이 지도를 만들 수 있는 로봇 = 내가 담당 운영자인 실기 로봇(총괄·남의 로봇은 서버도 403 MAPPING_OWNER_ONLY) */
export const makers = (u: User, robots: Robot[]) => (u.role === 'OPERATOR' ? robots.filter((r) => r.owner === u.id && !r.sim) : []);

const time = (s: number) => `${Math.floor(s / 60)}분 ${Math.floor(s % 60)}초`;
const failText = (p: MappingProgress) => (p.error_code === 'STALE' ? STALE_TEXT : p.error_code === 'LINK_LOST' ? LINK_LOST : p.reason || '지도를 저장하지 못했습니다.');
const actFail = (e: ApiFail) => (e.code === 'STALE' ? STALE_TEXT : e.code === 'ROBOT_OFFLINE' ? OFF : e.message);

/** 위에서 본 그림: 관측 칸(resolution 격자)·걸은 길·로봇(방향 선). 색은 테마 토큰. 칸이 없으면 안내 */
function Preview({ p }: { p?: MappingPreview | null }) {
  const ref = useRef<HTMLCanvasElement>(null), n = p?.cells.length ?? 0;
  useEffect(() => {
    const cv = ref.current, g = cv?.getContext?.('2d');
    if (!cv || !g || !p) return;
    const css = getComputedStyle(cv), tok = (k: string, fb: string) => css.getPropertyValue(k).trim() || fb, r = p.resolution;
    const xs: number[] = [], ys: number[] = [];
    for (const [i, j] of p.cells) { xs.push(i * r, (i + 1) * r); ys.push(j * r, (j + 1) * r); }
    for (const [x, y] of p.path) { xs.push(x); ys.push(y); }
    if (p.robot) { xs.push(p.robot[0]); ys.push(p.robot[1]); }
    g.clearRect(0, 0, cv.width, cv.height);
    if (!xs.length) return;
    const pad = 1, x0 = Math.min(...xs) - pad, y0 = Math.min(...ys) - pad, w = Math.max(...xs) + pad - x0, h = Math.max(...ys) + pad - y0;
    const k = Math.min(cv.width / w, cv.height / h), ox = (cv.width - w * k) / 2, oy = (cv.height - h * k) / 2;
    const px = (x: number, y: number): [number, number] => [ox + (x - x0) * k, cv.height - oy - (y - y0) * k];   // 위가 +y
    g.fillStyle = tok('--text', '#222');
    for (const [i, j] of p.cells) { const [a, b] = px(i * r, (j + 1) * r); g.fillRect(a, b, Math.max(1, r * k), Math.max(1, r * k)); }
    g.strokeStyle = tok('--accent', '#2a6'); g.lineWidth = 2; g.beginPath();
    p.path.forEach(([x, y], i) => { const [a, b] = px(x, y); if (i) g.lineTo(a, b); else g.moveTo(a, b); });
    g.stroke();
    if (p.robot) {
      const [x, y, yaw] = p.robot, [a, b] = px(x, y), [c, d] = px(x + Math.cos(yaw) * 0.6, y + Math.sin(yaw) * 0.6);
      g.fillStyle = tok('--warn', '#e90'); g.beginPath(); g.arc(a, b, 6, 0, Math.PI * 2); g.fill();
      g.strokeStyle = tok('--warn', '#e90'); g.lineWidth = 3; g.beginPath(); g.moveTo(a, b); g.lineTo(c, d); g.stroke();
    }
  }, [p]);
  return <div style={{ position: 'relative' }}>
    <canvas ref={ref} width={640} height={400} role="img" aria-label="위에서 본 그림" data-preview={n} data-path={p?.path.length ?? 0} data-robot={p?.robot ? '' : undefined}
      style={{ display: 'block', width: '100%', aspectRatio: '640 / 400', background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 8 }} />
    {!n && <p className="lv-note" style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', margin: 0 }}>아직 그린 것이 없습니다.</p>}
  </div>;
}

/** 창 «로봇으로 지도 만들기» 안 — 창이 열릴 때만 그린다(닫으면 언마운트 = 조회 멈춤). made = 이 층에 새 지도가 저장됨(그 판 id).
 *  approved·list = 이 층 지금 승인 판 id·받은 판 목록(받는 중 null) — 지난 SAVED(이미 반영·그 뒤 바뀜)를 다시 알리지 않게 */
export function MakeMap({ floor, user, robots, places, cancel, made, approved, list }: { floor: string; user: User; robots: Robot[]; places: Place[]; cancel?: AbortSignal; made: (version: string) => void;
  approved: string | null; list: MapVersion[] | null }) {
  const mine = makers(user, robots);
  const [rid, setRid] = useState(() => (mine.find((r) => r.online) ?? mine[0])?.id ?? ''), robot = mine.find((r) => r.id === rid);
  const [prog, setProg] = useState<MappingProgress | null | undefined>(), [n, setN] = useState(0), [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null), [poll, setPoll] = useState(''), [ask, setAsk] = useState(false), [stale, setStale] = useState(false);
  const madeRef = useRef(made); madeRef.current = made;
  const phone = usePhone(), drive = !!robot && canDrive({ user, phone }, robot), how = drive ? '이 창의 조종 단추나 키보드로' : '폰 조종 화면으로';
  // 1초마다 조회(RUNNING·SAVING 동안만). 언마운트·로봇 바꿈은 AbortSignal 로 진행 중 요청까지 거둔다
  useEffect(() => {
    if (!rid) return;
    const ac = new AbortController(), off = () => ac.abort();
    let t: ReturnType<typeof setTimeout> | undefined;
    cancel?.addEventListener('abort', off);
    const go = async () => {
      try {
        const x = (await api.slam(rid, ac.signal)) ?? null;
        if (ac.signal.aborted) return;
        setProg(x); setPoll('');
        if (x && LIVE.has(x.status)) t = setTimeout(go, 1000);
      } catch (e) {
        const f = e as ApiFail;
        if (f.code === 'CANCELED' || ac.signal.aborted) return;
        setPoll(`진행 상황을 받지 못했습니다. ${f.message}`);
        if (f.status === 0 || f.status >= 500) t = setTimeout(go, 1000);   // 4xx(권한 등)는 다시 묻지 않는다
      }
    };
    go();
    return () => { ac.abort(); clearTimeout(t); cancel?.removeEventListener('abort', off); };
  }, [rid, n]);
  // 완료는 서버 값만으로: 이 층·이 세션의 SAVED + map_version_id 이고, 그 판이 아직 화면에 반영되지 않았으면(승인 판이 아님·목록에 없거나 승인 상태) 알린다.
  // 저장 응답이 끊겼거나 창을 닫았다 다른 층을 거쳐 돌아와도 같은 판정. 다른 층 SAVED 는 소모하지 않는다
  useEffect(() => {
    const id = prog?.status === 'SAVED' && prog.floor_id === floor ? prog.map_version_id : null;
    if (!id || !list || told.has(prog!.session_id)) return;
    told.add(prog!.session_id);
    const v = list.find((x) => x.id === id);
    if (id !== approved && (!v || v.status === 'APPROVED')) madeRef.current(id);
  }, [prog, list, approved]);
  const act = async (op: 'start' | 'save' | 'cancel') => {
    if (busy) return;
    setBusy(true); setMsg(null); setAsk(false);
    try {
      const x = await api.slamDo(rid, op, op === 'start' ? { floor_id: floor } : { session_id: prog!.session_id }, cancel);
      if (op === 'start') setStale(false);
      if (op === 'cancel') { setMsg({ text: '지도 만들기를 취소했습니다.', ok: true }); }
      setProg(x);
    } catch (e) {
      const f = e as ApiFail;
      if (f.code === 'CANCELED') return;
      if (f.code === 'STALE') setStale(true);
      setMsg({ text: actFail(f) });
    } finally { setBusy(false); setN((k) => k + 1); }   // 성공·실패 모두 서버 상태를 다시 받는다(409 세션 어긋남 등)
  };

  if (!mine.length) return <p className="lv-note">지도 만들기는 로봇의 담당 운영자만 할 수 있습니다.</p>;
  const open = !!prog && OPEN.has(prog.status), here = open && prog!.floor_id === floor;
  const elsewhere = open && !here && places.find((p) => p.floor.id === prog!.floor_id);
  const p = here ? prog! : null, isStale = stale || p?.error_code === 'STALE';
  return <div className="fh-form" style={{ gap: 10 }} data-make-map>
    <label className="fh-field"><span>로봇</span>
      <select className="inp" value={rid} disabled={busy || (here && p!.status !== 'FAILED')} onChange={(e) => { setRid(e.target.value); setProg(undefined); setMsg(null); setStale(false); }}>
        {mine.map((r) => <option key={r.id} value={r.id}>{r.name}{r.online ? '' : ' (연결 안 됨)'}</option>)}</select></label>
    {prog === undefined && !poll && <p className="lv-note" role="status">진행 상황을 확인하는 중…</p>}
    {open && !here && <p className="fh-msg" role="status" data-elsewhere>이 로봇은 {elsewhere ? `«${elsewhere.building.name} ${elsewhere.floor.name}»` : '다른 층'}에서 지도를 만드는 중입니다. 그 층에서 저장하거나 취소하세요.</p>}
    {prog !== undefined && !open && <>
      <p className="lv-note">로봇이 돌아다니며 이 층 지도를 그립니다. 시작한 뒤 {how} 로봇을 움직이고, 다 돌면 «지도 저장»을 누릅니다.</p>
      {robot && !robot.online && <p className="fh-msg" role="alert" data-offline>{OFF}</p>}
      <div className="fh-row"><button type="button" className="btn pri" disabled={busy || !robot?.online} onClick={() => act('start')}>시작</button></div>
    </>}
    {p && <>
      {/* 왼쪽 실시간 지도·진행, 오른쪽 조종(좁으면 아래로) — 지도를 보면서 스크롤 없이 STOP·조종 */}
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', gap: 10 }}>
        <div style={{ flex: '1.4 1 340px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <Preview p={p.preview} />
          <div className="mx-sum" aria-label="진행" data-progress={p.status}>
            <span><b>{(p.distance_m ?? 0).toFixed(1)} m</b>걸은 거리</span><span><b>{(p.point_count ?? 0).toLocaleString('ko-KR')}</b>점 수</span><span><b>{time(p.elapsed_s ?? 0)}</b>걸린 시간</span></div>
        </div>
        {p.status === 'RUNNING' && drive && <div data-make-drive style={{ flex: '1 1 300px', minWidth: 0 }}><ServerDrive c={{ user }} r={robot!} inline /></div>}
      </div>
      {p.status === 'RUNNING' && <p className="fh-msg ok" role="status">그리는 중 — {how} 로봇을 천천히 움직이세요.</p>}
      {p.status === 'SAVING' && <p className="lv-note" role="status" data-saving>지도를 저장하는 중… 시뮬 지형까지 만들어 시간이 걸릴 수 있습니다.</p>}
      {p.status === 'FAILED' && <p className="fh-msg" role="alert" data-failed>{failText(p)}</p>}
      {ask ? <div className="fh-row" role="group" aria-label="확인"><span>지금까지 그린 것을 버리고 지도 만들기를 취소할까요?</span>
          <button type="button" className="btn pri" disabled={busy} onClick={() => act('cancel')}>취소하기</button>
          <button type="button" className="btn" onClick={() => setAsk(false)}>돌아가기</button></div>
        : <div className="fh-row">
          {p.status === 'RUNNING' && <button type="button" className="btn pri" disabled={busy || isStale} onClick={() => act('save')}>지도 저장</button>}
          {p.status === 'FAILED' && !isStale && <button type="button" className="btn pri" disabled={busy} onClick={() => act('save')}>다시 저장</button>}
          <button type="button" className="btn" disabled={busy} onClick={() => setAsk(true)}>취소</button></div>}
    </>}
    {isStale && !msg && p?.status !== 'FAILED' && <p className="fh-msg" role="alert">{STALE_TEXT}</p>}
    <Note m={msg} />
    {poll && <p className="fh-msg" role="alert">{poll}</p>}
  </div>;
}
