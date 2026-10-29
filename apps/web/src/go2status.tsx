// Go2 상태 전용(10-28, GO2-readonly 계약 rb-go2-readonly/runs/go2-readonly/PHONE-CONTRACT.md): 주변 찾기의 mode=go2-readonly 또는 직접 넣은 주소를
// 폰 앱(mobile/ Go2Status.java)이 1 s 마다 GET(3 s 제한, Wi-Fi 망에 묶음)해 'fh-go2' 이벤트로 넣는다. 이 화면은 window.fhGo2Status={seq,url,code} 를 둘 뿐(JS → 네이티브 호출 0).
// 읽기만: 조종 화면·서버 등록·조종권으로 넘어가지 않고 STOP 도 없다. 현장 코드는 메모리에만(URL·로그·저장 0), 401 이면 버리고 다시 받는다.
import { useEffect, useState } from 'react';
import type { Tone } from './fake';
import { Chip, Line } from './screens';
import { PROBLEM } from './nearby';

export type Conn = 'ONLINE' | 'STALE' | 'OFFLINE';
/** 노트북 에이전트가 받는 Go2 토픽(state.py sources) — fresh = 그 토픽이 노트북에 새로 오고 있음, age = 마지막으로 받은 뒤 초(없으면 null) */
export const TOPICS = { lowstate: '배터리·자세', sportmodestate: '모드·오류' } as const;
export type Src = Record<keyof typeof TOPICS, { fresh: boolean | null; age: number | null }>;
export type Go2 = { connection: Conn; soc: number | null; voltage: number | null; roll: number | null; pitch: number | null; fallen: boolean | null; mode: number | null; error: number | null; sources: Src };
/** 폰 시계(performance.now) 기준: 마지막 정상 응답 뒤 이만큼 지나면 늦음 / 끊김(값 지움) */
export const STALE_MS = 2000, OFFLINE_MS = 10000;
export const PORT = 9610;
/** 첫 응답을 기다리는 한도: 앱 연결 제한 3 s + 네이티브 시작 최대 0.5 s 지연 + 여유 — 넘으면 «옛 앱» 안내(주변 찾기 NO_APP_MS 3 s 와 따로) */
export const NO_APP_MS = 4500;

const RANK: Record<Conn, number> = { ONLINE: 0, STALE: 1, OFFLINE: 2 };
const TONE: Record<Conn, Tone> = { ONLINE: 'ok', STALE: 'warn', OFFLINE: 'off' };
/** 끊긴 곳: phone = 폰↔노트북 응답이 늦거나 없음(폰 시계), robot = 응답은 오는데 노트북이 Go2 토픽을 못 받음(서버 connection) */
export type Cut = 'phone' | 'robot' | null;
const CHIP: Record<Conn, Record<'phone' | 'robot', string>> = {
  ONLINE: { phone: '온라인 · 상태 전용', robot: '온라인 · 상태 전용' },
  STALE: { phone: '늦음 · 폰↔노트북 2초 넘게 응답 없음', robot: '늦음 · 노트북↔로봇 자료 끊김' },
  OFFLINE: { phone: '오프라인 · 폰↔노트북 응답 없음', robot: '오프라인 · 노트북↔로봇 자료 끊김' } };
const CUT_NOTE = { phone: { STALE: '마지막 값 — 폰 Wi-Fi·노트북 전원을 확인하세요', OFFLINE: '10초 넘게 응답 없음 — 값 지움. 폰 Wi-Fi·노트북 전원을 확인하세요' },
  robot: { STALE: '노트북은 답하지만 로봇 자료 일부가 낡았습니다(낡은 값은 «—») — 노트북↔Go2 유선·DDS 를 확인하세요', OFFLINE: '노트북은 답하지만 로봇 자료가 끊겼습니다 — 노트북↔Go2 유선·DDS 를 확인하세요' } } as const;

const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const obj = (v: unknown) => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});

