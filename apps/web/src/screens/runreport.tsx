// 실행 기록 보기(u15_3 중 지금 계약으로 되는 것): 끝난 · 도는 실행 한 건의 실제 값만.
// 실행 = GET /runs/{id}/history(이름 · 상태 · 시작 · 끝), 지점 = GET /events?run_id= 의 RUN_WAYPOINT_ARRIVED · RECORDED 사건(도착 시각 · 단계 결과).
// 예상(걸린 시간 · 배터리 · 작업별)은 계약에 없어 「예상 값은 서버에 아직 없음」 한 줄만 쓰고 수를 짓지 않는다.
import { useEffect, useRef, useState } from 'react';
import type { Event as Ev, RunHistory, RunStepResult } from '../../../contracts/ts';
import { ApiFail, api } from '../api';
import { RUN_STATUS } from '../run';
import './records.css';

type Got<T> = { ok: T } | { why: string } | null;
type Evs = { items: Ev[]; cut: boolean };
const fail = (e: unknown) => (e instanceof ApiFail ? e.message : '서버에 닿지 못했습니다. 잠시 뒤 다시 시도하세요.');
/** 한 실행의 사건을 끝까지(쪽 상한 20 × 100 건) */
const PAGES = 20, PER = 100;
const clock = (at: string) => new Date(at).toTimeString().slice(0, 8);
const day = (at: string) => { const d = new Date(at); return `${d.getMonth() + 1}/${d.getDate()} ${clock(at)}`; };
/** 시작 ~ 끝: 끝이 다른 날(현지)이면 끝에도 날짜 */
const span = (a: string, b: string) => `${day(a)} ~ ${new Date(a).toDateString() === new Date(b).toDateString() ? clock(b) : day(b)}`;
/** 걸린 시간: 한 시간 아래 «M 분 S 초», 넘으면 «H 시간 M 분» */
export const took = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60;
  return h ? `${h} 시간 ${m} 분` : `${m} 분 ${s % 60} 초`;
};
export type Stop = { idx: number; name: string; arrived?: string; results?: { mode?: string; steps?: RunStepResult[] } };
/** 지점 줄(지점 번호 순): 도착 사건 · 결과 사건을 idx 로 모은다. 같은 idx 가 또 오면 먼저 온 것(도착)을 둔다 */
export function stops(evs: Ev[]): Stop[] {
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
export const result = (r?: Stop['results']) => {
  if (!r) return '결과 기록 없음';
  if (r.mode !== 'EXECUTED') return '표시만 · 실행 단계 없음';
  const all = r.steps ?? [], bad = all.filter((x) => x.status === 'FAILED');
  return bad.length ? `단계 ${all.length} 개 중 ${bad.length} 개 실패 · ${bad[0].failure_reason || bad[0].failure_code || '까닭 없음'}` : `단계 ${all.length} 개 마침`;
};

/** 한 실행의 머리(GET /runs/{id}/history) · 사건(GET /events?run_id) 받기 · 다시 받기 */
function useRun(id: string, cancel?: AbortSignal) {
  const [run, setRun] = useState<Got<RunHistory>>(null), [evs, setEvs] = useState<Got<Evs>>(null), [again, setAgain] = useState(0), [head, setHead] = useState(0);
  useEffect(() => {
    let live = true;
    setRun(null);
    api.runHistory(id, cancel).then((r) => live && setRun({ ok: r }), (e) => live && setRun({ why: fail(e) }));
    return () => { live = false; };
  }, [id, head]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    let live = true;
    setEvs(null);
    (async () => {
      const all: Ev[] = [];
      let cursor: string | null = null;
      for (let i = 0; i < PAGES; i++) {
        const q = new URLSearchParams({ run_id: id, limit: String(PER) });
        if (cursor) q.set('cursor', cursor);
        const r = await api.events(q, cancel);
        all.push(...r.items); cursor = r.next_cursor;
        if (!cursor) break;
      }
      return { items: all, cut: !!cursor };   // 쪽 상한을 다 쓰고도 더 있으면 잘렸다고 알린다
    })().then((x) => live && setEvs({ ok: x }), (e) => live && setEvs({ why: fail(e) }));
    return () => { live = false; };
  }, [id, again]);   // eslint-disable-line react-hooks/exhaustive-deps
  return { run, evs, setAgain, setHead };
}

