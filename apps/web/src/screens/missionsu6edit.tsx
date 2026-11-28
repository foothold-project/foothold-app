/** 시안 u6_3 목록 · u6_4 노드 · u6_5 지도 편집 칸(만들기 가운데 · 왼쪽). 마크업은 시안 body 그대로, 상태 · 저장 · 저장 확인 · 충돌은 지도 탭 편집 칸과 같은 훅(missions.tsx usePlanEdit).
 *  지점 = 지도 좌표(m) + 할 일(임무 GET /missions). 지도 누름 · 우클릭 = 그 자리에 할 일 고르는 둥근 차림(u6_5). 경로 검사 = POST /scenarios/preview(저장 전 · 초안 내용).
 *  단계별 분은 서버 Estimate.legs 가 오면 채운다(서버에 요청함) · 그 전엔 빈칸 */
import { useEffect, useMemo, useState, type DragEvent, type ReactNode } from 'react';
import type { Mission, Scenario, ScenarioWaypoint, ScenarioWrite } from '../../../contracts/ts';
import type { Robot } from '../fake';
import { ACT, FINISH } from './missions';
import { hm, useRoute, type Plan, type Route } from './missiontab';
import { IC, Ic, Pager, RobotPill, RouteStage, Why } from './missionsu6';
import type { Place } from './maps';

export type Look = 'list' | 'node' | 'map';
type Edit = { body: ScenarioWrite; put: (b: ScenarioWrite) => void; ro: boolean; jobs: Record<string, Mission> };

/** 초안을 경로 지도(useRoute)에 넣을 모양으로. 층 = 첫 지점의 층, 지점이 없으면 새 임무에서 고른 층 */
export function useDraftRoute(body: ScenarioWrite | null, id: string, floor: string, places: Place[], cancel?: AbortSignal) {
  const fl = body?.waypoints[0]?.floor_id ?? floor, place = places.find((p) => p.floor.id === fl);
  const raw = body ? JSON.stringify([body.waypoints, body.finish]) : '', [key, setKey] = useState(raw);
  useEffect(() => { const t = setTimeout(() => setKey(raw), 400); return () => clearTimeout(t); }, [raw]);   // 미리 확인은 손을 멈춘 뒤 한 번
  const x = useMemo(() => (body ? { id: id || 'new', version: 0, name: body.name, waypoints: body.waypoints, finish: body.finish ?? { mode: 'STAY', target: null }, notes: body.notes ?? '',
    floor_ids: [fl], map_version_ids: place?.floor.approved_version_id ? [place.floor.approved_version_id] : [] } as unknown as Scenario : undefined), [body, id, fl, place?.floor.approved_version_id]);
  const route = useRoute(x, places, cancel, `draft:${key}`);
  return { x, route, checking: raw !== key };
}

/** 저장을 막는 까닭(옛 편집 칸과 같은 판정: 미리 확인 전 · 못 감 · 확인 실패 · 접근 금지 구역) */
export function blockOf(body: ScenarioWrite | null, route: Route, checking: boolean) {
  if (!body || !body.waypoints.length) return null;
  if (checking || !route.pr) return '경로를 확인하는 중입니다.';
  if (route.pr.err) return `경로를 확인하지 못했습니다. ${route.pr.err}`;
  if (route.pr.r && !route.pr.r.reachable) return '갈 수 없는 지점이 있습니다. 표시한 지점을 옮기세요.';
  if (route.hits > 0) return `접근 금지 구역을 지납니다(${route.hits} 곳). 지점을 옮기세요.`;
  return null;
}

