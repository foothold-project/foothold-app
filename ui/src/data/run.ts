// 수동 임무 진행·지도 계산 공용 — web/live.js 908·919–921·1124–1136·1170 과 같은 규칙. 자동 이동·자동 완료 없음, 운영자가 눌러 기록.
import type { DocWrite, Mission, Run } from '@contracts';
import { activeRun, docById, docsOf, type Docs, type SaveRes } from './shared';
import { MISSING_T, tmplOf } from './tmpl';
import { toast } from '../app/shell';

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
