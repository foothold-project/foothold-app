// 실기 보기 실시간·보간·맞추기 단위 시험(브라우저·서버 없음 — 가짜 WebSocket·가짜 GET). 사용: node mobile/scripts/go2-replay-live-selftest.mjs
import assert from 'node:assert/strict';
import { GO2_JOINTS, createReplayReader, placeSample, readAlign, sampleOf, yawOf } from '../sim/go2-replay.js';

const rid = '00000000-0000-4000-8000-000000000001';
const url = new URL(`http://localhost/sim/index.html?from=web&policy=go2-demo&robot=${rid}&map=warehouse`);
const iso = (ms) => new Date(ms).toISOString();
const info = (ms, { j = 0, age = 0, xyz = [0, 0, .3], yaw = 0 } = {}) => ({
  joints: { names: GO2_JOINTS, positions: Array(12).fill(j), received_at: iso(ms), age_s: age },
  quaternion: { wxyz: [Math.cos(yaw / 2), 0, 0, Math.sin(yaw / 2)], received_at: iso(ms), age_s: age },
  position: { xyz, origin: 'BOOT_ORIGIN_UNVERIFIED', received_at: iso(ms), age_s: age },
});
const world = { spawn: [2, 3, Math.PI / 2], floorZ: 0 };
const near = (a, b, e = 1e-9) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < e);

// 표본 검사: 이름 순서 바꿔도 GO2 순서로, 위치 출처가 다르면 버림
{
  const x = info(1000, { j: .5 }); x.joints.names = [...GO2_JOINTS].reverse(); x.joints.positions = GO2_JOINTS.map((_, i) => 11 - i);
  assert.deepEqual(sampleOf(x).q, GO2_JOINTS.map((_, i) => i));
  const y = info(1000); y.position.origin = 'MAP'; assert.equal(sampleOf(y), null);
  assert.equal(sampleOf(info(1000, { age: -1 })), null);
}

// 맞추기 전: 시작 자리에 관절·자세만(켤 때 기준 x·y 는 쓰지 않음)
{
  const s = sampleOf(info(1000, { xyz: [5, -7, .32], yaw: .4 }));
  const p = placeSample(s, world, null);
  assert.ok(near(p.xyz, [2, 3, .32])); assert.ok(Math.abs(yawOf(p.wxyz) - .4) < 1e-9);
  assert.ok(near(placeSample(sampleOf(info(1, { xyz: [0, 0, 9] })), world, null).xyz, [2, 3, .6]), '이상한 높이는 잘림');
  // 맞춘 뒤: 맞출 때 표본(켤 때 기준 (5,-7), 방향 .4) = 지도 (1,1), 방향 π/2, 바닥 0.2. 그 뒤 앞으로(켤 때 기준 방향 .4) 1 m → 지도 +y 로 1 m
  const align = { raw: [5, -7, .32, .4], x: 1, y: 1, yaw: Math.PI / 2, floor: .2 };
  assert.ok(near(placeSample(s, world, align).xyz, [1, 1, .52]));
  const moved = sampleOf(info(2000, { xyz: [5 + Math.cos(.4), -7 + Math.sin(.4), .30], yaw: .4 + .3 }));
  const q = placeSample(moved, world, align);
  assert.ok(near(q.xyz, [1, 2, .50], 1e-9), `이동량 반영 ${q.xyz}`);
  assert.ok(Math.abs(yawOf(q.wxyz) - (Math.PI / 2 + .3)) < 1e-9, '방향도 돌림');
  const store = new Map([['k', JSON.stringify({ ...align, at: iso(0) })], ['bad', '{"x":1}']]);
  const storage = { getItem: (k) => store.get(k) ?? null };
  assert.deepEqual(readAlign(storage, 'k').raw, align.raw); assert.equal(readAlign(storage, 'bad'), null); assert.equal(readAlign(storage, 'none'), null);
}

// 가짜 시계·GET·WebSocket
let t = 0, wallMs = Date.UTC(2026, 10, 18, 5, 0, 0), getBody = { simulation: false, robot_info: info(0) }, gets = 0;
const applied = [];
const sim = { world, applyReplay: (q, wxyz, xyz) => applied.push({ q: q.slice(), wxyz, xyz }) };
const sockets = [];
class FakeWS {
  constructor(u) { this.url = u; this.readyState = 0; this.sent = []; sockets.push(this); }
  send(x) { this.sent.push(JSON.parse(x)); }
  close() { this.readyState = 3; this.onclose?.(); }
  open() { this.readyState = 1; this.onopen?.(); }
  msg(m) { this.onmessage?.({ data: JSON.stringify(m) }); }
}
const reader = createReplayReader(sim, url, { now: () => t, wall: () => wallMs + t, WebSocket: FakeWS,
  fetcher: async () => { gets++; return { ok: true, json: async () => getBody }; } });
