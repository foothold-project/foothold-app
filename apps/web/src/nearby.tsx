// 주변 로봇 찾기(10-28 현민님 «+ 로봇 연결하기»): 폰 앱(mobile/ Nearby.java)이 Wi-Fi(mDNS _foothold._tcp · Go2 기본 주소)·블루투스(Go2_ 광고)로 찾은 것을 보여 준다.
// 통로: 이 화면이 [data-nearby-scan=<seq>] 를 두면 앱이 0.5 s 읽기로 보고 찾기 시작, 결과는 window 'fh-nearby' 이벤트(JS → 네이티브 호출 0 — RemoteClient 그대로).
// 찾기·표시만: 로봇 설정 변경·BLE 쓰기·Wi-Fi 비밀번호 전송 없음. 광고로 찾은 것은 «에이전트 발견»일 뿐 실기 온라인·조종 가능이 아니다.
import { useEffect, useState } from 'react';
import type { Robot } from './fake';
import { Chip } from './screens';
import { Go2View, manualUrl } from './go2status';

export type Found = { key: string; via: 'mdns' | 'addr' | 'ble'; name: string; host?: string; port?: number; model?: string; agent?: string; rid?: string; rssi?: number; mode?: 'discovery-only' | 'go2-readonly' };
export type Scan = { scanning: boolean; items: Found[]; problems: string[] };

const VIA = { mdns: 'Wi-Fi', addr: 'Wi-Fi', ble: '블루투스' } as const;
export const PROBLEM: Record<string, string> = {
  'wifi-no-internet': 'Wi-Fi 에 인터넷 없음 — 로봇 연결은 Wi-Fi, 서버는 모바일 데이터로 합니다.',
  'wifi-off': 'Wi-Fi 가 꺼져 있거나 연결되지 않았습니다 — 로봇과 같은 Wi-Fi(또는 Go2 핫스팟)에 연결하세요.',
  'bt-off': '블루투스가 꺼져 있습니다 — 켜면 Go2 를 블루투스로도 찾습니다.',
  'bt-perm': '블루투스 찾기 권한이 거부되어 Wi-Fi 로만 찾았습니다. 설정 › 앱 › FOOTHOLD › 권한에서 «주변 기기»(Android 11 이하는 «위치»)를 허용하세요.',
  'loc-off': 'Android 11 이하에서는 위치(GPS)를 켜야 블루투스 찾기가 됩니다.',
  'bt-fail': '블루투스 찾기를 시작하지 못했습니다. 잠시 뒤 «다시 찾기»를 누르세요.',
  'mdns-fail': 'Wi-Fi 에서 FOOTHOLD 에이전트 찾기를 시작하지 못했습니다. 잠시 뒤 «다시 찾기»를 누르세요.',
};
/** 앱이 이 시간 안에 아무 답도 없으면 찾기를 모르는 옛 앱(1.2.1-dev 이하) */
export const NO_APP_MS = 3000;

const str = (v: unknown, max = 200) => (typeof v === 'string' && v && v.length <= max ? v : undefined);
const num = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) ? v : undefined);

/** 앱이 보낸 이벤트 detail → Scan. 다른 seq(지난 찾기)·모양이 틀린 값은 null, 틀린 항목은 뺀다 */
export function parse(d: unknown, seq: string): Scan | null {
  const o = d as { seq?: unknown; scanning?: unknown; items?: unknown; problems?: unknown } | null;
  if (!o || typeof o !== 'object' || o.seq !== seq || !Array.isArray(o.items) || !Array.isArray(o.problems)) return null;
  const items: Found[] = [];
  for (const x of o.items as Record<string, unknown>[]) {
    const key = str(x?.key), via = x?.via, name = str(x?.name, 40);
    if (!key || !name || (via !== 'mdns' && via !== 'addr' && via !== 'ble')) continue;
    items.push({ key, via, name, host: str(x.host, 15), port: num(x.port), model: str(x.model, 40), agent: str(x.agent), rid: str(x.rid, 64), rssi: num(x.rssi), mode: x.mode === 'discovery-only' || x.mode === 'go2-readonly' ? x.mode : undefined });
  }
  return { scanning: o.scanning === true, items, problems: (o.problems as unknown[]).filter((p): p is string => typeof p === 'string') };
}

/** 한 로봇이 여러 길로 보이면 하나로: 같은 rid 의 에이전트는 처음 것만, 에이전트가 보인 주소의 «Go2 기본 주소» 응답은 뺀다. 순서 = 에이전트 → 기본 주소 → 블루투스 */
export function merge(items: Found[]): Found[] {
  const rids = new Set<string>(), keys = new Set<string>(), agents = new Set(items.filter((i) => i.via === 'mdns').map((i) => i.host));
  const out = items.filter((i) => {
    if (keys.has(i.key)) return false;
    keys.add(i.key);
    if (i.via === 'mdns' && i.rid) { if (rids.has(i.rid)) return false; rids.add(i.rid); }
    return !(i.via === 'addr' && agents.has(i.host));
  });
  const rank = { mdns: 0, addr: 1, ble: 2 };
  return out.sort((a, b) => rank[a.via] - rank[b.via]);
}

