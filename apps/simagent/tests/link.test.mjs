// run.mjs --ws 가 실제 소켓으로 Authorization 머리 · hello 하나 · 2 Hz state 를 보내는지, 가짜 루프백 서버로 잰다.
// 서버 · 로봇 등록 없음. FH_SIM_SRC 필요, FH_CONTRACT_PY 가 있으면 받은 프레임을 정본 모델로 검사.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const simSrc = process.env.FH_SIM_SRC, py = process.env.FH_CONTRACT_PY;
const here = fileURLToPath(new URL('../', import.meta.url)), apps = fileURLToPath(new URL('../../', import.meta.url));

// 최소 WS 서버: 손잡기 + 클라이언트 (가림) 글 프레임 해독만
function fakeAgentServer() {
  const got = { auth: null, frames: [] };
  const server = createServer((_, res) => { res.writeHead(404); res.end(); });
  server.on('upgrade', (req, sock) => {
    got.auth = req.headers.authorization;
    const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    let buf = Buffer.alloc(0);
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (buf.length < 2) return;
        const op = buf[0] & 0x0f; let len = buf[1] & 0x7f, off = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
        if (buf.length < off + 4 + len) return;
        const mask = buf.subarray(off, off + 4), body = Buffer.from(buf.subarray(off + 4, off + 4 + len));
        for (let i = 0; i < len; i++) body[i] ^= mask[i & 3];
        buf = buf.subarray(off + 4 + len);
        if (op === 1) got.frames.push(JSON.parse(body.toString()));
        if (op === 8) { sock.end(Buffer.from([0x88, 0x02, 0x03, 0xe8])); return; }
      }
    });
    sock.on('error', () => {});
  });
  return { server, got };
}

test('hello 하나 뒤 state 를 2 Hz 로 · Bearer 머리', { skip: simSrc ? false : 'FH_SIM_SRC 없음', timeout: 60000 }, async () => {
  const { server, got } = fakeAgentServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `ws://127.0.0.1:${server.address().port}/api/v1/agent/ws`;
  try {
    const out = await new Promise((resolve, reject) => execFile(process.execPath, ['run.mjs', '--seconds', '2', '--ws', url], {
      cwd: here, env: { ...process.env, FH_SIM_AGENT_TOKEN: 'fake-test-token' }, timeout: 30000 }, (e, so, se) => e ? reject(new Error(se || e.message)) : resolve(so)));
    assert.equal(got.auth, 'Bearer fake-test-token');
    assert.ok(!out.includes('fake-test-token'), '토큰이 출력에 나오면 안 됨');
    assert.equal(got.frames[0].t, 'hello');
    assert.equal(got.frames.filter((f) => f.t === 'hello').length, 1);
    const states = got.frames.filter((f) => f.t === 'state');
    assert.ok(states.length >= 4 && states.length <= 6, `state ${states.length} 개 (2 s · 2 Hz)`);
    assert.ok(states.every((s) => s.latched === true && s.applied.every((v) => v === 0)));
    if (py) {
      const code = 'import json,sys\nimport contracts.models as C\nfs=json.load(sys.stdin)\nC.AgentHello.model_validate(fs[0])\n[C.AgentState.model_validate(f) for f in fs[1:]]\nprint(len(fs))';
      assert.equal(execFileSync(py, ['-c', code], { cwd: apps, env: { ...process.env, PYTHONPATH: apps }, input: JSON.stringify(got.frames) }).toString().trim(), String(got.frames.length));
    }
  } finally { server.close(); }
});
