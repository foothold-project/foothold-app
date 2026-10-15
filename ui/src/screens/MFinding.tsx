// 휴대폰 관찰 사진(원본 «발견물 확인» 틀): 운영자가 찍은 사진 넘겨 보기·분류(확인·제외·보류)·빠른 메모 — web/live.js pageMFinding 과 같은 규칙.
// AI 탐지·신뢰도는 미연결이라 숨김. 분류·메모는 note 문서로 모든 기기 공유(PcReview 와 같은 문서).
import { Photo } from '../app/Photo';
import { useEffect, useState } from 'react';
import type { Note } from '@contracts';
import { CSS, View } from './MFinding.view';
import { deg, fmtT, posTxt, themeClass } from '../data/fmt';
import { OBS_NOTE } from '../data/facts';
import { noteOf, useDocs, useMedia } from '../data/shared';
import { useEditor } from '../data/editor';
import { nearOf, runsOf, tagMemo } from '../data/run';
import { LiveStatus, MediaStale } from '../app/status';
import { stopProps, toast, useRoute } from '../app/shell';
import { href } from '../data/hist';

const TAGS = ['미끄럼 주의', '누수 의심', '조치 필요'];
const CLS = [['ok', '확인', '확인 · 기록에 남김'], ['no', '제외', '제외'], ['later', '보류', '보류']] as const;
const IMG: React.CSSProperties = { display: 'block', width: '100%', objectFit: 'contain', background: '#05080A', aspectRatio: '16/9', borderRadius: 'inherit' };

