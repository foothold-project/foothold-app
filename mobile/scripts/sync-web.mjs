// mobile/start(시작 화면 한 장) + 브랜드 토큰·로고(apps/web/public/brand, 값 수정 없이 복사) → mobile/www.
// 1.1.0 원격 주소 방식: 화면(apps/web)은 서버가 내준다 — 옛 ui/dist 는 담지 않는다.
// 1.2.0: 앱 안 오프라인 시뮬(mobile/sim → www/sim). 커밋하지 않는 큰 파일·가중치(정책·MuJoCo wasm·three·Go2 메시)는
//   FH_SIM_SRC=<RS-6 시뮬 폴더>(policy_v2.f32 · vendor/ · node_modules/@mujoco/mujoco/ · assets/unitree_go2/)에서 복사한다. 없으면 멈춘다.
// www/SOURCE.json 에 모바일 판(git HEAD·미커밋 여부)·파일별 sha256 을 남긴다 — APK 안 번들 추적용(로컬 경로는 넣지 않는다).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(dirname(fileURLToPath(import.meta.url)));
const out = join(here, 'www'), brand = join(here, '..', 'apps', 'web', 'public', 'brand');
const src = process.env.FH_SIM_SRC, sim = join(out, 'sim');
const need = (rel) => { const p = join(src, rel); if (!existsSync(p)) throw new Error(`FH_SIM_SRC 에 ${rel} 없음`); return p; };
if (!src) throw new Error('FH_SIM_SRC=<RS-6 시뮬 폴더> 가 필요합니다(정책 가중치·MuJoCo wasm·three·Go2 메시는 저장소에 없음)');
rmSync(out, { recursive: true, force: true });          // www 는 생성물(gitignore)
cpSync(join(here, 'start'), out, { recursive: true });
mkdirSync(join(out, 'brand', 'assets', 'logo', 'v1'), { recursive: true });
cpSync(join(brand, 'tokens', 'foothold.tokens.css'), join(out, 'brand', 'tokens', 'foothold.tokens.css'));
for (const f of ['foothold-lockup-compact-light.svg', 'foothold-lockup-compact-dark.svg']) cpSync(join(brand, 'assets', 'logo', 'v1', f), join(out, 'brand', 'assets', 'logo', 'v1', f));

cpSync(join(here, 'sim'), sim, { recursive: true });
const go2 = need('assets/unitree_go2'), go2xml = readFileSync(join(go2, 'go2.xml'), 'utf8');
const copy = [['policy_v2.f32', 'policy_v2.f32'], ['vendor/three.module.js', 'vendor/three.module.js'], ['vendor/three.core.js', 'vendor/three.core.js'],
  ['vendor/LICENSE', 'vendor/LICENSE'], ['node_modules/@mujoco/mujoco/mujoco.js', 'mujoco/mujoco.js'], ['node_modules/@mujoco/mujoco/mujoco.wasm', 'mujoco/mujoco.wasm'],
  ['node_modules/@mujoco/mujoco/package.json', 'mujoco/package.json'], ['assets/unitree_go2/go2.xml', 'assets/unitree_go2/go2.xml'], ['assets/unitree_go2/LICENSE', 'assets/unitree_go2/LICENSE'],
  ...[...go2xml.matchAll(/<mesh file="([\w.]+)"/g)].map(([, f]) => [`assets/unitree_go2/assets/${f}`, `assets/unitree_go2/assets/${f}`])];
for (const [a, b] of copy) { mkdirSync(dirname(join(sim, b)), { recursive: true }); copyFileSync(need(a), join(sim, b)); }

const files = {};
const walk = (d) => readdirSync(d).sort().forEach((n) => {
  const p = join(d, n);
  if (statSync(p).isDirectory()) return walk(p);
  files[relative(out, p)] = createHash('sha256').update(readFileSync(p)).digest('hex');
});
walk(out);
const git = (...a) => { try { return execFileSync('git', ['-C', here, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; } };
const dirty = git('status', '--porcelain', '--', 'start', 'sim', 'scripts/sync-web.mjs', '../apps/web/public/brand');
const meta = { mobile_rev: git('rev-parse', 'HEAD') || '미확인', dirty: dirty === null ? '미확인' : !!dirty, at: new Date().toISOString(), files };
writeFileSync(join(out, 'SOURCE.json'), JSON.stringify(meta, null, 2));
console.log(`www ← start + sim + brand: ${Object.keys(files).length} 파일, mobile_rev=${meta.mobile_rev}${meta.dirty === true ? ' (+미커밋)' : ''}`);
