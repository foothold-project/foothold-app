// PC 사진 검토(원본 틀): 운영자가 찍은 관찰 사진 목록·분류(확인·보류·제외)·메모 — web/live.js pagePcReview 와 같은 규칙.
// AI 탐지·신뢰도·측정값·임무 되감기는 미연결 — 시안 예시값을 남기지 않는다. 분류·메모는 note 문서로 모든 기기 공유.
import { useEffect, useState } from 'react';
import type { Note } from '@contracts';
import { CSS, View } from './PcReview.view';
import { csvOf, deg, durTxt, fmtT, LV, posTxt, saveBlob, themeClass, tms } from '../data/fmt';
import { OBS_NOTE, WHY } from '../data/facts';
import { alertsOf, docById, noteOf, useDocs, useMedia } from '../data/shared';
import { useEditor } from '../data/editor';
import { nearOf, runsOf } from '../data/run';
import { href } from '../data/hist';
import { LiveStatus } from '../app/status';
import { stopProps, toast, useRoute } from '../app/shell';

const TABS = ['전체', '미분류', '확인', '보류', '제외'] as const;
const CLS = [['확인', '확인 · 기록에 남김'], ['제외', '제외'], ['보류', '보류 · 다음에 다시 보기']] as const;
type N = ReturnType<typeof noteOf>;
const badgeCls = (n: N) => `badge ${!n ? 'b-wait' : n.doc.cls === '확인' ? 'b-ok' : n.doc.cls === '제외' ? 'b-no' : 'b-wait'}`;
const IMG: React.CSSProperties = { display: 'block', width: '100%', objectFit: 'contain', background: '#05080A', aspectRatio: '16/9', borderRadius: '8px' };

