// 3D 지도(RB-VOXEL-VIEW 11-11): 실기 로봇이 만든 3D 지도 파일(.pcd·.ply) 하나 → 서버가 실기 지도 판 + 시뮬 지형을 같이 만든다(apps/server/VOXEL-MAPS.md).
// 여기는 지도 탭의 «3D 지도 파일» 올리기 칸과 «3D 로 보기»(칸 자료를 묶음으로 받아 높이색 칸으로). 그리기(three)는 voxel3d.tsx 를 동적 import 로만.
// 화면 글은 «3D 지도»·«시뮬 지형»·«지형 수정하기» — 개발자 용어는 쓰지 않는다(파일 형식 이름 .pcd·.ply 만 보인다).
import { lazy, Suspense, useEffect, useRef, useState, type FormEvent } from 'react';
import type { MapVersion, VoxelCells, VoxelMapImport, VoxelMapSummary } from '../../../contracts/ts';
import { ApiFail, api } from '../api';
import { terrainAsk } from './terrain';
import './voxel3d.css';

const Voxel3D = lazy(() => import('./voxel3d'));   // three 는 3D 를 열 때만 받는다

/** 지도 판의 3D 요약(서버 선택 필드 voxel_map). 모양이 어긋나면 없음으로 */
export const voxelOf = (v?: MapVersion | null): VoxelMapSummary | null => {
  const x = v?.voxel_map;
  return x && typeof x.terrain_id === 'string' && Number.isInteger(x.voxel_count) && Array.isArray(x.origin) && x.origin.length === 3 ? x : null;
};

/** 높이색 띠(참고 그림 — 바닥 주황 → 노랑·초록·하늘·파랑·자주, 높을수록). 이 화면 전용 값(토큰 아님) */
export const Z_TOP = 2;   // 이 높이(m) 이상은 맨 끝 색
export const hueAt = (z: number) => 30 + 270 * Math.max(0, Math.min(1, z / Z_TOP));   // HSL 색상각(채도 100%·밝기 50%)
const BAND = `linear-gradient(to right, ${[0, 0.25, 0.5, 0.75, 1].map((t) => `hsl(${hueAt(t * Z_TOP)} 100% 50%) ${t * 100}%`).join(', ')})`;

/** «시뮬 지형 수정하기» — 지형 화면을 열고 그 지형을 고른다 */
export const TerrainLink = ({ id }: { id: string }) =>
  <a className="btn" href="#/terrain" data-voxel-terrain={id} style={{ textDecoration: 'none' }} onClick={() => { terrainAsk.id = id; }}>시뮬 지형 수정하기</a>;

const MAX = 50 * 1024 * 1024;   // 서버 상한 50 MiB — 넘으면 보내기 전에 알린다
const formatOf = (f: File) => (/\.pcd$/i.test(f.name) ? 'pcd' : /\.ply$/i.test(f.name) ? 'ply' : null);
const nameBad = (s: string) => (!s.trim() ? '지도 이름을 입력하세요.' : s.trim().length > 40 ? '지도 이름은 40자까지 씁니다.'
  : /[\p{Cc}\p{Cf}]/u.test(s) ? '지도 이름에 탭 같은 보이지 않는 글자는 쓸 수 없습니다.' : null);
/** 실패 = 어떻게. 서버 문구(이미 쉬운 한국어)는 그대로, 보내기 전·연결 문제만 이 화면 말로 */
function fail(e: ApiFail) {
  if (e.code === 'STALE') return '다른 사람이 먼저 이 층의 지도를 바꿨습니다. 새로 불러온 뒤 다시 올리세요.';
  if (e.code === 'TIMEOUT') return '파일을 올리고 만드는 데 시간이 너무 오래 걸렸습니다. 만들어졌을 수 있어 저장 기록을 다시 받습니다.';
  if (e.status === 404) return '이 층을 찾을 수 없습니다. 지워졌을 수 있어 새로 불러오세요.';
  return e.message;
}

/** 3D 지도 파일 올리기. base = 지금 승인 판(새 층이면 null), had = 지금 지도가 있음(구역·지점·연결점이 옮겨지지 않음을 알림).
 *  made = 저장됨(목록 다시 받기), go = 결과 칸의 «지도 보기»·«3D 로 보기» */
