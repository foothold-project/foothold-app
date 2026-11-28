// 지도 탭 «지도 만들기»(RB-SLAM-WEB 11-12 → RB-SLAM-WEB2 11-25, 계약 apps/server/SLAM-CONTRACT.md): 담당 운영자가 실기 로봇을 움직이며 이 층 지도를 그린다.
// 지도는 전부 우리 앱 — 걷는 동안 Point-LIO(실시간 위치·칸), 저장은 GLIM. 시작 때 source=point_lio 를 꼭 보낸다(빼면 서버가 옛 길로 보냄).
// 11-13 RB-MAP-VIEW-WEB: 그리는 동안(RUNNING) 서버가 이 PC 조종을 허용한 로봇이면(fleet 와 같은 canDrive) 창 안에 같은 조종 패널(ServerDrive — STOP 포함)을 붙인다. 아니면 폰 조종 화면.
// 시작·저장·취소는 POST /robots/{id}/slam/{start|save|cancel}, 진행은 1초마다 GET /robots/{id}/slam(창이 열려 있는 동안만 — 닫거나 층을 바꿔도 서버 세션은 계속).
// 그림은 screens/slammap.tsx — Jetson 이 보낸 2D 조각·3D 칸을 놓기만(브라우저 계산 없음). 화면 글에 «SLAM» 을 쓰지 않는다. 이 파일은 주행 명령을 만들지 않는다.
// 11-27 RB-MAP-LIVE-WEB: 지도 위에 Point-LIO·GLIM 상태 두 줄(progress.sources), GLIM 미리보기(glim_preview 0.25 m)는 Point-LIO 그림과 같은 기준일 때만 겹침 — 저장 완료 표시 아님.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { MapVersion, MappingProgress, MappingSources } from '../../../contracts/ts';
import { ApiFail, api } from '../api';
import type { Robot, User } from '../fake';
import { Note, type Msg, type Place } from './maps';
import { ServerDrive, canDrive } from '../serverdrive';
import { usePhone } from '../App';
import { SlamView, useSlamLive } from './slammap';

/** 완료를 알린 세션(같은 SAVED 를 두 번 알리지 않게 — 화면 메모리에만, 그 층에서 알릴 때만 넣는다) */
const told = new Set<string>();
/** 조회를 이어가는 상태 · 창에 진행 화면을 여는 상태(그 밖 = 끝남 — 새로 시작) */
const LIVE = new Set(['STARTING', 'RUNNING', 'SAVING', 'FINALIZING', 'UNKNOWN']), OPEN = new Set([...LIVE, 'FAILED']);
/** 이보다 오래 «시작하는 중»이면 로봇 프로그램이 새 지도 기능을 아직 모를 수 있다고 알린다(초). ponytail: 실기 시작 시간을 재고 맞춘다 */
export const SLOW_START_S = 20;
const OFF = '로봇이 연결되어 있지 않습니다.';
export const STALE_TEXT = '다른 사람이 이 층 지도를 바꿨습니다. 취소하고 다시 시작하세요.';
const LINK_LOST = '연결이 끊겨 지도 기록은 로봇에서 계속합니다';
export const MADE = '로봇으로 만든 지도와 시뮬 지형을 만들었습니다.';
export const SLOW_TEXT = '로봇 프로그램이 새 지도 기능을 아직 지원하지 않을 수 있습니다(로봇 프로그램 업데이트 필요).';
export const RECEIVED_TEXT = '받은 범위만 보관했습니다 · 저장 확인 안 됨. 시뮬 지형은 만들지 않았고, 이 지도는 승인을 기다립니다.';

/** 이 사람이 지도를 만들 수 있는 로봇 = 내가 담당 운영자인 실기 로봇(총괄·남의 로봇은 서버도 403 MAPPING_OWNER_ONLY) */
export const makers = (u: User, robots: Robot[]) => (u.role === 'OPERATOR' ? robots.filter((r) => r.owner === u.id && !r.sim) : []);

