// 공통 머리줄 상태(UI-SIMPLIFY v3 R8 · U1-b): [시뮬] [연결] [역할] [잠금] 칩 + 개발자 표시(10-18 «시뮬 ▾» 삭제) + 문서 오류 + 새 판 차단.
// 칩 글은 서버가 준 값으로만 정한다(새 추정 0). 미확인·끊김을 «꺼짐»으로 보이지 않는다.
// B2(10-15 검토): 지금 계약의 session(result idle 등)은 조회 시각·신선도가 없고 unit·요청 진행과 따로라 «시뮬 꺼짐» 확정 근거가 못 된다
// → 세션 값은 ? 안 원문으로만 · 칩은 «시뮬 확인 안 됨»(끊김은 서버 sim_block 그대로 «시뮬 끊김»).
// 각 칩의 «?» 에 원래 상태 글(전문)을 그대로 둔다.
import type { MapInfo, Status } from '@contracts';
import { dropAll, linkView, sendOp, sessTxt, startTxt, useLink } from '../data/link';
import { reread, type Docs, type Media } from '../data/shared';
import { LATCH_TXT } from '../data/facts';
import { MapStartBox } from '../map/MapStartBox';
import { Chip, DevMark, type Tone } from './chip';
import { SimOff, toast, whyProps } from './shell';

type C = { k: 'sim' | 'link' | 'role' | 'lock'; tone: Tone; text: string; why: string };
/** 머리줄 칩 4종(순수 — 시험용). 실기 대상이면 시뮬·역할 칩 없이 연결 «실기 미연결»만 */
export function headChips(x: { provider: string; linkOk: boolean; open?: boolean; everMsg: boolean; authEnd: boolean; bad: string | null; st: Status | null; viewOnly: boolean; linkTxt: string; roleTxt: string; latch: boolean }): C[] {
  const { st } = x, full = `링크 ${x.linkTxt}`;
  if (x.provider !== 'simulation_gate') return [{ k: 'link', tone: 'off', text: '실기 미연결', why: x.linkTxt }];
  const known = x.linkOk && !x.bad && !!st;   // 서버 상태를 지금 확인함
  const link: C = x.authEnd ? { k: 'link', tone: 'bad', text: '로그인 끝남', why: full }
    // U2(670 P3): 소켓은 열려 있는데 상태가 1 s 넘게 안 옴 = «상태 오래됨»(warn) · 소켓 닫힘 = «연결 끊김»(bad)
    : !x.linkOk ? (!x.everMsg ? { k: 'link', tone: 'warn', text: '연결 중', why: full } : x.open ? { k: 'link', tone: 'warn', text: '상태 오래됨', why: full } : { k: 'link', tone: 'bad', text: '연결 끊김', why: full })
    : !known ? { k: 'link', tone: 'warn', text: '상태 확인 안 됨', why: full } : { k: 'link', tone: 'ok', text: '연결됨', why: full };
  const sb = st?.sim_block || '', sw = [full, sb && !full.includes(sb) && `시뮬 상태 ${sb}`, sessTxt(st) && `RL 세션 조회값 ${sessTxt(st)}(조회 시각 미표시 · 꺼짐 확정 아님)`, st?.sim_start?.why].filter(Boolean).join(' · ');
  const sim: C = !known ? { k: 'sim', tone: 'warn', text: '시뮬 확인 안 됨', why: full }
    : !sb ? { k: 'sim', tone: 'ok', text: '시뮬 실행', why: sw }
    : sb === '시뮬 상태 미수신' || sb === '시뮬 상태 끊김'
      ? (sb === '시뮬 상태 끊김' ? { k: 'sim', tone: 'bad', text: '시뮬 끊김', why: sw } : { k: 'sim', tone: 'warn', text: '시뮬 확인 안 됨', why: sw })
    : sb === '시뮬 리셋 중' ? { k: 'sim', tone: 'warn', text: '시뮬 리셋 중', why: sw }
    : sb === '정책 미실행' ? { k: 'sim', tone: 'warn', text: '제어 준비 안 됨', why: sw }   // §7-1: policy_running=false 소비 사실만
    : { k: 'sim', tone: 'warn', text: '시뮬 처리 중', why: sw };
  const role: C = !known ? { k: 'role', tone: 'warn', text: '역할 확인 안 됨', why: x.roleTxt }
    : st!.role === 'control' && !x.viewOnly ? { k: 'role', tone: 'ok', text: '이 기기 조종', why: x.roleTxt }
    : st!.role === 'view_other' ? { k: 'role', tone: 'warn', text: '다른 기기 조종 중', why: x.roleTxt } : { k: 'role', tone: 'off', text: '보기 전용', why: x.roleTxt };
  // B1(10-15 검토): 연결돼 있어도 유효한 현재 status 가 없으면(st 없음·형식 오류) 잠금도 미확인 — «해제» 확정 0
  const lt = known ? LATCH_TXT(x) : `잠금 상태 미확인(${x.linkOk ? `연결은 됐으나 ${x.linkTxt}` : x.open && x.everMsg ? '서버 상태 오래됨' : '서버 연결 끊김'})`;
  const lock: C = !known ? { k: 'lock', tone: 'warn', text: '잠금 확인 안 됨', why: lt } : x.latch ? { k: 'lock', tone: 'bad', text: 'STOP 잠금', why: lt } : { k: 'lock', tone: 'ok', text: '잠금 해제', why: lt };
  return [sim, link, role, lock];
}
export function useHeadChips() {
  const s = useLink(), v = linkView(s);
  return headChips({ provider: s.provider, linkOk: v.linkOk, open: s.open, everMsg: !!s.lastMsg, authEnd: s.authEnd, bad: s.bad, st: s.st, viewOnly: s.viewOnly, linkTxt: v.linkTxt, roleTxt: v.roleTxt, latch: v.latch });
}

