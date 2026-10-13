// 보고서(원본 한 쪽 틀) — 고른 수동 임무 진행 기록. web/live.js pageReport 와 같은 규칙.
// 예시값을 쓰지 않는다: 원본 틀의 모든 예시 자리(v.<이름> ?? 예시)에 실제 값이나 «—»를 넘긴다.
// 문서 읽기 실패면 옛 목록으로 확정값처럼 채우지 않고 비운 뒤 «미확인». 고른 run 이 없으면 다른 run 으로 바꿔 보여 주지 않는다.
import { CSS, View } from './Report.view';
import { MapCanvas } from '../map/MapCanvas';
import { LV, durTxt, fmtT, saveBlob, wpName } from '../data/fmt';
import { docById, docsOf, noteOf, useDocs, useMedia } from '../data/shared';
import { histCSV, histRows, href } from '../data/hist';
import { stopProps, toast, useRoute } from '../app/shell';

// 결과 색 = 공식 토큰(Report 는 항상 밝음): 완료·확인 dim-ink, 진행·미확인 note-ink, 실패·중단 stop. 색 + 글자로 구분
const COLOR: Record<string, string> = { '완료': 'var(--dim-ink)', '진행': 'var(--note-ink)', '실패': 'var(--stop)', '중단': 'var(--stop)' };