const failText = (p: MappingProgress) => (p.error_code === 'STALE' ? STALE_TEXT : p.error_code === 'LINK_LOST' ? LINK_LOST : p.reason || '지도를 저장하지 못했습니다.');
const actFail = (e: ApiFail) => (e.code === 'STALE' ? STALE_TEXT : e.code === 'ROBOT_OFFLINE' ? OFF : e.message);
/** SAVED 알림 글 — 시뮬 지형은 저장 뒤 따로 만든다(terrain_status) */
const savedText = (p: MappingProgress) => (p.terrain_id || p.terrain_status === 'READY' ? MADE
  : p.terrain_status === 'FAILED' ? '로봇으로 만든 지도를 저장했습니다. 시뮬 지형은 만들지 못했습니다.' : '로봇으로 만든 지도를 저장했습니다. 시뮬 지형은 이어서 만듭니다.');

/** Point-LIO 이상 이유(sources.point_lio.reason_code) — 쉬운 말로 */
export const LIO_WHY: Record<string, string> = {
  POSITION_OUT_OF_RANGE: '위치가 비정상적으로 멀리 튀었습니다(발산)', MISSING_DATA: '위치 자료가 들어오지 않습니다',
  POSITION_JUMP: '위치가 한 번에 너무 크게 바뀌었습니다', STAMP_REGRESSION: '자료 시각이 거꾸로 갔습니다',
  FRAME_MISMATCH: '위치 기준이 정해진 것과 다릅니다', STAMP_SKEW: '자료 시각이 로봇 시계와 어긋났습니다',
  STALE: '위치 자료가 끊겼습니다', INVALID_DATA: '받은 위치 자료가 올바르지 않습니다',
};
export const GLIM_STAGE: Record<string, string> = { OFF: '꺼짐', STARTING: '켜는 중', RECEIVING: '받는 중', SAVING: '저장 중', UNKNOWN: '상태를 알 수 없습니다' };
export const BEFORE = '지도 만들기를 누르면 켜집니다';
const LAMP = { ok: 'var(--ok)', warn: 'var(--warn)', bad: 'var(--bad)' } as const;
type Lamp = keyof typeof LAMP;
/** 받은 값 검사(RV-519 — 서버·로봇이 보낸 모양을 믿지 않음): 유한수만 · 나이는 0 이상만 · 글은 200자까지 · 객체만 */
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const age = (v: unknown) => { const n = num(v); return n != null && n >= 0 ? n : null; };
const str = (v: unknown) => (typeof v === 'string' && v ? v.slice(0, 200) : null);
const obj = <T,>(v: T | null | undefined): Partial<T> | null => (v && typeof v === 'object' ? v : null);
const word = (m: Record<string, string>, k: unknown) => (typeof k === 'string' && Object.prototype.hasOwnProperty.call(m, k) ? m[k] : null);
const ago = (s: number | null) => (s == null ? '' : s < 60 ? `${s.toFixed(1)}초 전` : `${Math.round(s / 60)}분 전`);
const and = (...t: (string | false | null | undefined)[]) => t.filter(Boolean).join(' · ');

/** 한 줄: 점(초록 정상·노랑 기다림·빨강 이상) + 이름 + 글(+ 작은 덧말) */
const Line = ({ k, name, lamp, text, more }: { k: string; name: string; lamp: Lamp; text: string; more?: string }) =>
  <p className="lv-note" data-src={k} data-lamp={lamp} style={{ color: 'var(--text)' }}>
    <i aria-hidden="true" style={{ fontStyle: 'normal', color: LAMP[lamp] }}>●</i> <b>{name}</b> {text}{more && <span style={{ color: 'var(--muted)' }}> · {more}</span>}</p>;

