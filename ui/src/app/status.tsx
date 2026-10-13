// 상태 줄(링크·STOP 잠금·조종권·시뮬·공유 문서 오류·새 판) — web/live.js paintStatus 와 같은 글.
import { linkView, sessTxt, useLink } from '../data/link';
import type { Docs } from '../data/shared';
import { toast } from './shell';

const dot = (good: boolean, t: string) => <span><span style={{ color: `var(${good ? '--ok' : '--warn'})` }}>{good ? '●' : '▲'}</span>{` ${t}`}</span>;

export function LiveStatus({ D, style }: { D: Docs; style?: React.CSSProperties }) {
  const s = useLink(), v = linkView(s), st = s.st, sess = sessTxt(st);
  const reload = () => { if (st?.role === 'control') return toast('조종 중에는 새로고침하지 않습니다 — 조종권 반납 뒤'); location.reload(); };
  return (
    <span className="lv-status" data-live-status="1" style={style}>
      {dot(v.linkOk && !v.simBlock, `링크 ${v.linkTxt}`)}
      {dot(v.linkOk && !v.latch, !v.linkOk ? '잠금 상태 미확인(서버 연결 끊김)' : v.latch ? 'STOP 잠금' : 'STOP 해제됨')}
      <span>{v.roleTxt}</span>
      {sess && <span>{`시뮬 ${sess}`}</span>}
      {D.err && <span style={{ color: 'var(--bad)' }}>{`공유 문서: ${D.err}`}</span>}
      {v.newVer && <><span style={{ color: 'var(--warn)' }}>{`새 화면 판 ${st!.ver} 반영됨(이 화면 ${s.firstVer})`}</span><button type="button" className="lv-btn" onClick={reload}>새로고침(새 판)</button></>}
    </span>
  );
}
