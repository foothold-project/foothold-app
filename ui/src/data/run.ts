// 수동 임무 진행·지도 계산 공용 — web/live.js 908·919–921·1124–1136·1170 과 같은 규칙. 자동 이동·자동 완료 없음, 운영자가 눌러 기록.
import type { DocWrite, MapSrc, Mission, Run, RunWaypoint } from '@contracts';
import { activeRun, docById, docsNow, docsOf, qc, saveDoc, type Docs, type SaveRes } from './shared';
import { ask, askPage, dropAsk, linkView, useLink } from './link';
import { WF } from './maps';
import { geomRid, ridReset } from './geom';
import { MISSING_T, tmplOf } from './tmpl';
import { toast } from '../app/shell';
import { wpName } from './fmt';
import type { Media } from './shared';

// ---- 관찰 사진: 어느 임무 지점에 붙었나 · 같은 위치(1 m 안) 다른 사진 (live.js runsOf·nearOf) ----
type Photo = Media['photos'][number];
export const runsOf = (D: Docs, url: string) => docsOf(D, 'run').flatMap((r) => r.doc.wps.map((w, i) => (w.photos.includes(url) ? `«${r.doc.name}» ${wpName(w, i)}` : null)).filter((x): x is string => !!x));
export const nearOf = (M: Media, p: Photo) => (p.x == null || p.y == null ? [] : M.photos.filter((q) => q !== p && q.x != null && q.y != null && Math.hypot(q.x - p.x!, q.y - p.y!) < 1));

export const r2 = (v: number) => Math.round(v * 100) / 100;
const pip = (x: number, y: number, pts: number[][]) => { let c = false; for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) { const [xi, yi] = pts[i], [xj, yj] = pts[j]; if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c; } return c; };
export const zonesAt = (D: Docs, x: number, y: number) => docsOf(D, 'zone').filter((z) => pip(x, y, z.doc.pts));
export const zoneTxt = (D: Docs, x: number, y: number) => { const z = zonesAt(D, x, y); return z.length ? z.map((d) => `${d.doc.type} «${d.doc.name}»`).join(', ') + ' 안(표시만)' : '구역 밖'; };
export const legLen = (wps: { x: number; y: number }[]) => wps.reduce((a, w, i) => a + (i ? Math.hypot(w.x - wps[i - 1].x, w.y - wps[i - 1].y) : 0), 0);

export const isoNow = () => {   // 이 기기 시각 + 시간대(서버 기록과 같은 꼴 2026-10-13T12:46:00+0900)
  const d = new Date(), o = -d.getTimezoneOffset(), p = (x: number) => String(Math.abs(x)).padStart(2, '0');
  return `${new Date(d.getTime() + o * 6e4).toISOString().slice(0, 19)}${o < 0 ? '-' : '+'}${p(Math.trunc(o / 60))}${p(o % 60)}`;
};
// ---- 좌표 출처(10-15 프리셋 1단계) — 지점을 찍거나 가져온 때의 GT world·현재층. 저장 때 현재 연결을 붙이지 않는다 ----
// 출처는 «믿음을 낮추는 쪽»으로만 바뀐다: 모르는 지도에서 더한 좌표·지문이 어긋난 좌표는 미확인(기록만)으로 떨어지고, 확인으로 올라가는 길은 «지금 지도에서 다시 찍기»뿐.
type Pt = { x: number; y: number };
/** 좌표 지문: 순서와 무관한 지점 좌표 집합(FNV-1a 32bit, 8 hex). 보안용 아님 — 출처를 모르는 옛 앱이 좌표를 고쳤는지 알아보는 용도 */
export const wkey = (wps: Pt[]) => {
  let h = 0x811c9dc5; for (const c of wps.map((w) => `${w.x},${w.y}`).sort().join(';')) h = Math.imul(h ^ c.charCodeAt(0), 0x01000193) >>> 0;
  return h.toString(16).padStart(8, '0');
};
export type Here = { map: MapSrc; why?: undefined } | { map?: undefined; why: string };
/** 지금 시뮬의 GT 좌표 기준(world·현재층). 하나라도 못 믿으면 이유(= 미확인 · 기록만) — 확정으로 올리는 조건:
 *  ① 링크 신선(1 s, 완화 없음) ② 서버 상태 수준 결속 bound=true 이고 st ok/wait(wait = 격자만 아직 — 상태는 결속). reset·bad·결속 불가는 미확인(F2)
 *  ③ 아는 world·층 ④ 층이 둘 이상인 연결 건물은 서버 층 판정 floor 가 on_floor 이고 current 가 그 건물 층일 때만 — floor 누락·null·모르는 current 면
 *     현재층 미확인(시작층 floor_id 로 대신하지 않음, F3). 단층 world 는 floor_id(그 world 층일 때만), floor 가 오면 같은 규칙
 *  ⑤ 좌표 개정 rid(F4): PcPlan 좌표 = Gazebo world GT(그림 없이 찍음) → 그 world 를 정하는 원본으로 대조. 단층 = w:<기동 world 원본 SDF sha>(spawn_floor 가 그 층),
 *     연결 건물 = g:<geom_get 으로 받아 geomBind ok 인 기하 파일 sha>(층마다 다른 기동 SDF 를 한 개정으로 묶음). 못 정하면 미확인. SDF include 메시·모델 파일은 미대조 */