export function RunReport({ id, cancel, close }: { id: string; cancel?: AbortSignal; close: () => void }) {
  const { run, evs, setAgain, setHead } = useRun(id, cancel);
  const title = useRef<HTMLElement>(null);
  useEffect(() => { title.current?.focus(); }, []);   // 열면 초점을 제목으로(표 아래에서 눌러도 보고서가 보이게). 닫을 때는 부른 쪽이 누른 단추로 돌려줌
  const r = run && 'ok' in run ? run.ok : null, list = evs && 'ok' in evs ? stops(evs.ok.items) : [];
  return <section className="lv-card rr-card" role="region" aria-label="실행 기록">
    <div className="fh-row"><b className="rr-title" tabIndex={-1} ref={title} data-run-title>실행 기록{r ? ` · ${r.scenario_name}` : ''}</b><span className="fh-grow" />
      <button type="button" className="btn" onClick={close}>닫기</button></div>
    {!run && <p className="lv-note" role="status">실행 기록을 받는 중…</p>}
    {run && 'why' in run && <p className="fh-msg" role="alert" data-run-head-why>실행 기록을 받지 못했습니다. {run.why} <button type="button" className="btn" onClick={() => setHead((n) => n + 1)}>다시 시도</button></p>}
    {r && <>
      <dl className="rr-sum">
        <div><dt>층</dt><dd>{r.floor_name}</dd></div>
        <div><dt>상태</dt><dd data-run-status>{RUN_STATUS[r.status] ?? r.status}</dd></div>
        <div><dt>시작 ~ 끝</dt><dd className="mono" data-run-span>{r.ended_at ? span(r.started_at, r.ended_at) : `${day(r.started_at)} ~ 끝나지 않음`}</dd></div>
        {r.ended_at && <div><dt>걸린 시간</dt><dd data-run-took>{took(Date.parse(r.ended_at) - Date.parse(r.started_at))}</dd></div>}
      </dl>
      <p className="lv-note" data-run-expect>예상 값은 서버에 아직 없음</p>
      {!evs && <p className="lv-note" role="status">지점 기록을 받는 중…</p>}
      {evs && 'why' in evs && <p className="fh-msg" role="alert" data-run-why>지점 기록을 받지 못했습니다. {evs.why} <button type="button" className="btn" onClick={() => setAgain((n) => n + 1)}>다시 시도</button></p>}
      {evs && 'ok' in evs && evs.ok.cut && <p className="lv-note" data-run-cut>사건이 많아 앞 {(PAGES * PER).toLocaleString('en-US')} 건만 보았습니다. 뒤 지점은 빠졌을 수 있습니다.</p>}
      {evs && 'ok' in evs && (list.length ? <div className="hs-wrap"><table className="hs-table" aria-label="지점별 실제">
        <thead><tr><th scope="col">지점</th><th scope="col">도착</th><th scope="col">구간 걸린 시간</th><th scope="col">결과</th></tr></thead>
        <tbody>{list.map((s, i) => { const from = i ? list[i - 1].arrived : r.started_at;
          return <tr key={s.idx}><td>{s.idx + 1}{s.name ? ` · ${s.name}` : ''}</td><td className="mono">{s.arrived ? clock(s.arrived) : '도착 기록 없음'}</td>
            <td>{s.arrived && from ? took(Date.parse(s.arrived) - Date.parse(from)) : '계산 못함'}</td><td>{result(s.results)}</td></tr>; })}</tbody>
      </table></div> : <p className="lv-note">이 실행에는 지점 기록이 없습니다.</p>)}
    </>}
  </section>;
}

const NO = '서버에 값 없음';
const mins = (ms: number) => `${Math.max(0, Math.round(ms / 60000))} 분`;
const X = <svg className="ic" viewBox="0 0 24 24" style={{ width: '20px', height: '20px' }} aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>;
const DL = <svg className="ic" viewBox="0 0 24 24" style={{ width: '17px', height: '17px' }} aria-hidden="true"><path d="M12 15V3M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5" /></svg>;
/** 시안 u15_3 임무 보고서(PC 기록 탭 · 사건 자세히의 「실행 기록 보기」). DOM · 클래스는 시안 그대로(.dim · .md · .kp · .tbl), 값은 지금 계약으로 되는 것만.
 *  예상 · 배터리 · 차이 · 다음 모의 실행 반영 · 예상의 근거는 서버에 값이 없어 「서버에 값 없음」. 내보내기 = 이 실행의 사건 CSV(GET /events/export.csv?run_id) */
