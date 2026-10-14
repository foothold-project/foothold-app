// 주변 관문 검색(같은 Wi-Fi mDNS) — 계약 D′: 네이티브 FhGate.discover({ms})·discoverStop(), 관문 광고 sim/gate_mdns.py.
// 규칙: 검색은 주소 편집 칸이 열린 동안만. stop() 뒤(닫기·숨김·떠남·로그인 시작) 늦게 온 결과는 버린다(세대 번호).
// 찾은 항목은 «미검증» — 고르면 입력칸에 넣기까지만. 저장·로그인·조종은 기존 «주소 저장» 확인 뒤 사용자가 직접(여기서 0).
import { gateOrigin } from './auth';

export type Item = { name: string; origin: string };
export type Found = { items: Item[]; msg: string };
export type NearbyApi = { discover: (ms: number) => Promise<unknown>; stop: () => unknown };
const MAX = 16;

/** 네이티브가 이미 거른 결과를 JS 에서 한 번 더: 사설 IPv4 https origin · app/api 일치 · 이름 정리 · 같은 origin 은 처음 것만 */
export function cleanItems(raw: unknown): Item[] {
  const out: Item[] = [];
  for (const it of Array.isArray(raw) ? raw : []) {
    if (!it || it.app !== 'foothold-gate' || it.api !== 1 || typeof it.origin !== 'string' || typeof it.name !== 'string') continue;   // api 는 숫자 1 만(문자 '1' 변환 0)
    const g = gateOrigin(it.origin);
    if ('why' in g || g.origin !== it.origin) continue;
    const m = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(new URL(g.origin).hostname);
    if (!m) continue;
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (!(a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168))) continue;   // 공인·Tailscale·루프백 0
    if (out.some((x) => x.origin === g.origin)) continue;
    const name = it.name.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim().slice(0, 64);
    out.push({ name, origin: g.origin });
    if (out.length >= MAX) break;
  }
  return out;
}

const WHY: Record<string, string> = {
  wifi: 'Wi-Fi 에 연결 안 됨 — 같은 Wi-Fi 에 붙은 뒤 다시 검색',
  nsd: '기기의 주변 검색 기능이 응답하지 않음 — 주소 입력·QR 을 쓰세요',
  hidden: '앱이 화면 밖이라 검색 안 함 — 다시 검색',
};
const STOP = ['none', 'requested', 'failed'], WHYS = ['wifi', 'nsd', 'hidden', 'cancelled'];
/** 결과 → 화면 한 줄. 계약(네이티브 2073a8e): {gen, items[], why?, stop} — stop 필수, why 는 정해진 넷만.
 *  형식이 틀리거나 why 가 있거나 stop failed 면 목록 0(사유와 목록을 섞지 않음 — 고를 후보 없음). cancelled 는 사용자가 멈춘 것이라 조용히 */
export function foundOf(r: any): Found {
  const ok = !!r && typeof r === 'object' && Number.isInteger(r.gen) && Array.isArray(r.items) && STOP.includes(r.stop) && (r.why === undefined || WHYS.includes(r.why));
  if (!ok) return { items: [], msg: '주변 검색 응답 형식이 맞지 않음 — 주소 입력·QR 을 쓰세요' };
  if (r.stop === 'failed') return { items: [], msg: '검색 정리 실패 — 앱을 다시 열어 주세요' };
  if (r.why !== undefined) return { items: [], msg: r.why === 'cancelled' ? '' : WHY[r.why] };
  const items = cleanItems(r.items);
  return { items, msg: items.length ? '' : '찾은 관문 없음 — 같은 Wi-Fi 인지 · 관문 PC 에서 광고가 켜졌는지 확인, 또는 주소 입력·QR' };
}
export function errOf(e: any): string {
  const c = String(e?.code || e?.message || e);
  return c === 'busy' ? '이전 검색을 정리하는 중 — 잠시 뒤 다시 검색' : c === 'stale' ? '' : `검색 안 됨(${c.slice(0, 40)}) — 주소 입력·QR 을 쓰세요`;
}

let gen = 0, cur = (_why?: string) => {}, stopping: Promise<unknown> = Promise.resolve();
/** 검색 한 번. 앞 검색이 돌고 있으면 먼저 멈추고 그 정리를 기다린 뒤 시작(네이티브는 동시 1개 — 'busy').
 *  돌려준 stop(why?) 은 여러 번 불러도 됨 — 끝나기 전이면 discoverStop 을 한 번 부르고 늦은 결과를 버린다. why 가 있으면 그 글로 끝냄(unmount 는 없이) */
export function startNearby(api: NearbyApi, ms: number, done: (f: Found) => void): (why?: string) => void {
  cur();
  const my = ++gen;
  let over = false;
  stopping.then(() => (my === gen ? api.discover(ms) : null)).then(
    (r) => { over = true; if (my === gen && r !== null) done(foundOf(r)); },
    (e) => { over = true; if (my === gen) { const m = errOf(e); if (m) done({ items: [], msg: m }); } });
  return cur = (why?: string) => {
    if (my !== gen) return;
    gen++;
    if (!over) { stopping = Promise.resolve().then(() => api.stop()).catch(() => {}); if (why) done({ items: [], msg: why }); }
  };
}
/** 로그인 시작 등 검색 칸 밖에서 진행 중 검색을 끝낼 때 */
export const stopNearby = () => cur('로그인 시작으로 검색을 멈춤 — 다시 검색');
