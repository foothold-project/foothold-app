// 시뮬 지도 «위에서 본 사진»(mobile/sim/assets/<이름>/top.png): 앱 시뮬과 같은 three.js 장면(scene.json 메시·색·빛)을
// 직교 카메라로 바로 위에서 그려 PNG 로 굽는다. 범위 = 장면 메시의 xy 경계 + 둘레 PAD m, 1 m = PX 화소.
// three 는 커밋하지 않으므로 FH_SIM_SRC/vendor 에서 읽고, 그림은 headless Chrome(창 없음, 임시 프로필)으로 로컬 파일을 읽는다(포트·서버 없음).
// 사진 옆 top.json = 사진이 덮는 지도 좌표 범위 [x0, y0, x1, y1](m) + 그 지도 판(origin·res·w·h) — 웹이 장애물 지도 밑에 깔 때 이 값으로만 맞춘다.
// 실행: FH_SIM_SRC=<RS-6 시뮬 폴더> node scripts/make-top.mjs [이름 …]   (이름 없으면 maps.json 전부). --meta = 그림 없이 top.json 만(three 불필요)
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const PX = 24, PAD = 0.3;
const here = dirname(dirname(fileURLToPath(import.meta.url))), simDir = join(here, 'sim'), src = process.env.FH_SIM_SRC;
const meta = process.argv.includes('--meta'), args = process.argv.slice(2).filter((a) => a !== '--meta');
if (!src && !meta) throw new Error('FH_SIM_SRC=<RS-6 시뮬 폴더> 가 필요합니다(three 는 저장소에 없음)');
const chrome = process.env.CHROME || 'google-chrome';
const ids = args.length ? args : JSON.parse(readFileSync(join(simDir, 'maps.json'), 'utf8')).map((m) => m.id);

/** 장면 메시를 모델 자세(quat = w,x,y,z)로 옮긴 xy 경계 + PAD */
function bounds(sc, map) {
  const b = [map.origin[0], map.origin[1], map.origin[0] + map.w * map.res, map.origin[1] + map.h * map.res];
  for (const { mesh, pos, quat: [w, x, y, z] } of sc.models) {
    const p = sc.meshes[mesh].p;
    for (let k = 0; k < p.length; k += 3) {
      const [vx, vy, vz] = [p[k], p[k + 1], p[k + 2]];
      const X = pos[0] + (1 - 2 * (y * y + z * z)) * vx + 2 * (x * y - w * z) * vy + 2 * (x * z + w * y) * vz;
      const Y = pos[1] + 2 * (x * y + w * z) * vx + (1 - 2 * (x * x + z * z)) * vy + 2 * (y * z - w * x) * vz;
      b[0] = Math.min(b[0], X); b[1] = Math.min(b[1], Y); b[2] = Math.max(b[2], X); b[3] = Math.max(b[3], Y);
    }
  }
  return [b[0] - PAD, b[1] - PAD, b[2] + PAD, b[3] + PAD];
}

