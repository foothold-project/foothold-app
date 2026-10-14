// ui/dist → mobile/www 복사(화면을 다시 만들지 않는다 — 빌드된 번들 그대로). 소스맵(*.map)만 뺀다.
// 사용: node scripts/sync-web.mjs [ui dist 경로]   (기본 ../ui/dist, 환경변수 FH_UI_DIST 도 됨)
// www/SOURCE.json 에 ui 판(FH_UI_REV 또는 자동 확인)·파일별 sha256 을 남긴다 — APK 안 번들이 어느 빌드인지 추적용(로컬 경로는 APK 에 넣지 않는다).
import { execFileSync } from 'node:child_process';
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
// ui 판: FH_UI_REV 를 주면 그 값. 안 주면 dist 가 든 git 체크아웃에서 자동 확인 — 단 모바일 자기 체크아웃(=모바일 HEAD),
// ui/ 미커밋 변경, HEAD 커밋보다 오래된 dist 는 «미확인»으로 남긴다(HEAD 를 UI 판으로 잘못 적지 않게)
const git = (...a) => { try { return execFileSync('git', ['-C', src, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; } };
let ui_rev = process.env.FH_UI_REV || null, ui_rev_from = 'FH_UI_REV';
if (!ui_rev) {
  const top = git('rev-parse', '--show-toplevel'), head = git('rev-parse', 'HEAD');
  const mine = (() => { try { return execFileSync('git', ['-C', here, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim(); } catch { return null; } })();
  const dirty = top && git('status', '--porcelain', '--', join(top, 'ui'));
  const stale = head && statSync(join(src, 'index.html')).mtimeMs / 1000 < Number(git('log', '-1', '--format=%ct', 'HEAD'));
  if (!top || !head) ui_rev_from = 'git 아님';
  else if (top === mine) ui_rev_from = '모바일 체크아웃 안의 ui — 판 미확인(FH_UI_REV 로 전달)';
  else if (dirty) ui_rev_from = `HEAD ${head} + ui 미커밋 변경 — 판 미확인`;
  else if (stale) ui_rev_from = `dist 가 HEAD ${head} 커밋보다 오래됨 — 판 미확인`;
  else { ui_rev = head; ui_rev_from = 'dist 체크아웃 HEAD(깨끗·dist 가 더 새것)'; }
}
const meta = { ui_rev: ui_rev || '미확인', ui_rev_from, at: new Date().toISOString(), files };
writeFileSync(join(out, 'SOURCE.json'), JSON.stringify(meta, null, 2));
console.log(`www ← ${src}: ${Object.keys(files).length} 파일, ui_rev=${meta.ui_rev} (${ui_rev_from})`);
