"""Same-PC phone driver. Credentials/images never enter measurement output.

Run once after first_launch.py start. On failure preserve runtime and ask;
there is deliberately no automatic retry, DELETE, or process termination.
"""
import argparse
import asyncio
import base64
import json
import math
from pathlib import Path
import socket
import sys
import time
from uuid import uuid4

from first_launch import request, private


class Phone:
    def __init__(self, ws, robot):
        self.ws, self.robot = ws, robot
        self.pending, self.state = {}, {}
        self.seq = 0
        self.sent, self.acks = {}, {}
        self.reader = asyncio.create_task(self.read())

    async def read(self):
        async for raw in self.ws:
            data = json.loads(raw)
            if data['t'] == 'state':
                self.state = data
            elif data.get('id') in self.pending:
                self.pending.pop(data['id']).set_result(data)
            if data['t'] == 'cmd.ack':
                self.acks[data['seq']] = data

    async def rpc(self, kind, **body):
        ident = str(uuid4())
        future = asyncio.get_running_loop().create_future()
        self.pending[ident] = future
        await self.ws.send(json.dumps(dict(t=kind, id=ident, robot=self.robot, **body)))
        return await asyncio.wait_for(future, 3)

    async def ping(self):
        while True:
            await self.rpc('ping', client_time_ms=int(time.time() * 1000))
            await asyncio.sleep(.8)

    async def command(self, moving):
        self.seq += 1
        message = dict(t='cmd', id=str(uuid4()), robot=self.robot, lease_id=self.lease,
            seq=self.seq, vx=.6 if moving else 0., vy=0., wz=0.)
        self.sent[self.seq] = time.monotonic()
        await self.ws.send(json.dumps(message))
        return self.seq

    async def stream(self, count, moving):
        seqs = []
        deadline = time.monotonic()
        for _ in range(count):
            seqs.append(await self.command(moving))
            deadline += .05
            await asyncio.sleep(max(0, deadline - time.monotonic()))
        return seqs

    async def resume(self):
        assert self.state, 'no phone state'
        reply = await self.rpc('unlock', lease_id=self.lease, stop_gen=self.state['stop_gen'])
        assert reply['ok'], 'unlock rejected: ' + str(reply.get('error'))
        await self.stream(20, False)


def publications(folder):
    path = folder / 'native/publisher.jsonl'
    if not path.exists():
        return []
    rows = []
    for line in path.read_text().splitlines():
        try:
            rows.append(json.loads(line))
        except ValueError:
            pass  # A partial last line is an unmatched sample until complete.
    return rows


def latency(phone, folder, seqs):
    samples, missing = [], []
    rows = publications(folder)
    for seq in seqs:
        matches = [r for r in rows if r['kind'] == 'published' and r['seq'] == seq
            and r['mono'] >= phone.sent[seq] and r['velocity'][0] > 0]
        ack = phone.acks.get(seq)
        if not matches or not ack or ack['applied'][0] <= 0:
            missing.append(seq)
        else:
            samples.append((min(r['mono'] for r in matches) - phone.sent[seq]) * 1000)
    p95 = sorted(samples)[math.ceil(len(samples) * .95) - 1] if samples else None
    coalesced = []
    for seq in missing:
        received = next((r for r in rows if r['kind'] == 'received' and r['seq'] == seq), None)
        following = next((r for r in rows if r['kind'] == 'published'
            and received and r['mono'] >= received['mono']), None)
        # Latest-only output may replace an acknowledged command before flush.
        newer = any(r['kind'] == 'received' and r['seq'] > seq and r['applied'][0] > 0
            and received and following and received['mono'] < r['mono'] < following['mono'] for r in rows)
        if (received and received['applied'][0] > 0 and following and newer
                and following['seq'] > seq and following['velocity'][0] > 0):
            coalesced.append(seq)
    genuine_missing = [seq for seq in missing if seq not in coalesced]
    longest = run = 0
    for seq in seqs:
        run = run + 1 if seq in missing else 0
        longest = max(longest, run)
    return {'requested': len(seqs), 'matched': len(samples), 'missing': missing, 'p95_ms': p95,
        'coalesced': coalesced, 'genuine_missing': genuine_missing,
        'max_consecutive_missing': longest,
        'strict_all_200_pass': not missing and len(samples) == 200 and p95 <= 100,
        'acceptance': 'coordinator: published seq p95, coalesced count and max consecutive missing reported',
        'pass': len(seqs) == 200 and bool(samples) and not genuine_missing and p95 <= 100}


