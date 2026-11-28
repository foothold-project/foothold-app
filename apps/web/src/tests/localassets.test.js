// @vitest-environment node
// 시안 자산 폴더(FH_ASSET_DIR)를 /proto-assets/ 로: 폴더 안 실제 파일만, 밖(.. · 바깥 링크)은 404, 폴더가 없으면 404
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { createServer } from 'vite';
import { assetDir, localAssets } from '../../localsim';

const cleanup = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()(); });

async function serve(dir, port) {
  const base = mkdtempSync(join(tmpdir(), 'fh-assets-'));
  cleanup.push(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, 'web'); mkdirSync(root);
  writeFileSync(join(root, 'index.html'), '<!doctype html><title>APP</title>');
  writeFileSync(join(base, 'secret.txt'), 'SECRET');
  let assets = null;
  if (dir) {
    assets = join(base, 'assets'); mkdirSync(join(assets, 'shared'), { recursive: true });
    writeFileSync(join(assets, 'shared/cam.jpg'), 'JPG');
    writeFileSync(join(assets, 'shared/go2.glb'), 'GLB');
    symlinkSync(join(base, 'secret.txt'), join(assets, 'leak.txt'));
  }
  const server = await createServer({ configFile: false, root, logLevel: 'silent', appType: 'spa',
    plugins: [localAssets(assets)], server: { host: '127.0.0.1', port, strictPort: true } });
  await server.listen();
  cleanup.push(() => server.close());
  return (path) => new Promise((ok, fail) => {
    const req = request({ host: '127.0.0.1', port, path }, (res) => {
      let body = ''; res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => ok({ status: res.statusCode, type: res.headers['content-type'] ?? '', body }));
    });
    req.on('error', fail); req.end();
  });
}

describe('시안 자산 폴더 /proto-assets/', () => {
  it('폴더 안 파일은 종류에 맞게 준다', async () => {
    const get = await serve(true, 5291);
    expect(await get('/proto-assets/shared/cam.jpg')).toMatchObject({ status: 200, type: 'image/jpeg', body: 'JPG' });
    expect(await get('/proto-assets/shared/go2.glb')).toMatchObject({ status: 200, type: 'model/gltf-binary', body: 'GLB' });
  });
  it('폴더 밖 (.. · %2e%2e · 바깥 링크) 은 404', async () => {
    const get = await serve(true, 5292);
    for (const p of ['/proto-assets/../secret.txt', '/proto-assets/%2e%2e/secret.txt', '/proto-assets/leak.txt']) {
      const r = await get(p);
      expect(r.body).not.toContain('SECRET');
      expect(r.status === 404 || r.body.includes('APP')).toBe(true);
    }
  });
  it('FH_ASSET_DIR 이 없으면 null, 요청은 404', async () => {
    expect(assetDir({})).toBeNull();
    expect(assetDir({ FH_ASSET_DIR: '/x/y' })).toBe('/x/y');
    const get = await serve(false, 5293);
    expect((await get('/proto-assets/shared/cam.jpg')).status).toBe(404);
  });
});