export function gtHere(s = useLink.getState()): Here {
  const lv = s.st?.live_map;
  if (!linkView(s).linkOk) return { why: '연결 끊김' };
  if (!lv || lv.st === 'off' || lv.st === 'stale' || lv.st === 'unknown' || !lv.world_id) return { why: '지도 미수신' };   // 부르는 쪽이 «지금 …»을 붙임(«지금 지금» 중복 0)
  if (lv.world_id !== 'v5_building') ridReset();   // G2: 연결 건물 밖(단층·다른 world)을 관찰 = 키 전환 → 옛 기하 요청·검증본 폐기
  const f = lv.floor as { state?: unknown; current?: unknown } | null | undefined;
  if (f && f.state === 'transit') return { why: '층 이동 중' };
  if (lv.st === 'reset') return { why: '시뮬 리셋 중' };
  if (lv.st === 'bad') return { why: '지도 오류' };
  if (lv.bound !== true || (lv.st !== 'ok' && lv.st !== 'wait') || !lv.floor_id) return { why: '서버 결속 미확인' };
  const fl = WF[lv.world_id];
  if (!fl || !fl.includes(lv.floor_id)) return { why: '모르는 지도·층' };
  let floor_id: string = lv.floor_id;
  if (fl.length > 1 || f) {
    if (!f || f.state !== 'on_floor' || typeof f.current !== 'string' || !fl.includes(f.current)) return { why: '현재층 미확인' };
    floor_id = f.current;
  }
  if (fl.length > 1) {
    const r = geomRid(s, lv);
    return r.rid ? { map: { src: 'gt', world_id: lv.world_id, floor_id, key: '', rid: r.rid } } : { why: r.wait ? '좌표 개정 확인 중(GT 기하 파일 받는 중)' : `좌표 개정 미확인(GT 기하 파일 미검증 · ${r.why})` };
  }
  const w = lv.world_src_sha256;
  if (typeof w !== 'string' || !/^[0-9a-f]{64}$/.test(w) || lv.spawn_floor !== fl[0]) return { why: '좌표 개정 미확인(world 원본 SDF sha 없음)' };
  return { map: { src: 'gt', world_id: lv.world_id, floor_id, key: '', rid: `w:${w}` } };
}
/** 문서의 출처: map 이 있고 개정 rid 가 있고(F4 — 없는 옛 출처는 자동 승격 0) 지문이 지금 좌표와 같을 때만. 지문(FNV)은 좌표 수정 감지 보조일 뿐 */
export const planMap = (d: { wps: Pt[]; map?: MapSrc }): Here => (!d.map ? { why: '출처 미확인(출처 기록 없음)' } : !d.map.rid ? { why: '출처 미확인(개정 기록 없음 — 지금 지도에서 다시 찍어야 확인)' }
  : d.map.key !== wkey(d.wps) ? { why: '출처 기록 뒤 좌표가 바뀜' } : { map: d.map });
