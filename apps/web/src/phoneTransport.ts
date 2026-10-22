/** Preview transport only; tickets and phone protocol stay end to end. */
export const PHONE_PROXY = '/__fh_phone';
export function phonePorts(value = '9430:9449'): number[] {
  const m = /^(\d{4,5}):(\d{4,5})$/.exec(value);
  const first = Number(m?.[1]), last = Number(m?.[2]);
  if (!m || first < 1024 || last > 65535 || first > last || last - first > 99) throw new Error('Invalid FH_PHONE_PORT_RANGE');
  return Array.from({ length: last - first + 1 }, (_, n) => first + n);
}

export function phoneUrl(address: string, page: Pick<Location, 'hostname' | 'host' | 'protocol'>,
  camera = false, ports = phonePorts(import.meta.env.FH_PHONE_PORT_RANGE || undefined)): string | null {
  try {
    const u = new URL(address);
    if (!['ws:', 'wss:'].includes(u.protocol) || u.pathname !== '/phone/ws' || u.search || u.hash || u.username || u.password) return null;
    if (camera) u.pathname = '/phone/camera/ws';
    if (['localhost', '127.0.0.1', '[::1]'].includes(page.hostname)) return u.href;
    // No remote targets or arbitrary local services through the preview proxy.
    if (!['localhost', '127.0.0.1', '[::1]'].includes(u.hostname) || !ports.includes(Number(u.port))) return null;
    if (!['http:', 'https:'].includes(page.protocol)) return null;
    return `${page.protocol === 'https:' ? 'wss:' : 'ws:'}//${page.host}${PHONE_PROXY}/${u.port}${u.pathname}`;
  } catch { return null; }
}
