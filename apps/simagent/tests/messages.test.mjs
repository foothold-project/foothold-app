// fh-agent/2 hello · state 모양. FH_CONTRACT_PY (pydantic 있는 파이썬) 가 있으면 apps/contracts 의 정본 모델로 검사한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { helloMessage, stateMessage } from '../messages.mjs';

const apps = fileURLToPath(new URL('../../', import.meta.url));
const fakeSim = { t: 1, d: { qpos: [1, 2, 0.3, Math.cos(0.25), 0, 0, Math.sin(0.25)] }, linB: [0.4, 0.3, 0], cmd: [0, 0, 0] };

test('hello 는 fh-agent/2 · 잠김 · 리스 없음', () => {
  const h = helloMessage({ agentVersion: 'simagent/0.0.1', stopGen: 0 });
  assert.equal(h.t, 'hello'); assert.equal(h.proto, 'fh-agent/2'); assert.equal(h.latched, true);
  assert.equal(h.robot_model, 'unitree_go2'); assert.equal(h.lease_id, null);
});

test('state 는 시뮬 자세 · 속도 · 적용 명령을 싣는다', () => {
  const s = stateMessage(fakeSim, { latched: true, stopGen: 0, stopRef: 0 });
  assert.equal(s.t, 'state');
  assert.deepEqual([s.pose.x, s.pose.y], [1, 2]);
  assert.ok(Math.abs(s.pose.yaw - 0.5) < 1e-12);
  assert.ok(Math.abs(s.speed - 0.5) < 1e-12);
  assert.deepEqual(s.applied, [0, 0, 0]);
});

const py = process.env.FH_CONTRACT_PY;
test('apps/contracts 정본 모델이 받는다', { skip: py ? false : 'FH_CONTRACT_PY 없음' }, () => {
  const frames = [helloMessage({ agentVersion: 'simagent/0.0.1', stopGen: 0 }), stateMessage(fakeSim, { latched: true, stopGen: 0, stopRef: 0 })];
  const code = 'import json,sys\nimport contracts.models as C\nh,s=json.load(sys.stdin)\nC.AgentHello.model_validate(h)\nC.AgentState.model_validate(s)\nprint("ok")';
  const out = execFileSync(py, ['-c', code], { cwd: apps, env: { ...process.env, PYTHONPATH: apps }, input: JSON.stringify(frames) }).toString().trim();
  assert.equal(out, 'ok');
});