const place = (w: ScenarioWaypoint, route: Route) => w.name || (w.waypoint_ref && route.v?.features.waypoints.find((p) => p.id === w.waypoint_ref)?.name) || `(${w.x.toFixed(1)}, ${w.y.toFixed(1)}) m`;
const jobName = (e: Edit, w: ScenarioWaypoint) => e.jobs[w.mission_id]?.name ?? '할 일';
/** 할 일 그림(시안 노드 고르기 그림): 임무 첫 단계로 고른다. 단계 없음 = 이동 */
const JOB_IC = {
  PHOTO: <><path d="m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5" /><rect x="2" y="6" width="14" height="12" rx="2" /></>,
  WAIT: <><path d="M5 22h14" /><path d="M5 2h14" /><path d="M17 22v-4.172a2 2 0 0 0-.586-1.414L12 12l-4.414 4.414A2 2 0 0 0 7 17.828V22" /><path d="M7 2v4.172a2 2 0 0 0 .586 1.414L12 12l4.414-4.414A2 2 0 0 0 17 6.172V2" /></>,
  SENSOR_LOG: <><path d="m12 14 4-4" /><path d="M3.34 19a10 10 0 1 1 17.32 0" /></>,
  OPERATOR_CONFIRM: <><path d="M10.268 21a2 2 0 0 0 3.464 0" /><path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326" /></>,
} as const;
const jobIc = (m?: Mission) => (m?.steps[0] ? JOB_IC[m.steps[0].action] ?? IC.check : IC.arrow);
/** 시안 끝 줄 이름: 돌아오기 = 「돌아옴」 */
const endName = (m?: string | null) => (m === 'RETURN_TO_START' ? '돌아옴' : FINISH[(m ?? 'STAY') as keyof typeof FINISH]);
const leave = (m?: Mission) => (m ? (m.steps.length ? m.steps.map((s) => ACT[s.action] ?? s.action).join(' · ') : '머무르기만') : '임무 정보를 받지 못함');
const badge = (n: number, dashed = false) => <b style={{ width: '22px', height: '22px', borderRadius: '50%', ...(dashed ? { border: '2px dashed #00c389', color: '#fff' } : { background: '#00c389', color: '#06231a' }),
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: '11.5px' }}>{n}</b>;
const move = (e: Edit, from: number, to: number) => { if (e.ro || from === to) return; const l = [...e.body.waypoints], [w] = l.splice(from, 1); l.splice(to, 0, w); e.put({ ...e.body, waypoints: l }); };
const drag = (e: Edit, i: number) => ({ draggable: !e.ro, onDragStart: (ev: DragEvent) => ev.dataTransfer.setData('text/plain', String(i)),
  onDragOver: (ev: DragEvent) => ev.preventDefault(), onDrop: (ev: DragEvent) => { ev.preventDefault(); const f = Number(ev.dataTransfer.getData('text/plain')); if (Number.isInteger(f)) move(e, f, i); } });

/** 할 일 종류 대응표 (한 곳): 지점 → mission_id → Mission.steps[0].action, 지점 wait_s.
 *  이동 = 단계 없음 · 대기 = WAIT 또는 지점 wait_s · 기록 = SENSOR_LOG(params.device). 온도 · 게이지 · 가스는 서버 ActionKey 에 아직 없어 자리만(꺼짐 · 「서버 준비 중」) */
