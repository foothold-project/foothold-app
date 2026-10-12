#!/usr/bin/env python3
"""실연결 확인(짧게): 이미 떠 있는 v2_link(8790)에 WebSocket 으로 붙어 조종권 → STOP 해제 → 0 → 앞 0.6 (N s) → 손 뗌 → STOP.
상태를 10 Hz 로 jsonl 에 남긴다. Gazebo·RL 은 띄우지 않는다.
  python3 tools/live_probe.py <결과 폴더(없어야 함)> [--fwd-s 2.0] [--arc 0|0.5|-0.5]"""
import argparse, asyncio, json, os, time
from tornado.websocket import websocket_connect
from tornado.httpclient import HTTPRequest

ap = argparse.ArgumentParser(); ap.add_argument('out'); ap.add_argument('--fwd-s', type=float, default=2.0); ap.add_argument('--arc', type=float, default=0.0)
a = ap.parse_args(); os.makedirs(a.out)
BASE = 'http://127.0.0.1:8790'; rows = []; st = {}


async def main():
    ws = await websocket_connect(HTTPRequest('ws://127.0.0.1:8790/ws', headers={'Origin': BASE}))
    t0 = time.monotonic(); phase = ['connect']

    async def pump():
        while True:
            m = await ws.read_message()
            if m is None: return
            if isinstance(m, str):
                d = json.loads(m); st.clear(); st.update(d)
                rows.append({'t': round(time.monotonic() - t0, 2), 'phase': phase[0], **{k: d[k] for k in ('role', 'latch', 'applied', 'reason', 'sim_block', 'resume_pending', 'episode', 'state_age', 'cam_age')},
                             'sim': {k: (d['sim'] or {}).get(k) for k in ('stop_requested', 'reset_in_progress', 'policy_running', 'x', 'y', 'yaw', 'vx', 'wz', 'tilt_deg', 'fallen', 'body_still', 'source', 'camera')}})
    asyncio.ensure_future(pump())

    async def until(pred, t):
        end = time.time() + t
        while time.time() < end:
            if st and pred(): return True
            await asyncio.sleep(0.1)
        return False

    def send(**o): return ws.write_message(json.dumps(o))
    ok = {'state': await until(lambda: not st['sim_block'], 10)}
    phase[0] = 'take'; await send(op='take'); await asyncio.sleep(0.3)
    ok['sim_stop_seen'] = await until(lambda: st['sim'] and st['sim']['stop_requested'], 5)
    phase[0] = 'resume'; await send(op='resume'); ok['resumed'] = await until(lambda: not st['latch'], 5)
    phase[0] = 'zero'
    for _ in range(10): await send(op='cmd', fx=0, fy=0, fw=0); await asyncio.sleep(0.05)
    phase[0] = 'fwd'; end = time.time() + a.fwd_s
    while time.time() < end: await send(op='cmd', fx=1, fy=0, fw=a.arc); await asyncio.sleep(0.05)
    phase[0] = 'release'
    for _ in range(40): await send(op='cmd', fx=0, fy=0, fw=0); await asyncio.sleep(0.05)
    phase[0] = 'stop'; await send(op='stop'); ok['stop_latched'] = await until(lambda: st['sim']['stop_requested'], 3)
    await asyncio.sleep(0.5); phase[0] = 'release_ctl'; await send(op='release'); await asyncio.sleep(0.5)
    ws.close(); return ok

ok = asyncio.run(main())
with open(f'{a.out}/status.jsonl', 'w') as f:
    for r in rows: f.write(json.dumps(r, ensure_ascii=False) + '\n')
fwd = [r for r in rows if r['phase'] == 'fwd']
summ = {'ok': ok, 'n': len(rows), 'fwd_applied': sorted({tuple(r['applied']) for r in fwd}),
        'x_start': rows[0]['sim']['x'] if rows else None, 'x_end': rows[-1]['sim']['x'] if rows else None,
        'max_vx': max([r['sim']['vx'] or 0 for r in rows] or [0]), 'fallen_any': any(r['sim']['fallen'] for r in rows),
        'cmd': f'python3 tools/live_probe.py {a.out} --fwd-s {a.fwd_s} --arc {a.arc}'}
json.dump(summ, open(f'{a.out}/summary.json', 'w'), ensure_ascii=False, indent=1); print(json.dumps(summ, ensure_ascii=False))