export const sameMap = (a: MapSrc, b: MapSrc) => a.src === b.src && a.world_id === b.world_id && a.floor_id === b.floor_id && !!a.rid && a.rid === b.rid;
/** 화면 표기: world · 층 (GT · SDF|기하 sha 앞 8자). 개정 기준 = world 원본 SDF / GT 기하 파일 — 그 SDF 가 부르는 메시·모델 파일은 대조 안 함 */
export const mapTxt = (m: MapSrc) => `${m.world_id} · ${m.floor_id} (GT · ${!m.rid ? '개정 미확인' : `${m.rid[0] === 'w' ? 'SDF' : '기하'} ${m.rid.slice(2, 10)}`})`;
/** 서버 시작 대조 표시(C) — mcas 는 «시작 순간 서버 대조»뿐(지도·기하·실제 환경 검증 아님). 양식 종류는 그 판(mrev)의 계획이 아직 있을 때만 */
export function mcasTxt(D: Docs, R: Run) {
  if (R.mcas !== 1) return '서버 미대조 — 이 기기 캐시 기준으로 시작';
  const m = docById(D, R.mission), t = m && m.kind === 'mission' && m.rev === R.mrev ? m.doc.tmpl : null;
  return `시작 때 서버가 계획 판·스냅샷 대조 · 양식: ${t == null ? '이름·존재만' : !t || t === 'base' ? '내장 기본(이름 대조)' : '이름·존재만(본문 개정 미검증)'}`;
}
/** 진행 기록을 지금 지도에 겹쳐도 되나 — 거리·지점 겹치기는 이것이 ok 일 때만 */
export function runHere(R: Run | null | undefined, s = useLink.getState()): { ok: boolean; why: string } {
  if (!R) return { ok: false, why: '' };
  const b = planMap(R), h = gtHere(s);
  if (!b.map) return { ok: false, why: `지도 미확인 · 기록만(${R.map ? b.why : '시작 때 출처 미확인'})` };
  if (!h.map) return { ok: false, why: `지금 지도 미확인 · ${h.why}` };
  return sameMap(b.map, h.map) ? { ok: true, why: '' } : { ok: false, why: `다른 지도 · 기록 ${mapTxt(b.map)} ≠ 지금 ${mapTxt(h.map)}` };
}
/** 지점 좌표를 고칠 때: 고치기 전 출처가 유효했을 때만 지문을 새로 매기고, 아니면 출처를 지운다(옛 지문을 새 좌표에 다시 맞춰 «확인»으로 둔갑시키지 않음) */
export function rekey(d: Mission, f: () => void) { const ok = !!planMap(d).map; f(); if (d.map) { if (ok) d.map = { ...d.map, key: wkey(d.wps) }; else delete d.map; } }
/** 계획에 지점 하나 더하기 전 판정: 'bind' 빈 계획에 지금 지도 결속 · 'keep' 같은 지도 · 'drop' 다른/모르는 지도(확인 뒤 기록만으로) · 'none' 이미 미확인 */
export function addPlan(d: Mission, h: Here): { act: 'bind' | 'keep' | 'drop' | 'none'; why: string } {
  if (!d.wps.length) return { act: 'bind', why: h.map ? mapTxt(h.map) : h.why };
  const b = planMap(d);
  if (!b.map) return { act: 'none', why: b.why };
  if (h.map && sameMap(b.map, h.map)) return { act: 'keep', why: '' };
  return { act: 'drop', why: h.map ? `지금 지도 ${mapTxt(h.map)} ≠ 이 계획 ${mapTxt(b.map)}` : `지금 지도 미확인(${h.why}) · 이 계획 ${mapTxt(b.map)}` };
}
/** 시작 정책(모든 진입점 공통): 출처·world·현재층 일치 = 결속 시작 · 둘 다 알고 다르면 차단 · 어느 한쪽이라도 모르면 «지도 미확인 · 기록만»(지금과 같은 동작, 거리·겹치기 표시 0) */
export function startPolicy(d: Mission, h: Here): { block: string | null; map: MapSrc | null; line: string } {
  const b = planMap(d);
  if (b.map && h.map && !sameMap(b.map, h.map)) return { block: `다른 지도 · 계획 ${mapTxt(b.map)} ≠ 지금 ${mapTxt(h.map)} — 시작 안 됨(열기·편집은 가능, 맞는 지도·층에서 시작)`, map: null, line: '' };
  if (b.map && h.map) return { block: null, map: b.map, line: `지도 ${mapTxt(b.map)} · 지금 시뮬과 같은 GT 출처(SDF/기하 sha 기준 · 메시·모델 파일 미대조)` };
  return { block: null, map: null, line: `지도 미확인 · 기록만 — ${b.map ? `지금 ${h.why}` : b.why} (거리·지도 겹치기 표시 안 함)` };
}
/** 계획 복제(조금 바꿀 때만): 양식 참조·지점·할 일·메모·좌표 출처 그대로 깊은 사본, 이름 «… 사본»(60자). 저장 전 초안 — 저장하면 새 계획(원본 무변경).
 *  출처는 원본 그대로(유효하면 유효, 미확인이면 미확인) — 지금 연결로 다시 붙이지 않음 */