def gap_sample(phone, folder, seqs):
    last = phone.sent[seqs[-1]]
    rows = publications(folder)
    zero = [r for r in rows if r['kind'] == 'published' and r['mono'] > last
        and r['velocity'] == [0., 0., 0.]]
    received = [r for r in rows if r['kind'] == 'received' and r['seq'] == seqs[-1]]
    first = min((r['mono'] for r in zero), default=None)
    moving = all(phone.acks.get(s, {}).get('applied', [0])[0] > 0 for s in seqs)
    return {'send_to_zero_s': first-last if first is not None else None,
        'receive_to_zero_s': first-received[0]['mono'] if first is not None and received else None,
        'all_inputs_applied_nonzero': moving,
        'pass': moving and first is not None and first-last <= .4}


async def remaining(folder):
    """c2-004 only: fresh neutral before each gap, baseline gaps and unread video."""
    from websockets.asyncio.client import connect
    credentials = json.loads((folder / 'session-private.json').read_text())
    rid, device = credentials['robot'], str(uuid4())
    status, issued = await asyncio.to_thread(request, 'POST', f'/robots/{rid}/phone-pass',
        {'device': device, 'purpose': 'control'}, credentials['bearer'])
    assert status == 200, 'actual pass issuance failed'
    result = {'suite': 'remaining deadman and unread-video only', 'pass_issuance': status}
    async with connect('ws://127.0.0.1:9433/phone/ws', proxy=None) as ws:
        phone = Phone(ws, rid)
        hello = await phone.rpc('hello', proto='fh-phone/1', device=device, ticket=issued['token'])
        ping = asyncio.create_task(phone.ping())
        try:
            await asyncio.sleep(.5)
            reply = await phone.rpc('lease.take')
            assert reply['ok'] and reply['lease_id'], 'lease acquisition failed'
            phone.lease = reply['lease_id']
            await asyncio.sleep(.3)
            await phone.resume()
            async def gaps():
                trials = []
                for _ in range(20):
                    # Existing Core invalidation requires a NEW neutral after
                    # each deadman. Do not change Core or its expectations.
                    await phone.stream(3, False)
                    seqs = await phone.stream(5, True)
                    await asyncio.sleep(.45)
                    trials.append(gap_sample(phone, folder, seqs))
                return {'trials': trials, 'pass': len(trials) == 20 and all(v['pass'] for v in trials)}
            async with connect('ws://127.0.0.1:9433/phone/camera/ws', proxy=None,
                               max_size=128*1024, max_queue=1, close_timeout=.2) as cam:
                await cam.send(json.dumps({'t': 'camera.hello', 'robot': rid, 'token': hello['camera_token']}))
                async def consume():
                    async for _ in cam:
                        pass  # no image storage
                reader = asyncio.create_task(consume())
                try:
                    result['deadman'] = await gaps()
                    reader.cancel()
                    await asyncio.gather(reader, return_exceptions=True)
                    await phone.stream(3, False)
                    seqs = await phone.stream(200, True)
                    await asyncio.sleep(.1)
                    result['unread_video_latency'] = latency(phone, folder, seqs)
                    result['unread_video_deadman'] = await gaps()
                    await phone.rpc('stop')
                    await asyncio.sleep(.3)
                    result['final_stop'] = bool(phone.state.get('latched') and phone.state.get('applied') == [0., 0., 0.])
                finally:
                    reader.cancel()
                    await asyncio.gather(reader, return_exceptions=True)
        finally:
            error = sys.exc_info()[0]
            if error:
                result['interrupted_or_error'] = error.__name__
            private(folder / 'measurement.json', result)
            await ws.send(json.dumps({'t': 'stop', 'id': str(uuid4()), 'robot': rid}))
            ping.cancel()
            phone.reader.cancel()
            await asyncio.gather(ping, phone.reader, return_exceptions=True)
    print(json.dumps(result))