/** Point-LIO·GLIM 상태 두 줄. st = 세션 상태(null = 아직 시작 전). 세션 중인데 sources 가 없으면(옛 서버) 그리지 않는다 */
export function Sources({ st, s }: { st: MappingProgress['status'] | null; s?: MappingSources | null }) {
  if (!st) return <div data-sources="before"><Line k="point_lio" name="Point-LIO" lamp="warn" text={BEFORE} /><Line k="glim" name="GLIM" lamp="warn" text={BEFORE} /></div>;
  if (!s) return null;
  // 한쪽이 없거나 모양이 틀려도(옛·고장 보고) 예외 없이 «기다리는 중» — 초록 «정상»은 신선·위치 유효·이유 없음·나이·위치·Hz 가 모두 맞을 때만
  const pl = obj(obj(s)?.point_lio) ?? {}, g = obj(obj(s)?.glim) ?? {}, code = str(pl.reason_code);
  const waiting = st === 'STARTING' || st === 'SAVING' || st === 'FINALIZING';   // 켜는 중·저장 중엔 자료가 없는 게 이상이 아니다
  const pa = age(pl.pose_age_s), hz = age(pl.pose_hz), pos = Array.isArray(pl.position_m) ? pl.position_m.map(num) : null;
  const at = pos && pos[0] != null && pos[1] != null ? `x ${pos[0].toFixed(2)} · y ${pos[1].toFixed(2)} m` : null;
  const xyz = pos?.length === 3 && pos.every((v) => v != null);   // RV-521: 세 좌표 모두 유한수 · 점군 나이도 유한 ≥0 이어야 초록
  const [lamp, text]: [Lamp, string] = pl.fresh === true && pl.position_valid === true && !code && pa != null && age(pl.cloud_age_s) != null && xyz && at && hz != null ? ['ok', and('실시간 위치 정상', ago(pa), `${hz}Hz`)]
    : code && !(waiting && (code === 'MISSING_DATA' || code === 'STALE')) ? ['bad', and(word(LIO_WHY, code) ?? str(pl.reason) ?? '위치 자료에 문제가 있습니다', ago(pa))]
    : ['warn', and('기다리는 중', ago(pa))];
  const stage = str(g.stage), ga = age(g.data_age_s), chunks = age(g.processed_chunks);
  const gl: Lamp = stage === 'RECEIVING' ? 'ok' : stage === 'UNKNOWN' || (stage === 'OFF' && (st === 'RUNNING' || st === 'FAILED')) ? 'bad' : 'warn';
  return <div data-sources={st}>
    <Line k="point_lio" name="Point-LIO" lamp={lamp} text={text} more={at || undefined} />
    <Line k="glim" name="GLIM" lamp={gl} text={and(word(GLIM_STAGE, stage) ?? stage ?? '기다리는 중', ga != null && `마지막 자료 ${ago(ga)}`,
      stage === 'SAVING' && chunks != null && `${chunks.toLocaleString('ko-KR')}조각 처리`)} more={str(g.reason) ?? undefined} />
  </div>;
}

/** 지도 칸(가로 640:400) — 받은 2D 조각·3D 칸·로봇 위치(screens/slammap.tsx) + GLIM 미리보기(glim_preview, 0.25 m 칸).
 *  지금 그려진 Point-LIO 그림의 세션·판·기준(frame_id)이 미리보기와 같을 때만 겹친다(판이 바뀌는 사이 지난 그림 위에 겹치지 않게 — RV-519).
 *  다르면 겹치지 않고 둘 중 하나만 보기(로봇 화살표도 Point-LIO 기준이라 GLIM 만 볼 땐 뺌). 미리보기가 사라지면 Point-LIO 보기로 돌아감 */