export default function MFinding() {
  const D = useDocs(), M = useMedia(), { q } = useRoute(), E = useEditor<Note>('note');
  const [url, setUrl] = useState<string | null>(q.get('url')), qu = q.get('url');
  useEffect(() => { if (qu) setUrl(qu); }, [qu]);   // 같은 화면 안 주소 이동(remount 없음)
  // R12 «분류 대기»(f=미분류): 미분류만 넘김, 처음·분류 뒤에는 가장 오래된 미분류. 저장 중·저장 실패/충돌로 초안이 남은 사진은 목록에 고정(대상·초안 유지).
  const only = q.get('f') === '미분류', [skip, setSkip] = useState<string[]>([]), [last, setLast] = useState<string | null>(null);
  const pin = (u: string) => E.d?.photo === u && (E.dirty || E.busy);
  const ps = only ? M.photos.filter((x) => (!noteOf(D, x.url) && !skip.includes(x.url)) || pin(x.url)) : M.photos;
  const at = ps.findIndex((x) => x.url === url), i = at >= 0 ? at : only ? ps.length - 1 : 0, p = ps[i], n = p ? noteOf(D, p.url) : undefined;
  // 남은 수 = 서버 기준 미분류 전체(건너뛴 것 포함) — 건너뛰기를 «분류 완료»로 세지 않는다(root P1 읽기 ④)
  const left = only ? M.photos.filter((x) => !noteOf(D, x.url)).length : 0, skipped = only ? skip.filter((u) => M.photos.some((x) => x.url === u && !noteOf(D, u))).length : 0;
  const reinc = skipped ? <button type="button" className="lv-btn" data-reinclude="1" onClick={() => { setSkip([]); setUrl(null); }}>{`건너뛴 미분류 ${skipped}장 다시 포함`}</button> : null;

  // 보이는 사진의 분류 문서를 편집기에 — 저장 중·내 수정 중이면 그대로, 서버 판이 더 새것이면 다시 읽음(PcReview 와 같은 규칙)
  useEffect(() => {
    if (!p || E.busy) return;
    const same = E.d?.photo === p.url;
    if (same && (E.dirty || (n ? E.id === n.id && (E.rev ?? 0) >= n.rev : true))) return;
    E.load(n || null, { photo: p.url, cls: '보류', memo: '' });
  });
  const go = (k: number) => { if (!ps.length) return; if (E.dirty && !confirm('저장 안 한 메모가 있습니다. 버릴까요?')) return; setUrl(ps[(i + k + ps.length) % ps.length].url); };
  const ed = !!p && E.d?.photo === p.url;
  const put = (f: (d: Note) => boolean | void) => {
    if (E.busy) return toast('저장 중 — 잠시 뒤 다시 누르세요'); if (!ed || f(E.d!) === false) return; E.dirty = true;
    const u = p!.url; setUrl(u); E.save().then((r) => { if (r?.ok) setLast(u); });   // 성공한 사진만 «방금 분류» — 실패·충돌은 그 사진에 머묾
  };
  // 저장 실패·충돌 뒤(초안 남음): 서버 판은 그대로 두고 이 사진만 건너뛰어 미분류 목록으로 — 내 분류 초안은 버림
  const back = only && ed && E.dirty && !E.busy ? <button type="button" className="lv-btn" onClick={() => { setSkip((s) => [...s, p!.url]); setUrl(null); E.load(null); }}>이 사진 건너뛰고 미분류 목록으로(내 분류 초안 버림 · 서버 판 그대로)</button> : null;
  const undo = only && last ? <a className="lbl" href={href('MFinding', { url: last })} onClick={() => setUrl(last)}>방금 분류한 사진 다시 열기(분류 바꾸기)</a> : null;
  const draft = ed && E.dirty;   // 저장 실패·충돌로 남은 내 분류 초안 — 서버 값 대신 이것을 보여 준다
  const lv = !n ? 'accent' : n.doc.cls === '확인' ? 'ok' : n.doc.cls === '제외' ? 'muted' : 'warn';
  const nav = (k: number, t: string, l: string) => <button type="button" className="lv-btn" aria-label={l} disabled={!p} onClick={() => go(k)} style={{ minWidth: '44px', height: '44px' }}>{t}</button>;

  const v: Record<string, unknown> = {
    themeClass: themeClass(false), stopProps, status: <><LiveStatus D={D} /><MediaStale M={M} D={D} /></>,
    ttl: only ? '분류 대기' : '관찰 사진', prev: nav(1, '‹', '이전(더 오래된) 사진'), next: nav(-1, '›', '다음(더 최근) 사진'), cnt: only ? `미분류 남은 ${left}장${skipped ? ` · 건너뜀 ${skipped}` : ''}` : p ? `${i + 1} / ${ps.length}` : '0 / 0',
    img: p ? <Photo src={p.url} alt={`관찰 사진 ${fmtT(p.frame_at)}`} style={IMG} /> : null,
    cap: p ? `Gazebo 렌더(실카메라 아님) · 프레임 수신 ${fmtT(p.frame_at)} · episode ${p.episode}`
      : M.ok && only ? (left ? `이 목록엔 남은 사진 없음 — 건너뛴 미분류 ${left}장은 아직 분류 안 됨(완료 아님)` : '분류 대기 사진 없음 — 모두 분류했습니다') : M.ok ? '사진 없음 — 조종 화면·현황의 📷 로 찍은 사진이 여기 쌓입니다(서버 저장 · 모든 기기 공통)' : M.err || '서버 기록 읽는 중…',
    name: p ? (draft ? `분류 초안: ${E.d!.cls} · 저장 안 됨${n ? ` (서버: ${n.doc.cls})` : ''}` : n ? `분류: ${n.doc.cls}` : '미분류 관찰') : '—', dotS: { background: `var(--${lv})` }, confHide: true, hlbl: OBS_NOTE,
    dt: ['임무 지점', '시뮬 위치', '같은 위치'],
    dd: !p ? ['—', '—', '—'] : [runsOf(D, p.url).join(', ') || '임무 지점에 붙지 않음',
      p.x == null ? '위치 미확인' : `${posTxt(p.x, p.y)} · ${deg(p.yaw)} (저장 요청 때 최신 시뮬 위치 · 프레임 동기 아님)`,
      p.x == null ? '비교 불가(위치 없음)' : `반경 1 m 안 다른 사진 ${nearOf(M, p).length}장`],
    tagT: [...TAGS, '+ 직접 입력'],
    tagP: [...TAGS.map((t) => ({ type: 'button', disabled: !ed, 'aria-pressed': ed && E.d!.memo.split(' · ').includes(t), onClick: () => put((d) => { d.memo = tagMemo(d.memo, t); }) })),
      { type: 'button', disabled: !ed, 'aria-pressed': false, onClick: () => put((d) => { const y = prompt('메모(무엇을 봤는지·조치)', d.memo); if (y == null) return false; d.memo = y.trim().slice(0, 400); }) }],
    memo: p ? <span className="lbl">{`메모: ${(ed && E.d!.memo) || '없음'}${n ? ` · ${n.by} · ${fmtT(n.at)}` : ''}`}{E.msg}{back}{undo}{reinc}</span> : <>{only && left ? <span className="lbl" role="status" data-notdone="1">{`이 목록엔 남은 사진 없음 — 건너뛴 미분류 ${left}장은 아직 분류 안 됨(완료 아님)`}</span> : null}{undo}{reinc}</>,
  };
  for (const [k, c, t] of CLS) { v[`${k}T`] = t; v[`${k}P`] = { type: 'button', disabled: !ed, 'aria-pressed': draft ? E.d!.cls === c : !!n && n.doc.cls === c, onClick: () => put((d) => { d.cls = c; }) }; }
  return <><style>{CSS}</style><div id="dc-root"><View v={v} /></div></>;
}
