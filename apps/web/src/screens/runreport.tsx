// 실행 기록 보기(u15_3 중 지금 계약으로 되는 것): 끝난 · 도는 실행 한 건의 실제 값만.
// 실행 = GET /runs/{id}/history(이름 · 상태 · 시작 · 끝), 지점 = GET /events?run_id= 의 RUN_WAYPOINT_ARRIVED · RECORDED 사건(도착 시각 · 단계 결과).
// 예상(걸린 시간 · 배터리 · 작업별)은 계약에 없어 「예상 값은 서버에 아직 없음」 한 줄만 쓰고 수를 짓지 않는다.
import { useEffect, useState } from 'react';
import type { Event as Ev, RunHistory, RunStepResult } from '../../../contracts/ts';
import { ApiFail, api } from '../api';
import { RUN_STATUS } from '../run';
import './records.css';

type Got<T> = { ok: T } | { why: string } | null;
const fail = (e: unknown) => (e instanceof ApiFail ? e.message : '서버에 닿지 못했습니다. 잠시 뒤 다시 시도하세요.');
/** 한 실행의 사건을 끝까지(쪽 상한 20 × 100 건) */
const PAGES = 20;
const clock = (at: string) => new Date(at).toTimeString().slice(0, 8);
const day = (at: string) => { const d = new Date(at); return `${d.getMonth() + 1}/${d.getDate()} ${clock(at)}`; };
/** 걸린 시간: 한 시간 아래 «M 분 S 초», 넘으면 «H 시간 M 분» */
export const took = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60;
  return h ? `${h} 시간 ${m} 분` : `${m} 분 ${s % 60} 초`;
};
type Stop = { idx: number; name: string; arrived?: string; results?: { mode?: string; steps?: RunStepResult[] } };
/** 지점 줄(지점 번호 순): 도착 사건 · 결과 사건을 idx 로 모은다. 같은 idx 가 또 오면 먼저 온 것(도착)을 둔다 */
function stops(evs: Ev[]): Stop[] {
  const by = new Map<number, Stop>();
  for (const e of [...evs].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))) {
    const d = (e.data ?? {}) as Record<string, unknown>, idx = d.idx;
    if (typeof idx !== 'number' || (e.code !== 'RUN_WAYPOINT_ARRIVED' && e.code !== 'RUN_WAYPOINT_RECORDED')) continue;
    const s = by.get(idx) ?? { idx, name: typeof d.mission_name === 'string' ? d.mission_name : '' };
    if (e.code === 'RUN_WAYPOINT_ARRIVED') s.arrived ??= e.at;
    else s.results = (d.results ?? {}) as Stop['results'];
    by.set(idx, s);
  }
  return [...by.values()].sort((a, b) => a.idx - b.idx);
}
const result = (r?: Stop['results']) => {
  if (!r) return '결과 기록 없음';
  if (r.mode !== 'EXECUTED') return '표시만 · 실행 단계 없음';
  const all = r.steps ?? [], bad = all.filter((x) => x.status === 'FAILED');
  return bad.length ? `단계 ${all.length} 개 중 ${bad.length} 개 실패 · ${bad[0].failure_reason || bad[0].failure_code || '까닭 없음'}` : `단계 ${all.length} 개 마침`;
};

export function RunReport({ id, cancel, close }: { id: string; cancel?: AbortSignal; close: () => void }) {
  const [run, setRun] = useState<Got<RunHistory>>(null), [evs, setEvs] = useState<Got<Ev[]>>(null), [again, setAgain] = useState(0);
  useEffect(() => {
    let live = true;
    setRun(null);
    api.runHistory(id, cancel).then((r) => live && setRun({ ok: r }), (e) => live && setRun({ why: fail(e) }));
    return () => { live = false; };
  }, [id]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    let live = true;
    setEvs(null);
    (async () => {
      const all: Ev[] = [];
      let cursor: string | null = null;
      for (let i = 0; i < PAGES; i++) {
        const q = new URLSearchParams({ run_id: id, limit: '100' });
        if (cursor) q.set('cursor', cursor);
        const r = await api.events(q, cancel);
        all.push(...r.items); cursor = r.next_cursor;
        if (!cursor) break;
      }
      return all;
    })().then((x) => live && setEvs({ ok: x }), (e) => live && setEvs({ why: fail(e) }));
    return () => { live = false; };
  }, [id, again]);   // eslint-disable-line react-hooks/exhaustive-deps
  const r = run && 'ok' in run ? run.ok : null, list = evs && 'ok' in evs ? stops(evs.ok) : [];
  return <section className="lv-card rr-card" role="region" aria-label="실행 기록">
    <div className="fh-row"><b className="rr-title">실행 기록{r ? ` · ${r.scenario_name}` : ''}</b><span className="fh-grow" />
      <button type="button" className="btn" onClick={close}>닫기</button></div>
    {!run && <p className="lv-note" role="status">실행 기록을 받는 중…</p>}
    {run && 'why' in run && <p className="fh-msg" role="alert">실행 기록을 받지 못했습니다. {run.why}</p>}
    {r && <>
      <dl className="rr-sum">
        <div><dt>층</dt><dd>{r.floor_name}</dd></div>
        <div><dt>상태</dt><dd data-run-status>{RUN_STATUS[r.status] ?? r.status}</dd></div>
        <div><dt>시작 ~ 끝</dt><dd className="mono">{day(r.started_at)} ~ {r.ended_at ? clock(r.ended_at) : '끝나지 않음'}</dd></div>
        {r.ended_at && <div><dt>걸린 시간</dt><dd data-run-took>{took(Date.parse(r.ended_at) - Date.parse(r.started_at))}</dd></div>}
      </dl>
      <p className="lv-note" data-run-expect>예상 값은 서버에 아직 없음</p>
      {!evs && <p className="lv-note" role="status">지점 기록을 받는 중…</p>}
      {evs && 'why' in evs && <p className="fh-msg" role="alert" data-run-why>지점 기록을 받지 못했습니다. {evs.why} <button type="button" className="btn" onClick={() => setAgain((n) => n + 1)}>다시 시도</button></p>}
      {evs && 'ok' in evs && (list.length ? <div className="hs-wrap"><table className="hs-table" aria-label="지점별 실제">
        <thead><tr><th scope="col">지점</th><th scope="col">도착</th><th scope="col">구간 걸린 시간</th><th scope="col">결과</th></tr></thead>
        <tbody>{list.map((s, i) => { const from = i ? list[i - 1].arrived : r.started_at;
          return <tr key={s.idx}><td>{s.idx + 1}{s.name ? ` · ${s.name}` : ''}</td><td className="mono">{s.arrived ? clock(s.arrived) : '도착 기록 없음'}</td>
            <td>{s.arrived && from ? took(Date.parse(s.arrived) - Date.parse(from)) : '—'}</td><td>{result(s.results)}</td></tr>; })}</tbody>
      </table></div> : <p className="lv-note">이 실행에는 지점 기록이 없습니다.</p>)}
    </>}
  </section>;
}