/** 영상 칩(R3·§3 «카메라 미연결 → 영상 없음»): 확인된 꺼짐(시뮬 카메라 off)만 off · 대기·없음은 warn. why = 원래 상태 글 */
export function camChip(v: { camOk: boolean; camTxt: string }): { tone: Tone; text: string; why: string } {
  return v.camOk ? { tone: 'ok', text: '영상 받음', why: v.camTxt } : v.camTxt.startsWith('꺼짐') ? { tone: 'off', text: '영상 꺼짐', why: v.camTxt }
    : /^(리셋|새 프레임)/.test(v.camTxt) ? { tone: 'warn', text: '영상 대기', why: v.camTxt } : { tone: 'warn', text: '영상 없음', why: v.camTxt };
}

/** 조종 화면(Main) 오른쪽 «시뮬 실행» 칸: 리셋·시뮬 시작(MapStartBox — 새 SLAM 지도 만들기 하나)·지도 저장·끄기. 실행 조건·권한·busy 는 기존 경로 그대로(sendOp·MapStartBox·SimOff).
 *  SLAM-1: 평지 «시뮬 시작(30분)»(op sim_start) 항목 삭제 — 시작은 MapStartBox 하나(확인 = 페이지 안 StartAsk).
 *  10-18 요청 5·7: 머리줄 «시뮬 ▾» 삭제 → PC 시뮬 조작 입구는 이 칸 하나 · PcMap 의 «만든 지도 보관»(map_save)도 이 칸으로 옮김(part 없음 = 열기+저장) */
/** 시뮬 리셋 단추 하나 — 옛 «시뮬 ▾» 항목 그대로(조건 linkOk·조종 역할·보기 전용 아님·리셋/재개 처리 중 아님 · dropAll 뒤 sendOp reset). Main «시뮬 실행» 칸·폰 MMap 본문(10-18 root D8) 공용 — 새 제어 경로 0 */
export function SimReset({ t, className = 'lv-btn' }: { t: string; className?: string }) {
  const L = useLink(), v = linkView(L), st = L.st;
  if (L.provider !== 'simulation_gate') return null;
  const ctl = v.linkOk && st?.role === 'control' && !L.viewOnly, busy = v.linkOk && !!(st?.reset_pending || st?.resume_pending);
  return ctl && !busy ? <button type="button" className={className} onClick={() => { dropAll(); sendOp('reset'); }}>{t}</button>   /* dropAll: 누르던 입력 0 */
    : <button type="button" {...whyProps(!v.linkOk ? '연결 확인 안 됨' : !ctl ? '조종 중인 기기에서만(«조종 시작» 뒤)' : '리셋·재개 처리 중')} className={`${className} lv-why`}>{t}</button>;
}
export function SimRun({ catalog, reloadCatalog }: { catalog?: MapInfo[] | string | null; reloadCatalog?: () => unknown }) {
  const L = useLink(), v = linkView(L), st = L.st;
  if (L.provider !== 'simulation_gate') return null;
  const ux = st?.map_start?.usage_scope === 'user_experience';
  return <>
    {!v.linkOk && <p className="lv-note">{`연결 확인 안 됨 — 조작하지 않음`}<span data-dev>{` (${v.linkTxt})`}</span></p>}
    <SimReset t="시뮬 리셋" />
    {st?.map_start && <div className="lv-simmap"><MapStartBox pc preview catalog={catalog} reloadCatalog={reloadCatalog} /></div>}
    <SimOff className="lv-btn" />
    {(sessTxt(st) || (st?.map_start && !ux)) && <p className="lv-note">{[st?.map_start && !ux && startTxt(st).map, sessTxt(st) && `시뮬 ${sessTxt(st)}`].filter(Boolean).join(' · ')}</p>}
  </>;
}
/** 칩 4종 + 개발자 표시 — 상태 줄(LiveStatus)과 Main 머리줄 공용. 10-18 요청 7: 머리줄 «시뮬 ▾» 삭제 — 시뮬 실행·리셋·끄기는 조종 화면(Main) 오른쪽 «시뮬 실행» 칸(SimRun)·폰 지도(MMap) 본문 */
export function HeadChips() {
  return <>{useHeadChips().map((c) => <span key={c.k} data-head={c.k} style={{ display: 'inline-flex' }}><Chip tone={c.tone} text={c.text} why={c.why} /></span>)}<DevMark /></>;
}

export function LiveStatus({ D, style }: { D: Docs; style?: React.CSSProperties }) {
  const s = useLink(), st = s.st, v = linkView(s);
  const reload = () => { if (st?.role === 'control') return toast('조종 중에는 새로고침하지 않습니다 — 조종 반납 뒤'); location.reload(); };
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
