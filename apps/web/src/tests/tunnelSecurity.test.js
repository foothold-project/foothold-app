// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { request } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer, preview, resolveConfig } from 'vite';
import { phonePorts, phoneUrl } from '../phoneTransport';
import { phoneProxy, tunnelGuard } from '../../tunnel';

const origin = 'https://example.trycloudflare.com';
const env = { FH_TUNNEL: '1', FH_TUNNEL_ORIGIN: origin };
// 듣는 포트는 검증용 9480..9489 안에서 tunnel.test.js(9480)와 따로 — 병렬 작업자가 같은 포트를 잡지 않게
const LISTEN = 9482;
const cleanup = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()(); vi.unstubAllEnvs(); });
const get = (path) => new Promise((resolve, reject) => {
  const req = request({ host: '127.0.0.1', port: LISTEN, path, headers: { host: new URL(origin).host } }, (res) => {
    let body = ''; res.on('data', (data) => { body += data; });
    res.on('end', () => resolve({ status: res.statusCode, body }));
  });
  req.on('error', reject); req.end();
});

it('always excludes service ports, including widened environment and caller-supplied port lists', () => {
  const forbidden = [9430, 9431, 9432, 9440, 8870, 8453, 8792, 9481];
  for (const port of forbidden) {
    expect(phonePorts()).not.toContain(port);
    expect(phoneProxy({ ...env, FH_PHONE_PORT_RANGE: `${port}:${port}` })).toEqual({});
    expect(phoneUrl(`ws://127.0.0.1:${port}/phone/ws`, new URL(origin), 'media', [port])).toBeNull();
  }
  for (const range of ['9430:9449', '8453:9449', '9433:9489', 'bad', '']) {
    expect(phoneProxy({ ...env, FH_PHONE_PORT_RANGE: range })).toEqual({});
    expect(phoneUrl('ws://127.0.0.1:9433/phone/ws', new URL(origin), 'media', phonePorts(range))).toBeNull();
  }
});

it('blocks the exact raw-import file attack and development internals on tunnel Hosts', async () => {
  const folder = await mkdtemp(resolve('../../tmp/phone-tunnel/attack-'));
  cleanup.push(() => rm(folder, { recursive: true, force: true }));
  const root = resolve(folder, 'web'); await mkdir(resolve(root, 'dist'), { recursive: true });
  await writeFile(resolve(root, 'dist/index.html'), '<h1>static build</h1>');
  const marker = 'PRIVATE-TUNNEL-ATTACK-MARKER';
  const secret = resolve(folder, 'private.txt'); await writeFile(secret, marker);
  // Both hooks must enforce the same policy: dev disables tunnel access entirely.
  const dev = await createServer({ configFile: false, root, cacheDir: resolve(folder, 'cache'), logLevel: 'silent',
    plugins: [tunnelGuard(origin, phonePorts())],
    server: { host: '127.0.0.1', port: LISTEN, strictPort: true, hmr: false, watch: { ignored: ['**/*'] } } });
  await dev.listen();
  try {
    const attack = await get(`/@fs/${secret}?import&raw??`);
    expect(attack.status).toBe(403); expect(attack.body).toBe('');
    expect((await get('/')).status).toBe(403);
  } finally { await dev.close(); }
  const server = await preview({ configFile: false, root, logLevel: 'silent',
    plugins: [tunnelGuard(origin, phonePorts())],
    preview: { host: '127.0.0.1', port: LISTEN, strictPort: true } });
  cleanup.push(() => new Promise((resolve) => { server.httpServer.closeAllConnections(); server.httpServer.close(resolve); }));
  expect(await get('/')).toEqual({ status: 200, body: '<h1>static build</h1>' });
  for (const path of [`/@fs/${secret}?import&raw??`, '/@id/test', '/@vite/client', '/__vite_ping', '/node_modules/test', '/src/test.ts', '/%40fs/private?import&raw??']) {
    const result = await get(path);
    expect(result.status, path).toBe(403); expect(result.body).toBe('');
  }
});

it('wires static preview API and phone proxies while dev refuses opt-in', async () => {
  vi.stubEnv('FH_TUNNEL', '1'); vi.stubEnv('FH_TUNNEL_ORIGIN', origin);
  vi.stubEnv('FH_PHONE_PORT_RANGE', '9433:9434');
  const configFile = resolve('vite.config.ts');
  const staticConfig = await resolveConfig({ configFile }, 'serve', 'production', 'production', true);
  expect(staticConfig.preview.proxy['/api'].ws).toBe(true);
  expect(staticConfig.preview.proxy['/api'].target).toBe('http://127.0.0.1:8810');
  expect(Object.values(staticConfig.preview.proxy).slice(1).map((p) => p.target))
    .toEqual(['http://127.0.0.1:9433', 'http://127.0.0.1:9434']);
  const devConfig = await resolveConfig({ configFile }, 'serve');
  expect(Object.keys(devConfig.server.proxy)).toEqual(['/api']);
  expect(devConfig.server.allowedHosts).toEqual([]);
});
