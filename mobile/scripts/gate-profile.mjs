// A 연결 개발 프로필 생성 — 관문 주소를 WebView 에 직접 로드(server.url). 개발·체험용이다(Capacitor 공식: server.url 은 production 용이 아님).
// 기본 빌드(bundled, server.url 없음)는 건드리지 않는다. 결과물은 gate 빌드 타입 소스셋에만, 둘 다 git 제외:
//   android/app/src/gate/assets/capacitor.config.json   (main 설정 복사 + server.url·appStartPath·errorPath)
//   android/app/src/gate/res/raw/fh_gate_ca.pem          (그 관문의 CA 한 장 — debug-overrides 로만 신뢰)
// 사용(mobile 폴더): FH_GATE_URL=https://<호스트>:<포트> FH_GATE_CA=<ca.crt> node scripts/gate-profile.mjs
//   node scripts/gate-profile.mjs --clean     생성물 삭제     node scripts/gate-profile.mjs --selftest
import { X509Certificate } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(dirname(fileURLToPath(import.meta.url)));
const GATE = join(here, 'android/app/src/gate');
const OUT_CFG = join(GATE, 'assets/capacitor.config.json');
const OUT_CA = join(GATE, 'res/raw/fh_gate_ca.pem');
const START = '/MLogin.dc.html?live=v2';   // 관문 공개 로그인 화면에서 시작 — 아래 «리다이렉트» 참고
const ERROR_PAGE = 'fh-offline.html';      // src/gate/assets/public 의 로컬 보기 전용 화면

// 관문 주소 → 정확한 origin 하나. https 만, 사용자정보·조각·질의·경로·와일드카드·localhost 거부.
export function gateOrigin(raw) {
  if (typeof raw !== 'string' || !raw || /[\s#@*\\]/.test(raw)) throw new Error('공백·#·@·*·\\ 가 든 주소는 받지 않는다');
  let u;
  try { u = new URL(raw); } catch { throw new Error('URL 형식 아님'); }
  if (u.protocol !== 'https:') throw new Error('https 만');
  if (u.username || u.password) throw new Error('사용자정보 금지');
  if (u.search || u.hash || (u.pathname !== '/' && u.pathname !== '')) throw new Error('경로·질의·조각 없이 origin 만');
  if (raw.replace(/\/$/, '') !== u.origin && raw.replace(/\/$/, '') !== `${u.protocol}//${u.host}`) throw new Error('정규화와 다른 주소(대소문자·기본 포트 표기 등)');
  // Capacitor 는 자기 로컬 화면을 https://localhost 로 내보낸다 — 같은 이름이면 관문과 앱 화면이 섞인다
  if (u.hostname === 'localhost' || u.hostname.endsWith('.localhost')) throw new Error('localhost 금지 — 127.0.0.1 등 실제 주소');
  return u.origin;
}

function caPem(path) {
  const pem = readFileSync(path, 'utf8');
  if ((pem.match(/-----BEGIN CERTIFICATE-----/g) || []).length !== 1 || /PRIVATE KEY/.test(pem)) throw new Error('인증서(CERTIFICATE) 정확히 한 장만, 개인키 금지');
  const c = new X509Certificate(pem);
  if (!c.ca) throw new Error('CA 인증서가 아님(basicConstraints CA:TRUE 필요)');
  if (Date.parse(c.validTo) < Date.now()) throw new Error('만료된 CA');
  return { pem, fp: c.fingerprint256, subject: c.subject };
}

function selftest() {
  const ok = { 'https://127.0.0.1:18453': 'https://127.0.0.1:18453', 'https://127.0.0.1:18453/': 'https://127.0.0.1:18453', 'https://gate.example.org': 'https://gate.example.org' };
  for (const [i, o] of Object.entries(ok)) if (gateOrigin(i) !== o) throw new Error(`selftest 통과 기대: ${i}`);
  const bad = ['http://127.0.0.1:18453', 'https://u:p@127.0.0.1:18453', 'https://127.0.0.1:18453/#x', 'https://127.0.0.1:18453#', 'https://127.0.0.1:18453/?a=1',
    'https://127.0.0.1:18453/MDrive.dc.html', 'https://*.example.org', 'https://localhost:18453', 'wss://127.0.0.1:18453', 'capacitor://localhost',
    'https://127.0.0.1:443', 'HTTPS://127.0.0.1:18453', ' https://127.0.0.1:18453', 'https://127.0.0.1:18453 ', '', undefined];
  for (const b of bad) { let threw = false; try { gateOrigin(b); } catch { threw = true; } if (!threw) throw new Error(`selftest 거부 기대: ${b}`); }
  console.log(`gate-profile selftest OK (${Object.keys(ok).length} 통과 · ${bad.length} 거부)`);
}

const arg = process.argv[2];
if (arg === '--selftest') selftest();
else if (arg === '--clean') { rmSync(OUT_CFG, { force: true }); rmSync(OUT_CA, { force: true }); console.log('gate 프로필 생성물 삭제'); }
else {
  const origin = gateOrigin(process.env.FH_GATE_URL);
  if (!process.env.FH_GATE_CA) throw new Error('FH_GATE_CA(관문 CA 인증서 경로) 필요 — 공인 인증서 관문이라도 이 프로필은 CA 한 장을 명시한다');
  const ca = caPem(process.env.FH_GATE_CA);
  const main = join(here, 'android/app/src/main/assets/capacitor.config.json');
  if (!existsSync(main)) throw new Error('main 설정 없음 — 먼저 npx cap sync android');
  const cfg = JSON.parse(readFileSync(main, 'utf8'));
  if (cfg.server && cfg.server.url) throw new Error('main 설정에 server.url 이 있다 — 기본은 bundled 여야 한다');
  cfg.server = { ...(cfg.server || {}), url: origin, appStartPath: START, errorPath: ERROR_PAGE, cleartext: false };
  delete cfg.server.allowNavigation;                                   // 기본(그 server origin 만)보다 넓히지 않는다
  cfg.android = { ...(cfg.android || {}), allowMixedContent: false };
  mkdirSync(dirname(OUT_CFG), { recursive: true }); mkdirSync(dirname(OUT_CA), { recursive: true });
  writeFileSync(OUT_CFG, JSON.stringify(cfg, null, 2)); writeFileSync(OUT_CA, ca.pem);
  // 주소·CA 는 생성물에만 있다. 화면에는 지문만(어느 CA 를 넣었는지 대조용)
  console.log(`gate 프로필 생성: CA sha256 ${ca.fp} · 시작 ${START} · 오류 화면 ${ERROR_PAGE}`);
}
