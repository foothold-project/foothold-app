// 수동 임무 진행·지도 계산 공용 — web/live.js 908·919–921·1124–1136·1170 과 같은 규칙. 자동 이동·자동 완료 없음, 운영자가 눌러 기록.
import type { DocWrite, Mission, Run, RunWaypoint } from '@contracts';
import { activeRun, docById, docsNow, docsOf, qc, saveDoc, type Docs, type SaveRes } from './shared';
import { ask } from './link';
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
// 계획 스냅샷: 나중에 계획을 고쳐도 이 기록은 그대로
const newRun = (D: Docs, mid: string, m: Mission): Run => ({ mode: '수동', mission: mid, tmpl: tmplOf(D, m.tmpl)!.name.slice(0, 60), name: m.name, status: '진행', started: isoNow(), ended: '', memo: '',
  wps: m.wps.map((w) => ({ x: w.x, y: w.y, name: w.name, mods: w.mods.slice(), st: '대기', at: '', why: '', chk: '', photos: [] })) });
// send: 화면의 editor.write(쓰기 한 번에 하나) — 두 번 눌러 진행 기록이 둘 생기지 않게
export async function startRun(D: Docs, mid: string | null, send: (m: DocWrite) => Promise<SaveRes | null>) {
  const m = docById(D, mid); if (!m || m.kind !== 'mission') { toast('계획을 고르세요'); return null; }
  if (!m.doc.wps.length) { toast('지점이 없는 계획입니다 — 먼저 지점을 추가'); return null; }
  if (!tmplOf(D, m.doc.tmpl)) { toast(MISSING_T); return null; }
  if (activeRun(D)) { toast('진행 중인 수동 임무가 있습니다 — 먼저 끝내세요'); return null; }
  if (!confirm(`«${m.doc.name}» 수동 진행을 시작할까요?\n· 로봇은 자동으로 움직이지 않습니다(직접 조종)\n· 방문·미방문·판단은 운영자가 눌러 기록`)) return null;
  const r = await send({ op: 'put', kind: 'run', id: null, doc: newRun(D, m.id, m.doc) }); if (!r) return null;
  toast(r.ok ? '수동 진행 시작 · 모든 기기 공유' : `시작 안 됨 · ${r.error}`); return r.ok ? r : null;
}

// ---- 진행 기록(live.js 1139–1177) — 운영자가 눌러 기록, 자동 판정 없음 ----
export const curWp = (R: Run) => R.wps.findIndex((w) => w.st === '대기');
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
