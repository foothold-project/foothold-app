// 수동 임무 진행·지도 계산 공용 — web/live.js 908·919–921·1124–1136·1170 과 같은 규칙. 자동 이동·자동 완료 없음, 운영자가 눌러 기록.
import type { DocWrite, MapSrc, Mission, Run, RunWaypoint } from '@contracts';
import { activeRun, docById, docsNow, docsOf, qc, saveDoc, type Docs, type SaveRes } from './shared';
import { ask, linkView, useLink } from './link';
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
/** 지금 시뮬의 GT 좌표 기준: 링크 신선 + 실시간 지도 상태의 world·층. 연결 건물은 서버 층 판정 on_floor 일 때만(시작층·보는 층을 현재층으로 쓰지 않음) */
export function gtHere(s = useLink.getState()): Here {
  const lv = s.st?.live_map;
  if (!linkView(s).linkOk) return { why: '연결 끊김' };
  if (!lv || lv.st === 'off' || lv.st === 'stale' || lv.st === 'unknown' || !lv.world_id || !lv.floor_id) return { why: '지금 지도 미수신' };
  const f = lv.floor as { state?: string; current?: string | null } | null | undefined;
  if (f && (f.state !== 'on_floor' || typeof f.current !== 'string' || !f.current)) return { why: f.state === 'transit' ? '층 이동 중' : '현재층 미확인' };
  return { map: { src: 'gt', world_id: lv.world_id, floor_id: f ? f.current! : lv.floor_id, key: '' } };
}
/** 문서의 출처: map 이 있고 지문이 지금 좌표와 같을 때만 */
export const planMap = (d: { wps: Pt[]; map?: MapSrc }): Here => (!d.map ? { why: '출처 기록 없음(옛 계획)' } : d.map.key !== wkey(d.wps) ? { why: '출처 기록 뒤 좌표가 바뀜' } : { map: d.map });
export const sameMap = (a: MapSrc, b: MapSrc) => a.src === b.src && a.world_id === b.world_id && a.floor_id === b.floor_id;
export const mapTxt = (m: MapSrc) => `${m.world_id} · ${m.floor_id} (GT)`;
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
  if (b.map && h.map) return { block: null, map: b.map, line: `지도 ${mapTxt(b.map)} · 지금 시뮬과 같음` };
  return { block: null, map: null, line: `지도 미확인 · 기록만 — ${b.map ? `지금 ${h.why}` : b.why} (거리·지도 겹치기 표시 안 함)` };
}
/** 계획 복제(조금 바꿀 때만): 양식 참조·지점·할 일·메모·좌표 출처 그대로 깊은 사본, 이름 «… 사본»(60자). 저장 전 초안 — 저장하면 새 계획(원본 무변경).
 *  출처는 원본 그대로(유효하면 유효, 미확인이면 미확인) — 지금 연결로 다시 붙이지 않음 */
export const dupMission = (m: Mission): Mission => { const c = structuredClone(m); c.name = `${m.name.slice(0, 57)} 사본`; return c; };
// 계획 스냅샷: 나중에 계획을 고쳐도 이 기록은 그대로. map = 시작 때 일치했을 때만, mrev = 시작한 계획 판
const newRun = (D: Docs, mid: string, m: Mission, map: MapSrc | null, mrev: number): Run => ({ mode: '수동', mission: mid, tmpl: tmplOf(D, m.tmpl)!.name.slice(0, 60), name: m.name, status: '진행', started: isoNow(), ended: '', memo: '',
  wps: m.wps.map((w) => ({ x: w.x, y: w.y, name: w.name, mods: w.mods.slice(), st: '대기', at: '', why: '', chk: '', photos: [] })), ...(map ? { map: { ...map } } : {}), mrev });
// send: 화면의 editor.write(쓰기 한 번에 하나) — 두 번 눌러 진행 기록이 둘 생기지 않게
export async function startRun(D: Docs, mid: string | null, send: (m: DocWrite) => Promise<SaveRes | null>) {
  const m = docById(D, mid); if (!m || m.kind !== 'mission') { toast('계획을 고르세요'); return null; }
  if (!m.doc.wps.length) { toast('지점이 없는 계획입니다 — 먼저 지점을 추가'); return null; }
  const T = tmplOf(D, m.doc.tmpl); if (!T) { toast(MISSING_T); return null; }
  if (activeRun(D)) { toast('진행 중인 수동 임무가 있습니다 — 먼저 끝내세요'); return null; }
  const p = startPolicy(m.doc, gtHere()); if (p.block) { toast(p.block); return null; }
  if (!confirm(`«${m.doc.name}» 수동 진행을 시작할까요?\n· ${p.line}\n· 지점 ${m.doc.wps.length}개 · 양식 «${T.name}»\n· 로봇은 자동으로 움직이지 않습니다(직접 조종)\n· 방문·미방문·판단은 운영자가 눌러 기록`)) return null;
  // 확인하는 사이: 계획 판이 바뀌었거나 지도 판정이 달라졌으면 보내지 않음(다시 누르게 — 확인한 내용과 다른 기록 0)
  const m2 = docById(docsNow(), m.id), p2 = m2 && m2.kind === 'mission' ? startPolicy(m2.doc, gtHere()) : null;
  if (!m2 || m2.rev !== m.rev || !p2 || p2.block || p2.line !== p.line) { toast('확인하는 사이 계획 또는 지도 상태가 바뀜 — 다시 눌러 주세요'); return null; }
  const r = await send({ op: 'put', kind: 'run', id: null, doc: newRun(D, m.id, m.doc, p.map, m.rev) }); if (!r) return null;
  toast(r.ok ? `수동 진행 시작 · 모든 기기 공유${p.map ? '' : ' · 지도 미확인 · 기록만'}` : `시작 안 됨 · ${r.error}`); return r.ok ? r : null;
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
  toast(r.ok ? `${what} · 기록됨(운영자 기록 · 모든 기기 공유)` : r.code === 409 ? '다른 기기가 먼저 고침 — 최신 값으로 다시 눌러 주세요' : `기록 안 됨 · ${r.error}`);
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
  runEdit(id, (x) => { x.status = status; x.ended = isoNow(); if (memo != null) x.memo = memo.trim().slice(0, 400); }, `임무 ${status}`);
}
/** 빠른 메모 칸: 같은 낱말이 있으면 빼고 없으면 붙임(' · ' 구분, 400자) — live.js tagMemo */
export const tagMemo = (memo: string, t: string) => { const a = memo.split(' · ').filter(Boolean); return (a.includes(t) ? a.filter((x) => x !== t) : [...a, t]).join(' · ').slice(0, 400); };
