import { realpathSync, statSync, createReadStream } from 'node:fs';
import { extname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// 로컬 개발 서버의 /sim/. 배포는 deploy/prepare_sim.py 가 dist/sim 을 만들어 정적 서버가 준다.
// 개발 서버는 /sim/index.html 을 웹 앱으로 돌려주므로(SPA 대신 보기) 여기서 먼저 받는다.
// 이 웹 폴더에는 @types/node 가 없어 node 모듈을 쓰는 이 파일은 JS 로 두고 형은 localsim.d.ts 에 적는다.
// 시뮬 자산(정책 · wasm)의 자리는 아직 정하지 않았다: 경로는 FH_SIM_DIR 하나로만 받고, 기본값은 이 폴더 안 dist/sim.

const WEB = fileURLToPath(new URL('.', import.meta.url));

/** 준비된 시뮬 폴더(prepare_sim.py 결과의 sim). FH_SIM_DIR 이 상대 경로면 apps/web 기준 */
export function simDir(env) {
  const value = env.FH_SIM_DIR?.trim();
  if (!value) return join(WEB, 'dist/sim');
  return isAbsolute(value) ? value : join(WEB, value);
}

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8', '.wasm': 'application/wasm',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.xml': 'application/xml; charset=utf-8',
};

const MISSING = `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="color-scheme" content="light dark"><title>시뮬 파일 없음</title>
<body style="font:15px/1.6 system-ui,sans-serif;max-width:40rem;margin:3rem auto;padding:0 16px;word-break:keep-all">
<h1 style="font-size:20px">시뮬 파일이 없습니다</h1>
<p>로컬 개발 서버는 준비된 시뮬 폴더만 /sim/ 으로 보여 줍니다. 저장소 맨 위에서 한 번 만듭니다.</p>
<pre style="white-space:pre-wrap;padding:12px;border:1px solid #8884;border-radius:6px">python3 deploy/prepare_sim.py mobile/sim &lt;시뮬 자산 폴더&gt; apps/web/dist</pre>
<p>다른 곳에 만들었으면 FH_SIM_DIR 에 그 sim 폴더를 주고 개발 서버를 다시 켭니다. 웹을 빌드하면 dist 가 비워지므로 다시 만듭니다.</p>
</body></html>`;

function send(res, status, type, body, head) {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(head ? undefined : body);
}

/** 시뮬 폴더 안의 실제 파일만. 폴더 밖(.. · 바깥 링크) · 특수 파일은 null */
function inside(dir, rest) {
  let name;
  try { name = decodeURIComponent(rest); } catch { return null; }
  if (name.includes('\0') || name.includes('\\')) return null;
  const parts = name.split('/');
  if (parts.some((p) => p === '..' || p === '.')) return null;
  try {
    const root = realpathSync(dir), file = realpathSync(resolve(root, ...parts.filter(Boolean)));
    if (!file.startsWith(root + sep)) return null;
    return statSync(file).isFile() ? file : null;
  } catch { return null; }
}

function simHandler(dir) {
  return (req, res, next) => {
    const raw = req.url ?? '', q = raw.indexOf('?'), path = q < 0 ? raw : raw.slice(0, q), query = q < 0 ? '' : raw.slice(q);
    if (path !== '/sim' && !path.startsWith('/sim/')) return next();
    const head = req.method === 'HEAD';
    if (req.method !== 'GET' && !head) return send(res, 405, 'text/plain; charset=utf-8', 'GET 만 받습니다', false);
    if (path === '/sim') { res.writeHead(301, { location: `/sim/${query}` }); return res.end(); }
    if (!inside(dir, 'index.html')) return send(res, 404, 'text/html; charset=utf-8', MISSING, head);
    const rest = path.slice('/sim/'.length) || 'index.html', file = inside(dir, rest);
    if (!file) return send(res, 404, 'text/plain; charset=utf-8', '시뮬 폴더에 없는 파일입니다', head);
    res.writeHead(200, { 'content-type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    if (head) return res.end();
    createReadStream(file).on('error', () => res.destroy()).pipe(res);
  };
}

/** 개발 서버(serve)에만. 웹 앱의 SPA 대신 보기보다 먼저 /sim/ 을 받는다 */
/** @returns {import('vite').Plugin} */
export function localSim(dir) {
  return { name: 'fh-local-sim', apply: 'serve', configureServer(server) { server.middlewares.use(simHandler(dir)); } };
}

/** 시안 자산 폴더(사진 · 3D 모형 · 지도 그림, 저장소 밖). FH_ASSET_DIR 이 없으면 null (그 화면 칸은 비어 보임) */
export function assetDir(env) {
  const value = env.FH_ASSET_DIR?.trim();
  if (!value) return null;
  return isAbsolute(value) ? value : join(WEB, value);
}

const ASSET_TYPES = { ...TYPES, '.glb': 'model/gltf-binary', '.bin': 'application/octet-stream', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };

/** 개발 서버(serve)에만. /proto-assets/ 를 FH_ASSET_DIR 폴더 안의 실제 파일로만 준다 */
/** @returns {import('vite').Plugin} */
export function localAssets(dir) {
  const handler = (req, res, next) => {
    const raw = req.url ?? '', q = raw.indexOf('?'), path = q < 0 ? raw : raw.slice(0, q);
    if (!path.startsWith('/proto-assets/')) return next();
    const head = req.method === 'HEAD';
    if (req.method !== 'GET' && !head) return send(res, 405, 'text/plain; charset=utf-8', 'GET 만 받습니다', false);
    const file = dir ? inside(dir, path.slice('/proto-assets/'.length)) : null;
    if (!file) return send(res, 404, 'text/plain; charset=utf-8', '자산 폴더에 없는 파일입니다', head);
    res.writeHead(200, { 'content-type': ASSET_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    if (head) return res.end();
    createReadStream(file).on('error', () => res.destroy()).pipe(res);
  };
  return { name: 'fh-local-assets', apply: 'serve', configureServer(server) { server.middlewares.use(handler); } };
}