export const KINDS = [
  { k: 'MOVE', label: '여기로 가기', action: null },
  { k: 'GAUGE_READ', label: '게이지 읽기', soon: true },
  { k: 'TEMP_READ', label: '온도 측정', soon: true },
  { k: 'GAS_READ', label: '가스 점검', soon: true },
  { k: 'PHOTO', label: '사진', action: 'PHOTO' },
  { k: 'WAIT', label: '기다리기', action: 'WAIT' },
  { k: 'OPERATOR_CONFIRM', label: '사람 확인', action: 'OPERATOR_CONFIRM' },
  { k: 'SENSOR_LOG', label: '기록', action: 'SENSOR_LOG' },
] as const;
export type Kind = (typeof KINDS)[number]['k'] | 'UNKNOWN';
export const SOON = '서버 준비 중', UNKNOWN_KIND = '알 수 없는 일';
/** 종류 그림 (IC 는 missionsu6 과 서로 부르는 모듈이라 쓸 때 읽는다) */
const kindIc = (k: Kind): ReactNode => ({
  MOVE: IC.arrow, PHOTO: JOB_IC.PHOTO, WAIT: JOB_IC.WAIT, OPERATOR_CONFIRM: JOB_IC.OPERATOR_CONFIRM, SENSOR_LOG: IC.doc, GAUGE_READ: JOB_IC.SENSOR_LOG,
  TEMP_READ: <path d="M14 4v10.54a4 4 0 1 1-4 0V4a2 2 0 0 1 4 0Z" />,
  GAS_READ: <><path d="M12.8 19.6A2 2 0 1 0 14 16H2" /><path d="M17.5 8a2.5 2.5 0 1 1 2 4H2" /><path d="M9.8 4.4A2 2 0 1 1 11 8H2" /></>,
  UNKNOWN: IC.warn,
} as Record<Kind, ReactNode>)[k];
/** 임무 하나의 종류(첫 단계). 모르는 action = 알 수 없는 일 */
export const missionKind = (m?: Mission | null): Kind => {
  if (!m) return 'UNKNOWN';
  const a = m.steps[0]?.action as string | undefined;
  if (!a) return 'MOVE';
  return (KINDS.find((x) => 'action' in x && x.action === a)?.k as Kind | undefined) ?? 'UNKNOWN';
};
/** 지점 하나의 종류: 임무 첫 단계가 먼저, 단계가 없고 wait_s 가 있으면 대기 */
export const kindOf = (w: Pick<ScenarioWaypoint, 'mission_id' | 'wait_s'>, jobs: Record<string, Mission>): Kind => {
  const k = missionKind(jobs[w.mission_id]);
  return k === 'MOVE' && w.wait_s ? 'WAIT' : k;
};
export const kindLabel = (k: Kind) => (k === 'UNKNOWN' ? UNKNOWN_KIND : KINDS.find((x) => x.k === k)!.label);

/** 둥근 할 일 차림(시안 u6_5): 누른 자리(빈 곳이면 새 지점 · 지점이면 그 지점) 가운데 · 둘레에 종류 여덟.
 *  종류를 고르면 그 종류의 임무(이름 순 첫째)로. 그 종류 임무가 없으면 꺼짐, 서버에 없는 종류는 꺼짐 + 「서버 준비 중」 */
export function Radial({ at, jobs, cur, pick, close }: { at: [number, number]; jobs: Mission[]; cur?: Kind; pick: (m: Mission) => void; close: () => void }) {
  const R = 132, C = 180, W = 92, H = 80;
  const of = (k: Kind) => jobs.filter((m) => missionKind(m) === k).sort((a, b) => a.name.localeCompare(b.name, 'ko'))[0];
  return <div style={{ position: 'absolute', left: `${at[0] - C}px`, top: `${at[1] - C}px`, width: `${C * 2}px`, height: `${C * 2}px`, zIndex: 4 }} data-radial role="menu" aria-label={cur ? '이 지점의 할 일' : '이 자리에 할 일'}
    onKeyDown={(ev) => { if (ev.key === 'Escape') close(); }}>
    <div style={{ position: 'absolute', inset: 0, borderRadius: '50%', background: 'radial-gradient(circle,rgba(12,15,20,.55),rgba(12,15,20,.25) 60%,rgba(12,15,20,0) 72%)' }} onClick={close} />
    <div style={{ position: 'absolute', left: `${C - 9}px`, top: `${C - 9}px`, width: '18px', height: '18px', borderRadius: '50%', background: '#fff', border: '3px solid #00c389', boxShadow: '0 0 0 6px rgba(0,195,137,.3)' }} />
    {cur === 'UNKNOWN' && <span className="g dk pill" style={{ left: `${C - 60}px`, top: `${C + 18}px`, height: '26px', fontSize: '12px' }} data-radial-cur>{UNKNOWN_KIND}</span>}
    {KINDS.map((x, n) => {
      const t = (n / KINDS.length) * 2 * Math.PI, m = 'soon' in x ? undefined : of(x.k), on = cur === x.k;
      const why = 'soon' in x ? SOON : !m ? '이 종류의 임무가 아직 없습니다' : undefined;
      return <button key={x.k} type="button" role="menuitem" className={`g${on ? ' wsel' : ''}`} data-radial-kind={x.k} data-soon={'soon' in x || undefined} aria-disabled={why ? 'true' : undefined} aria-pressed={cur ? on : undefined} title={why ?? m!.name}
        onClick={() => { if (m) pick(m); }}
        style={{ left: `${Math.round(C + R * Math.sin(t) - W / 2)}px`, top: `${Math.round(C - R * Math.cos(t) - H / 2)}px`, width: `${W}px`, height: `${H}px`, borderRadius: '18px', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '5px', fontSize: '12.5px', fontWeight: '800', textAlign: 'center', padding: '0 6px',
          ...(on && { background: 'linear-gradient(180deg,#00c389,#00c389)', color: '#fff', borderColor: 'rgba(0,195,137,.9)', boxShadow: '0 10px 24px rgba(0,195,137,.4)' }) }}>
        <Ic d={kindIc(x.k)} />{x.label}</button>;
    })}
  </div>;
}

