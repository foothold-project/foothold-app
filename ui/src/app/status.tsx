// 공통 머리줄 상태(UI-SIMPLIFY v3 R8 · U1-b): [시뮬] [연결] [역할] [잠금] 칩 + 개발자 표시(10-18 «시뮬 ▾» 삭제) + 문서 오류 + 새 판 차단.
// 칩 글은 서버가 준 값으로만 정한다(새 추정 0). 미확인·끊김을 «꺼짐»으로 보이지 않는다.
// B2(10-15 검토): 지금 계약의 session(result idle 등)은 조회 시각·신선도가 없고 unit·요청 진행과 따로라 «시뮬 꺼짐» 확정 근거가 못 된다
// → 세션 값은 ? 안 원문으로만 · 칩은 «시뮬 확인 안 됨»(끊김은 서버 sim_block 그대로 «시뮬 끊김»).
// 각 칩의 «?» 에 원래 상태 글(전문)을 그대로 둔다.
import { useId } from 'react';
import type { MapInfo, Status } from '@contracts';
import { dropAll, linkView, sendOp, sessTxt, startTxt, useLink } from '../data/link';
import { reread, type Docs, type Media } from '../data/shared';
import { LATCH_TXT } from '../data/facts';
import { MapStartBox } from '../map/MapStartBox';
import { Chip, DevMark, usePop, type Tone } from './chip';
import { InTop, SimOff, toast, whyProps } from './shell';

