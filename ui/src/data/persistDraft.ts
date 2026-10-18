// 영속 초안(10-19, RL) — 저장 안 한 편집 초안을 이 브라우저 localStorage 에 잠깐 두고, 새로 읽은 뒤(reload) 같은 문맥이면 되살린다.
//  opt-in 키는 PD_KEYS(지금 'mission:PcPlan' 하나)뿐. 서버에 자동으로 쓰지 않는다. 토큰·비밀번호·조종 상태는 넣지 않는다(키 이름 검사로 거부).
//  문맥 = 이 출처(origin)의 로컬 nonce + whoami 계정. nonce 는 인증 증명이 아니다 — 되살리기는 whoami 가 유효할 때(status 'ready')만.
//   http(관문 없음, T.gated=false)는 로그인이 없어 계정 대신 'ungated' — 이 origin 문맥에만 보관한다고 note 로 밝힌다.
//  폐기(drop): 로그인 성공·로그아웃·관문 변경·세션 끝(scratch.dropScratch) → nonce 교체 + 보관본 전부 삭제 + gen+1.
//   다른 탭의 nonce 교체(storage 이벤트)·get/put/remove/check 때 다시 읽은 nonce 가 다르면 이 탭도 폐기(쓰기 0). 늦은 whoami 응답·옛 gen 의 put/remove 는 버린다.
//   저장 키는 fh.pd.v1:<nonce>:<key> — 자기 nonce 소유 키만 쓰고 지운다.
//  storage 차단·깨짐·가득: 이 탭 메모리로만(status 'memory' 아님 — ready 유지, note 로 안내). 순환 import 주의: transport 만 가져온다(auth·scratch 0).
import { T } from './transport';

export const PD_KEYS = ['mission:PcPlan'] as const;
export type PdKey = (typeof PD_KEYS)[number];
export type PdDraft = { id: string | null; rev: number | null; d: unknown };
/** off = 되살리기·보관 0(초기·확인 전·로그인 없음·확인 실패·폐기 뒤) · checking = whoami 확인 중 · ready = get/put 가능 */
export type PdStatus = 'off' | 'checking' | 'ready';
/** gen: 문맥 세대 — drop 마다 +1. put 은 «편집을 시작한 때의 gen» 을 같이 넘겨, 그 사이 폐기됐으면 거부된다. mem: storage 를 못 써 탭 메모리만 */
export type PdSnap = { status: PdStatus; gen: number; mem: boolean; note: string };

const V = 1, NK = 'fh.pd.v1.nonce', PK = 'fh.pd.v1:';
export const PD_TTL_MS = 12 * 3600 * 1000, PD_MAX_BYTES = 256 * 1024;
// opt-in 키별 최소 구조(화면이 읽다 깨지지 않을 만큼 — 서버 전체 검사 복제 아님). 계약 Mission·Waypoint·MapSrc·PlanStart 모양
const fin = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
const str = (v: unknown) => typeof v === 'string';
const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const MODS = ['사진', '운영자 확인', '대기'];
const mapOk = (m: unknown) => obj(m) && m.src === 'gt' && str(m.world_id) && str(m.floor_id) && str(m.key) && (m.rid === undefined || str(m.rid));
const wpOk = (w: unknown) => obj(w) && fin(w.x) && fin(w.y) && str(w.name) && Array.isArray(w.mods) && w.mods.every((t) => MODS.includes(t as string));
const SHAPE: Record<PdKey, (d: unknown) => boolean> = {
  'mission:PcPlan': (d) => obj(d) && str(d.name) && str(d.tmpl) && str(d.memo) && Array.isArray(d.wps) && d.wps.length <= 200 && d.wps.every(wpOk)
    && (d.map === undefined || mapOk(d.map)) && (d.finish === undefined || d.finish === '출발점 복귀' || d.finish === '마지막 지점 종료')
    && (d.start === undefined || (obj(d.start) && fin(d.start.x) && fin(d.start.y) && mapOk(d.start.map))),
};
const BAD_KEY = /"(token|pw|password|passwd|secret|cookie|ticket)"\s*:/i;   // ponytail: 키 이름 검사뿐 — 값 안의 비밀은 못 잡음. opt-in 키가 늘면 키별 스키마로

let snap: PdSnap = { status: 'off', gen: 0, mem: false, note: '' };
// 결속 문맥: nonce(보관본·저장 키에 들어감) · seen(결속 때 storage 의 nonce 값 — undefined = 못 읽음) · acct.
// check 실패(401 등)는 status 만 off — 결속은 남겨 다음 check 가 «같은 문맥»인지 대조한다. 결속 해제는 local()(gen+1) 뿐.
let acct: string | null = null, nonce: string | null = null, seen: string | null | undefined, seq = 0;   // seq: check 요청 순번
const mem = new Map<string, string>();
const subs = new Set<() => void>();
const set = (p: Partial<PdSnap>) => { snap = { ...snap, ...p }; subs.forEach((f) => f()); };