async def measure(folder):
    from websockets.asyncio.client import connect
    credentials = json.loads((folder / 'session-private.json').read_text())
    rid, bearer = credentials['robot'], credentials['bearer']
    device = str(uuid4())
    status, issued = await asyncio.to_thread(request, 'POST', f'/robots/{rid}/phone-pass',
        {'device': device, 'purpose': 'control'}, bearer)
    assert status == 200, 'actual pass issuance failed'
    result = {'pass_issuance': status, 'manager_abnormal_exit': 'unverified',
        'pass_extended_matrix': 'unverified', 'source_flood': 'unverified'}
    camera_stats = []
    async with connect('ws://127.0.0.1:9433/phone/ws', proxy=None) as ws:
        phone = Phone(ws, rid)
        hello = await phone.rpc('hello', proto='fh-phone/1', device=device, ticket=issued['token'])
        ping = asyncio.create_task(phone.ping())
        try:
            await asyncio.sleep(.5)
            result['initial'] = {k: phone.state.get(k) for k in ('latched', 'stop_requested', 'sim_time_s', 'applied')}
            initial = json.loads((folder / 'state.json').read_text())['data']
            result['initial_ros'] = {k: initial.get(k) for k in
                ('stop_requested', 'cmd_applied', 'episode', 'plugin_mode', 'policy_running', 'sim_t', 'camera_frames')}
            result['initial_pass'] = (phone.state.get('latched') is True
                and initial.get('stop_requested') is True and initial.get('cmd_applied') == [0, 0, 0]
                and initial.get('episode', 0) >= 1 and initial.get('plugin_mode') == 'LOCKSTEP')
            reply = await phone.rpc('lease.take')
            assert reply['ok'] and reply['lease_id'], 'lease acquisition failed'
            phone.lease = reply['lease_id']
            await asyncio.sleep(.3)
            await phone.resume()
            async def camera_read(cam):
                async for raw in cam:
                    frame = json.loads(raw)
                    if frame['t'] == 'camera.frame':
                        from foothold_agent.camera.stream import jpeg_size
                        data = base64.b64decode(frame['jpeg'], validate=True)
                        camera_stats.append({'mono': time.monotonic(), 'seq': frame['seq'],
                            'bytes': len(data), 'size': jpeg_size(data)})
                    else:
                        result['no_video_seen'] = frame.get('state') == 'NO_VIDEO'
            async with connect('ws://127.0.0.1:9433/phone/camera/ws', proxy=None, max_size=128*1024) as cam:
                await cam.send(json.dumps({'t': 'camera.hello', 'robot': rid, 'token': hello['camera_token']}))
                camera_task = asyncio.create_task(camera_read(cam))
                sequences = await phone.stream(200, True)
                await asyncio.sleep(.1)
                result['latency'] = latency(phone, folder, sequences)
                gaps = []
                for _ in range(20):
                    await phone.stream(3, False)
                    seqs = await phone.stream(5, True)
                    await asyncio.sleep(.45)
                    gaps.append(gap_sample(phone, folder, seqs))
                result['deadman'] = {'trials': gaps, 'pass': len(gaps) == 20 and all(v['pass'] for v in gaps)}
                # Keep a real camera connection open without consuming frames.
                # This verifies this finite stall only; source flooding is separate.
                camera_task.cancel()
                await asyncio.gather(camera_task, return_exceptions=True)
                await phone.stream(3, False)
                sequences = await phone.stream(200, True)
                await asyncio.sleep(.1)
                result['unread_video_latency'] = latency(phone, folder, sequences)
                gaps = []
                for _ in range(20):
                    await phone.stream(3, False)
                    seqs = await phone.stream(5, True)
                    await asyncio.sleep(.45)
                    gaps.append(gap_sample(phone, folder, seqs))
                result['unread_video_deadman'] = {'trials': gaps, 'pass': len(gaps) == 20 and all(v['pass'] for v in gaps)}
                await phone.rpc('stop')
                await asyncio.sleep(.3)
                result['control_stop'] = bool(phone.state.get('latched') and phone.state.get('applied') == [0., 0., 0.])
                stopped = await phone.stream(5, True)
                result['no_implicit_resume'] = all(phone.acks.get(s, {}).get('applied') == [0., 0., 0.] for s in stopped)
                view_device = str(uuid4())
                status, view = await asyncio.to_thread(request, 'POST', f'/robots/{rid}/phone-pass',
                    {'device': view_device, 'purpose': 'view'}, bearer)
                assert status == 200, 'view pass issuance failed'
                async with connect('ws://127.0.0.1:9433/phone/ws', proxy=None) as view_ws:
                    viewer = Phone(view_ws, rid)
                    try:
                        await viewer.rpc('hello', proto='fh-phone/1', device=view_device, ticket=view['token'])
                        denied = await viewer.rpc('lease.take')
                        await viewer.rpc('stop')
                        await asyncio.sleep(.3)
                        result['view_stop'] = bool(phone.state.get('latched') and phone.state.get('applied') == [0., 0., 0.])
                        result['view_lease_denied'] = not denied['ok']
                    finally:
                        viewer.reader.cancel()
                        await asyncio.gather(viewer.reader, return_exceptions=True)
                await phone.resume()
                resumed = await phone.stream(5, True)
                result['explicit_resume'] = all(phone.acks.get(s, {}).get('applied', [0])[0] > 0 for s in resumed)
                await phone.rpc('stop')
                roundtrips = []
                for _ in range(60):
                    started = time.monotonic()
                    await phone.rpc('stop')
                    roundtrips.append((time.monotonic()-started)*1000)
                    await asyncio.sleep(.02)
                result['stop_roundtrip_p95_ms'] = sorted(roundtrips)[56]
                result['tcp_nodelay'] = ws.transport.get_extra_info('socket').getsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY)
                camera_task.cancel()
                await asyncio.gather(camera_task, return_exceptions=True)
            intervals = [b['mono']-a['mono'] for a,b in zip(camera_stats, camera_stats[1:])]
            result['camera'] = {'frames': len(camera_stats), 'max_bytes': max((r['bytes'] for r in camera_stats), default=None),
                'sizes': sorted(set(tuple(r['size']) for r in camera_stats)),
                'fps': (len(camera_stats)-1)/(camera_stats[-1]['mono']-camera_stats[0]['mono']) if len(camera_stats)>1 else None,
                'minimum_received_interval': min(intervals, default=None)}
            final = json.loads((folder / 'state.json').read_text())['data']
            result['clocks_advance'] = (final.get('sim_t', 0) > initial.get('sim_t', 0)
                and final.get('camera_frames', 0) > initial.get('camera_frames', 0))
        finally:
            error = sys.exc_info()[0]
            if error:
                result['interrupted_or_error'] = error.__name__
            private(folder / 'measurement.json', result)
            ping.cancel()
            phone.reader.cancel()
            await asyncio.gather(ping, phone.reader, return_exceptions=True)
            # Always request STOP before returning, including a measurement failure.
            await ws.send(json.dumps({'t': 'stop', 'id': str(uuid4()), 'robot': rid}))
    print(json.dumps(result))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--episode', required=True, type=Path)
    parser.add_argument('--remaining', action='store_true')
    args = parser.parse_args()
    asyncio.run((remaining if args.remaining else measure)(args.episode.resolve()))
