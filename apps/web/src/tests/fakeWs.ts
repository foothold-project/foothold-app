// 시험용 WebSocket(서버 흉내). 모든 시험에서 전역 WebSocket 을 이것으로 바꾼다(setup.ts) — 진짜 연결 0.
// open()·recv()·drop() 으로 서버 쪽을 움직이고, sent 로 화면이 보낸 것을 본다. auto = 받은 요청에 바로 답(null 이면 답 안 함).
import type { ScreenReply, ScreenState } from '../../../contracts/ts';

export type Msg = { t: string; id: string; proto?: string; robot?: string; [k: string]: unknown };
type Handler = ((e: { code?: number; data?: string }) => void) | null;

export class FakeWS {
  static all: FakeWS[] = [];
  static get last() { return FakeWS.all[FakeWS.all.length - 1]; }
  readyState = 0;
  sent: Msg[] = [];
  onopen: Handler = null; onmessage: Handler = null; onclose: Handler = null; onerror: Handler = null;
  auto: ((m: Msg) => Partial<ScreenReply> | void) | null = () => ({ ok: true });
  constructor(readonly url: string) { FakeWS.all.push(this); }
  send(data: string) {
    const m = JSON.parse(data) as Msg, r = this.auto?.(m);
    this.sent.push(m);
    if (r) this.recv({ t: 'reply', id: m.id, ok: true, ...r });
  }
  close(code = 1000) { if (this.readyState !== 3) this.drop(code); }
  open() { if (this.readyState !== 0) return; this.readyState = 1; this.onopen?.({}); }   // 닫힌(버린) 소켓은 열리지 않는다
  recv(m: object) { this.onmessage?.({ data: JSON.stringify(m) }); }
  drop(code: number) { this.readyState = 3; this.onclose?.({ code }); }
  of(t: string) { return this.sent.filter((m) => m.t === t); }
}

export const state = (robot: string, p: Partial<ScreenState> = {}): ScreenState => ({ t: 'state', robot, connection: 'ONLINE', status: 'IDLE',
  battery: { soc: 80, updated_at: '2026-10-19T00:00:00Z' }, location: null, devices: [], speed: 0, latency_ms: null, latched: true, stop_gen: 1, applied: [0, 0, 0], ...p });
export const lease = (robot: string, holder: { id: string | null; name: string; type?: 'USER' | 'RUN' } | null, lease_id: string | null = null) =>
  ({ t: 'lease', robot, holder: holder && { holder_type: holder.type ?? 'USER', user: holder.id ? { id: holder.id, display_name: holder.name } : null }, lease_id, since: null });
export const fail = (code: string, message = '') => ({ ok: false, error: { code, message, detail: {} } });
