// 휴지통(05 §5.1, 11-02 현민님): 지도(장소·건물·층)·시나리오의 «삭제»가 여기로 온다 — [복원] / [완전 삭제](DB 에서 지움, 되돌릴 수 없음).
// 끝난 실행·배정·결재 기록은 지우지 않고 이름만 남는다. 총괄·운영 같은 기능(10-25). 입구는 지도·시나리오 화면의 «휴지통»(#/trash, 메뉴에는 숨김).
// 완전 삭제 확인은 이 칸 안 확인 창(브라우저 confirm 금지) — 머리줄 STOP 을 가리지 않는다.
import { useEffect, useState } from 'react';
import type { TrashItem, TrashList } from '../../../contracts/ts';
import { ApiFail, api } from '../api';
import type { Ctx } from '../screens';
import { when } from './history';
import { Note, type Msg } from './maps';

export type TrashKind = TrashItem['kind'];
const KIND: Record<TrashKind, string> = { site: '장소', building: '건물', floor: '층', scenario: '시나리오' };
const OBJ: Record<TrashKind, string> = { site: '장소를', building: '건물을', floor: '층을', scenario: '시나리오를' };
/** 휴지통 409 = 쉬운 문구(사용 중이면 서버가 알려 준 무엇을 덧붙인다) */
const WHY: Record<string, string> = {
  HAS_CHILDREN: '안에 있는 건물·층을 먼저 지우세요(휴지통에 있는 것도 포함).',
  HAS_REFERENCES: '이 층을 쓰는 시나리오를 먼저 완전 삭제하세요.',
  RESOURCE_IN_USE: '실행 중이거나 배정된 곳에서 쓰는 중입니다.',
  PARENT_ARCHIVED: '상위 장소·건물을 먼저 복원하세요(장소 → 건물 → 층 순서).',
  NOT_IN_TRASH: '휴지통에 없는 항목입니다(이미 복원됐을 수 있음).',
};
export const trashFail = (e: ApiFail) => (e.code === 'RESOURCE_IN_USE' && e.said ? `${WHY.RESOURCE_IN_USE} ${e.message}`
  : WHY[e.code] ?? (e.status === 404 ? '이 항목을 찾을 수 없습니다. 이미 지워졌을 수 있습니다.' : e.message));
/** 지워진 시나리오·층 «(삭제됨) 이름» — 서버는 «삭제된 시나리오: 이름»·«삭제된 층: 이름»으로 준다 */
export const deleted = (name: string) => `(삭제됨) ${name.replace(/^삭제된 (시나리오|층): /, '')}`;
/** 지도·시나리오 화면 «휴지통» 입구 */
const LINK = { color: 'inherit', textDecoration: 'none' };   // a.btn 은 기본 링크색(파랑)이 남는다
export const TrashLink = () => <a className="btn" style={LINK} href="#/trash" data-trash-link>휴지통</a>;

const str = (v: unknown) => typeof v === 'string';
const isItem = (x: TrashItem) => !!x && x.kind in KIND && str(x.id) && str(x.name) && str(x.archived_at) && (x.parent_name === null || str(x.parent_name))
  && (x.deleted_by === null || (!!x.deleted_by && str(x.deleted_by.display_name)));
const isList = (l: TrashList) => !!l && Array.isArray(l.items) && l.items.every(isItem);

export function Trash(c: Pick<Ctx, 'cancel'>) {
  const [items, setItems] = useState<TrashItem[] | null>(null), [err, setErr] = useState(''), [n, setN] = useState(0);
  const [busy, setBusy] = useState(false), [ask, setAsk] = useState<TrashItem | null>(null), [msg, setMsg] = useState<Msg>(null);
  useEffect(() => {
    let live = true;   // 다시 받기가 겹치면 앞 요청의 늦은 답은 버린다
    api.trash(c.cancel).then((l) => { if (!isList(l)) throw new ApiFail(0, 'BAD_SHAPE', '받은 휴지통 형식이 맞지 않습니다. 잠시 뒤 다시 시도하세요.'); return l; })
      .then((l) => { if (live) { setItems(l.items); setErr(''); } }, (e: ApiFail) => { if (live && e.code !== 'CANCELED') setErr(e.message); });
    return () => { live = false; };
  }, [n]);
  const run = (x: TrashItem, purge: boolean) => {
    setBusy(true); setAsk(null); setMsg(null);
    (purge ? api.purge : api.restore)(x.kind, x.id, c.cancel).then(
      () => setMsg({ text: `«${x.name}» ${OBJ[x.kind]} ${purge ? '완전히 지웠습니다.' : '복원했습니다.'}`, ok: true }),
      (e: ApiFail) => { if (e.code !== 'CANCELED') setMsg({ text: `${purge ? '완전 삭제하지' : '복원하지'} 못했습니다. ${trashFail(e)}` }); })
      .finally(() => { setBusy(false); setN((k) => k + 1); });   // 성공·실패 모두 목록을 다시(답을 못 받았어도 처리됐을 수 있다)
  };
  return <section className="lv-card" aria-label="휴지통" data-trash>
    <div className="fh-row"><h2 className="fh-grow">휴지통</h2><a className="btn" style={LINK} href="#/map">지도</a><a className="btn" style={LINK} href="#/mission">시나리오</a></div>
    <p className="lv-note">지도·시나리오에서 «삭제»한 것이 여기 남습니다. 복원은 장소 → 건물 → 층 순서, 완전 삭제는 시나리오 → 층 → 건물 → 장소 순서로 하세요.</p>
    {ask && <div className="lv-card fh-form" role="alertdialog" aria-label="완전 삭제 확인" aria-describedby="purge-why" data-purge-ask>
      <b>«{ask.name}» {OBJ[ask.kind]} 완전히 지울까요?</b>
      <p id="purge-why" className="fh-msg" style={{ margin: 0 }}>되돌릴 수 없습니다. 끝난 실행 기록은 이름만 남습니다.</p>
      <div className="fh-row"><button type="button" className="btn pri" disabled={busy} onClick={() => run(ask, true)}>완전 삭제</button>
        <button type="button" className="btn" autoFocus onClick={() => setAsk(null)}>취소</button></div>
    </div>}
    <Note m={msg} />
    <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }} aria-label="휴지통 목록">{(items ?? []).map((x) => <li key={`${x.kind}-${x.id}`} className="fh-row" style={{ padding: '8px 10px', border: '1px solid var(--line)', borderRadius: 8, background: 'var(--panel2)' }} data-trash-item={x.id}>
      <span className="lbl">{KIND[x.kind]}</span>
      <b style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{x.name}</b>
      {x.parent_name && <span className="lbl">{x.parent_name} 안</span>}
      <span className="lbl fh-grow">{x.deleted_by?.display_name ?? '지운 사람 모름'} · {when(x.archived_at)}</span>
      <button type="button" className="btn" disabled={busy} onClick={() => run(x, false)}>복원</button>
      <button type="button" className="btn" disabled={busy} onClick={() => { setAsk(x); setMsg(null); }}>완전 삭제</button>
    </li>)}</ul>
    {items && !items.length && !err && <p className="lv-note" data-empty>휴지통이 비었습니다.</p>}
    {err && <div className="fh-row"><p className="fh-msg" role="alert">휴지통을 받지 못했습니다. {err}</p><button type="button" className="btn" onClick={() => setN((k) => k + 1)}>다시 시도</button></div>}
    {!items && !err && <p className="lv-note" role="status">휴지통을 불러오는 중…</p>}
  </section>;
}