export function RunReportU15({ id, cancel, close, robot, exp }: { id: string; cancel?: AbortSignal; close: () => void; robot?: string;
  /** 이 실행의 사건 CSV 받기(부른 쪽이 내려받기 · 결과 줄을 맡음). 없으면 단추 잠금 */ exp?: { go: () => void; busy: boolean; note?: string } }) {
  const { run, evs, setAgain, setHead } = useRun(id, cancel);
  const title = useRef<HTMLHeadingElement>(null);
  useEffect(() => { title.current?.focus(); }, []);
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); }; addEventListener('keydown', k); return () => removeEventListener('keydown', k); }, [close]);
  const r = run && 'ok' in run ? run.ok : null, items = evs && 'ok' in evs ? evs.ok.items : [], list = stops(items);
  const bad = items.filter((e) => e.severity !== 'INFO'), worst = bad.find((e) => e.severity === 'ERROR') ?? bad[0];
  return <><div className="dim" onClick={close} />
    <div className="md" role="dialog" aria-label="실행 기록" style={{ left: '300px', top: '150px', width: '1320px', padding: '30px 36px 32px' }} data-run-report>
      <div style={{ display: 'flex', alignItems: 'flex-start' }}><div><h2 tabIndex={-1} ref={title} data-run-title>임무 보고서{r ? ` · ${r.scenario_name}` : ''}</h2>
        <div className="sb">{r ? <>{[robot, r.floor_name, r.ended_at ? span(r.started_at, r.ended_at) : `${day(r.started_at)} ~ 끝나지 않음`].filter(Boolean).join(' · ')} · <span data-run-status>{RUN_STATUS[r.status] ?? r.status}</span></> : run && 'why' in run ? '' : '실행 기록을 받는 중…'}</div></div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: '8px' }}>
          <button type="button" className="btns" style={{ height: '44px', padding: '0 16px', fontSize: '14px' }} disabled={!exp || exp.busy} onClick={exp?.go} data-run-export>{DL}{exp?.busy ? '내보내는 중…' : '내보내기'}</button>
          <button type="button" aria-label="닫기" style={{ width: '44px', height: '44px', borderRadius: '12px', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(255,255,255,.06)' }} id="go-x" onClick={close}>{X}</button></div></div>
      {exp?.note && <p className="u8-msg" role="status" data-run-export-note>{exp.note}</p>}
      {run && 'why' in run && <p className="u8-msg" role="alert" data-run-head-why>실행 기록을 받지 못했습니다. {run.why} <button type="button" className="btns" onClick={() => setHead((n) => n + 1)}>다시 시도</button></p>}
      {r && <>
        <div style={{ display: 'flex', gap: '12px', marginTop: '22px' }}>
          <div className="kp"><span>걸린 시간 · 예상 → 실제</span><b data-run-took>{r.ended_at ? mins(Date.parse(r.ended_at) - Date.parse(r.started_at)) : '끝나지 않음'}<small>예상 {NO}</small></b></div>
          <div className="kp"><span>종료 시 배터리 · 예상 → 실제</span><b>없음<small>{NO}</small></b></div>
          <div className="kp"><span>점검 지점</span><b data-run-stops>{list.filter((x) => x.arrived).length}<small>곳 도착 · 상태 {RUN_STATUS[r.status] ?? r.status}</small></b></div>
          <div className="kp"><span>사건</span><b data-run-bad>{evs && 'ok' in evs ? bad.length : ''}<small>{worst ? `${worst.severity === 'ERROR' ? '위험' : '주의'} · ${worst.message.replace(/^\d\d:\d\d /, '')}` : evs && 'ok' in evs ? '주의 · 위험 없음' : ''}</small></b></div>
        </div>
        {!evs && <p className="u8-msg mu2" role="status">지점 기록을 받는 중…</p>}
        {evs && 'why' in evs && <p className="u8-msg" role="alert" data-run-why>지점 기록을 받지 못했습니다. {evs.why} <button type="button" className="btns" onClick={() => setAgain((n) => n + 1)}>다시 시도</button></p>}
        {evs && 'ok' in evs && evs.ok.cut && <p className="u8-msg mu2" data-run-cut>사건이 많아 앞 {(PAGES * PER).toLocaleString('en-US')} 건만 보았습니다. 뒤 지점은 빠졌을 수 있습니다.</p>}
        {evs && 'ok' in evs && <div style={{ marginTop: '22px' }}><table className="tbl" aria-label="지점별 실제"><thead><tr><th>작업</th><th>장소</th><th className="n">예상</th><th className="n">실제</th><th className="n">차이</th><th>까닭</th></tr></thead>
          <tbody>{list.slice(0, 8).map((x, i) => { const from = i ? list[i - 1].arrived : r.started_at;
            return <tr key={x.idx} data-run-row={x.idx + 1}><td>{x.name || '이동'}</td><td style={{ color: 'var(--mu2)' }}>지점 {x.idx + 1}</td><td className="n" style={{ color: 'var(--mu2)' }}>없음</td>
              <td className="n">{x.arrived && from ? took(Date.parse(x.arrived) - Date.parse(from)) : '도착 기록 없음'}</td><td className="n" style={{ color: 'var(--mu2)' }}>없음</td>
              <td style={{ color: 'var(--mu2)', fontSize: '13px' }}>{result(x.results)}</td></tr>; })}
            {!list.length && <tr><td colSpan={6} style={{ color: 'var(--mu2)' }}>이 실행에는 지점 기록이 없습니다.</td></tr>}</tbody></table>
          {list.length > 8 && <p className="u8-msg mu2">앞 8 지점만 보입니다 · 나머지 {list.length - 8} 지점은 내보내기 CSV 에 있습니다.</p>}</div>}
        <div style={{ marginTop: '18px', display: 'flex', gap: '12px' }}>
          <div className="kp" style={{ flex: '1' }}><span>다음 모의 실행에 반영</span><b style={{ fontSize: '15px', fontWeight: '700', lineHeight: '1.6', color: 'var(--mu2)' }}>{NO} · 예상과 실제의 차이를 서버가 아직 계산하지 않습니다.</b></div>
          <div className="kp" style={{ flex: '1' }}><span>예상의 근거</span><b style={{ fontSize: '15px', fontWeight: '700', lineHeight: '1.6', color: 'var(--mu2)' }}>{NO}</b></div>
        </div>
      </>}
    </div></>;
}