export default function PcReview() {
  const D = useDocs(), M = useMedia(), { q } = useRoute(), E = useEditor<Note>('note');
  const [url, setUrl] = useState<string | null>(q.get('url')), [filt, setFilt] = useState<(typeof TABS)[number]>('전체');
  const run = q.get('run') ? docById(D, q.get('run')!) : null, R = run?.kind === 'run' ? run.doc : null;
  const inRun = R ? new Set(R.wps.flatMap((w) => w.photos)) : null;
  const base = M.photos.filter((p) => !inRun || inRun.has(p.url));
  const is = (c: string, url: string) => { const n = noteOf(D, url); return c === '전체' || (c === '미분류' ? !n : !!n && n.doc.cls === c); };
  const cnt = (c: string) => base.filter((p) => is(c, p.url)).length, ps = base.filter((p) => is(filt, p.url));
  const u = url || ps[0]?.url || null, p = M.photos.find((x) => x.url === u), n = p ? noteOf(D, p.url) : undefined;

  // 고른 사진의 분류 문서를 편집기에 — 내 메모 수정 중(dirty)·저장 중이면 그대로, 서버 판이 더 새것이면 다시 읽음
  useEffect(() => {
    if (!p || E.busy) return;
    const same = E.d?.photo === p.url;
    if (same && (E.dirty || (n ? E.id === n.id && (E.rev ?? 0) >= n.rev : true))) return;
    E.load(n || null, { photo: p.url, cls: '보류', memo: '' });
  });
  const pick = (x: string) => { if (E.dirty && !confirm('저장 안 한 메모가 있습니다. 버릴까요?')) return; setUrl(x); };
  const judge = (c: Note['cls']) => { if (E.busy) return toast('저장 중 — 잠시 뒤 다시 누르세요'); if (!E.d || E.d.photo !== p?.url) return; E.d.cls = c; E.dirty = true; E.save(); };
  const vis = R ? R.wps.filter((w) => w.st === '방문').length : 0, al = alertsOf(M).length;

  const v = {
    themeClass: themeClass(true), stopProps, status: <LiveStatus D={D} />,
    hdrA: '사진 검토', hdrB: R ? `수동 임무 «${R.name}» 관찰 사진` : '관찰 사진 · 운영자 등록',
    sL: R ? `수동 임무 · 양식: ${R.tmpl || '—'} · ${R.status}` : '관찰 사진 검토 · 전체',
    sBig: `${LV.warn} 분류 대기 ${cnt('미분류')}장`, sBigS: { color: 'var(--warn)' }, sDesc: OBS_NOTE,
    stats: ([['소요', R ? durTxt(R.started, R.ended) : '—'], ['지점 방문', R ? `${vis} / ${R.wps.length}` : '—'], ['관찰 사진', String(base.length)], ['확인', String(cnt('확인'))], ['경보 사건', String(al)]] as const)
      .map(([a, b]) => <div key={a} style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}><span className="lbl">{a}</span>
        <span className="mono" style={{ fontSize: '20px', fontWeight: '600', color: a === '경보 사건' && al ? 'var(--bad)' : undefined }}>{b}</span></div>),
    csvT: '사진 정보 내려받기 (CSV)',
    csvP: { onClick: () => toast(!M.ok ? '서버 기록 미확인 — 내보내지 않음' : saveBlob(`foothold-v2-photos-${Date.now()}.csv`, new Blob([csvOf(['saved_at', 'frame_at', 'episode', 'x', 'y', 'yaw', 'by', 'cls', 'memo', 'url'],
      M.photos.map((x) => { const nn = noteOf(D, x.url); return [x.saved_at, x.frame_at, x.episode, x.x, x.y, x.yaw, x.by, nn ? nn.doc.cls : '미분류', nn ? nn.doc.memo : '', x.url]; }))], { type: 'text/csv' }))) },
    repT: '수동 임무 보고서', repP: { href: href('Report', run ? { run: run.id } : {}) },
    lhA: '관찰 사진', lhB: 'AI 탐지 미연결 · 운영자가 찍은 관찰',
    tabs: TABS.map((t) => <button key={t} type="button" className="tab" role="tab" aria-selected={t === filt} onClick={() => setFilt(t)}>{`${t} ${cnt(t)}`}</button>),
    fds: <div style={{ display: 'flex', flexDirection: 'column', gap: 'inherit', maxHeight: '640px', overflow: 'auto' }}>
      {!M.ok ? <span className="lbl">{M.err || '서버 기록 읽는 중…'}</span>
        : !ps.length ? <span className="lbl">해당 사진 없음 — 조종 화면·현황의 📷 로 찍습니다</span>
        : ps.slice(0, 120).map((x) => { const nn = noteOf(D, x.url); return (
          <button key={x.url} type="button" className={`fd${x.url === u ? ' sel' : ''}`} onClick={() => pick(x.url)}>
            <img src={x.url} alt="" loading="lazy" style={{ width: '88px', height: '66px', objectFit: 'cover', borderRadius: '6px', background: '#05080A' }} />
            <span style={{ display: 'flex', flexDirection: 'column', gap: '4px', minWidth: '0' }}>
              <span style={{ display: 'flex', justifyContent: 'space-between', gap: '6px' }}><b style={{ fontSize: '14px' }}>{nn?.doc.memo ? nn.doc.memo.slice(0, 24) : '관찰 사진'}</b>
                <span className={badgeCls(nn)}>{nn ? nn.doc.cls : '미분류'}</span></span>
              <span className="lbl">{`${runsOf(D, x.url)[0] || '임무 지점 없음'} · ${fmtT(x.frame_at)}`}</span>
              <span className="lbl">{posTxt(x.x, x.y)}</span></span>
          </button>); })}</div>,
    scS: p ? undefined : { visibility: 'hidden' as const },
  };
  if (p) {
    const old = nearOf(M, p).find((x) => tms(x.frame_at) < tms(p.frame_at)), ed = E.d?.photo === p.url;
    Object.assign(v, {
      scT: n ? `분류: ${n.doc.cls}` : '미분류 관찰', scB: n ? n.doc.cls : '미분류', scBP: { className: badgeCls(n) },
      scL: `${runsOf(D, p.url).join(', ') || '임무 지점 없음'} · ${posTxt(p.x, p.y)} · 방향 ${deg(p.yaw)} · ${fmtT(p.frame_at)}${n ? ` · 분류 ${n.by} ${fmtT(n.at)}` : ''}`,
      im1: <img src={p.url} alt={`관찰 사진 ${fmtT(p.frame_at)}`} style={IMG} />,
      c1: `Gazebo 렌더 · 프레임 수신 ${fmtT(p.frame_at)} · GT는 저장 요청 때 최신(프레임 동기 아님)`,
      im2: old ? <img src={old.url} alt={`같은 위치 이전 사진 ${fmtT(old.frame_at)}`} style={IMG} /> : null,
      c2: old ? `같은 위치(1 m 안) 이전 사진 · ${fmtT(old.frame_at)}` : '같은 위치(1 m 안) 이전 사진 없음',
      j: CLS.map(([c]) => ({ type: 'button', 'aria-pressed': !!n && n.doc.cls === c, disabled: !ed, onClick: () => judge(c) })), jT: CLS.map(([, t]) => t),
      memoL: '메모 · 보고서에 함께 실립니다(모든 기기 공유)',
      memo: <textarea id="memo" rows={2} maxLength={400} placeholder="무엇을 봤는지·조치" disabled={!ed} value={ed ? E.d!.memo : ''}
        onChange={(e) => { if (E.d) { E.d.memo = e.target.value; E.dirty = true; E.touch(); } }} onBlur={() => { if (E.dirty && !E.busy) E.save(); }}
        style={{ padding: '10px 12px', border: '1px solid var(--line2)', borderRadius: '6px', background: 'var(--panel2)', fontSize: '14px', resize: 'vertical' }} />,
      msg: E.msg,
    });
  }
  Object.assign(v, {
    rewA: '임무 되감기 — 미연결(주행 영상·기록 재생 없음)', rewB: '', rewHide: true,
    msLbl: `미제공 — ${WHY['가스·측정값·통신 품질'].split(' — ')[1] || '현재 v2 연결에 측정값 없음'}`,
    mRows: <tr><td className="lbl" colSpan={8}>측정값 미제공 — 현재 v2 연결에 가스·측정값이 없어 표를 채우지 않습니다</td></tr>,
  });
  return <><style>{CSS}</style><div id="dc-root"><View v={v} /></div></>;
}