export function VoxelUpload({ floor, base, had, title, ready, cancel, made, go, again }: { floor: string; base: string | null; had: boolean; title: string; ready: boolean; cancel?: AbortSignal;
  made: (x: VoxelMapImport) => void; go: (how: 'map' | '3d') => void; again: () => void }) {
  const [file, setFile] = useState<File | null>(null), [name, setName] = useState(() => title.slice(0, 40));
  const [busy, setBusy] = useState(false), [secs, setSecs] = useState(0), [msg, setMsg] = useState(''), [stale, setStale] = useState(false), [done, setDone] = useState<VoxelMapImport | null>(null);
  useEffect(() => { if (!busy) return; setSecs(0); const t = setInterval(() => setSecs((s) => s + 1), 1000); return () => clearInterval(t); }, [busy]);
  const send = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || !ready) return;
    const format = file && formatOf(file), why = nameBad(name);
    setStale(false);
    if (!file) return setMsg('3D 지도 파일(.pcd·.ply)을 고르세요.');
    if (!format) return setMsg('3D 지도 파일은 .pcd 또는 .ply 파일이어야 합니다.');
    if (file.size > MAX) return setMsg('파일이 너무 큽니다. 3D 지도 파일은 50 MB 까지 올릴 수 있습니다.');
    if (why) return setMsg(why);
    setMsg(''); setBusy(true);
    try {
      const x = await api.voxelUpload(floor, file, { name: name.trim(), format, base }, cancel);
      if (!x?.map?.id || !x.terrain?.spec?.id) throw new ApiFail(0, 'BAD_BODY', '');
      setDone(x); made(x);
    } catch (y) {
      const f = y as ApiFail;
      if (f.code === 'CANCELED') return;
      // 보낸 뒤 답이 끊기면 만들어졌을 수 있다 — 목록을 다시 받고 두 번 올리지 않게 알린다
      if (f.status === 0 && f.code !== 'NETWORK') { setMsg(f.code === 'TIMEOUT' ? fail(f) : '응답을 받지 못했습니다. 만들어졌을 수 있어 저장 기록을 다시 받습니다. 새 기록이 보이면 다시 올리지 마세요.'); again(); return; }
      setMsg(`올리지 못했습니다. ${fail(f)}`); setStale(f.code === 'STALE' || f.status === 404);
    } finally { setBusy(false); }
  };
  if (done) return <div className="fh-form" role="group" aria-label="3D 지도 결과" data-voxel-done>
    <p className="fh-msg ok" role="status">3D 지도로 이 층의 지도와 시뮬 지형을 만들었습니다.</p>
    <p className="lv-note">칸 {done.voxels.voxel_count.toLocaleString('ko-KR')}개 · 시뮬 지형 «{done.terrain.spec.name}» · 상자 {done.terrain.spec.items.length}개</p>
    {!!done.voxels.warnings.length && <div data-voxel-warnings><b>알아 둘 점</b><ul className="vx-warn">{done.voxels.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul></div>}
    <div className="fh-row"><button type="button" className="btn pri" onClick={() => go('3d')}>3D 로 보기</button>
      <button type="button" className="btn" onClick={() => go('map')}>지도 보기</button><TerrainLink id={done.terrain.spec.id} /></div>
  </div>;
  return <form className="fh-form" onSubmit={send} noValidate aria-label="3D 지도 올리기">
    <p className="lv-note">로봇으로 만든 3D 지도 파일 하나로 이 층의 지도와 시뮬 지형이 함께 만들어집니다.</p>
    <label className="fh-field"><span>3D 지도 파일(.pcd·.ply)</span><input type="file" className="inp" accept=".pcd,.ply" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></label>
    <label className="fh-field"><span>지도 이름</span><input className="inp" maxLength={40} value={name} onChange={(e) => setName(e.target.value)} /></label>
    {had && <p className="fh-msg" role="alert">지금 지도를 바꿉니다. 지금 지도의 진입 금지·감속 구역, 지점, 연결점은 새 지도로 옮겨지지 않습니다.</p>}
    {!ready && !busy && <p className="lv-note" role="status">지금 지도를 받은 뒤에 올릴 수 있습니다.</p>}
    <div className="fh-row"><button type="submit" className="btn pri" disabled={busy || !ready}>올리기</button>{stale && <button type="button" className="btn" onClick={() => { setStale(false); setMsg(''); again(); }}>새로 불러오기</button>}</div>
    {busy && <p className="lv-note" role="status" data-voxel-busy>3D 지도를 올리고 지도·시뮬 지형을 만드는 중… {secs}초
      {secs >= 60 && <><br />파일이 크면 몇 분 걸립니다. 창을 닫지 말고 기다리세요.</>}</p>}
    {msg && <p className="fh-msg" role="alert">{msg}</p>}
  </form>;
}