export default function Report() {
  const D = useDocs(), M = useMedia(), { q, setQ } = useRoute();
  const runs = D.err ? [] : docsOf(D, 'run'), want = q.get('run');
  const pick = D.err ? null : want ? docById(D, want) : runs.find((r) => r.doc.status !== '진행') || runs[0];
  const run = pick && pick.kind === 'run' ? pick : null, R = run?.doc;
  const keep = `기록 보관: 서버 공유 문서·사진 · 이 쪽은 ${new Date().toLocaleString('ko-KR')}에 만듦`;
  const map = (
    <div style={{ position: 'relative', width: '100%', aspectRatio: '920/545', borderRadius: 6, overflow: 'hidden', background: 'var(--map,#0E1317)' }}>
      <MapCanvas name="report" mode="all" noRobot showTrail={false} wps={R ? R.wps : null} zones={D.err ? [] : docsOf(D, 'zone')} />
    </div>
  );
  const blank = { recNo: '—', place: '—', when: '—', who: '—', robot: '—', tplLine: '—', wpLine: '—', resHead: '—', todo: '—', rows: [], modNote: '', thumbs: [],   // null·undefined 면 원본 예시가 나오므로 빈 배열
    map, mapCap: '기록 없음', signA: '운영자', signName: '', signB: '', keep, isBase: true, isGas: false, isPatrol: false, hasFind: false, resColor: 'var(--ink-2)',
    thAt: '방문 기록 시각(운영자)', thRes: '결과' };
  let v: Record<string, unknown>;
  if (!R) {
    v = { ...blank,
      title: D.err ? '기록 읽기 실패 · 미확인' : D.rev == null ? '읽는 중…' : want ? '고른 기록 없음(지워졌거나 수동 임무 기록이 아님)' : '수동 임무 기록 없음',
      resBody: D.err ? `${D.err} — 이전에 읽은 내용도 최신인지 미확인이라 비워 둠. 다시 읽히면 채워짐` : '관제·현황에서 «수동 진행 시작» 뒤 기록이 생깁니다.' };
  } else {
    const vis = R.wps.filter((w) => w.st === '방문').length, miss = R.wps.filter((w) => w.st === '미방문'), n = (c: string) => R.wps.filter((w) => w.chk === c).length;
    const ph = R.wps.flatMap((w, i) => w.photos.map((u) => [u, i] as const));
    v = { ...blank, title: R.name, recNo: run!.id,
      place: 'Gazebo foothold-v2 시뮬 바닥(±10 m) · 실제 현장 아님', when: `${fmtT(R.started)} – ${R.ended ? fmtT(R.ended) : '진행 중'} · ${durTxt(R.started, R.ended)}`,
      who: `마지막 기록 ${run!.by}`, robot: 'Go2 시뮬(Gazebo) · 실기 아님', tplLine: `${R.tmpl || '—'} · 수동 진행(자동 이동·자동 완료 아님)`,
      wpLine: `${R.wps.length}개 · 방문 ${vis} · 미방문 ${miss.length}`, resColor: COLOR[R.status] || 'var(--ink-2)',
      resHead: `${R.status === '완료' ? LV.ok : R.status === '진행' ? LV.warn : LV.bad} ${R.status === '진행' ? '진행 중(수동)' : R.status}`,
      resBody: R.memo || `방문 ${vis}/${R.wps.length} · 판단 확인 ${n('확인')} · 보류 ${n('보류')} · 제외 ${n('제외')}`,
      todo: miss.length ? miss.map((w) => `${wpName(w, R.wps.indexOf(w))}: ${w.why}`).join(' · ') : R.wps.some((w) => w.chk === '보류') ? '보류 판단 지점 다시 확인' : '없음',
      rows: R.wps.map((w, i) => (
        <tr key={i}>
          <td>{wpName(w, i)}</td><td className="mono">{w.at ? fmtT(w.at).slice(6) : '—'}</td><td className="mono">미연결</td>
          <td className="mono">{w.photos.length ? `${w.photos.length} · ${w.photos.map((u) => noteOf(D, u)?.doc.cls || '미분류').join('·')}` : '0'}</td>
          <td className="l">{w.chk ? `${w.chk} · 운영자` : '—'}</td><td className="l">{w.st === '미방문' ? `미방문 · ${w.why}` : w.st === '방문' ? '● 방문' : '대기'}</td>
        </tr>)),
      modNote: `지점마다 할 일: ${[...new Set(R.wps.flatMap((w) => w.mods))].join(' · ') || '이동만'}. 방문 시각은 운영자가 «방문 확인»을 누른 시각입니다(자동 도착 판정·도착 오차 미연결).`,
      mapCap: '지점 위치(계획 스냅샷) · Gazebo GT 좌표 · 지나온 길은 저장하지 않음(미기록)',
      thumbs: ph.length ? ph.slice(0, 12).map(([u, i]) => {
        const f = M.photos.find((p) => p.url === u)?.frame_at, nn = noteOf(D, u);
        return (<div className="thumb" key={`${u}${i}`}><img src={u} alt={`WP${i + 1} 사진`} style={{ width: '100%', aspectRatio: '16/9', objectFit: 'cover', display: 'block' }} />
          <span className="k">{`WP${i + 1} · ${f ? fmtT(f).slice(6) : ''} · ${nn ? `${nn.doc.cls}${nn.doc.memo ? ` · ${nn.doc.memo}` : ''}` : '미분류'}`}</span></div>);
      }) : <span className="k">붙인 사진 없음</span> };
  }
  return (
    <>
      <style>{CSS}</style>
      <div className="lv-row lv-noprint" style={{ maxWidth: 794, margin: '12px auto', padding: '0 8px' }}>
        <select className="lv-inp" aria-label="보고서로 볼 수동 임무" value={run ? run.id : ''} onChange={(e) => setQ('run', e.target.value)}>
          {runs.length ? runs.map((r) => <option key={r.id} value={r.id}>{`${r.doc.name} · ${r.doc.status} · ${fmtT(r.doc.started)}`}</option>)
            : <option value="">{D.err ? '기록 읽기 실패 · 미확인' : '수동 임무 기록 없음'}</option>}
        </select>
        <button type="button" className="lv-btn pri" onClick={() => print()}>인쇄</button>
        <button type="button" className="lv-btn" onClick={() => toast(saveBlob(`foothold-v2-history-${Date.now()}.csv`, new Blob([histCSV(histRows(D, M, true))], { type: 'text/csv' })))}>CSV 내보내기</button>
        <a className="lv-btn" href={href('PcHistory')}>기록 화면</a>
      </div>
      <div id="dc-root"><View v={v} /></div>
      <button type="button" className="lv-noprint lv-fstop" {...stopProps}>STOP</button>
    </>
  );
}
