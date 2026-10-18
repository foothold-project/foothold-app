// PC 임무 계획(원본 지도·경로·점검 틀 그대로) — web/live.js pagePcPlan 과 같은 규칙.
// 저장은 서버 문서(kind 'mission') · 409/404 에도 초안 유지(editor). «수동 진행 시작»은 기록을 시작할 뿐 로봇을 움직이지 않는다.
// 경로 검사(Nav2)·시간 예측·배터리·도착 반경/방향·자동 후퇴·경보 규칙은 미연결 — 원본 자리에 이유를 둔다.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Mission, PlanStart, Waypoint } from '@contracts';
import { CSS, View } from './PcPlan.view';
import { FLOOR, WF, WORLD, place } from '../data/maps';
import { FINISH, PRESETS, autoName, createWhy, firstSrc, flowTxt, inRaster, keepSrc, mdhm, mkStart, modsTxt, okT, pinRid, presetOf, sGate, sView, srcGate, usePlanTerrain } from './plan2d';
import type { Terr } from './plan2d';
import { memGet, memSet, themeClass } from '../data/fmt';
import { activeRun, docById, docsOf, useDocs } from '../data/shared';
import { useEditor } from '../data/editor';
import { linkView, useLink } from '../data/link';
import { LIVE_MODS, MISSING_T, RULE_WHY, defMods, modDetail, tmplOf, tmpls } from '../data/tmpl';
import { STOP_TIP, WHY, ZONE_NOTE } from '../data/facts';
import { ctx } from '../data/scratch';
import { dupMission, finishText, gtHere, legLen, mapTxt, planEdit, planMap, planOwn, r2, startPolicy, startRun, wkey, zoneTxt, zonesAt } from '../data/run';
import type { Here } from '../data/run';
import { href } from '../data/hist';
import { useDev } from '../data/dev';
import { MapCanvas } from '../map/MapCanvas';
import { LiveStatus } from '../app/status';
import { Chip, Help, LostHelp, popOpen } from '../app/chip';
import { toast, useRoute } from '../app/shell';

// ---- U5-a(v3 §4 PcPlan·§2-5): 지도 출처 운영 표시 — 판정은 gtHere·planMap·startPolicy 결과 그대로, 글만 줄인다(새 추정·자동 승격 0) ----
// 전문(GT·SDF/기하 sha·실패 이유)은 «?» 와 개발자 모드(기존 문구 그대로). 빈 계획 = «첫 점» 준비, 지점 있는 계획 = 계획 출처 대 지금 시작 상태로 구분
export const SRC_NOTE = '출처 일치 = 시뮬 좌표 출처(지도·층·개정 sha)만 대조한 것 — 실제 환경·경로 안전·SLAM 위치 확인이 아님';
/** gtHere 이유의 운영 짧은 글: «좌표 개정 확인 중(GT 기하 …)» → «좌표 개정 확인 중». 다른 이유엔 괄호 없음(그대로) */
export const hereShort = (why: string) => why.split('(')[0].trim();
/** «확인 중» = gtHere 가 GT 기하 파일을 받는 중(G1 대기)일 때만 — 나머지 이유는 «미확인» */
const waiting = (h: Here) => !h.map && h.why.startsWith('좌표 개정 확인 중');
export function srcView(pm: Here | null, h: Here, sp: { block: string | null; map: unknown } | null): { good: boolean; text: string; line: string } {
  const now = (x: Here) => (waiting(x) ? '출처 확인 중 · 기록만' : '출처 미확인 · 기록만');
  if (!pm || !sp) return h.map ? { good: true, text: '첫 점 · 출처 확인됨', line: '지도 · 지점 없음 · 첫 점은 지금 지도 출처로 기록' }
    : { good: false, text: `첫 점 · ${now(h)}`, line: `지도 · 지점 없음 · 지금 ${hereShort(h.why)} · 지금 찍으면 기록만` };
  if (sp.block) return { good: false, text: '지도·층·출처 다름', line: '지도·층·출처 다름 — 시작 안 됨 · 맞는 지도·층에서 시작(열기·편집은 가능)' };
  if (sp.map) return { good: true, text: '출처 일치', line: '지도 · 출처 일치 · 지금 시뮬과 같은 출처' };
  const why = pm.map ? `지금 ${hereShort(h.why ?? "")}` : pm.why.replace(/^출처 미확인\((.*)\)$/, '$1');
  const text = pm.map ? now(h) : '출처 미확인 · 기록만';
  return { good: false, text, line: `지도 · ${text} — ${why} (거리·지도 겹치기 표시 안 함)` };
}

type Tool = 'sel' | 'add' | 'measure' | 'start';   // start = «출발점 지정»(한 번 쓰고 이전 도구로 — ROOT 8)
const HINT = '지도를 누르면 «지점 확인»으로 바로 추가 · 할 일은 줄을 눌러 바꿈 · 끌면 지도 이동';   // UX-SPEC 5-2
const UNDO_MS = 5000;
const S_NOTE = 'S 는 계획 좌표 · 로봇이 그곳에 있는지 측정하지 않음 · 자동 복귀 없음 · 운영자가 직접 조종';   // SPEC 2-4
const GOTO = WHY['자동 목적지 이동·자동 복귀'];
const OV = { display: 'flex', alignItems: 'center', gap: '6px', height: '30px', padding: '0 10px', borderRadius: '6px', background: 'var(--panel)', border: '1px solid var(--line2)', fontSize: '12px' } as const;
const dot = (good: boolean) => <span style={{ color: good ? 'var(--ok)' : 'var(--warn)' }}>{good ? '●' : '▲'}</span>;
const P = ({ t }: { t: string }) => <span style={{ display: 'block', marginTop: 4 }}>{t}</span>;
// ---- 임무 2D(SPEC mission-flow-2d 59dbad0e): 이 화면 전용 클래스(pp-*) · 기존 토큰 색만. 배경막 0(STOP·Space 그대로) ----
const ORDER = ['v5_building', 'v5_single', 'rooms_a'];   // 지형 칸 순서(시안 21a4d069 그대로)
const PCSS = `.pcplan-hdr .card.act{border-color:var(--accent)}
.pcplan-hdr .pp-sel{height:34px;padding:0 8px;border:1px solid var(--line2);border-radius:6px;background:var(--panel2);color:var(--text);font-size:13px}
.pcplan-hdr .pp-sel.first{border-color:var(--accent)}
.pcplan-hdr .pp-cfm{margin:10px 12px;padding:12px 14px;border:1px solid var(--accent);border-radius:10px;background:var(--panel2);display:flex;flex-direction:column;gap:8px}
.pcplan-hdr .pp-row{display:flex;flex-wrap:wrap;gap:6px}
.pcplan-hdr .pp-msg{position:absolute;inset:0;display:grid;place-items:center;text-align:center;color:var(--muted);font-size:14px;padding:16px}
.pcplan-hdr .pp-msg b{display:block;color:var(--text);font-size:15px;margin-bottom:6px}
.pcplan-hdr .pp-band{position:absolute;top:10px;left:50%;transform:translateX(-50%);font-size:12px;background:var(--panel);padding:4px 10px;border-radius:6px;border:1px solid var(--accent);pointer-events:none;white-space:nowrap;max-width:calc(100% - 24px);overflow:hidden;text-overflow:ellipsis}
.pcplan-hdr .pp-foot{display:flex;justify-content:space-between;align-items:center;padding:6px 10px;font-size:12px;color:var(--muted);border-top:1px solid var(--line)}
.pcplan-hdr .pp-seg{display:flex;flex-wrap:wrap;gap:6px}
.pcplan-hdr .pp-seg button{height:32px;padding:0 10px;border:1px solid var(--line2);border-radius:6px;background:var(--panel);color:var(--text);font-size:12px}
.pcplan-hdr .pp-seg button[aria-pressed=true],.pcplan-hdr .pp-seg button[aria-checked=true]{border-color:var(--accent);background:var(--acc-bg);font-weight:600}
.pcplan-hdr .pp-st{padding:12px 16px;border-top:1px solid var(--line);display:flex;flex-direction:column;gap:8px}
.pcplan-hdr .pp-st h3{margin:0;font-size:14px;font-weight:600;display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.pcplan-hdr .pp-st.dim{opacity:.45}
.pcplan-hdr .pp-n{display:inline-grid;place-items:center;width:22px;height:22px;border-radius:50%;border:1.5px solid var(--accent);font-size:12px;color:var(--accent)}
.pcplan-hdr .pp-st.done .pp-n{background:var(--accent);color:var(--on-accent)}
.pcplan-hdr .pp-chain{display:flex;flex-wrap:wrap;gap:6px;align-items:center;font-size:13px}
.pcplan-hdr .pp-chain b{padding:3px 8px;border:1px solid var(--line2);border-radius:6px;background:var(--panel2);font-weight:500;overflow-wrap:anywhere}
.pcplan-hdr .pp-chain i{font-style:normal;color:var(--muted)}
.pcplan-hdr .pp-mode{font-size:12px;color:var(--muted);padding:8px 10px;border:1px dashed var(--line2);border-radius:8px}
.pcplan-hdr .pp-mode b{color:var(--text)}
.pcplan-hdr .pp-list{display:flex;flex-direction:column;gap:6px;padding:8px;border:1px solid var(--line);border-radius:8px;background:var(--panel2);max-height:320px;overflow:auto}
.pcplan-hdr .pp-li{display:flex;flex-direction:column;align-items:flex-start;gap:2px;text-align:left;padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--panel);color:var(--text)}
.pcplan-hdr .pp-li b{overflow-wrap:anywhere}
.pcplan-hdr .pp-li[aria-selected=true]{border-color:var(--accent)}
/* 10-19 ROOT 6~12: 복구 안내·되돌리기(top) · 만들기 띠(mk) · 지도 아래 상태 띠(범례·거리·출처 — 도면 밖) · 구역 링크 */
.pcplan-hdr .pp-top{display:flex;flex-direction:column;border-bottom:1px solid var(--line)}
.pcplan-hdr .pp-rest{display:flex;flex-wrap:wrap;gap:8px;align-items:center;justify-content:space-between;padding:10px 16px;font-size:13px;background:var(--panel2)}
.pcplan-hdr .pp-note{padding:6px 16px;font-size:12px;color:var(--warn)}
.pcplan-hdr .pp-undo{position:relative;display:flex;align-items:center;justify-content:space-between;gap:8px;height:44px;box-sizing:border-box;padding:0 16px;font-size:13px;background:var(--panel2);overflow:hidden}
.pcplan-hdr .pp-undo>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.pcplan-hdr .pp-undo i{position:absolute;left:0;bottom:0;height:2px;width:100%;background:var(--accent);transform-origin:left;animation:pp-undo 5s linear forwards}
@keyframes pp-undo{to{transform:scaleX(0)}}
@media (prefers-reduced-motion:reduce){.pcplan-hdr .pp-undo i{animation:none}}
.pcplan-hdr .pp-mk{border-top:1px solid var(--line);background:var(--panel);padding:10px 16px;display:flex;flex-direction:column;gap:8px;max-height:50dvh;overflow:auto}
.pcplan-hdr .pp-why{font-size:12px;color:var(--warn)}
.pcplan-hdr .pp-dflt{font-size:12px;font-weight:500;padding:1px 6px;border:1px solid var(--line2);border-radius:4px;color:var(--text)}
.pcplan-hdr .pp-band2{display:flex;flex-wrap:wrap;gap:6px 16px;align-items:center;padding:6px 10px;border-top:1px solid var(--line)}
.pcplan-hdr .pp-lg{display:inline-flex;flex-wrap:wrap;gap:4px 16px;align-items:center;font-size:12px;color:var(--text)}
.pcplan-hdr .pp-lg>span{display:inline-flex;align-items:center;gap:4px}
.pcplan-hdr .pp-zlink{font-size:12px;color:var(--accent);text-decoration:underline}
.pcplan-hdr .pp-zlim{font-size:12px;color:var(--text);display:inline-flex;align-items:center}
.pcplan-hdr .wp .nm{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pcplan-hdr .pp-maparea>svg{display:none}   /* 지도 칸 높이는 아래 배치 규칙(시안 svg 비율 0) */
/* 넓은 창(UX-SPEC 5-6): 100dvh · 페이지 스크롤 0 · 오른쪽 열 420 고정 · 단계만 안 스크롤 · 만들기 띠 하단 고정 · 지도 = 남은 높이 */
@media (min-width:1024px) and (min-height:640px){
  .pcplan-hdr{height:100dvh;min-height:0!important;overflow:hidden}
  .pcplan-hdr>div:has(>main){flex-wrap:nowrap!important}   /* UX2FIX(DESIGN P1 main 103..1058): 여러 줄 flex 의 줄 높이 = 내용 높이라 main 이 900 을 넘어 잘림 → 한 줄 = 남은 높이 */
  .pcplan-hdr main{flex-wrap:nowrap!important;align-content:stretch!important;min-height:0;box-sizing:border-box}
  .pcplan-hdr main>section{min-height:0}
  .pcplan-hdr .pp-aside{flex:0 0 420px!important;max-width:none!important;min-height:0}
  .pcplan-hdr .pp-scroll{flex:1 1 auto;min-height:0;overflow-y:auto}
  .pcplan-hdr .pp-mk{flex:0 0 auto}   /* U11FIX(1440 10곳 hit1·30곳 hit0): 띠가 overflow:auto 라 자동 최소 높이 0 → 단계 내용 높이 비율로 같이 줄어 단추가 띠 안 스크롤 밖으로 밀림 → 띠는 줄지 않고 단계 칸만 줄게(높이 상한 50dvh 그대로) */
  .pcplan-hdr .pp-maparea{flex:1 1 0;min-height:0}
}
/* 좁은 창(폭 < 1024 또는 높이 < 640): 지도 → 상태 띠 → 단계 → 만들기 띠(sticky · safe-area) */
@media not all and (min-width:1024px) and (min-height:640px){
  .pcplan-hdr .pp-maparea{height:min(56dvh,420px)}
  .pcplan-hdr .pp-mk{position:sticky;bottom:0;z-index:2;padding-bottom:calc(10px + env(safe-area-inset-bottom))}
}
@media (max-width:640px){
  .pcplan-hdr nav[aria-label="주 메뉴"]{flex:1 1 100%!important;flex-direction:row!important;justify-content:space-around;overflow-x:auto;padding:4px!important;border-right:0!important;border-bottom:1px solid var(--line)}
}`;

