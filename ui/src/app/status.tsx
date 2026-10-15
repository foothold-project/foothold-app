// 공통 머리줄 상태(UI-SIMPLIFY v3 R8 · U1-b): [시뮬] [연결] [역할] [잠금] 칩 + «시뮬 ▾» 메뉴 + 개발자 표시 + 문서 오류 + 새 판 차단.
// 칩 글은 서버가 준 값으로만 정한다(새 추정 0). 미확인·끊김을 «꺼짐»으로 보이지 않는다 — 확인된 꺼짐 = 서버 세션 result 'idle' 일 때만.
// 각 칩의 «?» 에 원래 상태 글(전문)을 그대로 둔다.
import type { Status } from '@contracts';
import { linkView, sendOp, sessTxt, startSimAsk, startTxt, useLink } from '../data/link';
import { reread, type Docs, type Media } from '../data/shared';
import { LATCH_TXT } from '../data/facts';
import { MapStartBox } from '../map/MapStartBox';
import { Chip, DevMark, usePop, type Tone } from './chip';
import { SimOff, toast, useRoute, whyProps } from './shell';

type C = { k: 'sim' | 'link' | 'role' | 'lock'; tone: Tone; text: string; why: string };
/** 머리줄 칩 4종(순수 — 시험용). 실기 대상이면 시뮬·역할 칩 없이 연결 «실기 미연결»만 */
export function headChips(x: { provider: string; linkOk: boolean; everMsg: boolean; authEnd: boolean; bad: string | null; st: Status | null; viewOnly: boolean; linkTxt: string; roleTxt: string; latch: boolean }): C[] {
  const { st } = x, full = `링크 ${x.linkTxt}`;
  if (x.provider !== 'simulation_gate') return [{ k: 'link', tone: 'off', text: '실기 미연결', why: x.linkTxt }];
  const known = x.linkOk && !x.bad && !!st;   // 서버 상태를 지금 확인함
  const link: C = x.authEnd ? { k: 'link', tone: 'bad', text: '로그인 끝남', why: full }
    : !x.linkOk ? (x.everMsg ? { k: 'link', tone: 'bad', text: '연결 끊김', why: full } : { k: 'link', tone: 'warn', text: '연결 중', why: full })
    : !known ? { k: 'link', tone: 'warn', text: '상태 확인 안 됨', why: full } : { k: 'link', tone: 'ok', text: '연결됨', why: full };
  const sess = st?.sim_start?.session?.result, sb = st?.sim_block || '', sw = [full, sb && !full.includes(sb) && `시뮬 상태 ${sb}`, sessTxt(st) && `시뮬 세션 ${sessTxt(st)}`, st?.sim_start?.why].filter(Boolean).join(' · ');
  const sim: C = !known ? { k: 'sim', tone: 'warn', text: '시뮬 확인 안 됨', why: full }
    : !sb ? { k: 'sim', tone: 'ok', text: '시뮬 실행', why: sw }
    : sb === '시뮬 상태 미수신' || sb === '시뮬 상태 끊김'
      ? (sess === 'idle' ? { k: 'sim', tone: 'off', text: '시뮬 꺼짐', why: sw } : sess === 'starting' ? { k: 'sim', tone: 'warn', text: '시뮬 켜지는 중', why: sw }
        : sb === '시뮬 상태 끊김' ? { k: 'sim', tone: 'bad', text: '시뮬 끊김', why: sw } : { k: 'sim', tone: 'warn', text: '시뮬 확인 안 됨', why: sw })
    : sb === '시뮬 리셋 중' ? { k: 'sim', tone: 'warn', text: '시뮬 리셋 중', why: sw }
    : sb === '정책 미실행' ? { k: 'sim', tone: 'warn', text: '제어 준비 안 됨', why: sw }   // §7-1: policy_running=false 소비 사실만
    : { k: 'sim', tone: 'warn', text: '시뮬 처리 중', why: sw };
  const role: C = !known ? { k: 'role', tone: 'warn', text: '역할 확인 안 됨', why: x.roleTxt }
    : st!.role === 'control' && !x.viewOnly ? { k: 'role', tone: 'ok', text: '이 기기 조종', why: x.roleTxt }
    : st!.role === 'view_other' ? { k: 'role', tone: 'warn', text: '다른 기기 조종 중', why: x.roleTxt } : { k: 'role', tone: 'off', text: '보기 전용', why: x.roleTxt };
  const lt = LATCH_TXT(x);
  const lock: C = !x.linkOk ? { k: 'lock', tone: 'warn', text: '잠금 확인 안 됨', why: lt } : x.latch ? { k: 'lock', tone: 'bad', text: 'STOP 잠금', why: lt } : { k: 'lock', tone: 'ok', text: '잠금 해제', why: lt };
  return [sim, link, role, lock];
}
export function useHeadChips() {
  const s = useLink(), v = linkView(s);
  return headChips({ provider: s.provider, linkOk: v.linkOk, everMsg: !!s.lastMsg, authEnd: s.authEnd, bad: s.bad, st: s.st, viewOnly: s.viewOnly, linkTxt: v.linkTxt, roleTxt: v.roleTxt, latch: v.latch });
}

