/** Preview transport only; tickets and phone protocol stay end to end. */
export const PHONE_PROXY = '/__fh_phone';
// Deliberately narrower than simmgr's general service allowlist (9430..9449).
// first_launch.py provisions 9433; test_manager.py provisions two slots at 9433/9434.
// launcher.py passes slot.port unchanged to FOOTHOLD_PHONE_PORT. Never admit
// manager 9430, API/DB 9431, preview 9440, or extra/production service ports.
export const PHONE_PORT_RANGE = '9433:9434';
export function phonePortAllowed(port: number, ports: readonly number[]): boolean {
  return Number.isInteger(port) && port >= 9433 && port <= 9434 && ports.includes(port);
}
export function phonePorts(value = PHONE_PORT_RANGE): number[] {
  const m = /^(\d{4}):(\d{4})$/.exec(value);
  const first = Number(m?.[1]), last = Number(m?.[2]);
  const ports = [9433, 9434];
  if (!m || first > last || !phonePortAllowed(first, ports) || !phonePortAllowed(last, ports)) {
    console.warn('Invalid FH_PHONE_PORT_RANGE: only subsets of 9433:9434 allowed; phone tunnel proxy disabled');
    return [];
  }
  return Array.from({ length: last - first + 1 }, (_, n) => first + n);
}

/** 에이전트 폰 포트의 고정 WS 경로 셋 — 조종(/phone/ws)·영상(§13.8)·관측 media/1. 이 밖은 중계하지 않는다 */
export const PHONE_ROUTES = ['ws', 'camera/ws', 'media/ws'] as const;
export function phoneUrl(address: string, page: Pick<Location, 'hostname' | 'host' | 'protocol'>,
  kind: '' | 'camera' | 'media' = '', ports = phonePorts(import.meta.env.FH_PHONE_PORT_RANGE)): string | null {
  try {
    const u = new URL(address);
    if (!['ws:', 'wss:'].includes(u.protocol) || u.pathname !== '/phone/ws' || u.search || u.hash || u.username || u.password) return null;
    if (kind) u.pathname = `/phone/${kind}/ws`;
    if (['localhost', '127.0.0.1', '[::1]'].includes(page.hostname)) return u.href;
    // No remote targets or arbitrary local services through the preview proxy.
    if (!['localhost', '127.0.0.1', '[::1]'].includes(u.hostname) || !phonePortAllowed(Number(u.port), ports)) return null;
    if (!['http:', 'https:'].includes(page.protocol)) return null;
    return `${page.protocol === 'https:' ? 'wss:' : 'ws:'}//${page.host}${PHONE_PROXY}/${u.port}${u.pathname}`;
  } catch { return null; }
}
