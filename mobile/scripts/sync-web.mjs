// ui/dist → mobile/www 복사(화면을 다시 만들지 않는다 — 빌드된 번들 그대로). 소스맵(*.map)만 뺀다.
// 사용: node scripts/sync-web.mjs [ui dist 경로]   (기본 ../ui/dist, 환경변수 FH_UI_DIST 도 됨)
// www/SOURCE.json 에 ui git 커밋(FH_UI_REV)·파일별 sha256 을 남긴다 — APK 안 번들이 어느 빌드인지 추적용(로컬 경로는 APK 에 넣지 않는다).
import { createHash } from 'node:crypto';
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(dirname(fileURLToPath(import.meta.url)));
const src = resolve(process.argv[2] || process.env.FH_UI_DIST || join(here, '..', 'ui', 'dist'));
const out = join(here, 'www');
if (!existsSync(join(src, 'index.html'))) {
  console.error(`ui 번들 없음: ${src}/index.html — ui 에서 npm run build 먼저`);
  process.exit(2);
}
rmSync(out, { recursive: true, force: true });          // www 는 생성물(gitignore)
cpSync(src, out, { recursive: true, filter: (p) => !p.endsWith('.map') });

const files = {};
const walk = (d) => readdirSync(d).sort().forEach((n) => {
  const p = join(d, n);
  if (statSync(p).isDirectory()) return walk(p);
  files[relative(out, p)] = createHash('sha256').update(readFileSync(p)).digest('hex');
});
walk(out);
const meta = { ui_rev: process.env.FH_UI_REV || '미확인', at: new Date().toISOString(), files };
writeFileSync(join(out, 'SOURCE.json'), JSON.stringify(meta, null, 2));
console.log(`www ← ${src}: ${Object.keys(files).length} 파일, ui_rev=${meta.ui_rev}`);