export default function PcPlan() {
  const D = useDocs(), L = useLink(), lk = linkView(L), st = L.st, E = useEditor<Mission>('mission', 'PcPlan'), { q, setQ } = useRoute(), dev = useDev((s) => s.on);
  const [tool, setTool0] = useState<Tool>('add'), [wsel, setWsel] = useState<number | null>(null), [meas, setMeas] = useState<number[][]>([]);
  const want = q.get('mission') || '', shown = useRef<string | null>(null);   // shown: 주소에 이미 반영한 id(새로 저장된 id 만 주소에 씀)
  const hNow = gtHere(L);   // 첫 점 w: 후보·시작 정책(startRun 과 같은 함수). 도면 위 로봇 표시에는 쓰지 않음
  const hT: Terr | null = hNow.map && okT(hNow.map) ? { w: hNow.map.world_id, f: hNow.map.floor_id } : null;
  // ROOT 7: 새 임무 기본값 = 종료 «출발점 복귀» + 이름 1회(지형·층 임무 MM-DD HH:mm). 안 고친 기본값은 dirty 0 → 늦은 초안 복원(editor 늦은 ready)을 막지도 덮지도 않음
  // ROOT 5 · UX-SPEC 4: 마지막으로 고른 지형·층(fh.plan.wf = world/floor) — WF 목록에 있을 때만 새 빈 계획의 기본값(없거나 낡으면 기존 규칙 = 지금 시뮬 지형). 저장은 사용자가 고를 때만
  const wfM: Terr | null = (() => { const [w, f] = (memGet('fh.plan.wf') || '').split('/'); return WF[w]?.includes(f) ? { w, f } : null; })(), dT = wfM ?? hT;
  const blank = (t: Terr | null = dT): Mission => ({ name: autoName(t), tmpl: q.get('tmpl') || 'base', memo: '', wps: [], finish: '출발점 복귀' });
  if (!E.d) E.d = blank();   // 문서 읽기 전 첫 그리기용(다시 그리기 없이) · 문맥 폐기(editor load(null)) 뒤 새 빈 계획도 여기서
  const d = E.d, ws = d.wps, run = activeRun(D), len = legLen(ws);
  // ---- 임무 2D: 지형 선택(controlled) — 지점 있는 계획 = 그 계획의 map 지형·층(WF 안일 때만), 출발점만 있는 계획 = S 의 지형·층, 빈 계획 = 고른 값(이 문서 세대에서만) 또는 지금 시뮬 지형 ----
  // 지점이 있는데 map 없음·WF 밖 = 옛 계획 «목록만»(지형을 골라도 옛 점에 연관을 붙이지 않음)
  const [sel, setSel] = useState<(Terr & { gen: number }) | null>(null);
  const [sw, setSw] = useState<{ t: Terr; ph: 'ask' | 'saving' | 'fail'; why?: string; gen: number; n: number } | null>(null);
  const [mv2, setMv2] = useState<{ wp: Waypoint; tok: string } | null>(null);   // 위치 옮기기 대상(번호가 아니라 지점 객체)
  const [ls, setLs] = useState(false);   // R3b: «저장된 임무 열기» 목록
  const swN = useRef(0), editN = useRef(0), ixN = useRef(0), downTok = useRef<number | null>(null);   // ixN: 상호작용 세대(단조 증가) · downTok: 누름 때의 ixN
  const prevTool = useRef<Tool>('add'), fUser = useRef(-1);   // prevTool: «출발점 지정» 뒤 돌아갈 도구 · fUser: 종료 방식을 사용자가 고른(또는 사본 원본에서 온) 문서 세대 — «기본값» 표 끔
  const mT: Terr | null = okT(d.map) ? { w: d.map.world_id, f: d.map.floor_id } : null;
  const sT: Terr | null = d.start && okT(d.start.map) ? { w: d.start.map.world_id, f: d.start.map.floor_id } : null;
  const val: Terr | null = mT ?? (ws.length ? null : sT ?? (sel && sel.gen === E.gen ? { w: sel.w, f: sel.f } : dT));
  const oldOnly = ws.length > 0 && !mT;
  // ---- R3b 저장 관문: ⑤·C0 «이 초안 저장»·409 «최신 판 위에 저장»·404 «새 문서로 저장» 이 모두 E.save 를 부르므로 이 화면의 편집기 객체에만 1회 감쌈 ----
  // 공용 editor 변경 0 · 렌더마다 재래핑 0(E 가 같으면 그대로) · 부르는 순간의 E.id·E.d 로 같은 createWhy(새 문서 = id 없음 = 종료 방식 필수, 기존 id 옛 계획 = 키 없음 허용)
  // 막히면 요청 0 · 초안·안내 상자 그대로 · 짧은 이유 토스트 · null(= 보내지 않음)
  // n = 쓰기 호출 세대(ROOT G2 Undo 경계): 관문을 지나 실제 E.save(⑤·C0·409·404)·E.write(진행 시작)를 부를 때마다 +1 — 결과(성공·409·404·실패)와 무관하게
  // 그 앞의 되돌리기는 영구 무효(busy 가 풀려도 되살아남 0). 관문에서 막힌 저장은 요청 0 이라 세대 그대로.
  const svRef = useRef<{ e: typeof E; val: boolean; n: number } | null>(null);
  if (svRef.current?.e !== E) {
    const raw = E.save, rw = E.write, g = svRef.current = { e: E, val: false, n: 0 };
    E.save = (rev) => { const why = E.d ? createWhy(E.d, !E.id, g.val) : '임무를 읽는 중'; if (why) { toast(why); return Promise.resolve(null); } g.n++; return raw(rev); };
    E.write = (m) => { g.n++; return rw(m); };
  }
  svRef.current!.val = !!val;
  const T2 = usePlanTerrain(val);
  const ras = T2.k === 'ok' && !oldOnly ? T2.ras : null, geo = T2.k === 'ok' ? T2.geo : null;
  const tokBase = `${T2.k === 'ok' ? T2.n : '-'}|${val ? `${val.w}/${val.f}` : '-'}|${E.gen}|${editN.current}`;   // 도면 신원·선택·문서 세대·편집 세대
  const mvOn = mv2 && mv2.tok === tokBase && ws.includes(mv2.wp) ? mv2 : null;   // 수명이 바뀌면 그냥 무효(새 해석 0)
  const gate = val && ws.length ? srcGate(d, val, hNow, geo) : null;
  const mapWhy = !val ? (oldOnly ? '이 계획은 지형 정보가 없음 — 목록만' : '지형을 먼저 고르세요') : !ras ? '도면이 없어 안 됨' : '';
  // ROOT 8 출발점 S: 그릴 수 있나(sView) · 지정/옮기기 막는 이유(도면·다른 도면 S·S 자기 출처 관문·목적지 관문)
  const S = sView(d, val), hasS = S.k !== 'none';
  // PREP-UI R2: 목적지 0곳 + S 있음 = 첫 점 출처를 S 에서 이어받음 → sView ok·sGate 통과한 S 만. 다른 도면·자기 key 불일치·관문 막힘 S = 추가 막음(S 원문 그대로)
  const sSrcWhy = !ws.length && val && S.k !== 'none' ? (S.k === 'other' ? `출발점과 도면이 달라 목적지 추가 불가(${S.why}) · 출발점을 지우면 추가됨` : sGate(S.s, val, hNow, geo) || '') : '';
  const addWhy = mapWhy || gate || sSrcWhy || '';
  const sWhy = mapWhy || (S.k === 'other' ? `도면이 달라 지도에 안 그림 · 옮기기 불가(${S.why})` : '') || (S.k === 'ok' && val ? sGate(S.s, val, hNow, geo) || '' : '') || gate || '';
  // ROOT 9 5초 되돌리기: 같은 문서(gen·id·rev)·같은 편집 세대·같은 문맥(ctx)·저장 중 아님일 때만 — 그 밖엔 옛 snapshot 으로 덮지 않음
  const [ud, setUd] = useState<{ snap: Mission; dirty: boolean; id: string | null; rev: number | null; load: boolean; gen: number; en: number; cn: number; sn: number; txt: string; t: number } | null>(null);
  // 유효 = 같은 문서 세대·편집 세대·문맥·쓰기 세대(sn — 저장/진행 호출 뒤 영구 무효) · 편집이면 id/rev 그대로 · 저장 중 아님 · 실제 경과 5 s 미만(타이머가 백그라운드에서 늦어도 복구 0)
  // 렌더 때와 누를 때 두 번 판정(렌더 뒤 시작된 저장·지난 시간도 막음)
  const udLive = () => ud && ud.gen === E.gen && ud.en === editN.current && ud.cn === ctx.n && ud.sn === svRef.current!.n
    && (ud.load || (ud.id === E.id && ud.rev === E.rev)) && !E.busy && Date.now() - ud.t < UNDO_MS ? ud : null;
  const udOn = udLive();
  useEffect(() => { if (!ud) return; const t = setTimeout(() => setUd(null), Math.max(0, ud.t + UNDO_MS - Date.now())); return () => clearTimeout(t); }, [ud]);

  useEffect(() => {   // 고른 계획을 편집기에 · 다른 기기가 고친 새 판은 깨끗할 때만 반영 · 저장 뒤 주소에 id
    if (want && E.id !== want && !E.dirty) { const x = docById(D, want); if (x) { E.load(x); shown.current = x.id; setWsel(null); return; } }
    // E6c: 저장 중 떠났다 돌아오면 보관 초안은 옛 판·dirty — 서버 새 판 본문이 초안과 정확히 같으면(그 저장이 반영됨) 새 판으로 깨끗하게, 한 글자라도 다르면 초안 보존
    const sc = E.stale(D); if (sc && (!E.dirty || JSON.stringify(sc.doc) === JSON.stringify(E.d))) E.load(sc);
    if (E.id && !E.dirty && E.id !== shown.current) { shown.current = E.id; if (want !== E.id) setQ('mission', E.id); }   // 저장(새 문서)으로 생긴 id 만 — 사용자가 연 주소는 덮지 않음 · 이어 편집 중인 초안(dirty)은 주소를 바꾸지 않음
  });
  useEffect(() => { const f = (e: BeforeUnloadEvent) => { if (E.dirty) e.preventDefault(); }; addEventListener('beforeunload', f); return () => removeEventListener('beforeunload', f); }, [E]);

  const edit = (f: () => void) => { editN.current++; planEdit(E, f); };   // editN: 옮기기·되돌리기 수명(편집 1회마다 무효)
  const setTool = (t: Tool) => { if (t === 'start' && tool !== 'start') prevTool.current = tool; setTool0(t); setMeas([]); setMv2(null); };
  // 문서 세대가 바뀌면(불러오기·새 계획·복제·버리기·문맥 폐기) 선택·옮기기 대기·S 도구는 옛 문서 것 — 비움(되돌리기는 gen 대조로 무효)
  useEffect(() => { setWsel(null); setMv2(null); setTool0((t) => (t === 'start' ? prevTool.current : t)); }, [E.gen]);
  // 되돌리기 기록: load = 문서를 바꾸는 동작(초안 버리기 — 바뀐 뒤 gen 을 잡음), 아니면 편집(바뀐 뒤 editN 을 잡음)
  const withUndo = (txt: string, f: () => void, load = false) => {
    const snap = structuredClone(d), dirty = E.dirty, id = E.id, rev = E.rev; f();
    setUd({ snap, dirty, id, rev, load, gen: E.gen, en: editN.current, cn: ctx.n, sn: svRef.current!.n, txt, t: Date.now() });
  };
  const undo = () => {
    const u = udLive(); setUd(null); if (!u) return;
    if (u.load) { E.load(u.id ? { id: u.id, rev: u.rev!, doc: u.snap } : null, u.snap); shown.current = E.id; E.dirty = u.dirty; E.touch(); return; }   // id/rev 그대로 → 저장은 기존 409·404·CAS
    edit(() => { E.d = structuredClone(u.snap); }); if (!u.dirty) { E.dirty = false; E.touch(); }   // 같은 자리·같은 출처(map·start·finish 전부 snapshot)
  };
  // Esc(UX-SPEC 5-2 · ROOT CODEX-G3 R2): 하나씩 — ① 열린 도움말·«상태» 패널이 먼저(그 패널만 닫힘 · popOpen) ② 위치 옮기기 대기 취소(점 원래 자리)
  // ③ «출발점 지정» 도구 끄기(S 그대로) ④ 지형 전환 패널 취소(715 N2 — 저장 중은 무시 · swN++ 로 그 요청 폐기) ⑤ 줄 선택 해제. 확정점 삭제 0 · STOP·Space 무관(전파 막기 0)
  const swEsc = !!sw && sw.gen === E.gen && sw.ph !== 'saving';
  const escR = useRef<(e: KeyboardEvent) => void>(() => {});
  escR.current = (e) => {
    if (e.key !== 'Escape' || e.isComposing || popOpen()) return;
    if (mvOn) return setMv2(null);
    if (tool === 'start') return setTool(prevTool.current);
    if (swEsc) { swN.current++; return setSw(null); }
    if (wsel !== null) setWsel(null);
  };
  useEffect(() => { const f = (e: KeyboardEvent) => escR.current(e); addEventListener('keydown', f); return () => removeEventListener('keydown', f); }, []);
  // 새 빈 계획 + 고른 지형(옛 rid·지점·S 를 들고 가지 않음)
  const fresh = (t: Terr) => {
    E.load(null, blank(t)); shown.current = E.id; setWsel(null); setMv2(null); swN.current++; setSw(null);
    setSel({ ...t, gen: E.gen }); memSet('fh.plan.wf', `${t.w}/${t.f}`); if (want) setQ('mission', '');
  };
  // 지형·층 바꾸기(경계 6): 미저장 = 페이지 안 패널(배경막 0) · 저장됨 = 확인 없이 새 계획 · 빈 새 계획 = 선택만
  const pick = (t: Terr) => {
    if (val && val.w === t.w && val.f === t.f) return;
    if (E.busy || sw?.ph === 'saving') return;
    if (!E.dirty && !ws.length && !mT && !d.start) { setSel({ ...t, gen: E.gen }); memSet('fh.plan.wf', `${t.w}/${t.f}`); setMv2(null); return; }   // S 만 있어도 수정 있음 = 패널(SPEC 2-3)
    if (!E.dirty) return fresh(t);
    setMv2(null); setSw({ t, ph: 'ask', gen: E.gen, n: ++swN.current });
  };
  const swCancel = () => { swN.current++; setSw(null); };
  const swSave = async () => {
    if (!sw || sw.ph === 'saving') return;
    const { t, n } = sw, g0 = E.gen;
    setSw({ t, ph: 'saving', gen: g0, n });
    const r = await save();
    if (swN.current !== n) return;   // 그사이 취소·다른 전환
    // 같은 주인(gen)·같은 전환 요청·저장 성공·다른 문서 아님·저장 중 편집 없음일 때만. 나중 재저장(409 상자 등) 성공으로 이 전환을 되살리지 않음
    if (r && r.ok && !r.other && E.gen === g0 && !E.dirty) return fresh(t);
    swN.current++;
    if (r === false) return setSw({ t, ph: 'ask', gen: g0, n: swN.current });   // 이름·지점 검사 실패(토스트·초점) — 패널 그대로
    const why = !r ? '▲ 저장 못 함 · 이미 저장 중 — 지금 계획·지형 그대로' : r.other ? '▲ 저장 못 함 · 다른 문서로 바뀜 — 지금 계획·지형 그대로'
      : r.ok ? '저장 중 수정됨 · 바꾸지 않음' : `▲ 저장 못 함 · ${r.error || (r.code === 409 ? '다른 기기가 먼저 고침' : `코드 ${r.code}`)} — 지금 계획·지형 그대로`;
    setSw({ t, ph: 'fail', why, gen: g0, n: swN.current });
  };
  const openPlan = (id: string) => {
    if (E.dirty && !confirm('저장 안 한 수정이 있습니다. 버릴까요?')) return;
    E.load(docById(D, id) || null, blank(val)); shown.current = E.id; setWsel(null); setLs(false); setQ('mission', id);
  };
  // 누름 수명(715 R1 P1): 도면·선택·문서·편집·도구·임시/옮기기·전환 패널 값(tapTok)이 렌더에서 바뀔 때마다 ixN 을 올림(단조) —
  // 누름 때 ixN 과 뗄 때 ixN 이 다르면 탭 무시. 값 비교가 아니라 세대라 add→sel→add 처럼 처음 값으로 돌아와도 취소된다
  const tapTok = `${tokBase}|${tool}|${mvOn ? 'm' : ''}${sw ? 's' : ''}`;
  useLayoutEffect(() => { ixN.current++; }, [tapTok]);   // commit 직후(다음 입력 이벤트 전)
  const onDown = () => { downTok.current = ixN.current; };
  const onTap = (x: number, y: number, k: number) => {
    if (downTok.current !== ixN.current) return; downTok.current = null;
    const X = r2(x), Y = r2(y);
    if (mvOn) {   // 위치 옮기기: 짧게 누름 1회 → «선택» 도구로. 도면 밖·비유한 = 거절(clamp 0) · rid 근거 불일치 = 막음
      const wp = mvOn.wp; setMv2(null);
      if (!ras || !val || !inRaster(ras, X, Y)) return toast('도면 밖 · 옮기지 않음');
      const g = srcGate(d, val, hNow, geo); if (g) return toast(g);
      edit(() => keepSrc(d, val, () => { wp.x = X; wp.y = Y; })); setTool('sel'); setWsel(ws.indexOf(wp));
      return;
    }
    if (mv2) return setMv2(null);
    if (tool === 'start') {   // ROOT 8: 한 번 누름 = S(창 0) → 이전 도구로. 도면 밖 = 안 찍힘(clamp 0) · 다른 도면 S·출처 불일치 = 막음(옛 S 그대로)
      if (sWhy) return toast(sWhy);
      if (!ras || !val) return;
      if (!inRaster(ras, X, Y)) return toast('도면 밖 · 출발점 안 찍힘');
      const now = firstSrc(val, hNow, geo), old = d.start;   // 새 S = 목적지 첫 점과 같은 firstSrc · 옮기기 = 옛 S 출처에서 낮추기만(pinRid — 승격 0)
      edit(() => { d.start = mkStart(X, Y, old ? pinRid(old.map, now) : now); });
      return setTool(prevTool.current);
    }
    if (tool === 'add') {   // ROOT 6: 짧게 누름 = «지점 확인» 즉시 확정(팝오버 0) · 할 일은 펼친 줄 프리셋에서. 첫 점 map = 지금 firstSrc, 이어 붙이기 = keepSrc
      if (addWhy) return void toast(addWhy);   // 막힌 이유를 누른 자리에서 알림(조용한 무시 0)
      if (!ras || !val) return;
      if (ws.length >= 30) return toast('목적지는 30곳까지');
      if (!inRaster(ras, X, Y)) return toast('도면 밖 · 안 찍힘');
      const mods = LIVE_MODS.filter((m) => PRESETS[0].mods.includes(m));
      edit(() => {
        // 첫 점: 유효 S 가 있으면 S.map 의 world/floor/rid 유무 그대로 + key 만 wkey(wps) — 늦게 성공한 기하로 rid 승격 0(S 와 목적지 기준 같음). 없으면 지금 firstSrc
        if (!d.wps.length) { d.wps.push({ x: X, y: Y, name: '', mods }); d.map = { ...(S.k === 'ok' ? structuredClone(S.s.map) : firstSrc(val, hNow, geo)), key: wkey(d.wps) }; }
        else keepSrc(d, val, () => { d.wps.push({ x: X, y: Y, name: '', mods }); });
      }); setWsel(d.wps.length - 1);
    }
    else if (tool === 'measure') { if (ras) setMeas((m) => (m.length >= 2 ? [[X, Y]] : [...m, [X, Y]])); }
    else { const i = ws.findIndex((w) => Math.hypot(w.x - x, w.y - y) * k < 16); setWsel(i < 0 ? null : i); }
  };
  // R02-C0: 주소가 가리키는 문서(want)와 편집 중 초안이 다를 때 — 둘 다 이름으로 알리고, 사용자가 고르게(주소·서버 판은 그대로)
  const asked = want ? docById(D, want) : null, mine = E.id ? docById(D, E.id) : null;
  const c0 = want && E.dirty && E.id !== want ? (
    <div className="lv-warnbox" role="alert" data-c0="1">
      <span>{`요청한 문서 «${asked?.kind === 'mission' ? asked.doc.name || '이름 없음' : '찾지 못함'}»와 다른 문서의 초안을 편집 중: «${d.name || '이름 없음'}»(${E.id ? `${mine?.kind === 'mission' ? `«${mine.doc.name}» ` : ''}판 ${E.rev}` : '새 문서'}) · 저장 안 됨`}</span>
      <div className="lv-row">
        <button type="button" className="lv-btn pri" disabled={E.busy} onClick={() => { const nm = d.name; E.save().then((r) => { if (r?.ok) toast(E.dirty ? `초안 판 ${r.rev} 저장됨 · 저장 중 고친 내용은 아직 저장 안 됨 — 요청한 문서로 옮기지 않음` : `초안 «${nm || '이름 없음'}» 저장됨 · 판 ${r.rev} — 요청한 문서를 엽니다`); /* dirty 면 effect 도 옮기지 않음(새 편집 보존) */ }); }}>이 초안 저장</button>
        <button type="button" className="lv-btn" disabled={E.busy} onClick={() => { E.load(asked?.kind === 'mission' ? asked : null, blank(val)); shown.current = E.id; setWsel(null); }}>초안 버리고 요청 문서 열기</button>
      </div>
    </div>) : null;
  const dup = () => {   // 저장된 판을 복제(초안 아님) → 새 문서 초안. 원본·주소의 원본 id 는 건드리지 않음
    const src = E.id ? docById(D, E.id) : null; if (!src || src.kind !== 'mission') return toast('저장된 계획을 먼저 고르세요');
    if (E.dirty && !confirm('저장 안 한 수정이 있습니다. 버리고 저장된 판을 복제할까요?')) return;
    E.load(null, dupMission(src.doc)); E.dirty = true; shown.current = null; setWsel(null); setQ('mission', '');
    if (E.d!.finish) fUser.current = E.gen; else E.d!.finish = '출발점 복귀';   // ROOT 7: 사본은 원본 finish·S 그대로 · 원본에 finish 없을 때만 기본값(«기본값» 표)
    toast(`«${src.doc.name}» 사본 초안 — 고친 뒤 저장하면 새 계획(원본 그대로)`);
  };
  const toZone = () => {   // R3b: 진입 금지·감속 = 오른쪽 끝 보조 단추 하나(지도 화면에서 그림)
    if (st?.role === 'control') return toast('조종 중입니다 — 조종권 반납 뒤 지도 화면으로');
    if (E.dirty) toast('저장 안 한 계획은 이 탭에 보관 — 계획 화면으로 돌아오면 이어서 편집');   // R02: 버리지 않음(확인창 대신 보관)
    location.hash = href('PcMap', {});
  };
  const loadPrev = () => {
    const r = docsOf(D, 'run')[0]; if (!r) return toast('지난 수동 진행 기록이 없습니다');
    if (ws.length && !confirm(`지금 지점 ${ws.length}개를 «${r.doc.name}» 기록의 지점 ${r.doc.wps.length}개로 바꿀까요?`)) return;
    edit(() => {   // 가져온 좌표는 그 기록의 출처를 그대로(지금 연결로 다시 붙이지 않음) — 기록에 유효한 출처가 없으면 미확인
      d.wps = r.doc.wps.slice(0, 30).map((w) => ({ x: w.x, y: w.y, name: w.name, mods: w.mods.slice() }));
      const b = planMap(r.doc); if (b.map && b.map.key === wkey(d.wps)) d.map = { ...b.map }; else delete d.map;
    }); setWsel(null);
  };
  // 순서·삭제: rid 있음/목록만 = 기존 rekey 그대로, rid 없는 연관 = 지역 keepSrc(경계 5)
  const mv = (i: number, s: number) => { const j = i + s; if (j < 0 || j >= ws.length) return; edit(() => keepSrc(d, val, () => { [ws[i], ws[j]] = [ws[j], ws[i]]; })); setWsel(j); };
  // false = 이름·지점 검사에서 멈춤(토스트·초점) · 그 밖 = E.save 결과(null = 이미 저장 중 또는 저장 관문에서 막힘)
  const save = async () => {
    const why = createWhy(d, !E.id, !!val);   // R3b: ⑤ 막힘과 같은 검사 · ③ 은 새 임무(사본 포함)만
    if (why) { if (!d.name.trim()) document.getElementById('pname')?.focus(); toast(why); return false as const; }
    ws.forEach((w, i) => { if (!w.name.trim()) w.name = `지점 ${i + 1}`; });
    return E.save();
  };
  const start = async (e?: React.MouseEvent<HTMLElement>) => {
    if (run) { location.hash = href('Main'); return; }
    const from = e?.currentTarget;   // P2-B: 연 단추(이벤트 처리 중에만 유효 — await 전에 잡음)
    let same = true;   // 응답 사이 다른 계획을 열었거나 고쳤으면 화면은 그대로(초안 보존), 결과만 알림
    // E1: 확인창 사이 이탈(unmount)·다른 계획·복제(gen 오름)·같은 계획 수정(dirty) → 쓰기 0. 확인 직후 대조(E.write 가 새 gen 을 잡아 옛 확인을 살리지 않게)
    const r = await startRun(D, E.id, async (m) => { const w = await E.write(m); if (w) same = w.same; return w && w.r; }, { ...planOwn(E), anchor: from });
    if (!r) return;
    if (same && !E.dirty) location.hash = href('Main'); else toast('수동 진행은 시작됨 · 모든 기기 공유 — 그사이 화면·계획이 바뀌어 자동으로 옮기지 않음(관제에서 기록)');
  };

  // ---- 경로 목록(원본 .wp 줄) ----
  const T = tmplOf(D, d.tmpl);
  const rows = ws.map((w, i) => {
    const head = [<span key="h" aria-hidden="true" style={{ color: 'var(--muted)' }}>⋮⋮</span>];
    const dist = <span key="m" className="mono lbl">{!i ? '' : ras ? `${i}→${i + 1} ${Math.hypot(w.x - ws[i - 1].x, w.y - ws[i - 1].y).toFixed(1)} m` : '—'}</span>;   // R3b: 지점 사이 직선만 · 도면 없음·목록만 = 표시 안 함
    if (i !== wsel) {
      const zin = zonesAt(D, w.x, w.y).length;
      return <div key={i} className="wp" style={{ cursor: 'pointer' }} tabIndex={0} onClick={() => setWsel(i)} onKeyDown={(e) => { if (e.key === 'Enter') setWsel(i); }}>
        {head}<span className="num mono">{i + 1}</span>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', minWidth: 0 }}>
          <span className="nm" title={w.name || undefined} style={{ fontSize: '13px', fontWeight: 600 }}>{w.name || `지점 ${i + 1}`}</span>
          <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
            <span className="act">{modsTxt(w.mods)}</span>
            {zin ? <span className="act">{`▲ ${zoneTxt(D, w.x, w.y)}`}</span> : null}
          </div>
        </div>{dist}
      </div>;
    }
    // M7(10-18): 도착 판정 반경·방향 읽기 전용 «미연결» 칸 삭제 — 자동 도착처럼 보임. 도착 = 운영자 «방문 확인»(관제) 그대로
    const sb = (t: string, f: () => void, lab?: string) => <button type="button" className="btn sm" aria-label={lab} onClick={f}>{t}</button>;
    return <div key={i} className="wp sel" style={{ gridTemplateColumns: '18px 28px 1fr auto' }}>
      {head}<span className="num mono" style={{ background: 'var(--accent)', color: 'var(--on-accent)' }}>{i + 1}</span>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', minWidth: 0 }}>
        <input className="inp" value={w.name} maxLength={40} placeholder={`지점 ${i + 1} 이름`} aria-label={`지점 ${i + 1} 이름`} onChange={(e) => edit(() => { w.name = e.target.value; })} />
        <span className="lbl">할 일</span>
      </div>{dist}
      <div style={{ gridColumn: '2 / -1', display: 'flex', flexDirection: 'column', gap: '8px', paddingTop: '4px' }}>
        {/* 프리셋 3(aria-pressed) — 집합이 정확히 같을 때만 눌림. 옛 조합은 «기존 조합 · …»으로 보이고 누르기 전엔 바꾸지 않음(정규화 0) */}
        <div className="pp-seg" role="group" aria-label={`지점 ${i + 1} 할 일`}>
          {PRESETS.map((p) => <button key={p.name} type="button" aria-pressed={presetOf(w.mods) === p} onClick={() => edit(() => { w.mods = LIVE_MODS.filter((m) => p.mods.includes(m)); })}>{p.name}</button>)}
        </div>
        {presetOf(w.mods) ? null : <span className="lbl">{modsTxt(w.mods)}</span>}
        <span className="lbl">{w.mods.length ? w.mods.map((ty) => `${ty} · ${modDetail(D, d.tmpl, ty)}`).join(' / ') : '이동만'}</span>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', gridColumn: '1/-1' }}>
        {sb('↑', () => mv(i, -1), '위로')}{sb('↓', () => mv(i, 1), '아래로')}
        <button type="button" className="btn sm" aria-pressed={mvOn?.wp === w} disabled={!!addWhy} title={addWhy || '누른 뒤 지도에서 옮길 곳을 한 번 누르세요'}
          onClick={() => { if (tool === 'start') setTool(prevTool.current); setMv2(mvOn?.wp === w ? null : { wp: w, tok: tokBase }); }}>위치 옮기기</button>
        {sb('삭제', () => { withUndo(`지점 ${i + 1} «${w.name.trim() || `지점 ${i + 1}`}» 삭제함`, () => edit(() => keepSrc(d, val, () => { ws.splice(i, 1); }))); setWsel(null); })}{sb('선택 해제', () => setWsel(null))}
      </div>
    </div>;
  });
  // 출발점 S 는 목적지 목록과 따로(② 카드) — 종료 방식은 ④ 단추 · 흐름은 ⑤ 글
  const rList = ws.length ? <>{rows}<span className="lbl">{ras && !addWhy ? `${HINT} · 줄을 누르면 이름·할 일·위치 옮기기·순서·삭제` : '줄을 누르면 이름·할 일·위치 옮기기·순서·삭제'}</span></>
    : <span className="lbl">{!val ? (oldOnly ? '이 계획은 지형 정보가 없음 — 목록만' : '① 지형을 먼저 고르세요') : !ras ? '도면이 열리면 지도를 눌러 목적지 추가' : addWhy || `${HINT} · 최대 30`}</span>;

  // ---- 출발 전 점검: 막는 것은 «진행 중 임무 없음»·«계획 저장됨»뿐(기록을 시작할 뿐 로봇을 움직이지 않음) ----
  // G1: 빈 계획에서도 매번 지금 지도를 판정 — 연결 건물이면 첫 점 전에 GT 기하를 받아 둠(받는 중/확인됨/미확인을 지도 칩에 표시)
  const pm = ws.length ? planMap(d) : null, sp = ws.length ? startPolicy(d, hNow) : null;   // 좌표 출처·시작 정책(startRun 과 같은 함수)
  // 임무 2D: 빈 계획의 «첫 점» 표시 = 첫 누름이 실제로 붙일 출처(onTap 첫 점과 같은 갈래) — 기존 srcView 문구에 그 결과를 넘김(새 판정 0)
  // CODEX-G2 R2: 유효 S = S.map 그대로(rid 없으면 «출처 미확인 · 기록만» 유지 — 늦게 온 기하·w: 로 «확인됨» 표시 0) · S other/관문 막힘 = 추가 막힘(«찍으면 기록만» 안내 0) · S 없음 = 지금 firstSrc
  const sInh = !ws.length && !sSrcWhy && S.k === 'ok';
  const fp = !ws.length && val && !sSrcWhy ? (sInh ? S.s.map : firstSrc(val, hNow, geo)) : null, geoWhy = val?.w === 'v5_building' && geo && 'why' in geo ? geo.why : null;
  const fpHere: Here = fp?.rid ? { map: fp } : { why: !val ? '지형 미선택' : sSrcWhy ? sSrcWhy : sInh ? '출발점 S 출처 미확인(첫 지점은 S 기준 그대로 · 좌표 개정 기록 없음)'
    : val.w !== 'v5_building' ? (hNow.map ? '시뮬 지형·층이 선택과 다름' : hNow.why)
    : geoWhy ? `좌표 개정 미확인(기하 파일 · ${geoWhy})` : T2.k === 'loading' ? '좌표 개정 확인 중(기하 파일 받는 중)' : '좌표 개정 미확인(도면·기하 파일 없음)' };
  const firstTxt = fpHere.map ? `첫 지점 결속 준비됨 · ${mapTxt(fpHere.map)}${sInh ? ' · 출발점 S 와 같은 기준' : ''}`
    : sSrcWhy ? `첫 지점 추가 막힘 · ${sSrcWhy}` : `지금 ${fpHere.why} · 지금 찍으면 기록만`;
  const linkGood = lk.linkOk && !st?.sim_block, posTxt = lk.fresh ? '시뮬 위치 수신' : lk.robot ? '시뮬 위치 오래됨' : '시뮬 위치 미수신';
  // U5-a: 지도 칩·점검 줄 — 운영 = srcView 짧은 글 + ?(기존 전문·SRC_NOTE), 개발자 모드 = 기존 문구 그대로
  const sv = !pm && sSrcWhy ? { good: false, text: '첫 점 · 추가 막힘', line: `지도 · 지점 없음 · 첫 지점 추가 막힘 — ${sSrcWhy}` } : srcView(pm, pm ? hNow : fpHere, sp), oldChip = !pm ? firstTxt : pm.map ? mapTxt(pm.map) : `미확인 · ${pm.why}`, oldLine = sp ? sp.block || sp.line : `지도 · 지점 없음 · ${firstTxt}`;
  const srcHelp = <Help label="지도 출처 · 설명"><span style={{ display: 'block' }}>{oldChip}</span>{sp ? <P t={oldLine} /> : null}<P t={SRC_NOTE} /></Help>;
  const batHelp = <Help label="배터리 · 설명">{WHY['배터리']}</Help>;
  const cks: [boolean, string, 1?, React.ReactNode?][] = [[linkGood, `로봇 링크 · ${lk.linkTxt}`], [lk.fresh, `위치 · ${posTxt}`],
    [lk.camOk, `영상 · ${lk.camTxt}`], [false, '배터리 · 값 없음', undefined, batHelp],
    [!run, run ? `진행 중 수동 임무 «${run.doc.name}» — 먼저 끝내기` : '진행 중 수동 임무 없음', 1],
    [!!sp?.map, dev ? oldLine : sv.line, sp?.block ? 1 : undefined, dev ? undefined : srcHelp],
    [!!(E.id && !E.dirty && ws.length), !E.id ? '계획 저장 · 아직 저장 안 됨' : E.dirty ? '계획 저장 · 저장 안 한 수정 있음' : `계획 저장됨 · 지점 ${ws.length}개`, 1],
    ...(T ? [] : [[false, `임무 양식 · ${MISSING_T}`, 1] as [boolean, string, 1]])];   // 누락 양식은 기본으로 대신하지 않고 막음
  const block = cks.filter((c) => c[2] && !c[0]).map((c) => c[1]);
  const inZ = ws.map((w, i) => (zonesAt(D, w.x, w.y).length ? `WP${i + 1} ${zoneTxt(D, w.x, w.y)}` : null)).filter(Boolean);
  const zoneWarn = inZ.length > 0 && tool !== 'measure';
  // 임무 2D: 추가 = 지형·도면·rid 근거 필요, 거리 재기 = 도면 필요(꺼짐 + 이유 title). 선택은 늘 가능
  const tp = (t: Tool) => { const why = t === 'add' ? addWhy : t === 'measure' ? mapWhy : '';
    return { 'aria-pressed': String(tool === t && !why) as 'true' | 'false', disabled: !!why, title: why || undefined, onClick: () => setTool(t) }; };
  const plc = val ? place(val.w, val.f) : '';
  const OVW = { ...OV, height: 'auto', minHeight: '30px', flexWrap: 'wrap' as const };   // 계획 기준 칩은 문구가 길어 줄바꿈 허용
  const basis = ws.length ? d.map : fp;   // 계획 기준(빈 계획 = 첫 점에 붙을 값 미리보기)
  const bTxt = gate || (basis?.rid ? `계획 기준 = ${basis.rid[0] === 'g' ? '기하 파일' : '실행 world'} · 시뮬 대조는 시작 때` : '출처 미확인 · 기록만');
  const bHelp = gate ? '이 계획의 좌표 기준과 지금 근거가 맞지 않아 추가·옮기기를 막음 · 기존 기준은 지우거나 바꾸지 않음 · 이름·할 일·순서·삭제는 목록에서'
    : basis?.rid ? '계획 좌표의 기준만 적음 · 지금 시뮬과의 대조는 «수동 진행 시작» 때 · 도면 그림과 같은 판이라는 뜻 아님'
    : `좌표 개정 기록이 없어 관제 겹치기·거리 대조를 하지 않음 · 다른 지형 시뮬에서도 시작이 막히지 않으니 지형을 확인하고 시작${geoWhy ? ` · 기하 파일을 받지 못함: ${geoWhy}` : ''}`;
  const msgEl = !val ? (oldOnly ? <div><b>이 계획은 지형 정보가 없음 — 목록만</b>이름·할 일·순서·삭제는 오른쪽 목록에서</div>
      : <div><b>① 오른쪽에서 지형을 고르세요</b>고르면 그 지형의 2D 도면이 열립니다 · 시뮬은 바뀌지 않음</div>)
    : T2.k === 'nolink' ? <div><b>지도 목록을 받을 수 없음</b>연결 확인 안 됨</div>
    : T2.k === 'nomap' ? <div><b>이 지형·층에 2D 도면 없음</b>다른 층·지형 지도로 대신 열지 않음{ws.length ? <><br />저장된 지점은 오른쪽 목록에만 · 지도 위 표시 0</> : null}</div>
    : T2.k === 'fail' ? <div><b>도면을 받지 못함</b>{T2.why}<br /><br /><button type="button" className="btn sm" style={{ display: 'inline-flex' }} onClick={T2.retry}>다시 읽기</button></div>
    : <div><b>{`${plc} 도면 읽는 중…`}</b></div>;
  const swOn = sw && sw.gen === E.gen ? sw : null, swBusy = swOn?.ph === 'saving';
  const terrSel = (
    <>
      <select className={`pp-sel${!val && !oldOnly ? ' first' : ''}`} data-pop-avoid="1" aria-label="지형" value={val?.w ?? ''} disabled={swBusy || E.busy}
        onChange={(e) => { const w = e.target.value; if (WF[w]) pick({ w, f: WF[w][0] }); }}>
        {val ? null : <option value="">지형 고르기</option>}
        {ORDER.map((w) => <option key={w} value={w}>{(WORLD as Record<string, string>)[w]}</option>)}
      </select>
      {val && WF[val.w].length > 1 ? <select className="pp-sel" aria-label="층" value={val.f} disabled={swBusy || E.busy} onChange={(e) => pick({ w: val.w, f: e.target.value })}>
        {WF[val.w].map((f) => <option key={f} value={f}>{(FLOOR as Record<string, string>)[f] || f}</option>)}
      </select> : null}
    </>);
  const cfm = swOn ? (
    <div className="pp-cfm" role="region" aria-label="지형 바꾸기 확인">
      <b>{ws.length ? (val ? `지점 ${ws.length}개는 «${plc}» 기준입니다` : `지점 ${ws.length}개는 지형 정보 없는 계획입니다`) : d.start && val ? `출발점 S 는 «${plc}» 기준입니다` : '저장 안 한 수정이 있습니다'}</b>
      <span className="lbl">다른 지형·층에서는 새 계획으로 엽니다. 지금 지점은 옮기지 않습니다.</span>
      {swOn.ph === 'fail' ? <span className="lbl" role="alert" style={{ color: 'var(--warn)' }}>{swOn.why}</span> : null}
      <div className="pp-row">
        <button type="button" className="btn" disabled={swBusy} onClick={swCancel}>취소</button>
        <button type="button" className="btn" disabled={swBusy} onClick={() => fresh(swOn.t)}>저장하지 않고 바꾸기</button>
        <button type="button" className="btn pri" disabled={swBusy} aria-busy={swBusy || undefined} onClick={swSave}>{swBusy ? '저장 중…' : '저장하고 바꾸기'}</button>
      </div>
    </div>) : null;
  const mvI = mvOn ? ws.indexOf(mvOn.wp) : -1;
  const band = mvOn ? `${mvI + 1}번 지점 · 옮길 곳을 누르세요 · Esc 취소` : ras && tool === 'start' && !sWhy ? '도면을 한 번 누르면 출발점 S · 끌면 지도 이동 · Esc = 취소'
    : ras && tool === 'add' && !addWhy ? '끌면 지도 이동 · 짧게 누르면 «지점 확인» 추가' : '';
  const over = band ? <span className="pp-band">{band}</span> : null;
  // ROOT 12 · UX-SPEC 5-7: 구역 = 지도 탭 링크(단추 모양 0) + 한계를 밖에(? = ZONE_NOTE 원문)
  const zLim = <span className="pp-zlim">표시만 · 주행 제한 미연결<Help label="구역 · 설명">{ZONE_NOTE}</Help></span>;
  const zone = <><a className="pp-zlink" href={href('PcMap', {})} title={`진입 금지·감속 구역은 지도 화면에서 그립니다(${WHY['구역 주행 제한(피하기·감속)']})`} onClick={(e) => { e.preventDefault(); toZone(); }}>구역 그리기 · 지도 탭 →</a>{zLim}</>;
  // UX-SPEC 3-4 범례(지도 아래 띠 · 도면 밖): 이 화면이 실제로 그리는 표식만(로봇 0 — noRobot)
  const zs = D.err ? [] : docsOf(D, 'zone'), zBan = zs.some((z) => z.doc.type === '금지'), zSlow = zs.some((z) => z.doc.type !== '금지');
  const lg = (svg: React.ReactNode, t: string) => <span key={t}><svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">{svg}</svg>{t}</span>;
  const legend = ras ? <span className="pp-lg" aria-label="지도 범례">
    {ws.length ? lg(<circle cx="7" cy="7" r="5.5" fill="none" stroke="var(--accent)" strokeWidth="1.5" />, '목적지 번호') : null}
    {S.k === 'ok' ? lg(<rect x="1.5" y="1.5" width="11" height="11" rx="3" fill="var(--text)" />, '출발점 S') : null}
    {zBan ? lg(<rect x="1.5" y="1.5" width="11" height="11" fill="var(--bad)" fillOpacity=".18" stroke="var(--bad)" strokeWidth="1.5" />, '진입 금지 구역') : null}
    {zSlow ? lg(<rect x="1.5" y="1.5" width="11" height="11" fill="var(--warn)" fillOpacity=".18" stroke="var(--warn)" strokeWidth="1.5" />, '감속 구역') : null}
    {zBan || zSlow ? zLim : null}</span> : null;
  const opt = (b: string, extra: string, lbl: React.ReactNode, on: boolean) => (
    <label className={`opt${on ? ' on' : ''}`}><input type="radio" name="lost" checked={on} disabled readOnly /><span><b>{b}</b>{extra}<br /><span className="lbl">{lbl}</span></span></label>);

  // ---- 단계 열 ①~⑥(UX-SPEC 5-1 · ROOT 7·8) — 마법사 단추 0 · 모든 단계가 늘 보이고 앞 단계가 비면 흐림 · ② 출발점은 선택(막지 않음) ----
  // 새 임무 = 아직 id 없음(사본 포함) — ④ 는 새 임무만 요구. 원본 id 있는 옛 임무는 키 없음 그대로 저장(채움·추정 0)
  const isNew = !E.id, cw = createWhy(d, isNew, !!val), flow = flowTxt(ws, d.finish, hasS), fin = FINISH.find((f) => f.v === d.finish);
  const dflt = isNew && d.finish === '출발점 복귀' && fUser.current !== E.gen;   // «기본값» 표: 사용자가 고르기 전(사본 원본 값이면 표 0)
  const stp = (n: number, title: React.ReactNode, done: boolean, dimmed: boolean, body: React.ReactNode) => (
    <div className={`pp-st${done ? ' done' : ''}${dimmed ? ' dim' : ''}`} data-step={n}><h3><span className="pp-n">{n}</span>{title}</h3>{body}</div>);
  const xy = (p: PlanStart) => `X ${p.x.toFixed(2)} m · Y ${p.y.toFixed(2)} m`;
  const sBtn = (t: string) => <button type="button" className="btn sm" aria-pressed={tool === 'start'} disabled={!!sWhy} title={sWhy || '누른 뒤 도면을 한 번 누르세요 · Esc = 취소'}
    onClick={() => setTool(tool === 'start' ? prevTool.current : 'start')}>{t}</button>;
  const sCard = S.k === 'none' ? <>
      <span>{isNew ? '출발점 · 지정 안 함(선택)' : '출발점 좌표 없음 · 지정 안 함(선택)'}<Help label="출발점 · 설명">지도에 계획 출발점을 찍어 둘 수 있습니다 · 실제 로봇 위치 아님 · 안 찍어도 임무를 만들 수 있습니다</Help></span>
      <div className="pp-row">{sBtn('출발점 지정')}</div></>
    : <>
      <span><b>S</b>{` 출발점 · ${xy(S.s)}`}</span>
      {S.k === 'ok' ? <span className="lbl">지도에 찍은 계획 위치 · 실제 로봇 위치 아님<Help label="출발점 S · 설명">{S_NOTE}</Help></span>
        : <span className="lbl" style={{ color: 'var(--warn)' }}>도면이 달라 지도에 안 그림 · 옮기기 불가<Help label="출발점 · 다른 도면">{S.why}</Help></span>}
      <div className="pp-row">{S.k === 'ok' ? sBtn('위치 옮기기') : null}
        <button type="button" className="btn sm" onClick={() => withUndo('출발점 삭제함', () => edit(() => { delete d.start; }))}>삭제</button></div></>;
  const steps = <>
    {stp(1, '지형·층', !!val || oldOnly, false, <><div className="pp-row">{terrSel}</div><span className="lbl">선택한 지형의 2D 도면을 엽니다</span></>)}
    {stp(2, <>출발점 <span className="lbl">선택</span></>, hasS, !val && !oldOnly && !hasS, sCard)}
    {stp(3, <>목적지와 할 일 <span className="lbl">{`${ws.length}곳${ws.length >= 2 && ras ? ` · 지점 사이 ${len.toFixed(1)} m 직선` : ''}`}</span></>, ws.length > 0, !val && !oldOnly,
      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>{rList}</div>)}
    {stp(4, <>종료 방식{dflt ? <span className="pp-dflt">기본값</span> : null}</>, !!d.finish, false, <>
      {/* 목적지 0곳이어도 늘 보임(UX-SPEC 5-3) · 직접 누름만 바꿈(다시 눌러 빼기 0) — 옛 임무 키 없음 = 둘 다 안 눌림 */}
      <div className="pp-seg" role="radiogroup" aria-label="종료 방식">
        {FINISH.map((f) => <button key={f.v} type="button" role="radio" aria-checked={d.finish === f.v} onClick={() => { fUser.current = E.gen; if (d.finish !== f.v) edit(() => { d.finish = f.v; }); else E.touch(); }}>{f.v}</button>)}
      </div>
      <span className="lbl">{d.finish === '출발점 복귀' ? (hasS ? '계획 출발점 S 로 · 직접 조종' : '진행을 시작한 곳으로 · 직접 조종') : fin ? fin.sub : isNew ? '하나를 고르세요' : '종료 방식 미지정'}
        {d.finish === '출발점 복귀' ? <Help label="출발점 복귀 · 설명">{hasS ? '계획 출발점 S 로 · 운영자가 직접 조종해 돌아옴 · 자동 복귀 없음' : '진행을 시작한 곳으로 · 그 좌표는 기록 안 함 · 운영자가 직접 조종해 돌아옴 · 자동 복귀 없음'}</Help> : null}</span></>)}
    {stp(5, '흐름', !!flow, !flow, flow ? <>
      <div className="pp-chain">{flow.flatMap((t, i) => [...(i ? [<i key={`a${i}`}>→</i>] : []),
        i === 0 || (d.finish === '출발점 복귀' && i === flow.length - 1) ? <i key={i}>{t}</i> : <b key={i}>{t}</b>])}</div>
      <span className="lbl">거리: 지점 사이 직선만 · 출발점 쪽·복귀 구간은 계산 안 함</span></> : <span className="lbl">{ws.length ? '④ 종료 방식을 고르면 흐름이 보입니다' : '③ 목적지를 찍으면 흐름이 보입니다'}</span>)}
    {stp(6, '이름', !!d.name.trim(), false, <>
      <span className="lbl">{`이름은 아래 «${isNew ? '임무 만들기' : '변경 저장'}» 칸에서 고칩니다${isNew ? ' · 처음 이름은 지형·시각으로 채움' : ''}`}</span>
      <div className="pp-mode"><b>진행:</b> 수동(운영자가 조종하며 지점마다 기록) · 자동 이동·촬영·복귀 미지원</div></>)}
    {E.id || run ? <div className="pp-st">
      <div className="pp-row"><button type="button" className="btn" disabled={!run && block.length > 0} aria-describedby="why" onClick={start}>{run ? '진행 기록 화면(관제)' : '수동 진행 시작'}</button></div>
      <span id="why" style={{ fontSize: '12px', color: 'var(--warn)' }}>{run ? '▲ 수동 진행 중 — 관제 화면 «임무 단계»·휴대폰 «현황»에서 지점마다 기록' : block.length ? `▲ ${block.join(' · ')}` : '● 로봇은 자동으로 움직이지 않습니다 · 직접 조종하며 지점마다 기록'}</span>
    </div> : null}
  </>;
  // ROOT 9·10 초안 버리기(5초 되돌리기): 새 임무 = 새 빈 계획, 저장된 임무 = 서버 판으로. 서버 문서 삭제 아님
  const discard = () => {
    if (!E.dirty || E.busy) return;
    const src = E.id ? docById(D, E.id) : null;
    withUndo('초안 버림', () => { E.load(src?.kind === 'mission' ? src : null, blank(val)); shown.current = E.id; }, true);
  };
  // ROOT 10 · UX-SPEC 5-5: 복구 안내(맨 위) · 보관 한 줄 · 되돌리기 띠(44 · 2px 5초 막대)
  const rs = E.restored && E.dirty ? E.restored : null;
  const top = rs || E.pdNote || udOn ? <div className="pp-top">
    {rs ? <div className="pp-rest" role="status"><span>{`저장 안 한 초안을 이어서 엽니다 · ${rs.src === 'pd' ? `${rs.at != null ? `${mdhm(rs.at)} 보관 · ` : ''}이 기기 브라우저에만 있음` : '이 탭에만 있음'}`}</span>
      <button type="button" className="btn sm" disabled={E.busy} onClick={discard}>초안 버리기</button></div> : null}
    {E.pdNote ? <span className="pp-note" role="status">{E.pdNote}</span> : null}
    {udOn ? <div className="pp-undo" role="status"><span>{udOn.txt}</span><button type="button" className="btn sm" onClick={undo}>되돌리기</button><i key={udOn.t} aria-hidden="true" /></div> : null}
  </div> : null;
  // UX-SPEC 5-6 만들기 띠: 이름 · 막힘 한 줄(빠진 것 전부) · 만들기/변경 저장 · 초안 버리기. 저장 결과·409/404 상자(E.msg)·C0 도 여기(단추 곁)
  const mk = <div className="pp-mk" role="group" aria-label="임무 만들기">
    {c0}{E.msg}
    <input id="pname" className="inp" maxLength={60} placeholder="예: 창고 앞 사진 확인" aria-label="임무 이름" value={d.name} onChange={(e) => edit(() => { d.name = e.target.value; })} />
    {cw ? <span id="mkwhy" className="pp-why">{`▲ ${cw}`}</span> : null}
    <div className="pp-row">
      <button type="button" className="btn pri" disabled={!!cw} aria-describedby={cw ? 'mkwhy' : undefined} onClick={save}>{isNew ? '임무 만들기' : '변경 저장'}</button>
      <button type="button" className="btn" disabled={!E.dirty || E.busy} onClick={discard}>초안 버리기</button>
    </div>
  </div>;
  const aS = { fontSize: '12px', color: 'var(--accent)' } as const;
  const lnk = (t: string, f: () => void, x?: object) => <a href="#" style={aS} {...x} onClick={(e) => { e.preventDefault(); f(); }}>{t}</a>;
  const ms = docsOf(D, 'mission');

  const v = {
    // G4(ROOT3 · UX-SPEC 2 요약 칩 최대 3): 위치·지도 출처 칩 → «상태 ▾» 상세 행(운영 = 짧은 글 + 운영 줄 sv.line · 개발자 = 기존 문구). 출처 ? 전문(oldChip·oldLine·SRC_NOTE)은 점검 줄 srcHelp 에 그대로
    themeClass: `${themeClass(true)} pcplan-hdr`, status: <LiveStatus D={D} extra={[['위치', posTxt, lk.fresh ? '시뮬이 보낸 위치를 받는 중' : lk.robot ? '마지막으로 받은 시뮬 위치가 오래됨' : '시뮬 위치를 아직 못 받음'],
      dev ? ['지도', oldChip, oldLine] : ['지도', sv.text, sv.line]]} />,   // pcplan-hdr: B2 A3 STOP 첫 줄 오른쪽(live.css)
    hdrA: `임무 · ${!E.id ? '새 임무 · 저장 안 됨' : E.dirty ? '저장 안 한 수정 있음' : `저장됨 · 판 ${E.rev}`}`, hdrB: E.id ? d.name || '이름 없음' : '새 임무 만들기',
    pill: run ? `수동 진행 중 · ${run.doc.name}` : '진행 중 임무 없음',
    chips: <></>,   // G4: 칩 0(위 상세 행) · 옛: 위치 칩 + 지도 칩(운영 srcHelp / 개발자 oldChip)   // B2 R16: 링크는 상태 줄 · 배터리 값 없음은 출발 전 점검 한 곳 · U5-a 지도 칩 운영/개발자
    tSel: tp('sel'), tAdd: tp('add'), tMeas: tp('measure'), steps,
    prevP: { onClick: loadPrev }, prevT: '지난 경로 불러오기',   // 10-18 SPEC-MISSION M2(동작 loadPrev 그대로)
    // 임무 2D: 고른 지형·층의 GT 도면(참고 그림)만 · 로봇 마커 0(noRobot) · 임시 고리 = 기존 sel 핀. 도면이 아니면 상태 글만(격자·가짜 지점 0)
    map: ras ? <MapCanvas name="plan" mode="all" btns wps={ws} hiWp={wsel} zones={D.err ? [] : docsOf(D, 'zone')} noRobot raster={ras} onTap={onTap} onDown={onDown}
      start={S.k === 'ok' ? [S.s.x, S.s.y] : null} draft={tool === 'measure' && meas.length ? { type: '측정', pts: meas } : null} />
      : <div className="pp-msg" role="status">{msgEl}</div>,
    ov1: ras ? <span style={OV}>{dot(false)}거리 = 직선<Help label="거리 · 설명">경로 검사(자동 길찾기) 미연결 · 거리는 직선</Help></span> : <></>,   // M3
    ov2: ras ? <>
      <span style={{ ...OV, border: '1px solid var(--warn)' }}>{dot(!zoneWarn)}{tool === 'measure'
        ? (meas.length === 2 ? `거리 재기: 직선 ${Math.hypot(meas[1][0] - meas[0][0], meas[1][1] - meas[0][1]).toFixed(2)} m` : '거리 재기: 지도에서 두 점을 누르세요')
        : inZ.length ? `${inZ.join(' · ')}(구역은 표시만)` : '구역 안 지점 없음'}</span>
      <span style={OVW}>{dot(false)}{bTxt}<Help label="계획 기준 · 설명">{bHelp}</Help>{geoWhy ? <button type="button" className="btn sm" onClick={T2.retry}>다시 읽기</button> : null}</span>
      <span style={OV}>{dot(false)}로봇 위치 · 이 도면에 표시 안 함<Help label="로봇 위치 · 설명">도면 개정을 대조하지 않은 참고 그림이라 로봇 위치를 겹치지 않습니다 · 로봇 위치는 관제에서</Help></span>
    </> : <></>,
    cfm, over, mapAct: !!(mvOn || tool === 'start'), top, mk, legend, zone,
    foot: ras ? <div className="pp-foot"><span>{`${plc} · 시뮬 도면 지도 · 참고 그림 `}<Help label="참고 그림 · 설명">그림 개정은 계획 좌표 개정과 대조하지 않음 · 서버가 도면 원본 sha 를 주지 않음 · 계획 출처 확인은 시작 때</Help></span></div> : null,
    // R3b 머리: «새 임무 만들기» / «임무 수정 · 이름» + «저장된 임무 열기 ▾»(줄 = 이름 · 지형·층 · 종료 방식 · 지점 n) · 이름은 React 글로만
    planBox: <div className="pp-st" style={{ borderTop: 0 }}>
      <div className="pp-row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <h3>{isNew ? '새 임무 만들기' : `임무 수정 · ${d.name || '이름 없음'}`}</h3>
        <span className="pp-row" style={{ gap: '12px' }}>
          {E.id ? lnk('복제해서 새 임무', dup) : null}{E.id ? lnk('+ 새 임무', () => openPlan('')) : null}
          {lnk(`저장된 임무 열기 ${ls ? '▴' : '▾'}`, () => setLs(!ls), { 'aria-expanded': ls })}
        </span>
      </div>
      {ls ? <div className="pp-list" role="listbox" aria-label="저장된 임무">
        <span className="lbl">저장된 임무 · 고르면 수정으로 엶</span>
        {ms.length ? ms.map((m) => <button key={m.id} type="button" role="option" aria-selected={m.id === E.id} className="pp-li" onClick={() => openPlan(m.id)}>
          <b>{m.doc.name || '이름 없음'}</b>
          <span className="lbl">{`${okT(m.doc.map) ? place(m.doc.map.world_id, m.doc.map.floor_id) : '지형 정보 없음 · 목록만'} · ${finishText(m.doc)} · 지점 ${m.doc.wps.length}`}</span>
        </button>) : <span className="lbl">{D.err ? '임무 목록을 읽지 못함' : '저장된 임무 없음'}</span>}
      </div> : null}
    </div>,
    tplP: { value: T ? T.id : d.tmpl, onChange: (e: React.ChangeEvent<HTMLSelectElement>) => { const id = e.target.value; edit(() => { d.tmpl = id; }); if (ws.length && confirm('지점마다 할 일을 이 양식 기본값으로 바꿀까요?\n프리셋으로 고른 할 일도 바뀝니다.')) edit(() => { for (const w of ws) w.mods = defMods(D, id); }); } },
    tplO: <>{T ? null : <option value={d.tmpl}>{MISSING_T}</option>}{tmpls(D).map((t) => <option key={t.id} value={t.id}>{t.locked ? `${t.name} (기본)` : t.name}</option>)}</>,
    tplHref: href('PcMissions', T ? { tmpl: T.id } : {}),   // M10: 경보 규칙 «양식에서 규칙 고치기» 링크 삭제(양식 화면도 규칙 추가 막힘 — 막다른 길)
    tplHelp: <Help label="임무 양식 · 설명">양식이 지점마다 할 일의 기본값을 정합니다. 지점별로 더하거나 뺄 수 있습니다.</Help>,   // M4
    // U5-a: 공용 쉬운 말(U4-c 고정 규칙과 같은 글) + ? 전문(U5-b: 공용 LostHelp — STOP_FACT·SAFE_NOTE·STOP_OBS·RELURCH 보존) · 동작·선택 불가 그대로
    // M9(10-18): 짧은 글 + ? · 둘 다 선택 불가(disabled) 그대로 — 0.3 s/1 s 전문은 LostHelp(STOP_FACT·SAFE_NOTE·STOP_OBS·RELURCH)
    lost: <>{opt('입력 차단·잠금', ' · 서버 고정', <LostHelp />, true)}
      {opt('마지막 통신 지점으로 후퇴', '', <Chip tone="off" text="미연결" why={`${GOTO} — 자동 후퇴는 실행하지 않습니다.`} whyLabel="후퇴 · 설명" />, false)}</>,
    aH: <Chip tone="off" text="자동 실행 안 함" why={RULE_WHY} whyLabel="경보 규칙 · 설명" />, aOpts: <></>,   // U5-a: U4-c 경보 규칙 칩과 같음(전문은 ?)
    cH: `${cks.filter((c) => c[0]).length} / ${cks.length}`,
    cList: <>{cks.map(([good, t, , hp]) => <div className="ck" key={t}><span className={`m ${good ? 'ok' : 'warn'}`}>{good ? '●' : '▲'}</span><span>{t}{hp}</span><span /></div>)}</>,
    stopSub: '스페이스 · 입력 차단·잠금', stopHelp: <Help label="STOP 설명">{STOP_TIP}</Help>,   // 공용 STOP 글(v3 §3 — PcMissions·PcRobot 와 같음)
  };
  return <><style>{CSS}</style><style>{PCSS}</style><div id="dc-root"><View v={v} /></div></>;
}