/** 묶음 받기 — 칸 자료를 끝까지(묶음마다 그린다). 실패하면 받은 데까지 두고 «다시 시도»는 이어서 */
function useCells(id: string, cancel?: AbortSignal) {
  const pages = useRef<VoxelCells['cells'][]>([]), at = useRef<number | null>(0);
  const [, tick] = useState(0), [info, setInfo] = useState<{ total: number; got: number; err: string; none: boolean }>({ total: 0, got: 0, err: '', none: false }), [n, setN] = useState(0);
  useEffect(() => {
    let live = true;
    (async () => {
      setInfo((o) => ({ ...o, err: '' }));
      try {
        while (live && at.current != null) {
          const r = await api.voxels(id, at.current, cancel);
          if (!live) return;
          if (!r || !Array.isArray(r.cells) || !(r.next_cursor === null || Number.isInteger(r.next_cursor)) || !Number.isInteger(r.summary?.voxel_count)) throw new ApiFail(0, 'BAD_SHAPE', '받은 3D 지도 형식이 맞지 않습니다.');
          pages.current.push(r.cells); at.current = r.next_cursor;
          setInfo((o) => ({ ...o, total: r.summary.voxel_count, got: o.got + r.cells.length }));
          tick((x) => x + 1);
        }
      } catch (e) {
        const f = e as ApiFail;
        if (!live || f.code === 'CANCELED') return;
        if (f.status === 404) { at.current = null; setInfo((o) => ({ ...o, none: true })); return; }
        setInfo((o) => ({ ...o, err: f.message }));
      }
    })();
    return () => { live = false; };
  }, [n]);
  return { pages: pages.current, ...info, more: at.current != null, again: () => setN((x) => x + 1) };
}

/** «3D 로 보기»: 높이색 칸 + 받는 중 진행 + 높이 범례 한 줄 */
export function VoxelView({ v, cancel }: { v: MapVersion; cancel?: AbortSignal }) {
  const c = useCells(v.id, cancel), empty = !c.more && !c.err && (c.none || !c.got);
  return <div className="vx" data-voxel-view>
    {empty ? <div className="mx-center"><p className="lv-note" data-voxel-empty>이 지도에는 3D 자료가 없습니다.</p></div>
      : <Suspense fallback={<p className="lv-note mx-center" role="status">3D 화면을 여는 중…</p>}><Voxel3D v={v} pages={c.pages} n={c.pages.length} /></Suspense>}
    <div className="vx-over">
      {c.more && !c.err && <p className="lv-note" role="status" data-voxel-loading>3D 지도를 받는 중… {c.got.toLocaleString('ko-KR')}{c.total ? ` / ${c.total.toLocaleString('ko-KR')}` : ''}칸
        {!!c.total && <progress max={c.total} value={c.got} aria-label="3D 지도 받기" />}</p>}
      {c.err && <div className="fh-row"><p className="fh-msg" role="alert">3D 지도를 다 받지 못했습니다({c.got.toLocaleString('ko-KR')}칸까지). {c.err}</p><button type="button" className="btn" onClick={c.again}>이어 받기</button></div>}
    </div>
    {!empty && <div className="vx-legend" aria-label="높이 범례" data-voxel-legend><b>높이</b><span>바닥 0 m</span><span className="vx-band" style={{ background: BAND }} aria-hidden="true" /><span>{Z_TOP} m 이상</span><span aria-hidden="true">· 끌어서 돌리기 · 휠로 확대</span></div>}
  </div>;
}