/** 새 지점(그 층 승인 판 · 고른 임무 최신 판) */
const point = (route: Route, [x, y]: [number, number], m: Mission): ScenarioWaypoint | null =>
  route.v ? { floor_id: route.floor, map_version_id: route.v.id, x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100, mission_id: m.id, mission_version: m.version, name: null } : null;

/** 지도 칸 공통: 누름 · 우클릭 → 둥근 차림(고르는 임무가 정해져 있으면 바로 그 자리) · 지점 누름 → 고름 */
export function EditMap({ e, x, route, sel, setSel, pending, setPending, robot, children }: { e: Edit; x?: Scenario; route: Route; sel: number | null; setSel: (i: number | null) => void;
  pending: Mission | null; setPending: (m: Mission | null) => void; robot?: Robot; children?: ReactNode }) {
  const [menu, setMenu] = useState<{ m: [number, number]; at: [number, number]; i?: number } | null>(null);
  const add = (m: Mission, at: [number, number]) => { const w = point(route, at, m); if (!w || e.ro) return; e.put({ ...e.body, waypoints: [...e.body.waypoints, w] }); setSel(e.body.waypoints.length); setPending(null); setMenu(null); };
  // 지점의 종류 바꾸기 = 그 종류 임무로 바꿈(자리 · 머무는 시간은 그대로)
  const swap = (i: number, m: Mission) => { if (e.ro) return; e.put({ ...e.body, waypoints: e.body.waypoints.map((y, k) => (k === i ? { ...y, mission_id: m.id, mission_version: m.version } : y)) }); setMenu(null); };
  return <>
    <div className="stage" style={{ inset: 0 }}>
      <RouteStage x={x} route={route} sel={sel} pickAt={(i, at) => { setSel(i); setMenu(e.ro ? null : { m: [0, 0], at, i }); }}
        pick={e.ro ? undefined : (m, at) => { if (pending) add(pending, m); else setMenu({ m, at }); }}>{robot && <RobotPill robot={robot} route={route} label={`${robot.name} ${robot.sim ? '시뮬' : '실제'} · 지금 자리`} />}</RouteStage></div>
    {menu && <Radial at={menu.at} jobs={Object.values(e.jobs).filter((j) => !j.archived_at)} cur={menu.i != null && e.body.waypoints[menu.i] ? kindOf(e.body.waypoints[menu.i], e.jobs) : undefined}
      pick={(m) => (menu.i != null ? swap(menu.i, m) : add(m, menu.m))} close={() => setMenu(null)} />}
    {children}
  </>;
}

