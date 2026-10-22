import type { Plugin, ProxyOptions } from 'vite';
import { PHONE_PROXY, phonePorts } from './src/phoneTransport';

export function tunnelOrigin(env: Record<string, string>): string | null {
  if (env.FH_TUNNEL !== '1') return null;
  const origin = env.FH_TUNNEL_ORIGIN || '';
  if (origin !== origin.trim() || !/^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.trycloudflare\.com$/.test(origin)) {
    console.warn('FH_TUNNEL_ORIGIN must be an exact HTTPS Quick Tunnel origin; tunnel disabled');
    return null;
  }
  return origin;
}

export function hostAllowed(host: string | undefined, origin: string | null): boolean {
  if (!host || /[\s/@?#\\]/.test(host)) return false;
  try {
    const parsed = new URL(`http://${host}`);
    const name = parsed.hostname;
    return ['localhost', '127.0.0.1', '[::1]'].includes(name) || name.endsWith('.localhost')
      || (origin !== null && host === new URL(origin).host);
  } catch { return false; }
}

export function phoneProxy(env: Record<string, string>): Record<string, ProxyOptions> {
  if (!tunnelOrigin(env)) return {};
  return Object.fromEntries(phonePorts(env.FH_PHONE_PORT_RANGE).map((port) => [
    `^${PHONE_PROXY}/${port}/phone/(ws|camera/ws)$`,
    { target: `http://127.0.0.1:${port}`, ws: true,
      rewrite: (path: string) => path.slice(`${PHONE_PROXY}/${port}`.length) },
  ]));
}

/** Vite 5.4.10 predates allowedHosts. Guard HTTP and upgrades before its proxies. */
export function tunnelGuard(origin: string | null, ports: number[]): Plugin {
  type Request = { url?: string; headers: { host?: string; origin?: string; 'sec-websocket-protocol'?: string } };
  const paths = new Set(ports.flatMap((port) => [
    `${PHONE_PROXY}/${port}/phone/ws`, `${PHONE_PROXY}/${port}/phone/camera/ws`,
  ]));
  return {
    name: 'fh-preview-host-and-phone-guard',
    configureServer(server) {
      const permitted = (req: Request, upgrade: boolean) =>
        hostAllowed(req.headers.host, origin) && (!req.url?.startsWith(PHONE_PROXY)
          || (upgrade && origin !== null && req.headers.origin === origin && paths.has(req.url)));
      server.middlewares.use((req, res, next) => {
        if (permitted(req as unknown as Request, false)) return next();
        res.statusCode = 403; res.end('Preview request denied');
      });
      server.httpServer?.prependListener('upgrade', (req: Request, socket: { end: (value: string) => void }) => {
        if (permitted(req, true)) return;
        // Later Vite listeners must not match a proxy or HMR upgrade after denial.
        req.url = '/__fh_denied'; delete req.headers['sec-websocket-protocol'];
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      });
    },
  };
}