/** 걸은 시간 · 거리 · 로봇이 모은 점(U7-06): 서버 진행 값 그대로, 없거나 이상한 값(음수 · NaN)은 칸째 뺀다 */
const ok = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 0;
const two = (n: number) => String(n).padStart(2, '0');
const clock = (s: number) => { const t = Math.floor(s), h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60; return h ? `${h}:${two(m)}:${two(t % 60)}` : `${two(m)}:${two(t % 60)}`; };
const meters = (m: number) => `${m < 10 ? m.toFixed(1) : Math.round(m).toLocaleString('ko-KR')} m`;
const points = (n: number) => (n >= 1e8 ? `${(n / 1e8).toFixed(1)} 억` : n >= 1e4 ? `${n < 1e5 ? (n / 1e4).toFixed(1) : Math.round(n / 1e4).toLocaleString('ko-KR')} 만` : Math.round(n).toLocaleString('ko-KR'));
const WALK: ['elapsed_s' | 'distance_m' | 'point_count', string, (n: number) => string][] = [['elapsed_s', '걸은 시간', clock], ['distance_m', '걸은 거리', meters], ['point_count', '로봇이 모은 점', points]];
const WALK_KEY = { elapsed_s: 'time', distance_m: 'dist', point_count: 'points' } as const;
export function MapBox({ robot, p, link }: { robot: string; p: MappingProgress; link: number }) {
  const pic = useSlamLive(robot, p, link);
  const [lio, setLio] = useState(true), [gl, setGl] = useState(true);
  const gp = obj(p.glim_preview);
  const same = !!gp && pic.sid === p.session_id && pic.rev === p.revision && pic.frame != null && pic.frame === gp.frame_id;
  const only = !!gp && !same && gl && !lio;   // only = 기준이 달라 GLIM 만 보는 중
  const onLio = same ? lio : !only, onGl = same ? gl : only, hide = !onLio;
  const over = useMemo(() => (gp && onGl ? { cells: gp.cells ?? [], res: gp.resolution ?? 0.25 } : null), [gp, onGl]);   // 칸 검사·1024칸 상한은 SlamView(cleanOver)
  const shown = useMemo(() => (only ? { ...pic, pose: null } : pic), [pic, only]);
  const walk = WALK.flatMap(([k, name, f]) => { const x = p[k]; return ok(x) ? [[k, name, f, x] as const] : []; }), moving = walk.some(([, , , x]) => x > 0);
  const pick = (to: 'lio' | 'gl') => (same ? (to === 'lio' ? setLio((v) => !v) : setGl((v) => !v)) : (setLio(to === 'lio'), setGl(to === 'gl')));
  return <>
    <div style={{ position: 'relative', aspectRatio: '640 / 400', borderRadius: 8, overflow: 'hidden', border: '1px solid var(--line)' }} data-make-mapbox>
      <SlamView pic={shown} over={over} hideBase={hide} empty={hide ? '보이게 고른 지도에 아직 받은 칸이 없습니다.' : moving ? '로봇은 지도를 만드는 중 · 화면에 아직 받은 칸이 없습니다.' : '아직 받은 지도가 없습니다.'} /></div>
    {gp && <div className="fh-row" style={{ flexWrap: 'wrap', alignItems: 'center' }} data-glim-preview={same ? 'over' : 'apart'}>
      <span role="group" aria-label="겹쳐 보기 고르기" className="fh-row">
        <button type="button" className="btn" aria-pressed={onLio} data-layer="point_lio" onClick={() => pick('lio')}>Point-LIO</button>
        <button type="button" className="btn" aria-pressed={onGl} data-layer="glim" onClick={() => pick('gl')}>GLIM</button></span>
      <span className="lv-note">GLIM 미리보기, 저장 전{same ? '' : ' · 좌표 맞춤 전이라 겹치지 않고 따로 봅니다'}</span></div>}
    <div className="mx-sum" aria-label="진행" data-progress={p.status}>
      <span><b>{pic.n.toLocaleString('ko-KR')}</b>받은 3D 칸</span><span><b>{pic.patches.length.toLocaleString('ko-KR')}</b>받은 2D 조각</span></div>
    {/* 로봇이 보낸 진행 값(서버 MappingProgress)은 이 화면이 받은 칸과 출처가 달라 줄을 나눈다 */}
    {walk.length > 0 && <div className="mx-sum" aria-label="로봇 진행" data-walk-row>
      {walk.map(([k, name, f, x]) => <span key={k} data-walk={WALK_KEY[k]}><b>{f(x)}</b>{name}</span>)}</div>}
    {pic.gap && <p className="lv-note" data-gap>이 세션의 3D 칸은 서버에서 처음부터 받을 수 없습니다. 저장한 뒤 다시 열면 전부 보입니다.</p>}
  </>;
}

/** 창 «로봇으로 지도 만들기» 안 — 창이 열릴 때만 그린다(닫으면 언마운트 = 조회 멈춤). made = 이 층에 새 지도가 저장됨(그 판 id, 알림 글).
 *  approved·list = 이 층 지금 승인 판 id·받은 판 목록(받는 중 null) — 지난 SAVED(이미 반영·그 뒤 바뀜)를 다시 알리지 않게.
 *  지도 만들기는 지도 탭에서만(11-25 RB-SLAM-WEB4 — 조종 화면 오른쪽 칸 «지도 만들기» 없앰) */