/** «시뮬 ▾»: 시작(30분)·리셋·지도 시뮬 열기·끄기. 실행 조건·확인창·권한·busy 는 기존 경로 그대로(startSimAsk·sendOp·MapStartBox·SimOff).
 *  열면 누르던 입력 폐기(usePop) · 닫혀도 자동 재출발 0 · 지도 화면에서는 그 화면의 상자를 쓰라고만(같은 패널 두 번 장착 0) */
export function SimMenu() {
  const L = useLink(), v = linkView(L), st = L.st, { name } = useRoute(), P = usePop(380);
  if (L.provider !== 'simulation_gate') return null;
  const ctl = v.linkOk && st?.role === 'control' && !L.viewOnly, busy = v.linkOk && !!(st?.reset_pending || st?.resume_pending);
  const ss = st?.sim_start, off = v.linkOk && !!ss && ['시뮬 상태 미수신', '시뮬 상태 끊김'].includes(st!.sim_block);   // Main showStart 와 같은 조건
  const sx = startTxt(st), onMapPage = name === 'PcMap' || name === 'MMap';
  const item = (t: string, go: (() => void) | null, why: string) => go ? <button type="button" className="lv-btn" onClick={go}>{t}</button> : <button type="button" {...whyProps(why)} className="lv-btn lv-why">{t}</button>;
  return <span className="lv-help">
    <button ref={P.b} type="button" className="lv-btn" aria-haspopup="true" aria-expanded={!!P.pos} onClick={P.toggle}>시뮬 ▾</button>
    {P.pos && <div ref={P.p as React.RefObject<HTMLDivElement>} role="dialog" aria-label="시뮬 메뉴" className="lv-pop lv-simmenu" style={P.style}>
      {!v.linkOk && <p className="lv-note">{`연결 확인 안 됨 — 시뮬 상태를 알 수 없어 조작하지 않음(${v.linkTxt})`}</p>}
      {ss && item('시뮬 시작(30분)', v.linkOk && off && ss.ok ? () => { P.close(false); startSimAsk(st).then(toast); } : null,
        !v.linkOk ? '연결 확인 안 됨' : !off ? `지금 시뮬 상태(${st!.sim_block || '실행 중'})에서는 시작 안 함` : ss.why || '서버가 시작을 허용하지 않음')}
      {item('시뮬 리셋', ctl && !busy ? () => { P.close(false); sendOp('reset'); } : null, !v.linkOk ? '연결 확인 안 됨' : !ctl ? '조종 중인 기기에서만(«조종 시작» 뒤)' : '리셋·재개 처리 중')}
      {st?.map_start && (onMapPage ? <p className="lv-note">지도 시뮬 열기는 이 화면의 «지도 열기» 상자에서</p>
        : <div className="lv-simmap"><b>지도 시뮬 열기</b><MapStartBox pc={name.startsWith('Pc') || name === 'Main' || !name} /></div>)}
      <SimOff className="lv-btn" />
      <p className="lv-note">{[ss && sx.left, st?.map_start && sx.map, sessTxt(st) && `시뮬 세션 ${sessTxt(st)}`, '30분 뒤 자동 종료 · 동시 1개'].filter(Boolean).join(' · ')}</p>
    </div>}
  </span>;
}

/** 칩 4종 + «시뮬 ▾» + 개발자 표시 — 상태 줄(LiveStatus)과 Main 머리줄 공용 */
export function HeadChips() {
  return <>{useHeadChips().map((c) => <span key={c.k} data-head={c.k} style={{ display: 'inline-flex' }}><Chip tone={c.tone} text={c.text} why={c.why} /></span>)}<SimMenu /><DevMark /></>;
}

export function LiveStatus({ D, style }: { D: Docs; style?: React.CSSProperties }) {
  const s = useLink(), st = s.st, v = linkView(s);
  const reload = () => { if (st?.role === 'control') return toast('조종 중에는 새로고침하지 않습니다 — 조종권 반납 뒤'); location.reload(); };
  return (
    <span className="lv-status" data-live-status="1" style={style}>
      <HeadChips />
      {D.err && <span style={{ color: 'var(--bad)' }}>{`공유 문서: ${D.err}`}</span>}
      {v.newVer && <><span style={{ color: 'var(--warn)' }}>{`새 화면 판 반영됨 — 새로고침 필요`}<span data-dev>{` (서버 ${st!.ver} · 이 화면 ${s.firstVer})`}</span></span><button type="button" className="lv-btn" onClick={reload}>새로고침(새 판)</button></>}
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