// 자르기는 문자(code point) 단위로 — UTF-16 slice 는 이모지 반쪽(외톨이 surrogate)을 남겨 UTF-8 저장이 깨짐(Codex 9dc703e P2). 상한은 입력칸과 같은 UTF-16 길이
// ponytail: 글자 묶음(👨‍👩‍👧 같은 ZWJ·국기)은 중간에서 끊길 수 있음(유효 UTF-8 은 유지) — 필요하면 Intl.Segmenter
export const cutName = (s: string, n: number) => { let o = ''; for (const ch of s) { if (o.length + ch.length > n) break; o += ch; } return o; };
export const dupMission = (m: Mission): Mission => { const c = structuredClone(m); c.name = `${cutName(m.name, 57)} 사본`; return c; };
// 계획 스냅샷: 나중에 계획을 고쳐도 이 기록은 그대로. map = 시작 때 일치했을 때만, mrev = 시작한 계획 판.
// C: 서버가 같은 규칙으로 대조(Run.tmpl == cut16(양식 이름, 60) — server/runcas.py cut16 = cutName). mcas 는 서버만 붙임(여기서 보내면 400)
const newRun = (D: Docs, mid: string, m: Mission, map: MapSrc | null, mrev: number): Run => ({ mode: '수동', mission: mid, tmpl: cutName(tmplOf(D, m.tmpl)!.name, 60), name: m.name, status: '진행', started: isoNow(), ended: '', memo: '',
  wps: m.wps.map((w) => ({ x: w.x, y: w.y, name: w.name, mods: w.mods.slice(), st: '대기', at: '', why: '', chk: '', photos: [] })), ...(map ? { map: { ...map } } : {}), mrev });