/** u6_3 왼쪽 «할 일 순서»: 지점마다 이동 · 할 일 두 줄 + 끝 동작 · 끌어서 순서 · 고른 줄 자세히 */
export function ListPane({ e, route, sel, setSel, adding, setAdding }: { e: Edit; route: Route; sel: number | 'end' | null; setSel: (i: number | 'end' | null) => void; adding: boolean; setAdding: (b: boolean) => void }) {
  const rows: ({ k: 'move' | 'task'; i: number } | { k: 'end' })[] = [...e.body.waypoints.flatMap((_, i) => [{ k: 'move' as const, i }, { k: 'task' as const, i }]), { k: 'end' as const }];
  const PER = 6, [page, setPage] = useState(0), pages = Math.max(1, Math.ceil(rows.length / PER)), at = Math.min(page, pages - 1);
  const fin = e.body.finish ?? { mode: 'STAY' as const, target: null };
  const row = (r: (typeof rows)[number], n: number) => {
    const on = r.k === 'end' ? sel === 'end' : r.k === 'task' && sel === r.i, w = r.k === 'end' ? null : e.body.waypoints[r.i];
    const ic = r.k === 'move' ? IC.arrow : r.k === 'end' ? IC.flag : jobIc(e.jobs[e.body.waypoints[r.i].mission_id]), color = r.k === 'task' ? '#00c389' : '#9aa19d';
    return <div key={n} role="button" tabIndex={0} className="row" data-row={r.k} data-row-i={r.k === 'end' ? undefined : r.i} aria-pressed={on} {...(r.k === 'task' ? drag(e, r.i) : {})}
      onClick={() => setSel(r.k === 'end' ? 'end' : r.i)} onKeyDown={(ev) => { if (ev.key === 'Enter') setSel(r.k === 'end' ? 'end' : r.i); }}
      style={{ height: '62px', gap: '12px', padding: '0 14px', borderRadius: '14px', cursor: 'pointer', ...(on ? { background: 'rgba(0,195,137,.08)', border: '1px solid rgba(0,195,137,.5)' } : { border: '1px solid var(--line)', background: 'rgba(255,255,255,.03)' }) }}>
      <span className="mu2"><Ic d={IC.grip} /></span><span style={{ color }}><Ic d={ic} /></span>
      <div style={{ flex: '1', minWidth: 0 }}><div style={{ fontSize: '15px', fontWeight: '700' }} className="row">{r.k === 'move' ? '이동' : r.k === 'end' ? endName(fin.mode) : jobName(e, w!)}&nbsp;{r.k === 'task' && badge(r.i + 1)}</div>
        <div className="lab" style={{ marginTop: '2px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.k === 'end' ? (fin.mode === 'RETURN_TO_START' && e.body.waypoints[0] ? place(e.body.waypoints[0], route) : '') : place(w!, route)}</div></div>
      {/* 단계별 분: 서버 Estimate.legs(요청 중) */}<span className="num" style={{ fontSize: '14px', fontWeight: '700' }} data-leg-min />
    </div>;
  };
  const w = typeof sel === 'number' ? e.body.waypoints[sel] : undefined, job = w ? e.jobs[w.mission_id] : undefined;
  const set = (p: Partial<ScenarioWaypoint>) => typeof sel === 'number' && e.put({ ...e.body, waypoints: e.body.waypoints.map((y, k) => (k === sel ? { ...y, ...p } : y)) });
  return <div className="pane" style={{ left: '24px', top: '156px', width: '500px', bottom: '24px', padding: '22px' }} aria-label="할 일 순서">
    <div className="row" style={{ justifyContent: 'space-between', marginBottom: '14px' }}><span className="ttl">할 일 순서</span>
      <span className="row" style={{ gap: '10px' }}><span className="lab">끌어서 순서 바꾸기</span><Pager n={rows.length} per={PER} at={at} go={setPage} label="할 일" /></span></div>
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>{rows.slice(at * PER, at * PER + PER).map((r, k) => row(r, at * PER + k))}</div>
    <button type="button" className="btns" style={{ marginTop: '12px', height: '52px', fontSize: '14.5px', borderStyle: 'dashed', width: '100%' }} disabled={e.ro} aria-pressed={adding} onClick={() => setAdding(!adding)} data-add-step>
      <Ic d={IC.plus} />{adding ? '지도에서 자리를 누르세요 · 다시 누르면 그만' : '할 일 추가'}</button>
    {w && <div style={{ marginTop: '22px', padding: '18px', borderRadius: '16px', background: 'rgba(255,255,255,.04)', border: '1px solid var(--line)' }} data-step-detail={sel}>
      <div className="row" style={{ gap: '10px' }}><span style={{ color: '#00c389' }}><Ic d={jobIc(job)} /></span><b style={{ fontSize: '15.5px' }}>{jobName(e, w)} · {place(w, route)}</b>
        <span className="row" style={{ marginLeft: 'auto', gap: '6px' }}>
          <button type="button" className="btns" style={{ width: '30px', height: '30px', padding: 0 }} aria-label="앞으로" disabled={e.ro || sel === 0} onClick={() => { move(e, sel as number, (sel as number) - 1); setSel((sel as number) - 1); }}>↑</button>
          <button type="button" className="btns" style={{ width: '30px', height: '30px', padding: 0 }} aria-label="뒤로" disabled={e.ro || sel === e.body.waypoints.length - 1} onClick={() => { move(e, sel as number, (sel as number) + 1); setSel((sel as number) + 1); }}>↓</button>
          <button type="button" className="btns" style={{ width: '30px', height: '30px', padding: 0, color: '#ff4d4f' }} aria-label="이 지점 지우기" disabled={e.ro} data-step-drop
            onClick={() => { e.put({ ...e.body, waypoints: e.body.waypoints.filter((_, k) => k !== sel) }); setSel(null); }}><Ic d={IC.x} /></button></span></div>
      <div style={{ display: 'grid', gridTemplateColumns: '96px minmax(0, 1fr)', rowGap: '12px', marginTop: '14px', fontSize: '14px', fontWeight: '600', alignItems: 'center' }}>
        <span className="lab" style={{ fontSize: '13.5px' }}>할 일</span>
        <select className="u6-select" style={{ width: '100%', minWidth: 0, textOverflow: 'ellipsis' }} aria-label="할 일" value={w.mission_id} disabled={e.ro} data-step-job onChange={(ev) => { const m = e.jobs[ev.target.value]; if (m) set({ mission_id: m.id, mission_version: m.version }); }}>
          {!job && <option value={w.mission_id}>받지 못한 임무</option>}{Object.values(e.jobs).filter((j) => !j.archived_at || j.id === w.mission_id).map((j) => <option key={j.id} value={j.id}>{j.name}</option>)}</select>
        <span className="lab" style={{ fontSize: '13.5px' }}>머무는 시간</span>
        <span className="row" style={{ gap: '6px' }}><input className="u6-select num" style={{ width: '90px' }} type="number" min={0} max={3600} aria-label="머무는 시간(초)" value={w.wait_s ?? ''} disabled={e.ro} data-step-wait
          onChange={(ev) => set({ wait_s: ev.target.value === '' ? null : Math.max(0, Math.min(3600, Math.round(Number(ev.target.value)))) })} /><span className="lab">초</span></span>
        <span className="lab" style={{ fontSize: '13.5px' }}>남길 것</span><span>{leave(job)}</span>
      </div></div>}
    {sel === 'end' && <div style={{ marginTop: '22px', padding: '18px', borderRadius: '16px', background: 'rgba(255,255,255,.04)', border: '1px solid var(--line)' }} data-finish-detail>
      <div className="row" style={{ gap: '10px' }}><span style={{ color: '#9aa19d' }}><Ic d={IC.flag} /></span><b style={{ fontSize: '15.5px' }}>끝나면</b></div>
      <div className="mseg" role="group" aria-label="끝나면" style={{ marginTop: '12px' }}>{(['STAY', 'RETURN_TO_START'] as const).map((k) =>
        <button key={k} type="button" className={fin.mode === k ? 'on' : ''} aria-pressed={fin.mode === k} disabled={e.ro} data-finish={k} onClick={() => e.put({ ...e.body, finish: { mode: k, target: null } })}>{FINISH[k]}</button>)}</div>
      {fin.mode === 'GO_TO' && <Why>지정 지점으로 이동은 지도 탭 편집 칸에서 고칩니다.</Why>}</div>}
    <div className="row lab" style={{ position: 'absolute', left: '22px', right: '22px', bottom: '22px', gap: '8px', fontSize: '13px', lineHeight: '1.5' }}><Ic d={IC.node} />목록 · 노드 · 지도는 같은 임무를 다르게 보여 줍니다. 한 곳에서 고치면 모두 바뀝니다.</div>
  </div>;
}

/** u6_4 노드: 왼쪽 «노드 고르기»(임무 = 할 일) → 지도 보기에서 자리 고르기, 가운데 흐름(출발 → 지점 → 끝), 노드를 다른 노드에 끌어 놓으면 순서, 오른쪽 아래 작은 지도 */
export function NodePane({ e, x, route, p, setSel, pickJob, mini }: { e: Edit; x?: Scenario; route: Route; p: Plan; setSel: (i: number) => void; pickJob: (m: Mission) => void; mini: ReactNode }) {
  const PER = 7, [page, setPage] = useState(0);
  const items: { k: 'start' | 'pt' | 'end'; i: number; t: string; s: string }[] = [
    { k: 'start', i: -1, t: '출발', s: `${e.body.waypoints[0] ? place(e.body.waypoints[0], route) : '첫 지점'} · ${p.start}` },
    ...e.body.waypoints.map((w, i) => ({ k: 'pt' as const, i, t: jobName(e, w), s: place(w, route) })),
    { k: 'end', i: -2, t: endName(e.body.finish?.mode), s: [e.body.finish?.mode === 'RETURN_TO_START' && e.body.waypoints[0] ? place(e.body.waypoints[0], route) : '', p.est ? hm(p.est.eta) : ''].filter(Boolean).join(' · ') }];
  const pages = Math.max(1, Math.ceil(items.length / PER)), at = Math.min(page, pages - 1), shown = items.slice(at * PER, at * PER + PER);
  // 시안 자리: 윗줄 왼→오 셋, 다음 줄 오→왼 셋 … (뱀 모양)
  const pos = (k: number): [number, number] => { const row = Math.floor(k / 3), c = k % 3, col = row % 2 ? 2 - c : c; return [60 + col * 280, 180 + row * 240]; };
  const jobs = Object.values(e.jobs).filter((j) => !j.archived_at).slice(0, 8);
  return <div className="pane" style={{ left: '24px', top: '156px', width: '1500px', bottom: '24px', overflow: 'hidden', background: 'radial-gradient(rgba(255,255,255,.09) 1px,transparent 1.3px) 0 0/24px 24px,linear-gradient(180deg,rgba(255,255,255,.06),rgba(255,255,255,.03))' }} aria-label="노드">
    <div style={{ position: 'absolute', left: '280px', top: '60px', right: '0', bottom: '0' }} data-nodes>
      <svg style={{ position: 'absolute', inset: '0', width: '100%', height: '100%' }} fill="none" stroke="rgba(0,195,137,.7)" strokeWidth="2.4">
        {shown.slice(1).map((_, k) => { const [ax, ay] = pos(k), [bx, by] = pos(k + 1);
          return <path key={k} d={ay === by ? `M${ax < bx ? ax + 210 : ax} ${ay + 38} H${ax < bx ? bx : bx + 210}` : `M${ax + 105} ${ay + 76} V${by}`} />; })}</svg>
      {shown.map((n, k) => { const [l, t] = pos(k);
        return <div key={`${n.k}${n.i}`} role={n.k === 'pt' ? 'button' : undefined} tabIndex={n.k === 'pt' ? 0 : undefined} className="g dk" data-node={n.k === 'pt' ? n.i + 1 : n.k}
          {...(n.k === 'pt' ? { ...drag(e, n.i), onClick: () => setSel(n.i) } : {})}
          style={{ left: `${l}px`, top: `${t}px`, width: '210px', height: '76px', padding: '0 14px', display: 'flex', alignItems: 'center', gap: '12px', borderRadius: '16px', cursor: n.k === 'pt' ? 'grab' : undefined }}>
          <span style={{ width: '40px', height: '40px', borderRadius: '12px', background: 'rgba(0,195,137,.18)', color: '#00c389', display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none' }}><Ic d={n.k === 'start' ? IC.play : n.k === 'end' ? IC.flag : jobIc(e.jobs[e.body.waypoints[n.i].mission_id])} /></span>
          <div style={{ minWidth: 0 }}><div style={{ fontSize: '15px', fontWeight: '800', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{n.t}</div>
            <div className="u6-at" style={{ fontSize: '12.5px', fontWeight: '600', marginTop: '2px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{n.s}</div></div></div>; })}
      {pages > 1 && <div style={{ position: 'absolute', left: '60px', top: '20px' }}><Pager n={items.length} per={PER} at={at} go={setPage} label="노드" /></div>}
    </div>
    <div style={{ position: 'absolute', left: '22px', top: '22px', width: '230px' }}><div className="ttl" style={{ fontSize: '17px', marginBottom: '12px' }}>노드 고르기</div>
      {jobs.map((j) => <button key={j.id} type="button" className="row" disabled={e.ro} data-node-job={j.id} onClick={() => pickJob(j)}
        style={{ width: '100%', height: '46px', gap: '10px', padding: '0 12px', borderRadius: '12px', marginBottom: '6px', border: '1px solid var(--line)', background: 'rgba(255,255,255,.03)', fontSize: '14px', fontWeight: '700' }}>
        <span className="mu2"><Ic d={jobIc(j)} /></span><span style={{ minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={j.name}>{j.name}</span></button>)}
      {!jobs.length && <Why>임무(할 일)가 없습니다.</Why>}</div>
    <div className="g dk" style={{ position: 'absolute', left: '300px', bottom: '22px', height: '46px', padding: '0 16px', borderRadius: '13px', display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13.5px', fontWeight: '600', whiteSpace: 'nowrap' }}>
      <Ic d={IC.node} />목록 · 지도와 같은 임무입니다. 노드를 끌어 놓으면 지도 경로도 바뀝니다.</div>
    <div className="g dk" style={{ position: 'absolute', right: '22px', bottom: '22px', width: '380px', height: '220px', borderRadius: '16px', overflow: 'hidden', padding: '0' }} aria-label="작은 지도">{x ? mini : null}</div>
  </div>;
}

/** u6_5 지도 위 «할 일 순서» 상자(고르는 중인 할 일은 점선 번호) */
export function MapSteps({ e, route, pending }: { e: Edit; route: Route; pending: Mission | null }) {
  const PER = 8, [page, setPage] = useState(0), n = e.body.waypoints.length, at = Math.min(page, Math.max(0, Math.ceil(n / PER) - 1));
  return <div className="g dk" style={{ left: '20px', top: '20px', width: '320px', padding: '18px', borderRadius: '18px', zIndex: 3 }} data-map-steps>
    <div className="row" style={{ justifyContent: 'space-between', marginBottom: '10px' }}><span style={{ fontSize: '15px', fontWeight: '800' }}>할 일 순서</span><Pager n={n} per={PER} at={at} go={setPage} label="할 일" /></div>
    {e.body.waypoints.slice(at * PER, at * PER + PER).map((w, k) => <div key={at * PER + k} className="row" style={{ height: '38px', gap: '10px', fontSize: '14px', fontWeight: '700' }}>{badge(at * PER + k + 1)}<span style={{ minWidth: 0, flex: '1', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={jobName(e, w)}>{jobName(e, w)}</span>
      <span className="u6-at" style={{ flex: 'none', fontSize: '12.5px', maxWidth: '96px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{place(w, route)}</span></div>)}
    {pending && <div className="row u6-pend" style={{ height: '42px', gap: '10px', fontSize: '14px', fontWeight: '800', marginTop: '6px' }} data-pending>{badge(n + 1, true)}{pending.name} 고르는 중</div>}
    {!n && !pending && <Why>지도를 누르거나 우클릭해 첫 할 일을 놓으세요.</Why>}
  </div>;
}