/** 200 본문 → Go2. 상태 전용(kind·v·read_only·motion_enabled)이 아니면 null — 숫자가 아닌 값은 null(«—»), 0 으로 바꾸지 않는다 */
export function body(b: unknown): Go2 | null {
  const o = obj(b);
  if (o.v !== 1 || o.kind !== 'go2-readonly' || o.read_only !== true || o.motion_enabled !== false || !(typeof o.connection === 'string' && o.connection in RANK)) return null;
  const bat = obj(o.battery), att = obj(o.attitude), src = obj(o.sources);
  const one = (k: keyof Src) => { const t = obj(src[k]); return { fresh: typeof t.fresh === 'boolean' ? t.fresh : null, age: n(t.age_s) }; };
  return { connection: o.connection as Conn, soc: n(bat.soc), voltage: n(bat.voltage), roll: n(att.roll), pitch: n(att.pitch), fallen: typeof o.fallen === 'boolean' ? o.fallen : null, mode: n(o.mode), error: n(o.error_code),
    sources: { lowstate: one('lowstate'), sportmodestate: one('sportmodestate') } };
}

/** 서버(로봇 쪽)가 말한 연결과 폰이 마지막으로 받은 뒤 지난 시간 중 더 나쁜 쪽 */
export function conn(server: Conn | undefined, ageMs: number | null): Conn { return cut(server, ageMs)[0]; }
/** [연결, 끊긴 곳] — 폰 쪽이 같거나 더 나쁘면 폰↔노트북, 서버만 나쁘면 노트북↔로봇 */
export function cut(server: Conn | undefined, ageMs: number | null): [Conn, Cut] {
  const local: Conn = ageMs == null || ageMs > OFFLINE_MS ? 'OFFLINE' : ageMs > STALE_MS ? 'STALE' : 'ONLINE';
  if (server && RANK[server] > RANK[local]) return [server, 'robot'];
  return [local, local === 'ONLINE' ? null : 'phone'];
}

const dash = (v: number | null, f: (x: number) => string) => (v == null ? '—' : f(v));
export const deg = (rad: number | null) => dash(rad, (x) => `${((x * 180) / Math.PI).toFixed(1)}°`);

/** 사설 IPv4(10/8·172.16/12·192.168/16) → 상태 주소, 아니면 null (앱 Go2Status.target 과 같은 거름) */
export function manualUrl(ip: string): string | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip.trim());
  const p = m?.slice(1).map(Number);
  if (!p || p.some((x) => x > 255)) return null;
  const ok = p[0] === 10 || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168);
  return ok ? `http://${p.join('.')}:${PORT}/go2/status` : null;
}

type W = Window & { fhGo2Status?: { seq: string; url: string; code: string } };

