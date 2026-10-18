// 휴대폰 기록(원본 거르기 칩·날짜 묶음·항목) — web/live.js pageMHistory 와 같은 규칙. 예시 항목은 쓰지 않는다.
import { useState } from 'react';
import { CSS, View } from './MHistory.view';
import { LV, dayTxt, fmtT, themeClass } from '../data/fmt';
import { docsSt, useDocs, useMedia } from '../data/shared';
import { histRows, sevKeep, type Row } from '../data/hist';
import { LiveStatus, MediaStale } from '../app/status';

const FL = ['전체', '수동 임무', '경보 · 중단', '확인 대기'];
const FN: ((r: Row) => boolean)[] = [() => true, (r) => r.kind === '임무', (r) => (r.kind === '사건' && r.lvl !== 'ok') || (r.kind === '임무' && /실패|중단/.test(r.st || '')), (r) => !!r.wait];

export default function MHistory() {
  const D = useDocs(), M = useMedia(), [filt, setFilt] = useState(0);
  const rs = M.ok ? histRows(D, M, false).filter((r) => sevKeep(r) && FN[filt](r)) : [];   // 715 B1: 폰은 심각도 선택 없음 → 기본(위험·경고)으로 옛 목록 그대로(정보 사건 새 노출·200행 밀림 0)
  const out: JSX.Element[] = []; let day: string | null = null;
  for (const [i, r] of rs.slice(0, 200).entries()) {
    const dt = dayTxt(r.at); if (dt !== day) { day = dt; out.push(<span className="day" key={`d${i}`}>{dt}</span>); }
    out.push(
      <a className="it" href={r.href} key={i}>
        <b style={{ fontSize: '15px' }}>{r.show ?? r.title}</b>
        <span className={`res ${r.lvl}`}>{`${LV[r.lvl] || '·'} ${r.res}`}</span>
        <span className="lbl">{`${r.kind} · ${r.show && r.show !== r.title ? '원문은 상세' : r.sub} · ${r.by || ''} · ${fmtT(r.at)}`}</span>
        <span />
        {r.extra ? <><span className="lbl" style={{ fontSize: '12px', color: 'var(--warn)', fontWeight: '600' }}>{r.extra}</span><span /></> : null}
      </a>);
  }
  // «확인 대기» 칩: 문서를 못 읽음·오류·보관이면 wait 가 꺼져 0건 — «없음»으로 단정하지 않고 분류 미확인 이유를 보임(670 P2)
  const dk = docsSt(D);
  if (M.ok && !rs.length) out.push(<span className="day" key="none">{filt === 3 && dk ? `분류 대기 미확인 — 문서 ${dk}` : '해당 기록 없음'}</span>);
  const v = {
    themeClass: themeClass(false), status: <><LiveStatus D={D} /><MediaStale M={M} D={D} /></>,
    cnt: M.ok ? `${M.stale ? '보관 자료(재조회 실패)' : '서버 보관'} · ${rs.length}건` : '—',
    chipT: FL, chipOn: filt, chips: FL.map((_, i) => () => setFilt(i)),
    list: M.ok ? out : <span className="day">{M.err || '서버 기록 읽는 중…'}</span>,
    listOverflow: 'auto',   // 원본 틀은 넘침 숨김(예시 5건 기준) — 실기록은 길어서 스크롤
  };
  return <><style>{CSS}</style><div id="dc-root"><View v={v} /></div></>;
}