export function MakeMap({ floor, user, robots, places, cancel, made, approved, list }: { floor: string; user: User; robots: Robot[]; places: Place[]; cancel?: AbortSignal; made: (version: string, text: string) => void;
  approved: string | null; list: MapVersion[] | null }) {
  const mine = makers(user, robots);
  const [rid, setRid] = useState(() => (mine.find((r) => r.online) ?? mine[0])?.id ?? ''), robot = mine.find((r) => r.id === rid);
  const [prog, setProg] = useState<MappingProgress | null | undefined>(), [n, setN] = useState(0), [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null), [poll, setPoll] = useState(''), [ask, setAsk] = useState(false), [stale, setStale] = useState(false);
  const [link, setLink] = useState(0), lost = useRef(false);   // 조회가 끊겼다 이어지면 link+1 — 3D 칸을 처음부터 다시 받는다(slammap)
  const madeRef = useRef(made); madeRef.current = made;
  const startAt = useRef({ sid: '', t: 0 });   // 이 화면이 그 세션의 «시작하는 중»을 처음 본 때(서버·이 PC 시계 차이를 섞지 않게 이 PC 시계만)
  const phone = usePhone(), drive = !!robot && canDrive({ user, phone }, robot), how = drive ? '이 창의 조종 단추나 키보드로' : '폰 조종 화면으로';
  // 1초마다 조회(진행 중인 동안만). 언마운트·로봇 바꿈은 AbortSignal 로 진행 중 요청까지 거둔다
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
        if (lost.current) { lost.current = false; setLink((k) => k + 1); }
        if (x && LIVE.has(x.status)) t = setTimeout(go, 1000);
      } catch (e) {
        const f = e as ApiFail;
        if (f.code === 'CANCELED' || ac.signal.aborted) return;
        setPoll(`진행 상황을 받지 못했습니다. ${f.message}`); lost.current = true;
        if (f.status === 0 || f.status >= 500) t = setTimeout(go, 1000);   // 4xx(권한 등)는 다시 묻지 않는다
      }
    };
    go();
    return () => { ac.abort(); clearTimeout(t); cancel?.removeEventListener('abort', off); };
  }, [rid, n]);
  // 완료는 서버 값만으로: 이 층·이 세션의 SAVED + map_version_id 이고, 그 판이 아직 화면에 반영되지 않았으면(승인 판이 아님·목록에 없거나 승인 상태) 알린다.
  // 저장 응답이 끊겼거나 창을 닫았다 다른 층을 거쳐 돌아와도 같은 판정. 다른 층 SAVED 는 소모하지 않는다. RECEIVED_ONLY 는 창 안 안내로(닫지 않음)
  useEffect(() => {
    const id = prog?.status === 'SAVED' && prog.floor_id === floor ? prog.map_version_id : null;
    if (!id || !list || told.has(prog!.session_id)) return;
    told.add(prog!.session_id);
    const v = list.find((x) => x.id === id);
    if (id !== approved && (!v || v.status === 'APPROVED')) madeRef.current(id, savedText(prog!));
  }, [prog, list, approved]);
  const act = async (op: 'start' | 'save' | 'cancel') => {
    if (busy) return;
    setBusy(true); setMsg(null); setAsk(false);
    try {
      const x = await api.slamDo(rid, op, op === 'start' ? { floor_id: floor, source: 'point_lio' } : { session_id: prog!.session_id }, cancel);
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
  const elsewhere = open && !here && places.find((x) => x.floor.id === prog!.floor_id);
  const p = here ? prog! : null, isStale = stale || p?.error_code === 'STALE';
  const got = prog?.status === 'RECEIVED_ONLY' && prog.floor_id === floor ? prog : null;
  if (p?.status === 'STARTING' && startAt.current.sid !== p.session_id) startAt.current = { sid: p.session_id, t: Date.now() };
  const slow = p?.status === 'STARTING' && Date.now() - startAt.current.t > SLOW_START_S * 1000;
  const asked = !!p?.times?.save_requested_at, stuck = p?.status === 'FAILED' || p?.status === 'UNKNOWN';
  const rej = p?.last_report_rejection ?? got?.last_report_rejection;
  return <div className="fh-form" style={{ gap: 10 }} data-make-map>
    <label className="fh-field"><span>로봇</span>
      <select className="inp" value={rid} disabled={busy || (here && !stuck)} onChange={(e) => { setRid(e.target.value); setProg(undefined); setMsg(null); setStale(false); }}>
        {mine.map((r) => <option key={r.id} value={r.id}>{r.name}{r.online ? '' : ' (연결 안 됨)'}</option>)}</select></label>
    {prog === undefined && !poll && <p className="lv-note" role="status">진행 상황을 확인하는 중…</p>}
    {open && !here && <p className="fh-msg" role="status" data-elsewhere>이 로봇은 {elsewhere ? `«${elsewhere.building.name} ${elsewhere.floor.name}»` : '다른 층'}에서 지도를 만드는 중입니다. 그 층에서 저장하거나 취소하세요.</p>}
    {prog !== undefined && !open && <>
      {got && <div className="fh-row" role="status" data-received><p className="fh-msg fh-grow">{RECEIVED_TEXT}</p>
        {got.map_version_id && <button type="button" className="btn" onClick={() => madeRef.current(got.map_version_id!, RECEIVED_TEXT)}>받은 지도 보기</button>}</div>}
      <Sources st={null} />
      <p className="lv-note">로봇이 돌아다니며 이 층 지도를 그립니다. «지도 만들기»를 누른 뒤 {how} 로봇을 움직이고, 다 돌면 «지도 저장»을 누릅니다.</p>
      {robot && !robot.online && <p className="fh-msg" role="alert" data-offline>{OFF}</p>}
      <div className="fh-row"><button type="button" className="btn pri" disabled={busy || !robot?.online} onClick={() => act('start')}>지도 만들기</button></div>
    </>}
    {p && <>
      {/* 왼쪽 실시간 지도·진행, 오른쪽 조종(좁으면 아래로) — 지도를 보면서 스크롤 없이 STOP·조종 */}
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', gap: 10 }}>
        <div style={{ flex: '1.4 1 340px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 10 }}><Sources st={p.status} s={p.sources} /><MapBox robot={rid} p={p} link={link} /></div>
        {p.status === 'RUNNING' && drive && <div data-make-drive style={{ flex: '1 1 300px', minWidth: 0 }}><ServerDrive c={{ user }} r={robot!} inline /></div>}
      </div>
      {p.status === 'STARTING' && <p className="lv-note" role="status" data-starting>시작하는 중… 로봇이 지도 기능을 켜고 있습니다.</p>}
      {slow && <p className="fh-msg" role="alert" data-slow>{SLOW_TEXT}</p>}
      {p.status === 'RUNNING' && <p className="fh-msg ok" role="status">만드는 중 · {how} 로봇을 천천히 움직이세요.</p>}
      {(p.status === 'SAVING' || p.status === 'FINALIZING') && <p className="lv-note" role="status" data-saving>지도를 저장하는 중… 마무리까지 시간이 걸릴 수 있습니다.</p>}
      {p.status === 'UNKNOWN' && <p className="fh-msg" role="alert" data-unknown>{p.error_code === 'LINK_LOST' ? LINK_LOST : p.reason || '로봇 상태를 확인하지 못했습니다. 저장하거나 취소하세요.'}</p>}
      {p.status === 'FAILED' && <p className="fh-msg" role="alert" data-failed>{failText(p)}</p>}
      {ask ? <div className="fh-row" role="group" aria-label="확인"><span>지금까지 그린 것을 버리고 지도 만들기를 취소할까요?</span>
          <button type="button" className="btn pri" disabled={busy} onClick={() => act('cancel')}>취소하기</button>
          <button type="button" className="btn" onClick={() => setAsk(false)}>돌아가기</button></div>
        : <div className="fh-row">
          {p.status === 'RUNNING' && <button type="button" className="btn pri" disabled={busy || isStale} onClick={() => act('save')}>지도 저장</button>}
          {stuck && !isStale && <button type="button" className="btn pri" disabled={busy} onClick={() => act('save')}>{asked || p.status === 'FAILED' ? '다시 저장' : '지도 저장'}</button>}
          <button type="button" className="btn" disabled={busy} onClick={() => setAsk(true)}>취소</button></div>}
    </>}
    {rej && <p className="lv-note" data-rejected>로봇이 보낸 자료 일부를 서버가 받지 않았습니다: {rej.reason}</p>}
    {isStale && !msg && p?.status !== 'FAILED' && <p className="fh-msg" role="alert">{STALE_TEXT}</p>}
    <Note m={msg} />
    {busy && <p className="lv-note" role="status" data-make-busy>요청을 보내는 중… 답이 오면 단추가 다시 켜집니다.</p>}
    {poll && <p className="fh-msg" role="alert">{poll}</p>}
  </div>;
}