/** 상태 전용 보기(«주변 로봇 찾기» 카드 자리). 기체·주소를 눈으로 대조하고 로봇 쪽에 뜬 8자리 현장 코드를 넣으면 시작 */
export function Go2View({ name, url, close }: { name: string; url: string; close: () => void }) {
  const [draft, setDraft] = useState(''), [code, setCode] = useState<string | null>(null), [seq, setSeq] = useState(0);
  const [last, setLast] = useState<{ go2: Go2; at: number } | null>(null), [why, setWhy] = useState<string | null>(null), [heard, setHeard] = useState(false), [old, setOld] = useState(false), [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    if (code == null) return;
    const w = window as W, s = String(seq);
    w.fhGo2Status = { seq: s, url, code };
    const on = (e: Event) => {
      const d = obj((e as CustomEvent).detail);
      if (d.seq !== s) return;
      setHeard(true);
      if (d.status === 200) { const g = body(d.body); if (g) { setLast({ go2: g, at: performance.now() }); setWhy(null); } else setWhy('응답 모양이 상태 전용 계약과 다릅니다.'); }
      else if (d.status === 401) { setCode(null); setWhy('현장 코드가 틀렸거나 만료됐습니다 — 로봇 쪽 코드를 다시 확인해 넣으세요.'); }
      else if (d.status === 429) setWhy(`잘못된 코드가 많아 로봇이 잠시 막았습니다 — ${n(d.retry) ?? 60}초 뒤 다시 읽습니다.`);
      else if (d.status === -2) { setCode(null); setWhy('주소나 코드 모양이 틀렸습니다.'); }
      else if (d.status === -1) setWhy('응답 모양이 상태 전용 계약과 다릅니다.');
      else setWhy(d.why === 'wifi-off' || d.why === 'other-subnet' ? PROBLEM[d.why] : typeof d.status === 'number' && d.status >= 400 ? `로봇이 오류로 답했습니다(${d.status}).` : '응답 없음(3초) — 같은 Wi-Fi(또는 Go2 핫스팟)인지 확인하세요.');
    };
    window.addEventListener('fh-go2', on);
    const tick = setInterval(() => setNow(performance.now()), 500), t = setTimeout(() => setOld(true), NO_APP_MS);
    return () => { window.removeEventListener('fh-go2', on); clearInterval(tick); clearTimeout(t); if (w.fhGo2Status?.seq === s) delete w.fhGo2Status; };
  }, [code, seq, url]);
  const [c, where] = cut(last?.go2.connection, last ? now - last.at : null), g = c === 'OFFLINE' ? null : last?.go2;
  const start = () => { if (!/^\d{8}$/.test(draft)) return; setLast(null); setWhy(null); setHeard(false); setOld(false); setSeq((x) => x + 1); setCode(draft); setDraft(''); };
  return <section className="lv-card" style={{ flexBasis: '100%' }} aria-label="Go2 상태 전용" data-go2-view={code == null ? 'code' : c}>
    <div className="fh-row"><h2 className="fh-grow">{name}</h2><button type="button" className="btn" onClick={close}>닫기</button></div>
    <p className="lv-note">{url.replace(/^http:\/\//, '').replace(/\/go2\/status$/, '')} · 상태만 읽습니다(조종·등록·STOP 없음).</p>
    {code == null ? <form className="fh-field" onSubmit={(e) => { e.preventDefault(); start(); }}>
      <label className="fh-field"><span className="lbl">현장 코드 8자리 — 로봇이 맞는지 기체·주소를 확인한 뒤 넣으세요</span>
        <input className="inp" value={draft} onChange={(e) => setDraft(e.target.value.replace(/\D/g, '').slice(0, 8))} inputMode="numeric" autoComplete="off" spellCheck={false} maxLength={8} data-go2-code /></label>
      <button type="submit" className="btn pri" disabled={!/^\d{8}$/.test(draft)}>상태 보기</button>
    </form> : <>
      <div className="fh-row" data-go2-cut={where ?? undefined}><Chip tone={TONE[c]} text={CHIP[c][where ?? 'phone']} />{last && c !== 'ONLINE' && where && <span className="lbl">{CUT_NOTE[where][c]}</span>}</div>
      {!heard && old ? <p className="fh-why" data-go2-old>이 앱 판은 상태 전용을 지원하지 않습니다 — FOOTHOLD 앱을 1.2.3-dev 이상으로 업데이트하세요.</p> : !last && !why && <p className="lv-note" role="status">읽는 중…</p>}
      <Line k="배터리"><span className="mono">{dash(g?.soc ?? null, (x) => `${Math.round(x)}%`)} · {dash(g?.voltage ?? null, (x) => `${x.toFixed(1)} V`)}</span></Line>
      <Line k="자세"><span className="mono">롤 {deg(g?.roll ?? null)} · 피치 {deg(g?.pitch ?? null)}</span></Line>
      <Line k="넘어짐"><span>{g?.fallen == null ? '—' : g.fallen ? '넘어짐 추정' : '아님(추정)'}</span><span className="lbl">IMU 기울기 추정 — 넘어짐 감지 보장 아님</span></Line>
      {last && <Line k="로봇 자료"><span data-go2-src>{(Object.keys(TOPICS) as (keyof Src)[]).map((k) => { const t = last.go2.sources[k];
        return `${TOPICS[k]} ${t.fresh ? '받는 중' : t.fresh === false ? `끊김${t.age == null ? '(받은 적 없음)' : `(${t.age.toFixed(1)}초 전)`}` : '모름'}`; }).join(' · ')}</span>
        <span className="lbl">노트북↔Go2 토픽(lowstate · sportmodestate)</span></Line>}
      <Line k="모드"><span className="mono">{dash(g?.mode ?? null, String)}</span><span className="lbl">오류 코드</span><span className="mono">{dash(g?.error ?? null, String)}</span></Line>
      <button type="button" className="btn" onClick={() => { setCode(null); setLast(null); setWhy(null); }}>멈추고 코드 다시 넣기</button>
    </>}
    {why && <p className="fh-why" role="alert" data-go2-why>{why}</p>}
  </section>;
}