// C 서버가 시작을 거절한 사유(reason_code) — 이것만 «다른 기기가 바꿈» 문구. 진행 1개·rev 409 는 기존 문구 그대로
const C_REASON = new Set(['mission_gone', 'mission_changed', 'tmpl_changed', 'snapshot_mismatch']);
// send: 화면의 editor.write(쓰기 한 번에 하나) — 두 번 눌러 진행 기록이 둘 생기지 않게. ask: 페이지 안 확인창(시험에서 바꿔 끼움)
// own(E1): owner = 확인창 주인(이탈·대상 변경 때 dropAsk 로 닫힘), alive = 확인 뒤 «연 화면·고른 계획·편집기 세대가 그대로인가». 아니면 쓰기·화면 이동 0
export async function startRun(D: Docs, mid: string | null, send: (m: DocWrite) => Promise<SaveRes | null>, own: { owner?: unknown; alive?: () => boolean; ask?: (t: string) => Promise<boolean> } = {}) {
  const ask = own.ask ?? ((t: string) => askPage(t, '진행 시작', own.owner)), route = globalThis.location?.hash;
  const m = docById(D, mid); if (!m || m.kind !== 'mission') { toast('계획을 고르세요'); return null; }
  if (!m.doc.wps.length) { toast('지점이 없는 계획입니다 — 먼저 지점을 추가'); return null; }
  const T = tmplOf(D, m.doc.tmpl); if (!T) { toast(MISSING_T); return null; }
  if (activeRun(D)) { toast('진행 중인 수동 임무가 있습니다 — 먼저 끝내세요'); return null; }
  const p = startPolicy(m.doc, gtHere()); if (p.block) { toast(p.block); return null; }
  // 확인창은 페이지 안(비차단, F1): 기다리는 동안 status·문서 갱신이 계속 들어오므로 아래 재검사는 1 s 신선도를 그대로 쓴다. STOP 은 눌리고 창은 닫힘(취소)
  if (!(await ask(`«${m.doc.name}» 수동 진행을 시작할까요?\n· ${p.line}\n· 지점 ${m.doc.wps.length}개 · 양식 «${T.name}»\n· 로봇은 자동으로 움직이지 않습니다(직접 조종)\n· 방문·미방문·판단은 운영자가 눌러 기록`))) return null;
  if (globalThis.location?.hash !== route || (own.alive && !own.alive())) { toast('확인하는 사이 화면·고른 계획이 바뀜 — 시작 안 됨'); return null; }
  // 확인 뒤 재검사 — 범위는 «이 기기가 지금까지 받은 문서 캐시 + 지금 링크 상태»뿐(서버 최신 판을 다시 읽지 않음).
  // C 서버는 Run 을 받는 순간 같은 잠금/트랜잭션 안에서 계획 판(mrev)·스냅샷·양식 이름을 대조 → 통과만 mcas=1, 다르면 409 + reason(쓰기 0).
  // C 직전 서버는 대조하지 않음(mcas 없이 저장 = 화면 «서버 미대조»). 자동 재시도·최신 판 자동 대체 0
  const D2 = docsNow(), x2 = docById(D2, m.id), m2 = x2 && x2.kind === 'mission' ? x2 : null, p2 = m2 ? startPolicy(m2.doc, gtHere()) : null, T2 = m2 ? tmplOf(D2, m2.doc.tmpl) : null;
  if (qc.getQueryState(['docs'])?.status === 'error') { toast('문서 다시 읽기 실패 — 최신 계획 미확인 · 시작 안 됨'); return null; }
  if (!m2 || m2.rev !== m.rev || !p2 || p2.block || p2.line !== p.line || !T2 || T2.name !== T.name) { toast('확인하는 사이 이 기기에 들어온 계획·양식 또는 지도 상태가 바뀜 — 다시 눌러 주세요'); return null; }
  const r = await send({ op: 'put', kind: 'run', id: null, doc: newRun(D2, m.id, m2.doc, p2.map, m2.rev) }); if (!r) return null;
  toast(r.ok ? `수동 진행 시작 · 모든 기기 공유${p2.map ? '' : ' · 지도 미확인 · 기록만'}` : r.reason && C_REASON.has(r.reason) ? `다른 기기가 계획/양식을 바꿈 — 시작 안 됨 · 다시 열어 확인(${r.error})` : `시작 안 됨 · ${r.error}`);
  return r.ok ? r : null;
}

// ---- 계획 편집기 ↔ 시작 확인창 결속(E1 + dirty) ----
type PlanEd = { gen: number; id: string | null; dirty: boolean; touch(): void };
/** 확인창을 여는 순간의 편집기 세대·선택 + 저장 안 한 수정 없음 — 확인 직후 하나라도 다르면 쓰기 0.
 *  «서버에 저장된 판으로 시작하니 괜찮다»로 미저장 수정을 우회하지 않는다(화면의 계획 ≠ 시작될 계획) */
export const planOwn = (E: PlanEd) => { const g0 = E.gen, id0 = E.id; return { owner: E, alive: () => E.gen === g0 && E.id === id0 && !E.dirty }; };
/** 계획 편집 1회: 수정 표시 + 이 편집기가 연 시작 확인창만 취소(편집 내용·저장·서버 판 무변경 · N1 등 다른 주인 창 무영향) */
export function planEdit(E: PlanEd, f: () => void) {
  f(); E.dirty = true;
  if (dropAsk(E)) toast('계획을 고쳐 시작 확인을 닫음 — 시작 안 됨 · 저장한 뒤 다시 누르세요');
  E.touch();
}

// ---- 진행 기록(live.js 1139–1177) — 운영자가 눌러 기록, 자동 판정 없음 ----
export const curWp = (R: Run) => R.wps.findIndex((w) => w.st === '대기');
/** 기록 중인 지점: 이 기기에서 고른 번호(sel)가 이 기록에 있으면 그것, 아니면 첫 대기 지점. 방문 확인은 선택을 옮기지 않는다 —
 *  다음 지점으로는 «다음 지점» 또는 지점 줄을 눌러서만(R01). next = 선택 뒤쪽 첫 대기 지점, 없으면 앞쪽, 그것도 없으면 -1 */
