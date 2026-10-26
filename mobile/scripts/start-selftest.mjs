// 시작 화면 주소 검사(start/origin.js) 자체 시험 — 옛 gate-profile --selftest 사례 + 터널 주소. 사용: node scripts/start-selftest.mjs
import { gateOrigin } from '../start/origin.js';

const ok = { 'https://127.0.0.1:18453': 'https://127.0.0.1:18453', 'https://127.0.0.1:18453/': 'https://127.0.0.1:18453', 'https://gate.example.org': 'https://gate.example.org',
  'https://abc-def-ghi.trycloudflare.com': 'https://abc-def-ghi.trycloudflare.com' };
for (const [i, o] of Object.entries(ok)) if (gateOrigin(i) !== o) throw new Error(`통과 기대: ${i}`);
const bad = ['http://127.0.0.1:18453', 'https://u:p@127.0.0.1:18453', 'https://127.0.0.1:18453/#x', 'https://127.0.0.1:18453#', 'https://127.0.0.1:18453/?a=1',
  'https://127.0.0.1:18453/MDrive.dc.html', 'https://*.example.org', 'https://localhost:18453', 'wss://127.0.0.1:18453', 'capacitor://localhost',
  'https://127.0.0.1:443', 'HTTPS://127.0.0.1:18453', ' https://127.0.0.1:18453', 'https://127.0.0.1:18453 ', '', undefined,
  'https://abc.trycloudflare.com/#/drive', 'javascript:alert(1)'];
for (const b of bad) { let threw = false; try { gateOrigin(b); } catch { threw = true; } if (!threw) throw new Error(`거부 기대: ${b}`); }
console.log(`start selftest OK (${Object.keys(ok).length} 통과 · ${bad.length} 거부)`);
