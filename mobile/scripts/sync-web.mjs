// mobile/start(시작 화면 한 장) + 브랜드 토큰·로고(apps/web/public/brand, 값 수정 없이 복사) → mobile/www.
// 1.1.0 원격 주소 방식: 화면(apps/web)은 서버가 내준다 — 옛 ui/dist 는 담지 않는다.
// www/SOURCE.json 에 모바일 판(git HEAD·미커밋 여부)·파일별 sha256 을 남긴다 — APK 안 번들 추적용(로컬 경로는 넣지 않는다).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(dirname(fileURLToPath(import.meta.url)));
const out = join(here, 'www'), brand = join(here, '..', 'apps', 'web', 'public', 'brand');
rmSync(out, { recursive: true, force: true });          // www 는 생성물(gitignore)
cpSync(join(here, 'start'), out, { recursive: true });
mkdirSync(join(out, 'brand', 'assets', 'logo', 'v1'), { recursive: true });
cpSync(join(brand, 'tokens', 'foothold.tokens.css'), join(out, 'brand', 'tokens', 'foothold.tokens.css'));
for (const f of ['foothold-lockup-compact-light.svg', 'foothold-lockup-compact-dark.svg']) cpSync(join(brand, 'assets', 'logo', 'v1', f), join(out, 'brand', 'assets', 'logo', 'v1', f));

const files = {};
const walk = (d) => readdirSync(d).sort().forEach((n) => {
  const p = join(d, n);
  if (statSync(p).isDirectory()) return walk(p);
  files[relative(out, p)] = createHash('sha256').update(readFileSync(p)).digest('hex');
});
walk(out);
const git = (...a) => { try { return execFileSync('git', ['-C', here, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; } };
const dirty = git('status', '--porcelain', '--', 'start', 'scripts/sync-web.mjs', '../apps/web/public/brand');
const meta = { mobile_rev: git('rev-parse', 'HEAD') || '미확인', dirty: dirty === null ? '미확인' : !!dirty, at: new Date().toISOString(), files };
writeFileSync(join(out, 'SOURCE.json'), JSON.stringify(meta, null, 2));
console.log(`www ← start + brand: ${Object.keys(files).length} 파일, mobile_rev=${meta.mobile_rev}${meta.dirty === true ? ' (+미커밋)' : ''}`);