const ls = (): Storage | null => { try { return globalThis.localStorage ?? null; } catch { return null; } };
const origin = () => globalThis.location?.origin ?? '';
// nonce 는 문맥 구별용(인증 아님) — crypto 없으면(옛 node 시험) 시각+Math.random
const rnd = () => (globalThis.crypto?.getRandomValues
  ? Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('')
  : Date.now().toString(36) + Math.random().toString(36).slice(2));
const MEM_NOTE = '이 브라우저에 초안 보관 못 함 — 이 탭 메모리에만(새로 읽으면 사라짐)';
const MOVED = '다른 탭에서 로그인 상태가 바뀜 — 초안 복구 안 함';
const toMem = () => { if (!snap.mem) set({ mem: true, note: MEM_NOTE }); };
/** storage 의 nonce 읽기만 — 쓰기 실패(mem)와 별개. 못 읽으면 undefined */
const peek = (): string | null | undefined => { try { const s = ls(); return s ? s.getItem(NK) : undefined; } catch { return undefined; } };
/** 저장 키 = nonce 소유 — 다른 문맥(다른 nonce)의 보관본은 이 탭 put/remove 가 건드릴 수 없다 */
const own = (key: string) => `${PK}${nonce}:${key}`;
const split = (k: string) => { const r = k.slice(PK.length), i = r.indexOf(':'); return i < 0 ? null : { n: r.slice(0, i), key: r.slice(i + 1) }; };

/** 처음 결속: storage nonce 를 쓰고, 없으면 만든다. 읽기·쓰기 못 하면 메모리 nonce(seen = 그때 storage 값) */
function bind(s1: string | null | undefined) {
  if (typeof s1 === 'string') { nonce = seen = s1; return; }
  nonce = rnd(); seen = s1;
  if (s1 === undefined) { toMem(); return; }
  try { ls()!.setItem(NK, nonce); seen = nonce; } catch { toMem(); }
}

/** 이 탭 폐기(쓰기 없이 — 다른 탭이 이미 교체·삭제했을 때): 결속 해제 + gen+1(scratch 탭 메모리도 구독으로 폐기) */
function local(note: string) { acct = null; nonce = null; seen = undefined; mem.clear(); set({ status: 'off', gen: snap.gen + 1, note }); }

/** 폐기: nonce 교체 + 보관본 전부 삭제 + gen+1. 로그인 성공·로그아웃·관문 변경·세션 끝에서 부른다(scratch.dropScratch·login 성공) */
export function drop() {
  const s = ls();
  try { if (s) for (let i = s.length - 1; i >= 0; i--) { const k = s.key(i); if (k?.startsWith(PK)) s.removeItem(k); } } catch { /* 차단 */ }
  try { s?.setItem(NK, rnd()); } catch { /* 차단 */ }
  local('');
}

/** 문맥 확인(=init·check 같음): whoami 유효 → ready. 재시도 0.
 *  응답 전 drop(gen)·더 새 check(seq)면 이 답은 버린다. 결속된 문맥에서 nonce 가 바뀌었거나(시작 전·도중, 이벤트 전이라도) 계정이 다르면
 *  같은 gen 으로 다시 결속하지 않고 local()(gen+1·off) — 다음 check 가 새 gen 에서 처음 결속. 같은 문맥 재확인은 gen 그대로 ready */
export async function check(): Promise<PdStatus> {
  const g = snap.gen, my = ++seq, s0 = peek();
  set({ status: 'checking' });
  let who: string | null = null, why = '';
  if (!T.gated) who = 'ungated';
  else {
    try {
      const r = await T.whoami();
      const a = r.status === 200 ? (JSON.parse(r.body) as { account?: unknown }).account : null;
      if (typeof a === 'string' && a) who = a; else why = r.status === 401 ? '로그인 필요' : `계정 확인 못 함(HTTP ${r.status})`;
    } catch (e) { why = `계정 확인 못 함 · ${(e as Error)?.message || e}`; }
  }
  if (g !== snap.gen || my !== seq) return snap.status;   // 그 사이 폐기·더 새 확인 — 늦은 응답이 결과를 뒤집지 않음
  if (!who) { set({ status: 'off', note: `초안 복구 안 함 · ${why}` }); return 'off'; }
  const s1 = peek();
  if (nonce !== null && (acct !== who || (s1 !== undefined && s1 !== seen))) { local(acct !== who ? '계정이 바뀜 — 초안 복구 안 함' : MOVED); return 'off'; }
  // 처음 결속인데 확인 도중 storage nonce 가 바뀜(null→N2 포함 — null 은 «읽음·없음», undefined 만 «못 읽음») → 결속·sweep 0(새 탭 키 보존)
  if (nonce === null && s0 !== undefined && s1 !== s0) { local(MOVED); return 'off'; }
  if (nonce === null) bind(s1);
  acct = who;
  sweep();
  set({ status: 'ready', note: snap.mem ? MEM_NOTE : who === 'ungated' ? `로그인 없는 연결 — 이 주소(${origin()})에만 보관` : '' });
  return 'ready';
}
export const init = check;

