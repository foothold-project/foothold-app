// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { request } from 'node:http';
import { createServer } from 'vite';
import { localSim, simDir } from '../../localsim';

const cleanup = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()(); });

/** 웹 앱 자리(APP) 하나와 시뮬 자리 하나를 임시로 만들고 vite 개발 서버를 띄운다 */
async function serve(withSim, port) {
  const base = mkdtempSync(join(tmpdir(), 'fh-localsim-'));
  cleanup.push(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, 'web'), sim = join(base, 'sim');
  mkdirSync(root);
  writeFileSync(join(root, 'index.html'), '<!doctype html><title>APP</title>');
  writeFileSync(join(base, 'secret.txt'), 'SECRET');
  if (withSim) {
    mkdirSync(join(sim, 'mujoco'), { recursive: true });
    writeFileSync(join(sim, 'index.html'), '<!doctype html><title>SIM</title>');
    writeFileSync(join(sim, 'mujoco/mujoco.wasm'), 'WASM');
    symlinkSync(join(base, 'secret.txt'), join(sim, 'leak.txt'));
  }
  const server = await createServer({ configFile: false, root, logLevel: 'silent', appType: 'spa',
    plugins: [localSim(sim)], server: { host: '127.0.0.1', port, strictPort: true } });
  await server.listen();
  cleanup.push(() => server.close());
  // fetch 는 %2e%2e 를 미리 풀어 버리므로 경로를 글자 그대로 보내는 http.request 를 쓴다
  return (path, method = 'GET') => new Promise((ok, fail) => {
    const req = request({ host: '127.0.0.1', port, path, method }, (res) => {
      let body = ''; res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => ok({ status: res.statusCode, type: res.headers['content-type'] ?? '', body }));
    });
    req.on('error', fail); req.end();
  });
}

describe('로컬 개발 서버의 /sim/', () => {
  it('준비된 시뮬 폴더가 있으면 그 파일을 웹 앱 대신 준다', async () => {
    const get = await serve(true, 9581);
    for (const path of ['/sim/index.html', '/sim/index.html?from=web&map=x', '/sim/']) {
      const r = await get(path);
      expect(r.status).toBe(200);
      expect(r.type).toContain('text/html');
      expect(r.body).toContain('SIM');
    }
    const wasm = await get('/sim/mujoco/mujoco.wasm');
    expect([wasm.status, wasm.type, wasm.body]).toEqual([200, 'application/wasm', 'WASM']);
    expect((await get('/sim')).status).toBe(301);
    expect((await get('/')).body).toContain('APP');   // 웹 앱은 그대로
  });

  it('시뮬 폴더 안에 없는 파일은 웹 앱으로 대신하지 않고 404', async () => {
    const get = await serve(true, 9582);
    const r = await get('/sim/no-such-file.js');
    expect(r.status).toBe(404);
    expect(r.body).not.toContain('APP');
  });

  it('시뮬 폴더 밖으로 나가는 경로 · 바깥을 가리키는 링크 · 쓰기 요청은 막는다', async () => {
    const get = await serve(true, 9583);
    for (const path of ['/sim/%2e%2e/secret.txt', '/sim/..%2fsecret.txt', '/sim/leak.txt', '/sim/%00', '/sim/%zz']) {
      const r = await get(path);
      expect(r.status, path).toBeGreaterThanOrEqual(400);
      expect(r.body, path).not.toContain('SECRET');
      expect(r.body, path).not.toContain('APP');
    }
    expect((await get('/sim/index.html', 'POST')).status).toBe(405);
  });

  it('시뮬 폴더가 없으면 웹 앱이 아니라 만드는 명령 한 줄 안내를 준다', async () => {
    const get = await serve(false, 9584);
    for (const path of ['/sim/index.html?from=web&map=x', '/sim/', '/sim/mujoco/mujoco.wasm']) {
      const r = await get(path);
      expect(r.status, path).toBe(404);
      expect(r.type, path).toContain('text/html');
      expect(r.body, path).toContain('시뮬 파일이 없습니다');
      expect(r.body, path).toContain('python3 deploy/prepare_sim.py mobile/sim');
      expect(r.body, path).toContain('FH_SIM_DIR');
      expect(r.body, path).not.toContain('APP');
    }
    expect((await get('/')).body).toContain('APP');
  });

  it('경로는 FH_SIM_DIR 하나로 받고, 없으면 저장소 안 dist/sim', () => {
    const web = resolve(__dirname, '../..');
    expect(simDir({})).toBe(join(web, 'dist/sim'));
    expect(simDir({ FH_SIM_DIR: '  ' })).toBe(join(web, 'dist/sim'));
    expect(simDir({ FH_SIM_DIR: '/x/sim' })).toBe('/x/sim');
    expect(simDir({ FH_SIM_DIR: 'out/sim' })).toBe(join(web, 'out/sim'));
  });
});
