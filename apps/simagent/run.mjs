// 헤드리스 시뮬 에이전트 골격 실행.
//   FH_SIM_SRC=<자산> node apps/simagent/run.mjs --map collapsed-house-v2 --seconds 5 [--seed 1]
//     → 화면 없이 N 초 (시뮬 시각) 진행하고 JSON 한 줄.
//   FH_SIM_SRC=<자산> FH_SIM_AGENT_TOKEN=<시뮬 로봇 토큰> node apps/simagent/run.mjs --map … --seconds 5 --ws ws://127.0.0.1:8812/api/v1/agent/ws
//     → 벽시계 속도로 돌며 fh-agent/2 hello 뒤 state 를 2 Hz 로 보낸다. 잠김 유지 (lease · cmd 처리 없음).
// 토큰 값은 출력하지 않는다. ws:// 는 루프백만 (apps/agent link/client.py Settings 와 같은 규칙).
import { parseArgs } from 'node:util';
import { POLICY_DT } from '../../mobile/sim/sim.js';
import { loadWorld } from './world.mjs';
import { helloMessage, stateMessage } from './messages.mjs';

const { values: a } = parseArgs({ options: { map: { type: 'string', default: 'collapsed-house-v2' }, seconds: { type: 'string', default: '5' },
  seed: { type: 'string', default: '0' }, ws: { type: 'string' } } });
const seconds = Number(a.seconds), seed = Number(a.seed);
if (!(seconds > 0 && seconds <= 86400) || !Number.isInteger(seed)) throw new Error('--seconds (0, 86400] · --seed 정수');
const world = await loadWorld({ simSrc: process.env.FH_SIM_SRC, mapId: a.map, seed });
const summary = () => ({ map: a.map, seed, t: +world.sim.t.toFixed(3), base_height_m: +world.baseHeight().toFixed(4), upright: +world.upright().toFixed(4),
  xy: [+world.sim.d.qpos[0].toFixed(4), +world.sim.d.qpos[1].toFixed(4)] });

if (!a.ws) {
  const t0 = performance.now();
  world.run(seconds, [0, 0, 0]);
  console.log(JSON.stringify({ ...summary(), wall_ms: +(performance.now() - t0).toFixed(1) }));
  world.dispose();
} else {
  const url = new URL(a.ws), token = process.env.FH_SIM_AGENT_TOKEN;
  if (!['ws:', 'wss:'].includes(url.protocol) || (url.protocol === 'ws:' && !['127.0.0.1', '[::1]'].includes(url.hostname)) || url.search || url.username)
    throw new Error('wss 필요 (ws 는 루프백만, 질의 · 계정 금지)');
  if (!token || /[\s\x00-\x1f]/.test(token)) throw new Error('FH_SIM_AGENT_TOKEN 필요');
  const log = (o) => console.log(JSON.stringify({ at: +world.sim.t.toFixed(2), ...o }));
  const ws = new WebSocket(url, { headers: { Authorization: 'Bearer ' + token } });
  let timer, sent = 0, opened = false;
  // 한 번도 열리지 않으면 (인증 거부 403 · 서버 없음) 0 이 아닌 값으로 끝낸다. 브라우저식 WebSocket 은 HTTP 상태를 보여 주지 않는다.
  const finish = (why) => { clearInterval(timer); log({ end: why, opened, sent, ...summary() }); world.dispose(); if (!opened) process.exitCode = 2; };
  ws.onopen = () => {
    opened = true; log({ open: true });
    ws.send(JSON.stringify(helloMessage({ agentVersion: 'simagent/0.0.1' }))); sent++;
    const start = performance.now(); let steps = 0, lastState = -1;
    timer = setInterval(() => {
      // 벽시계를 따라 정책 주기 단위로 진행 (밀리면 최대 0.2 s 만 따라잡음)
      const due = Math.min(Math.floor((performance.now() - start) / 1000 / POLICY_DT), steps + 10);
      for (; steps < due; steps++) world.sim.step();
      const slot = Math.floor(world.sim.t * 2);
      if (slot !== lastState && ws.readyState === WebSocket.OPEN) { ws.send(JSON.stringify(stateMessage(world.sim))); sent++; lastState = slot; }
      if (world.sim.t >= seconds) ws.close(1000);
    }, 10);
  };
  ws.onmessage = (e) => { try { const m = JSON.parse(e.data); log({ rx: m.t ?? '?', keys: Object.keys(m).slice(0, 8) }); } catch { log({ rx: 'non-json' }); } };
  ws.onerror = (e) => log({ error: e.message ?? String(e.error?.message ?? 'ws error') });
  ws.onclose = (e) => finish(`close ${e.code}${e.reason ? ' ' + e.reason : ''}`);
}