type Env = { v: number; nonce: string; acct: string; origin: string; key: string; at: number; id: string | null; rev: number | null; d: unknown };
/** 최소 구조 검증 + 문맥 대조. 맞으면 초안, 아니면 null */
function parse(raw: string | null | undefined, key: string): PdDraft | null {
  if (!raw || raw.length > PD_MAX_BYTES) return null;
  let e: Env;
  try { e = JSON.parse(raw); } catch { return null; }
  const ok = e && typeof e === 'object' && e.v === V && e.key === key && e.nonce === nonce && e.acct === acct && e.origin === origin()
    && typeof e.at === 'number' && Date.now() - e.at >= 0 && Date.now() - e.at <= PD_TTL_MS
    && (e.id === null || typeof e.id === 'string') && (e.rev === null || Number.isInteger(e.rev))
    && (PD_KEYS as readonly string[]).includes(key) && SHAPE[key as PdKey](e.d);
  return ok ? { id: e.id, rev: e.rev, d: e.d } : null;
}

/** 결속 직후: 맞지 않는 보관본(옛 nonce·다른 계정·만료·깨짐·opt-in 밖 키) 삭제. storage 에 nonce 는 하나뿐이라 다른 nonce 키 = 지난 문맥 */
function sweep() {
  const s = ls();
  try {
    if (!s) return;
    for (let i = s.length - 1; i >= 0; i--) {
      const k = s.key(i), o = k?.startsWith(PK) ? split(k) : undefined;
      if (o === undefined) continue;
      if (!o || o.n !== nonce || !parse(s.getItem(k!), o.key)) s.removeItem(k!);
    }
  } catch { /* 못 읽음·못 지움 — 남은 것은 parse 대조로 쓰이지 않음 */ }
}

/** 다른 탭이 nonce 를 바꿨는가 — mem(쓰기 실패)이어도 읽을 수 있으면 대조. 바뀌었으면 이 탭 폐기 */
function rotated(): boolean {
  const n = peek();
  if (n === undefined || n === seen) return false;
  local(MOVED);
  return true;
}

const live = (key: string): key is PdKey => snap.status === 'ready' && !!nonce && !!acct && (PD_KEYS as readonly string[]).includes(key) && !rotated();
const sget = (key: string) => { try { return ls()?.getItem(own(key)); } catch { return undefined; } };

/** 보관본 읽기 — ready 이고 문맥이 맞을 때만(탭 메모리 대체본 먼저). 지우지 않는다(UI 가 채택 뒤 remove) */
export function get(key: PdKey): PdDraft | null {
  if (!live(key)) return null;
  return parse(mem.get(key), key) ?? parse(sget(key), key);
}

/** 보관(덮어씀). atGen = 편집을 시작한 때의 snapshot().gen — 그 사이 폐기됐으면 false. 크기·구조·금지 키 위반도 false */
export function put(key: PdKey, v: PdDraft, atGen: number): boolean {
  if (atGen !== snap.gen || !live(key)) return false;
  const e: Env = { v: V, nonce: nonce!, acct: acct!, origin: origin(), key, at: Date.now(), id: v.id, rev: v.rev, d: v.d };
  let raw: string;
  try { raw = JSON.stringify(e); } catch { return false; }
  if (raw.length > PD_MAX_BYTES || BAD_KEY.test(raw) || !parse(raw, key)) return false;
  if (!snap.mem) {
    try { ls()!.setItem(own(key), raw); mem.delete(key); return true; } catch { toMem(); }   // 가득·차단 → 메모리로
  }
  mem.set(key, raw); return true;
}

/** 삭제 — put 과 같은 가드(atGen·ready·nonce 재대조) + 이 nonce 소유 키만. 옛 문맥의 저장 성공·cleanup 이 새 문맥 초안을 지우지 않게 */
export function remove(key: PdKey, atGen: number): boolean {
  if (atGen !== snap.gen || !live(key)) return false;
  mem.delete(key);
  try { ls()?.removeItem(own(key)); } catch { /* 차단 */ }
  return true;
}

/** useSyncExternalStore(subscribe, snapshot) 그대로 */
export function subscribe(f: () => void): () => void { subs.add(f); return () => { subs.delete(f); }; }
export const snapshot = (): PdSnap => snap;

// 다른 탭의 nonce 교체·전체 삭제(key null) → 이 탭 폐기
globalThis.addEventListener?.('storage', (e: StorageEvent) => {
  if (e.key === NK || e.key === null) local('다른 탭에서 로그인 상태가 바뀜 — 초안 복구 안 함');   // off 여도 gen+1 — scratch 탭 메모리도 같이 폐기(구독)
});
