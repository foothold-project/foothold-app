// 지도 탭 버전 기록 = 시안 u7_9_history. 시안 body 틀(왼쪽 버전 줄 · 머리 · 비교 그림 칸 · 아래 「바뀐 것」)을 그대로 두고 값은 서버 판 목록 · 판 비교(/map-versions/{id}/diff)만.
// 비교 그림은 기록 비교(mapdiff DiffPic)와 같은 것: 두 판 그림을 같은 지도 좌표로 겹치고 차이를 색으로. 되돌리기는 층 화면의 「이 기록으로 되돌리기」 확인(이유 칸)으로.
import { startTransition, useEffect, useState } from 'react';
import type { MapDiff, MapVersion } from '../../../../contracts/ts';
import { api, type ApiFail } from '../../api';
import { CH, DiffPic, diffFail, isDiff, says } from '../mapdiff';
import { shape, type Place } from '../maps';
import '../../proto/ui.pv.css';
import '../../proto/pc.pv.css';
import '../../proto/light.pv.css';
import './u7.css';

const md = (iso: string) => { const d = new Date(iso); return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const SAME = '#9aa19d';
const GONE = '이 기록을 찾을 수 없습니다. 지워졌을 수 있어 새로 불러오세요.';
const light = () => typeof document !== 'undefined' && document.documentElement.dataset.theme === 'light';

/** list = 같은 층 판 목록(최신이 위), now = 지금 승인 판. restore = 그 판으로 되돌리기 확인 열기(한때 승인된 판만 · 실기 현장만). back = 층 화면(u7_3) */
export function History({ p, list, now, names, real, cancel, back, restore, gone }: {
  p: Place; list: MapVersion[]; now: MapVersion; names: (id: string) => string | undefined; real: boolean; cancel?: AbortSignal;
  back: () => void; restore: (v: MapVersion) => void; gone: () => void;
}) {
  // 고른 두 판: b = 뒤(번호 큰 쪽), a = 앞(없으면 빈 지도). 처음 = 지금 판과 그 기준 판
  const [pair, setPair] = useState<[string | null, string]>(() => [now.base_version_id && list.some((x) => x.id === now.base_version_id) ? now.base_version_id : null, now.id]);
  const byId = (id: string | null) => (id ? list.find((x) => x.id === id) ?? null : null);
  const a = byId(pair[0]), b = byId(pair[1]) ?? now;
  const pick = (x: MapVersion) => {
    if (x.id === b.id || x.id === a?.id) return;
    const two = [x, b].sort((m, n) => n.number - m.number);   // 새로 고른 줄 + 뒤 판 = 비교 둘
    setPair([two[1].id, two[0].id]);
  };
  const [d, setD] = useState<MapDiff | null>(null), [err, setErr] = useState(''), [n, setN] = useState(0);
  useEffect(() => {
    let live = true;
    setD(null); setErr('');
    api.diff(b.id, a?.id ?? null, cancel).then(shape(isDiff)).then((x) => { if (live) startTransition(() => setD(x)); }, (e: ApiFail) => {
      if (!live || e.code === 'CANCELED') return;
      setErr(e.status === 404 ? GONE : diffFail(e));   // 404 = 판이 지워짐 · 「다시 시도」 가 목록을 다시 받는다(저절로 되풀이하지 않음)
    });
    return () => { live = false; };
  }, [a?.id, b.id, n]);
  const vn = (x: Pick<MapVersion, 'id' | 'number'>) => `v${x.number}`;
  const ch = d?.changes ?? [];
  const can = real && !!a && a.status === 'SUPERSEDED';   // 한때 승인된 판만 되돌림(서버 ROLLBACK_NOT_APPROVED)
  const cell = (k: string, color: string, title: string, sub: string) => <div key={k} className="row" style={{ flex: '1', gap: '14px', padding: '0 22px', borderRight: '1px solid var(--line)' }} data-u7-change={k}>
    <i className="sw2" style={{ width: '14px', height: '14px', background: color }} /><div style={{ minWidth: '0' }}><b style={{ fontSize: '15px' }}>{title}</b>
      <div className="mu2" style={{ fontSize: '12.5px', marginTop: '4px', fontWeight: '600' }}>{sub}</div></div></div>;
  const count = (c: keyof typeof CH) => ch.filter((x) => x.change === c).length;
  return <div className={`proto${light() ? ' light' : ''} u7`} aria-label="버전 기록" data-u7="u7_9_history">
    <div className="pane side"><span className="ttl">버전 기록</span><p className="mu2" style={{ fontSize: '12.5px', margin: '8px 4px 14px' }}>두 버전을 골라 비교합니다.</p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }} aria-label="저장 기록 목록">{list.map((x) => {
        const on = x.id === a?.id || x.id === b.id, who = names(x.created_by);
        return <div key={x.id} className={`frow${on ? ' on' : ''}`} style={{ padding: '14px' }} role="button" tabIndex={0} aria-pressed={on} data-save={x.id} onClick={() => pick(x)}>
          <span className={`tag${x.id === now.id ? ' m' : ''}`} style={{ height: '28px', fontSize: '13px' }}>{vn(x)}</span>
          <div style={{ flex: '1', minWidth: '0' }}><b style={{ fontSize: '14.5px' }}>{x.reason}</b><div className="meta"><span>{md(x.created_at)}</span>{who && <span>{who}</span>}</div></div>
          {x.id === now.id && <span className="mu2" style={{ fontSize: '12px' }}>현재 버전</span>}</div>;
      })}</div>
      {can && <div className="btns" style={{ position: 'absolute', left: '20px', right: '20px', bottom: '20px', height: '48px', fontSize: '14px' }} role="button" tabIndex={0} data-u7-restore onClick={() => restore(a!)}>
        <svg className="ic" viewBox="0 0 24 24" style={{ width: '17px', height: '17px' }}><path d="M9 14 4 9l5-5" /><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11" /></svg>{vn(a!)} 로 되돌리기</div>}
    </div>
    <div className="head"><span className="g dk" style={{ position: 'relative', width: '44px', height: '44px', borderRadius: '13px', display: 'flex', alignItems: 'center', justifyContent: 'center' }} role="button" tabIndex={0} aria-label="지도로" data-u7-back onClick={back}>
      <svg className="ic" viewBox="0 0 24 24" style={{ width: '20px', height: '20px' }}><path d="m15 18-6-6 6-6" /></svg></span>
      <span className="ttl" style={{ fontSize: '26px' }}>{p.building.name} · {p.floor.name}</span>
      <span className="mu2" style={{ fontSize: '14px', fontWeight: '600' }} data-u7-pair>{a ? `${vn(a)} 와 ${vn(b)} 비교` : `빈 지도와 ${vn(b)} 비교`}</span>
      <div className="row" style={{ marginLeft: 'auto', gap: '16px', fontSize: '13px', fontWeight: '600' }}>
        {([['added', '추가됨'], ['removed', '지워짐'], ['changed', '바뀜']] as const).map(([k, t]) => <span key={k} className="row" style={{ gap: '6px' }}><i className="sw2" style={{ background: CH[k].color }} />{t}</span>)}
        <span className="row" style={{ gap: '6px' }}><i className="sw2" style={{ background: SAME }} />같음</span></div></div>
    <div className="pane" style={{ left: '348px', top: '160px', right: '24px', height: '740px', overflow: 'hidden', padding: '0' }}>
      <div className="u7-pic">{d ? <DiffPic d={d} name={vn} style={{ display: 'block', width: '100%', height: '100%' }} />
        : <p className="mu2" role={err ? 'alert' : 'status'} style={{ padding: '80px 24px', textAlign: 'center' }}>{err || '두 기록을 비교하는 중'}
          {err && <> · <span role="button" tabIndex={0} style={{ textDecoration: 'underline' }} onClick={() => (err === GONE ? gone() : setN(n + 1))}>다시 시도</span></>}</p>}</div>
      <div className="g dk tl" style={{ left: '20px', top: '20px', height: '38px', padding: '0 14px', borderRadius: '12px', display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', fontWeight: '700' }}>
        <svg className="ic" viewBox="0 0 24 24" style={{ width: '16px', height: '16px' }}><path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z" /><path d="M2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 12" /><path d="M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 17" /></svg>
        {a ? `${vn(b)} 위에 ${vn(a)} 를 겹쳐 봄` : `${vn(b)} · 첫 저장`}</div>
    </div>
    <div className="pane" style={{ left: '348px', top: '924px', right: '24px', bottom: '24px', display: 'flex', alignItems: 'center', padding: '0 4px' }} aria-label="바뀐 것">
      <span className="ttl" style={{ fontSize: '17px', padding: '0 22px', whiteSpace: 'nowrap' }}>바뀐 것</span>
      {d && <>
        {ch.length ? ch.slice(0, 2).map((c, i) => cell(`c${i}`, CH[c.change].color, says(c), i === 1 && ch.length > 2 ? `그 밖 ${ch.length - 2} 개 · 지도 위 색으로` : `추가 ${count('added')} · 지워짐 ${count('removed')} · 바뀜 ${count('changed')}`))
          : [cell('none', SAME, '구역 · 지점 · 연결점 · 선', '바뀌지 않음')]}
        {cell('img', d.image_changed ? CH.changed.color : SAME, '지도 그림', d.image_changed ? '바뀜 · 두 그림을 겹쳐 봄' : '바뀌지 않음')}
      </>}
    </div>
  </div>;
}