assert.match(reader.status(), /상태 기다리는 중/);
// 1) 첫 GET 으로 실기 확인 + 첫 표본, 그 뒤에야 실시간 연결을 연다
await reader.poll(); assert.equal(gets, 1); assert.equal(sockets.length, 0);
assert.equal(reader.frame(), true); assert.equal(applied.length, 1);
assert.match(reader.status(), /상태 수신 중 · 마지막 수신 14:00:00\(0\.0초 전\)/);
assert.match(reader.status(), /실시간 연결 안 됨/);
assert.doesNotMatch(reader.status(), /지연|ms/, '전체 지연 숫자는 보이지 않음');
t = 200; await reader.poll(); assert.equal(sockets.length, 1);
const ws = sockets[0]; assert.equal(ws.url, 'ws://localhost/api/v1/ws');
ws.open(); assert.deepEqual(ws.sent[0], { t: 'sub', robots: [rid], streams: ['state'], id: '1', proto: 'fh-rt/1' });
// 2) 실시간 수신: 다른 로봇·모양 틀림은 무시, 받는 동안 GET 안 함
ws.msg({ t: 'state', robot: '00000000-0000-4000-8000-000000000009', robot_info: info(100, { j: 9 }) });
ws.msg({ t: 'state', robot: rid, robot_info: info(100, { j: 1 }) });
assert.equal(reader.live, true); assert.match(reader.status(), /실시간 연결/); assert.doesNotMatch(reader.status(), /실시간 연결 안 됨/);
t = 300; ws.msg({ t: 'state', robot: rid, robot_info: info(200, { j: 2 }) });
const before = gets; t = 350; await reader.poll(); assert.equal(gets, before, '실시간 받는 동안 GET 안 함');
assert.ok(ws.sent.some((m) => m.t === 'ping'), '1초마다 ping');
// 3) 역순·중복 버림
ws.msg({ t: 'state', robot: rid, robot_info: info(150, { j: 7 }) });
ws.msg({ t: 'state', robot: rid, robot_info: info(200, { j: 7 }) });
// 4) 보간: 받는 간격(≈100 ms)만큼 늦게, 두 표본 사이를 잇는다. 역순·중복(7)은 끼지 않는다
// (받은 시각 0·200·300 ms → 간격 추정 180 ms: 350 ms 에 그리는 시각 170 ms = 0 과 1 사이 0.85)
t = 350; reader.frame(); const mid = applied.at(-1).q[0];
assert.ok(Math.abs(mid - .85) < 1e-9, `사이 값 ${mid}`);
t = 450; reader.frame(); assert.ok(applied.at(-1).q[0] > 1.6 && applied.at(-1).q[0] < 2, '1 과 2 사이');
t = 300 + 250; reader.frame(); assert.ok(Math.abs(applied.at(-1).q[0] - 2) < 1e-9, '늦어도 0.25 초 뒤엔 최신 표본');
assert.ok(applied.every((a) => a.q[0] !== 7));
// 5) 옛 값(나이 1초 넘음) 버림
t = 560; ws.msg({ t: 'state', robot: rid, robot_info: info(300, { j: 5, age: 1.2 }) });
reader.frame(); assert.ok(Math.abs(applied.at(-1).q[0] - 2) < 1e-9);
// 6) 끊김: 실시간 1초 조용 → GET 으로 돌아감(같은 표본이면 새 값 아님) → 1초 넘으면 «끊김», 마지막 자세로 멈춤(다시 그리지 않음)
const n = applied.length;
getBody = { simulation: false, robot_info: info(200, { j: 2 }) };
t = 1600; await reader.poll(); assert.equal(gets, before + 1, '실시간이 조용하면 GET');
assert.equal(reader.live, false);
assert.match(reader.status(), /상태 끊김 · 마지막 자세로 멈춤 · 마지막 수신 14:00:00\(1\.3초 전\)/);
for (t = 1700; t < 3000; t += 100) assert.equal(reader.frame(), false);
assert.equal(applied.length, n, '끊긴 동안 자세 그대로');
// 7) 연결이 닫히면 3초 뒤 다시 열고, 그동안 GET 새 표본은 받는다
ws.close(); getBody = { simulation: false, robot_info: info(3000, { j: 3 }) };
t = 3000; await reader.poll(); assert.equal(sockets.length, 1); reader.frame(); assert.equal(applied.at(-1).q[0], 3);
assert.match(reader.status(), /상태 수신 중/);
t = 6100; await reader.poll(); assert.equal(sockets.length, 2, '다시 연결');
// 8) 구독 거절 → GET 그대로(10 초 뒤 다시)
sockets[1].open(); sockets[1].msg({ t: 'reply', id: '1', ok: false, error: { code: 'FORBIDDEN' } });
assert.equal(sockets[1].readyState, 3); t = 6300; await reader.poll(); assert.equal(sockets.length, 2);
// 9) 맞춤을 넣으면 같은 표본도 새 자리로 다시 그린다
reader.setAlign({ raw: [0, 0, .3, 0], x: 9, y: 9, yaw: 0, floor: 0 }); reader.frame();
assert.ok(near(applied.at(-1).xyz, [9, 9, .3]));
assert.deepEqual(reader.raw().slice(0, 3), [0, 0, .3]);
// 10) 시뮬 로봇이면 거부하고 실시간 연결도 닫는다
getBody = { simulation: true, robot_info: info(9000) }; t = 9000; await reader.poll();
assert.match(reader.status(), /실기 로봇을 골라야 함/);
console.log('go2 replay live selftest OK: 표본 검사·맞추기 전 시작 자리·맞춘 뒤 이동량·저장본, ws 구독·GET 대체·다시 연결·거절, 역순·중복·옛 값 버림, 보간, 끊김 동결, 수신 시각 표시');
