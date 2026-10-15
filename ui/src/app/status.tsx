// 상태 줄(링크·STOP 잠금·조종권·시뮬·공유 문서 오류·새 판) — web/live.js paintStatus 와 같은 글.
import { linkView, sessTxt, useLink } from '../data/link';
import { reread, type Docs, type Media } from '../data/shared';
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

// R25: 공유 기록(사진·사건 = media, 임무·분류·구역 문서 = docs)을 다시 읽지 못했을 때 — 옛 목록은 그대로 보이되
// 소스마다 «보관 자료·마지막 받은 시각·실패 원인·다시 읽기»를 따로 표시. 옛 사건을 지금 위험으로 단정하지 않음 · 자동 재시도 정책은 그대로.
// (문서 읽기 실패 원인 글은 상태 줄에도 있음 · 보고서의 «문서 오류 = 비움» 정책은 화면 쪽 그대로)
const two = (n: number) => String(n).padStart(2, '0');
export const localT = (ms: number) => { const d = new Date(ms); return `${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`; };
export function MediaStale({ M, D }: { M: Media; D?: Docs }) {
  const rows = ([[M.stale, '사진·사건', M.at, M.err, 'media'], [!!D?.stale, '임무·분류 문서', D?.at || 0, D?.err || '', 'docs']] as const).filter((x) => x[0]);
  if (!rows.length) return null;
  return (
    <span className="lv-warnbox" role="status" data-media-stale="1" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px' }}>
      {rows.map(([, what, at, err, k]) => <span key={k} data-stale-src={k} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px' }}>
        <span>{`보관 자료(${what}) · 마지막 받음 ${localT(at)} · 재조회 실패: ${err.replace(/^(서버 기록|문서) 읽기 실패 · /, '')}`}</span>
        <button type="button" className="lv-btn" onClick={() => reread(k)}>다시 읽기</button></span>)}
    </span>);
}
