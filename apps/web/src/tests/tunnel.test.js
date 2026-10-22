// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { createServer as httpServer, request } from 'node:http';
import { createServer } from 'vite';
import { hostAllowed, phoneProxy, tunnelGuard, tunnelOrigin } from '../../tunnel';

const origin = 'https://example.trycloudflare.com';
const env = { FH_TUNNEL: '1', FH_TUNNEL_ORIGIN: origin, FH_PHONE_PORT_RANGE: '9481:9481' };
const cleanup = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()(); });
const get = (path, headers = {}, upgrade = false) => new Promise((resolve, reject) => {
  const req = request({ host: '127.0.0.1', port: 9480, path, headers: { host: 'example.trycloudflare.com',
    ...upgrade ? { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13',
      'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' } : {}, ...headers } }, (res) => {
    res.resume(); res.on('end', () => resolve(res.statusCode));
  });
  req.on('error', reject); req.end();
});

describe('preview proxy boundary', () => {
  it('requires opt-in and one exact HTTPS Quick Tunnel origin', () => {
    expect(tunnelOrigin({ FH_TUNNEL_ORIGIN: origin })).toBeNull();
    expect(phoneProxy({})).toEqual({});
    expect(tunnelOrigin(env)).toBe(origin);
    for (const value of ['https://*.trycloudflare.com', 'http://example.trycloudflare.com', `${origin}/`,
      `${origin}.evil.invalid`, 'https://trycloudflare.com', `${origin}:443`, 'https://a.b.trycloudflare.com']) {
      expect(tunnelOrigin({ ...env, FH_TUNNEL_ORIGIN: value })).toBeNull();
    }
    expect(hostAllowed('evil.invalid', origin)).toBe(false);
    expect(hostAllowed('example.trycloudflare.com', null)).toBe(false);
    expect(hostAllowed('localhost:5190', null)).toBe(true);
    expect(Object.values(phoneProxy(env)).map((p) => p.target)).toEqual(['http://127.0.0.1:9481']);
  });
  it('forwards only the exact WS routes, preserving Origin, and refuses HTTP and malformed targets', async () => {
    const seen = [];
    const upstream = httpServer();
    upstream.on('upgrade', (req, socket) => {
      seen.push([req.url, req.headers.origin]);
      socket.end('HTTP/1.1 418 Test upstream\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    });
    await new Promise((resolve) => upstream.listen(9481, '127.0.0.1', resolve));
    cleanup.push(() => new Promise((resolve) => upstream.close(resolve)));
    const vite = await createServer({ configFile: false, root: process.cwd(), cacheDir: '../../tmp/phone-tunnel/vite-proxy-test',
      logLevel: 'silent', plugins: [tunnelGuard(origin, [9481])],
      server: { host: '127.0.0.1', port: 9480, strictPort: true, hmr: false, proxy: phoneProxy(env),
        watch: { ignored: ['**/*'] } } });
    await vite.listen(); cleanup.push(() => vite.close());
    for (const path of ['/phone/ws', '/phone/camera/ws']) {
      expect(await get(`/__fh_phone/9481${path}`, { origin }, true)).toBe(418);
    }
    expect(seen).toEqual([['/phone/ws', origin], ['/phone/camera/ws', origin]]);
    for (const path of ['/__fh_phone/8453/phone/ws', '/__fh_phone/127.0.0.1:9481/phone/ws',
      '/__fh_phone/9481/api/v1/ws', '/__fh_phone/9481/phone/ws?x=1', '/__fh_phone/9481/phone/ws/']) {
      expect(await get(path, { origin }, true)).toBe(403);
    }
    expect(await get('/__fh_phone/9481/phone/ws', { origin: 'https://evil.invalid' }, true)).toBe(403);
    expect(await get('/__fh_phone/9481/phone/ws', { origin, host: 'evil.invalid' }, true)).toBe(403);
    expect(await get('/__fh_phone/9481/phone/ws', { origin })).toBe(403);
    expect(await get('/', { host: 'evil.invalid' })).toBe(403);
    expect(seen).toHaveLength(2);
  });
});