type C = { k: 'sim' | 'link' | 'role' | 'lock'; tone: Tone; text: string; why: string };
type HX = { provider: string; linkOk: boolean; open?: boolean; everMsg: boolean; authEnd: boolean; bad: string | null; st: Status | null; viewOnly: boolean; linkTxt: string; roleTxt: string; latch: boolean };
/** «상태 ▾» 패널의 상세 4종(순수 — 시험용 · 10-19 전까지 머리줄 칩이던 판정 그대로). 실기 대상이면 연결 «실기 미연결»만 */
export function statusRows(x: HX): C[] {
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
export type H3 = { k: 'gate' | 'target' | 'op'; tone: Tone; text: string; why: string };
export const LOCK_NOTE = '잠금 = 명령 0 유지 · 몸이 멈췄는지는 화면에서 확인';
/** 10-19 머리줄 칩 3개(순수 — 시험용 · UX-SPEC 2-1 R1 · ROOT-IMPLEMENT 3): ① 관문(앱↔관문만 · 도움말에 sim_block 0) ② 대상(관문↔시뮬) ③ 조작·다음 행동(역할+잠금).
 *  상위 원인 하나: ① 이 ok 가 아니면 ② 는 off «대기». ③ 은 ② 와 무관 — 관문 현재 status 가 유효하면(known) sim_block 이 있어도 다른 기기 조종·STOP 잠금을 밖에 그대로,
 *  status 자체가 미확인일 때만 off «조작 · 대기»(옛 잠금을 현재처럼 보이지 않음 · 도움말 = 미확인 원문). 잠금은 lock tone(중립 테두리 · 채운 빨강은 STOP 하나).
 *  실기 대상이면 ② 하나만. main = Main 화면(꼬리 «조종 시작» — 그 화면에 단추가 있음). 판정 입력은 statusRows 와 같고 새 추정 0 */
export function headChips(x: HX & { main?: boolean }): H3[] {
  if (x.provider !== 'simulation_gate') return [{ k: 'target', tone: 'off', text: '실기 미연결 · 직접 연결 준비 중', why: x.linkTxt }];
  const { st } = x, known = x.linkOk && !x.bad && !!st, lost = !x.linkOk && x.everMsg;
  const gwhy = ['앱과 관문 PC 사이 연결', known ? '정상' : x.linkTxt, lost && 'STOP 전달·잠금 확인 불가'].filter(Boolean).join(' · ');
  const gate: H3 = { k: 'gate', why: gwhy, ...(x.authEnd ? { tone: 'bad', text: '로그인 끝남 · 다시 로그인' }
    : !x.linkOk ? (!x.everMsg ? { tone: 'warn', text: '관문 연결 중' } : x.open ? { tone: 'warn', text: '관문 상태 오래됨' } : { tone: 'bad', text: '관문 끊김 · 다시 연결 중' })
    : !known ? { tone: 'warn', text: '관문 상태 확인 안 됨' } : { tone: 'ok', text: '관문 연결됨' }) as Pick<H3, 'tone' | 'text'> };
  const sb = st?.sim_block || '', sw = [sb && `시뮬 상태 ${sb}`, sessTxt(st) && `RL 세션 조회값 ${sessTxt(st)}(조회 시각 미표시 · 꺼짐 확정 아님)`, st?.sim_start?.why].filter(Boolean).join(' · ') || '시뮬 상태 정상';
  const target: H3 = gate.tone !== 'ok' ? { k: 'target', tone: 'off', text: '시뮬 · 대기(관문 먼저)', why: `관문 «${gate.text}» — 관문이 연결돼야 시뮬 응답을 확인` }
    : { k: 'target', why: sw, ...(!sb ? { tone: 'ok', text: '시뮬 응답 중' } : sb === '시뮬 상태 미수신' ? { tone: 'warn', text: '시뮬 확인 안 됨' } : sb === '시뮬 상태 끊김' ? { tone: 'bad', text: '시뮬 끊김' }
      : sb === '시뮬 리셋 중' ? { tone: 'warn', text: '시뮬 리셋 중' } : sb === '정책 미실행' ? { tone: 'warn', text: '제어 준비 안 됨' } : { tone: 'warn', text: '시뮬 처리 중' }) as Pick<H3, 'tone' | 'text'> };
  const lt = statusRows(x)[3].why, tail = x.main ? '«조종 시작»' : '조종은 «조종» 메뉴', rw = `${x.roleTxt} · ${lt}`;
  const op: H3 = !known ? { k: 'op', tone: 'off', text: '조작 · 대기', why: lt }
    // 다른 기기 조종 + 잠금: 둘 다 독립 사실이라 함께 밖에(UX-SPEC 표에 없는 조합 — DESIGN 통지)
    : st!.role === 'view_other' ? { k: 'op', tone: 'warn', text: x.latch ? '다른 기기 조종 중 · STOP 잠금' : '다른 기기 조종 중 · 반납 대기', why: x.latch ? `${rw} · ${LOCK_NOTE}` : rw }
    : st!.role === 'control' && !x.viewOnly ? (x.latch ? { k: 'op', tone: 'lock', text: 'STOP 잠금 · «조종 시작»으로 해제', why: `${rw} · ${LOCK_NOTE}` } : { k: 'op', tone: 'ok', text: '이 기기 조종 중', why: rw })
    : x.latch ? { k: 'op', tone: 'lock', text: x.main ? '보기 전용 · STOP 잠금 · «조종 시작»' : '보기 전용 · STOP 잠금', why: `${rw} · ${LOCK_NOTE}` }
    : { k: 'op', tone: 'off', text: `보기 전용 · ${tail}`, why: rw };
  return [gate, target, op];
}
// G3 CURRENT(715 13d12525 P2 · ROOT3 «현재 연결에서 확인한 status 만 현재 역할/잠금»): 이 연결 세대가 아닌 옛 st(stGen ≠ gen)는 표시 입력에서 뺀다(PcRobot known 과 같은 기준)
// → statusRows·headChips 의 known 거짓 = 회색 대기 · 역할 도움말에 옛 roleTxt 0. 제어 관문(linkView·driveBlock)·송신은 그대로(raw st 사용)
const hx = (s: ReturnType<typeof useLink.getState>): HX => { const v = linkView(s), cur = s.stGen === s.gen;
  return { provider: s.provider, linkOk: v.linkOk, open: s.open, everMsg: !!s.lastMsg, authEnd: s.authEnd, bad: s.bad, st: cur ? s.st : null, viewOnly: s.viewOnly, linkTxt: v.linkTxt, roleTxt: s.st && !cur ? '역할 미확인(이 연결에서 받은 상태 없음)' : v.roleTxt, latch: v.latch }; };
export function useHeadChips(main = false) { return headChips({ ...hx(useLink()), main }); }
/** 관문(①)이 정상이 아니면 참 — 종속 표시(영상 등)를 «대기»로 낮출 때 */
export const gateWait = (c: H3[]) => !(c[0]?.k === 'gate' && c[0].tone === 'ok');

/** 영상 칩(R3·§3 «카메라 미연결 → 영상 없음»): 확인된 꺼짐(시뮬 카메라 off)만 off · 대기·없음은 warn. why = 원래 상태 글 */
export function camChip(v: { camOk: boolean; camTxt: string }, wait = false): { tone: Tone; text: string; why: string } {
  if (wait && !v.camOk) return { tone: 'off', text: '영상 · 대기', why: `관문 먼저 — ${v.camTxt}` };   // 10-19 상위 원인 하나(UX-SPEC 2-4): 관문이 정상일 때만 영상 경고
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
export function SimRun({ catalog, reloadCatalog, pri = true }: { catalog?: MapInfo[] | string | null; reloadCatalog?: () => unknown; pri?: boolean }) {   // pri: 시뮬 실행 단추 강조(Main = 주행동일 때만)
  const L = useLink(), v = linkView(L), st = L.st;
  if (L.provider !== 'simulation_gate') return null;
  const ux = st?.map_start?.usage_scope === 'user_experience';
  return <>
    {!v.linkOk && <p className="lv-note">{`연결 확인 안 됨 — 조작하지 않음`}<span data-dev>{` (${v.linkTxt})`}</span></p>}
    <SimReset t="시뮬 리셋" />
    {st?.map_start && <div className="lv-simmap"><MapStartBox pc preview catalog={catalog} reloadCatalog={reloadCatalog} pri={pri} /></div>}
    <SimOff className="lv-btn" />
    {(sessTxt(st) || (st?.map_start && !ux)) && <p className="lv-note">{[st?.map_start && !ux && startTxt(st).map, sessTxt(st) && `시뮬 ${sessTxt(st)}`].filter(Boolean).join(' · ')}</p>}
  </>;
}
/** 칩 4종 + 개발자 표시 — 상태 줄(LiveStatus)과 Main 머리줄 공용. 10-18 요청 7: 머리줄 «시뮬 ▾» 삭제 — 시뮬 실행·리셋·끄기는 조종 화면(Main) 오른쪽 «시뮬 실행» 칸(SimRun)·폰 지도(MMap) 본문 */
export function HeadChips({ main = false, extra = [] }: { main?: boolean; extra?: [string, string, string][] }) {
  return <>{useHeadChips(main).map((c) => <span key={c.k} data-head={c.k} style={{ display: 'inline-flex' }}><Chip tone={c.tone} text={c.text} why={c.why} /></span>)}<StatusMore extra={extra} /><DevMark /></>;
}
/** «상태 ▾»(UX-SPEC 2-3): 칩 3개가 줄인 원문 전부 — 시뮬·관문·역할·잠금(+화면별 extra: 영상·위치). 정상 값(잠금 해제·영상 받음)은 여기에만.
 *  패널 = usePop(STOP·[data-pop-avoid] 프로젝트 선택칸과 겹침 0 · Esc 먼저 소비 · 바깥 누름 닫힘) — 새 자리 계산 0 */
export function StatusMore({ extra = [] }: { extra?: [string, string, string][] }) {
  const s = useLink(), x = hx(s), d = statusRows(x), g = headChips(x)[0], P = usePop(360, { inline: true }), id = useId(), inl = !!P.pos?.inline;
  const rows: [string, string, string][] = x.provider !== 'simulation_gate' ? [['연결', d[0].text, d[0].why]]
    : [['시뮬', d[0].text, d[0].why], ['관문', g.text, g.why], ['역할', d[2].text, d[2].why], ['잠금', d[3].text, d[3].why], ...extra];
  const body = rows.map(([k, t, w]) => <span key={k} style={{ display: 'block', marginTop: 4 }}><b>{`${k} · ${t}`}</b>{` — ${w}`}</span>);
  // 떠 있는 패널(InTop) ↔ 자리 없을 때 인라인(ROOT CODEX-G3 R1 · UX-SPEC 2-3): 머리줄 flex-wrap 의 새 줄(flex-basis 100%)로 본문을 밀어냄 — fixed 0 → STOP·프로젝트 칸 덮음 0
  return <><span style={{ display: 'inline-flex' }}>
    <button ref={P.b} type="button" className="lv-btn" style={{ minHeight: 34 }} aria-expanded={!!P.pos} aria-controls={id} onClick={P.toggle}>{P.pos ? '상태 ▴' : '상태 ▾'}</button>
    <InTop><span id={inl ? undefined : id} ref={inl ? undefined : P.p as React.RefObject<HTMLSpanElement>} role="region" aria-label="상태 상세" className="lv-pop" hidden={!P.pos || inl} style={P.style}>{body}</span></InTop></span>
    {inl && <span id={id} ref={P.p as React.RefObject<HTMLSpanElement>} role="region" aria-label="상태 상세" className="lv-pop-inline" data-pop-inline="1">{body}</span>}</>;
}

// G4(ROOT3 · UX-SPEC 2 요약 칩 최대 3): 화면별 덧붙일 사실(위치·출처 등)은 칩이 아니라 «상태 ▾» 상세 행(extra)으로
export function LiveStatus({ D, style, extra }: { D: Docs; style?: React.CSSProperties; extra?: [string, string, string][] }) {
  const s = useLink(), st = s.st, v = linkView(s);
  const reload = () => { if (st?.role === 'control') return toast('조종 중에는 새로고침하지 않습니다 — 조종 반납 뒤'); location.reload(); };
  return (
    <span className="lv-status" data-live-status="1" style={style}>
      <HeadChips extra={extra} />
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
