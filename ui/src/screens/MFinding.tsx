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
import { LiveStatus } from '../app/status';
import { stopProps, toast, useRoute } from '../app/shell';

const TAGS = ['미끄럼 주의', '누수 의심', '조치 필요'];
const CLS = [['ok', '확인', '확인 · 기록에 남김'], ['no', '제외', '제외'], ['later', '보류', '보류']] as const;
const IMG: React.CSSProperties = { display: 'block', width: '100%', objectFit: 'contain', background: '#05080A', aspectRatio: '16/9', borderRadius: 'inherit' };

export default function MFinding() {
  const D = useDocs(), M = useMedia(), { q } = useRoute(), E = useEditor<Note>('note');
  const [url, setUrl] = useState<string | null>(q.get('url'));
  const ps = M.photos, i = Math.max(0, ps.findIndex((x) => x.url === url)), p = ps[i], n = p ? noteOf(D, p.url) : undefined;

  // 보이는 사진의 분류 문서를 편집기에 — 저장 중·내 수정 중이면 그대로, 서버 판이 더 새것이면 다시 읽음(PcReview 와 같은 규칙)
  useEffect(() => {
    if (!p || E.busy) return;
    const same = E.d?.photo === p.url;
    if (same && (E.dirty || (n ? E.id === n.id && (E.rev ?? 0) >= n.rev : true))) return;
    E.load(n || null, { photo: p.url, cls: '보류', memo: '' });
  });
  const go = (k: number) => { if (!ps.length) return; if (E.dirty && !confirm('저장 안 한 메모가 있습니다. 버릴까요?')) return; setUrl(ps[(i + k + ps.length) % ps.length].url); };
  const ed = !!p && E.d?.photo === p.url;
  const put = (f: (d: Note) => boolean | void) => { if (E.busy) return toast('저장 중 — 잠시 뒤 다시 누르세요'); if (!ed || f(E.d!) === false) return; E.dirty = true; E.save(); };
  const lv = !n ? 'accent' : n.doc.cls === '확인' ? 'ok' : n.doc.cls === '제외' ? 'muted' : 'warn';
  const nav = (k: number, t: string, l: string) => <button type="button" className="lv-btn" aria-label={l} disabled={!p} onClick={() => go(k)} style={{ minWidth: '44px', height: '44px' }}>{t}</button>;

  const v: Record<string, unknown> = {
    themeClass: themeClass(false), stopProps, status: <LiveStatus D={D} />,
    ttl: '관찰 사진', prev: nav(1, '‹', '이전(더 오래된) 사진'), next: nav(-1, '›', '다음(더 최근) 사진'), cnt: p ? `${i + 1} / ${ps.length}` : '0 / 0',
    img: p ? <Photo src={p.url} alt={`관찰 사진 ${fmtT(p.frame_at)}`} style={IMG} /> : null,
    cap: p ? `Gazebo 렌더(실카메라 아님) · 프레임 수신 ${fmtT(p.frame_at)} · episode ${p.episode}`
      : M.ok ? '사진 없음 — 조종 화면·현황의 📷 로 찍은 사진이 여기 쌓입니다(서버 저장 · 모든 기기 공통)' : M.err || '서버 기록 읽는 중…',
    name: p ? (n ? `분류: ${n.doc.cls}` : '미분류 관찰') : '—', dotS: { background: `var(--${lv})` }, confHide: true, hlbl: OBS_NOTE,
    dt: ['임무 지점', 'GT 위치', '같은 위치'],
    dd: !p ? ['—', '—', '—'] : [runsOf(D, p.url).join(', ') || '임무 지점에 붙지 않음',
      p.x == null ? '위치 미확인' : `${posTxt(p.x, p.y)} · ${deg(p.yaw)} (저장 요청 때 최신 GT · 프레임 동기 아님)`,
      p.x == null ? '비교 불가(위치 없음)' : `반경 1 m 안 다른 사진 ${nearOf(M, p).length}장`],
    tagT: [...TAGS, '+ 직접 입력'],
    tagP: [...TAGS.map((t) => ({ type: 'button', disabled: !ed, 'aria-pressed': ed && E.d!.memo.split(' · ').includes(t), onClick: () => put((d) => { d.memo = tagMemo(d.memo, t); }) })),
      { type: 'button', disabled: !ed, 'aria-pressed': false, onClick: () => put((d) => { const y = prompt('메모(무엇을 봤는지·조치)', d.memo); if (y == null) return false; d.memo = y.trim().slice(0, 400); }) }],
    memo: p ? <span className="lbl">{`메모: ${(ed && E.d!.memo) || '없음'}${n ? ` · ${n.by} · ${fmtT(n.at)}` : ''}`}{E.msg}</span> : null,
  };
  for (const [k, c, t] of CLS) { v[`${k}T`] = t; v[`${k}P`] = { type: 'button', disabled: !ed, 'aria-pressed': !!n && n.doc.cls === c, onClick: () => put((d) => { d.cls = c; }) }; }
  return <><style>{CSS}</style><div id="dc-root"><View v={v} /></div></>;
}