const page = (scenePath, textureURLs, b, W, H) => `<!doctype html><meta charset="utf-8"><script type="module">
import * as THREE from '${pathToFileURL(join(src, 'vendor/three.module.js'))}';
const sc = await (await fetch('${pathToFileURL(scenePath)}')).json(), textureURLs = ${JSON.stringify(textureURLs)}, [x0, y0, x1, y1] = ${JSON.stringify(b)};
const w = x1 - x0, h = y1 - y0, cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
const r = new THREE.WebGLRenderer({ antialias: true }); r.setPixelRatio(1); r.setSize(${W}, ${H});
const s = new THREE.Scene(); s.background = new THREE.Color(0x14171c);
s.add(new THREE.HemisphereLight(0xffffff, 0x404048, 1.6));
const sun = new THREE.DirectionalLight(0xffffff, 1.4); sun.position.set(-4, -6, 10); s.add(sun);
const cache = {}, textures = {};
for (const md of sc.models) {   // main.js 와 같은 방식(quat = w,x,y,z)
  const g = cache[md.mesh] ??= (() => { const m = sc.meshes[md.mesh], b = new THREE.BufferGeometry();
    b.setAttribute('position', new THREE.Float32BufferAttribute(m.p, 3)); b.setIndex(m.i);
    if (m.uv) b.setAttribute('uv', new THREE.Float32BufferAttribute(m.uv, 2)); b.computeVertexNormals(); return b; })();
  const texture = md.texture ? (textures[md.texture] ??= await new THREE.TextureLoader().loadAsync(textureURLs[md.texture])) : null;
  if (texture) { texture.colorSpace = THREE.SRGBColorSpace;
    if (md.texture_repeat) texture.wrapS = texture.wrapT = THREE.RepeatWrapping; }
  const o = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ color: new THREE.Color(...md.color), map: texture, flatShading: !!md.flat_shading, side: THREE.DoubleSide }));
  o.position.set(...md.pos); o.quaternion.set(md.quat[1], md.quat[2], md.quat[3], md.quat[0]); s.add(o);
}
const cam = new THREE.OrthographicCamera(-w / 2, w / 2, h / 2, -h / 2, 0.1, 200);
cam.up.set(0, 1, 0); cam.position.set(cx, cy, 100); cam.lookAt(cx, cy, 0);
r.render(s, cam);
document.body.textContent = r.domElement.toDataURL('image/png');   // 화면 크기와 무관하게 그린 그대로(--dump-dom 으로 받음)
</script>`;

for (const id of ids) {
  if (!/^[a-z0-9-]+$/.test(id)) throw new Error(`지도 이름은 [a-z0-9-] 만: ${id}`);
  const dir = join(simDir, 'assets', id), map = JSON.parse(readFileSync(join(dir, 'map.json'), 'utf8'));
  const b = bounds(JSON.parse(readFileSync(join(dir, 'scene.json'), 'utf8')), map);
  const W = Math.round((b[2] - b[0]) * PX), H = Math.round((b[3] - b[1]) * PX);
  const previous = existsSync(join(dir, 'top.json')) ? JSON.parse(readFileSync(join(dir, 'top.json'), 'utf8')) : {};
  const floors = previous.floors;
  writeFileSync(join(dir, 'top.json'), JSON.stringify({ bounds: b, px: [W, H], map: { origin: map.origin, res: map.res, w: map.w, h: map.h }, ...(floors ? { floors } : {}) }) + '\n');
  if (meta) { console.log(`${id}: top.json ${W}×${H}`); continue; }
  const shots = [{ top: 'top.png', scene: 'scene.json' }, ...(floors ?? []).map((f) => ({ top: f.top, scene: `scene-${f.id}.json` }))];
  for (const shot of shots) {
    const scenePath = join(dir, shot.scene), scene = JSON.parse(readFileSync(scenePath, 'utf8')), textureURLs = {};
    for (const { texture } of scene.models) if (texture) {
      if (typeof texture !== 'string' || !/^[a-z0-9_-]+\.png$/.test(texture)) throw new Error('장면 재질 파일 형식');
      textureURLs[texture] = pathToFileURL(join(dir, texture)).href;
    }
    const prof = mkdtempSync(join(tmpdir(), 'fh-top-')), out = join(dir, shot.top), html = join(prof, 'top.html');
    writeFileSync(html, page(scenePath, textureURLs, b, W, H));
    try {
      const { stdout } = await promisify(execFile)(chrome, ['--headless=new', `--user-data-dir=${prof}`, '--no-first-run', '--allow-file-access-from-files', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
        '--virtual-time-budget=15000', '--dump-dom', pathToFileURL(html).href], { timeout: 120_000, maxBuffer: 64 << 20 });
      const png = stdout.match(/data:image\/png;base64,([A-Za-z0-9+/=]+)/);
      if (!png) throw new Error(`${id}/${shot.top}: 그림을 받지 못함(WebGL 실패?)`);
      writeFileSync(out, Buffer.from(png[1], 'base64'));
    } finally { rmSync(prof, { recursive: true, force: true }); }
    console.log(`${id}: ${out} ${W}×${H} ${readFileSync(out).length} B`);
  }
}