/** 항목을 눌렀을 때 안내. 폰에서 쓸 연결 등록 API 는 아직 없다(POST /robots 는 총괄 등록이고, 받은 에이전트 토큰을 로봇에 넣는 길이 없음) */
export function detail(f: Found, robots: Robot[]): string {
  if (f.via !== 'mdns') return 'Go2 발견 — FOOTHOLD 에이전트가 아직 없음(설치 필요). 로봇 온보드 컴퓨터에 에이전트를 설치·실행하면 Wi-Fi 에서 «에이전트 발견»으로 보입니다.';
  if (f.mode === 'discovery-only') return '찾기 시험 신호 — 실제 연결 아님. 등록·연결하지 않습니다.';
  if (f.mode === 'go2-readonly') return `상태 전용 에이전트: ${f.name} ${f.host ?? ''}${f.port ? `:${f.port}` : ''} — 로봇 쪽 8자리 현장 코드를 넣으면 배터리·자세만 읽습니다(조종·등록·STOP 없음).`;
  const mine = f.rid && robots.find((r) => r.id === f.rid);
  if (mine) return `이미 내 조직에 등록된 로봇입니다(${mine.name}). 에이전트가 서버에 접속하면 «내 로봇»에서 «연결됨»으로 바뀝니다.`;
  return `에이전트 발견: ${f.name} ${f.host ?? ''}${f.port ? `:${f.port}` : ''} — 연결 등록은 서버 준비 중입니다.`;
}

function status(f: Found, robots: Robot[]) {
  if (f.via !== 'mdns') return f.via === 'ble' ? `에이전트 없음${f.rssi != null ? ` · 신호 ${f.rssi} dBm` : ''}` : '에이전트 없음 · 기본 주소 응답';
  if (f.mode === 'discovery-only') return '찾기 시험 신호 — 실제 연결 아님';
  if (f.mode === 'go2-readonly') return '상태 전용 에이전트';
  return f.rid && robots.some((r) => r.id === f.rid) ? '에이전트 발견 · 내 조직 로봇' : '에이전트 발견';
}

/** «주변 로봇 찾기» 화면(«내 로봇» 카드 자리). 들어오면 바로 찾기, «다시 찾기» = 새 seq */
export function Nearby({ robots, close }: { robots: Robot[]; close: () => void }) {
  const [seq, setSeq] = useState(1), [scan, setScan] = useState<Scan | null>(null), [open, setOpen] = useState<string | null>(null), [old, setOld] = useState(false);
  const [view, setView] = useState<{ name: string; url: string } | null>(null), [ip, setIp] = useState('');
  useEffect(() => {
    setScan(null); setOld(false); setOpen(null);
    const on = (e: Event) => { const s = parse((e as CustomEvent).detail, String(seq)); if (s) setScan(s); };
    window.addEventListener('fh-nearby', on);
    const t = setTimeout(() => setOld(true), NO_APP_MS);
    return () => { window.removeEventListener('fh-nearby', on); clearTimeout(t); };
  }, [seq]);
  const items = merge(scan?.items ?? []), busy = !scan || scan.scanning, typed = manualUrl(ip);
  if (view) return <Go2View {...view} close={() => setView(null)} />;
  return <section className="lv-card" style={{ flexBasis: '100%' }} aria-label="주변 로봇 찾기" data-nearby-scan={seq}>
    <div className="fh-row"><h2 className="fh-grow">주변 로봇 찾기</h2><button type="button" className="btn" onClick={close}>닫기</button></div>
    {!scan && old ? <p className="fh-why" role="status" data-nearby="old">이 앱 판은 주변 찾기를 지원하지 않습니다 — FOOTHOLD 앱을 1.2.2-dev 이상으로 업데이트하세요.</p>
      : <p className="lv-note" role="status" data-nearby={busy ? 'scanning' : 'done'}>{busy ? `찾는 중… (Wi-Fi·블루투스, 약 10초)${items.length ? ` — ${items.length}대 찾음` : ''}` : items.length ? `${items.length}대 찾았습니다.` : '찾은 로봇이 없습니다.'}</p>}
    {scan?.problems.map((p) => PROBLEM[p] && <p key={p} className="fh-why" data-nearby-problem={p}>{PROBLEM[p]}</p>)}
    {items.length > 0 && <ul className="dv-cards">{items.map((f) => <li key={f.key} className="card dv-card">
      <button type="button" className="btn" style={{ textAlign: 'left', flexDirection: 'column', alignItems: 'flex-start' }} aria-expanded={open === f.key} onClick={() => setOpen(open === f.key ? null : f.key)}>
        <span className="fh-row"><b>{f.name}</b><Chip tone="off" text={VIA[f.via]} /></span>
        <span className="lbl">{status(f, robots)}{f.host ? ` · ${f.host}` : ''}{f.model ? ` · ${f.model}` : ''}</span>
      </button>
      {open === f.key && <span className="fh-why" data-nearby-detail>{detail(f, robots)}</span>}
      {open === f.key && f.mode === 'go2-readonly' && f.agent && <button type="button" className="btn pri" onClick={() => setView({ name: f.name, url: f.agent! })}>상태 보기</button>}
    </li>)}</ul>}
    <button type="button" className="btn pri" disabled={busy && !old} onClick={() => setSeq((n) => n + 1)}>다시 찾기</button>
    <form className="fh-row" onSubmit={(e) => { e.preventDefault(); if (typed) setView({ name: `Go2 ${ip.trim()}`, url: typed }); }}>
      <label className="fh-field fh-grow"><span className="lbl">안 보이면 주소 직접 넣기(상태 전용, 사설 IPv4)</span><input className="inp" value={ip} onChange={(e) => setIp(e.target.value)} inputMode="decimal" autoComplete="off" placeholder="192.168.12.x" data-go2-ip /></label>
      <button type="submit" className="btn" disabled={!typed}>상태 보기</button>
    </form>
    <p className="lv-note">Wi-Fi 찾기는 폰과 로봇이 같은 망(같은 공유기 또는 Go2 핫스팟)일 때만 됩니다. 블루투스는 로봇 근처에서만 보입니다. 찾기·표시만 하고 로봇 설정은 바꾸지 않습니다.</p>
  </section>;
}