export function pickWp(R: Run, sel: number | undefined) {
  const i = sel != null && Number.isInteger(sel) && sel >= 0 && sel < R.wps.length ? sel : curWp(R);
  const after = R.wps.findIndex((w, k) => k > i && w.st === '대기');
  return { i, next: after >= 0 ? after : R.wps.findIndex((w, k) => k !== i && w.st === '대기') };
}
type Mod = RunWaypoint['mods'][number];
export const modDone = (w: RunWaypoint, ty: Mod) => (ty === '사진' ? w.photos.length > 0 : ty === '운영자 확인' ? !!w.chk : w.st === '방문');
export const modTxt = (w: RunWaypoint, ty: Mod) => (ty === '사진' ? `사진 · ${w.photos.length}장 붙임` : ty === '운영자 확인' ? `운영자 확인 · ${w.chk || '아직 판단 없음'}` : '대기 · 운영자가 지킴(자동 타이머 아님)');

// 최신 판 위에 한 가지 수정. 충돌이면 다시 누르게(수정 내용이 작아서). 쓰기는 한 번에 하나 — 두 번 눌러 409 가 나지 않게.
// 화면 이동·초안 없음: 늦은 응답도 서버 결과 알림만 한다.
let editing = false;
export async function runEdit(id: string, fn: (d: Run) => boolean | void, what: string) {
  const d = docById(docsNow(), id); if (!d || d.kind !== 'run') return toast('진행 기록을 찾지 못함 — 새로 읽는 중');
  if (d.doc.status !== '진행') return toast(`이미 «${d.doc.status}»로 끝난 기록입니다`);
  if (editing) return toast('기록 중 — 잠시 뒤 다시 누르세요');
  const doc = structuredClone(d.doc); if (fn(doc) === false) return;
  editing = true; let r: SaveRes; try { r = await saveDoc({ op: 'put', id, rev: d.rev, doc }); } finally { editing = false; }
  toast(r.ok ? `${what} · 기록됨(운영자 기록 · 모든 기기 공유)${r.mcasDropped ? ' · 서버 시작 대조 표시 해제(근거 필드가 바뀜)' : ''}` : r.code === 409 ? '다른 기기가 먼저 고침 — 최신 값으로 다시 눌러 주세요' : `기록 안 됨 · ${r.error}`);
}
// 사진 = 서버가 받은 최신 프레임을 서버가 그 순간의 GT·에피소드와 함께 저장(화면은 요청만)
export async function shoot() {
  const r = await ask('photo'); if (!r.ok || !r.photo) { toast(r.text || '사진 응답에 사진 정보 없음'); return null; }
  qc.invalidateQueries({ queryKey: ['media'] }); return r.photo;
}
export async function attachPhoto(id: string, i: number) {
  const p = await shoot(); if (!p) return;
  runEdit(id, (d) => { if (d.wps[i].photos.length >= 10) { toast('지점마다 사진 10장까지 — 사진은 서버 기록에 남음'); return false; } d.wps[i].photos.push(p.url); }, `WP${i + 1} 사진`);
}
export function runEnd(id: string, status: '완료' | '실패' | '중단') {
  const d = docById(docsNow(), id); if (!d || d.kind !== 'run') return;
  const left = d.doc.wps.filter((w) => w.st === '대기').length;
  if (status === '완료' && left) return toast(`대기 지점 ${left}개 — 방문 확인하거나 미방문 사유를 적은 뒤 완료`);
  const memo = status === '완료' ? null : prompt(`${status} 사유(기록에 남음)`, d.doc.memo); if (status !== '완료' && (memo == null || !memo.trim())) return;
  if (!confirm(`수동 임무를 «${status}»로 끝낼까요? (운영자 기록 · 로봇 동작과 무관)`)) return;
  runEdit(id, (x) => { x.status = status; x.ended = isoNow(); if (memo != null) x.memo = cutName(memo.trim(), 400); }, `임무 ${status}`);
}
/** 빠른 메모 칸: 같은 낱말이 있으면 빼고 없으면 붙임(' · ' 구분, 400자) — live.js tagMemo */
export const tagMemo = (memo: string, t: string) => { const a = memo.split(' · ').filter(Boolean); return cutName((a.includes(t) ? a.filter((x) => x !== t) : [...a, t]).join(' · '), 400); };
