import asyncio
import json
from pathlib import Path
import sys
import time
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / 'tests'))
from test_phone import Harness, phone_socket, signed
from foothold_agent.camera import Camera, CameraTransport, jpeg_size
from foothold_agent.phone.server import Server, Settings


def jpeg(width=424, height=240, payload=b''):
    # Minimal synthetic JPEG header. No real images are committed or saved.
    return b'\xff\xd8\xff\xc0\x00\x08\x08' + height.to_bytes(2,'big') + width.to_bytes(2,'big') + b'\x01' + payload + b'\xff\xd9'


def test_latest_queue_and_no_video_have_no_control_effect():
    h = Harness()
    try:
        camera = Camera(h.robot, now=h.clock)
        queue = camera.subscribe()
        for _ in range(100):
            h.clock.t += .201
            assert camera.submit(jpeg())
            camera.sample()
        assert queue.qsize() == 1 and queue.get_nowait()['seq'] == 100
        peer, _ = h.moving()
        assert h.hub.session.core.out[0] == .6
        h.clock.t += 1.1
        camera.sample()
        assert queue.get_nowait()['state'] == 'NO_VIDEO'
        # Camera loss has no authority over lease or safety latch.
        assert h.hub.owner == peer and not h.hub.session.core.latch
        assert not camera.submit(jpeg(641))
        assert not camera.submit(jpeg(640,361))
        assert not camera.submit(jpeg(payload=b'x'*65536))
        assert not camera.submit(b'invalid')
    finally:
        h.hub.close(); h.verifier.close()


class WS:
    def __init__(self, hello, *, block=False):
        self.input = asyncio.Queue()
        self.input.put_nowait(json.dumps(hello))
        self.frames = []
        self.closed = asyncio.Event()
        self.block = block
        self.sending = asyncio.Event()
        self.code = None
    async def recv(self):
        return await self.input.get()
    async def send(self, frame):
        self.sending.set()
        if self.block:
            await asyncio.Event().wait()
        self.frames.append(json.loads(frame))
    async def close(self, code=1000, reason=''):
        self.code = self.code or code
        self.closed.set()


def open_camera(transport, peer, **kwargs):
    return WS(dict(t='camera.hello',robot=transport.camera.robot,token=transport.issue(peer)), **kwargs)


@pytest.mark.parametrize('purpose',['control','view'])
def test_parent_close_revocation_expiry_and_receive_only(purpose):
    async def run():
        h = Harness()
        try:
            peer,_,_ = h.connect(purpose=purpose)
            camera = Camera(h.robot,now=h.clock); transport = CameraTransport(camera,h.hub,now=h.clock)
            ws = open_camera(transport,peer)
            task = asyncio.create_task(transport.handler(ws))
            await asyncio.wait_for(ws.sending.wait(),1)
            assert peer in transport.active
            # All revoke/expiry/switch paths remove the parent from Hub.peers.
            h.hub.disconnect(peer,reserve=False)
            await asyncio.sleep(.12)
            finished = task.done()
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
            assert finished, 'camera stayed alive after parent closed'
            assert ws.code == 4403 and not transport.active and not camera.queues
            peer,_,_ = h.connect(purpose=purpose)
            ws = open_camera(transport,peer)
            task = asyncio.create_task(transport.handler(ws))
            await asyncio.wait_for(ws.sending.wait(),1)
            ws.input.put_nowait('{"t":"stop"}')
            await asyncio.wait_for(task,1)
            assert ws.code == 4403 and h.hub.peers[peer].user is not None
            token = transport.issue(peer)
            h.clock.t += 10
            ws = WS(dict(t='camera.hello',robot=h.robot,token=token))
            await asyncio.wait_for(transport.handler(ws),1)
            assert ws.code == 4403
        finally:
            h.hub.close(); h.verifier.close()
    asyncio.run(run())


def test_camera_token_one_use_and_open_pass_expiry():
    async def run():
        h = Harness()
        try:
            peer,_,_ = h.connect()
            camera = Camera(h.robot,now=h.clock); transport = CameraTransport(camera,h.hub,now=h.clock)
            ws = open_camera(transport,peer); hello = await ws.input.get(); ws.input.put_nowait(hello)
            task = asyncio.create_task(transport.handler(ws))
            await asyncio.wait_for(ws.sending.wait(),1)
            duplicate = WS(json.loads(hello))
            await transport.handler(duplicate)
            assert duplicate.code == 4403
            h.clock.t = h.hub.peers[peer].deadline
            await asyncio.wait_for(task,1)
            assert ws.code == 4403
        finally:
            h.hub.close(); h.verifier.close()
    asyncio.run(run())


def test_blocked_camera_cannot_block_control_or_deadman():
    async def run():
        h = Harness()
        try:
            peer,_ = h.moving()
            camera = Camera(h.robot,now=h.clock); transport = CameraTransport(camera,h.hub)
            ws = open_camera(transport,peer,block=True)
            task = asyncio.create_task(transport.handler(ws))
            await asyncio.wait_for(ws.sending.wait(),1)
            delays = []
            for _ in range(30):
                started = time.monotonic()
                h.send(peer,'stop')
                delays.append(time.monotonic()-started)
                await asyncio.sleep(.001)
            assert max(delays) < .1
            assert h.hub.session.core.latch and h.hub.session.core.out == (0.,0.,0.)
            # A separate moving run proves camera does not replace the existing tick.
            h.clock.t += .4
            h.hub.tick()
            assert h.hub.session.core.out == (0.,0.,0.)
            await asyncio.wait_for(task,1)
            assert peer in h.hub.peers
        finally:
            h.hub.close(); h.verifier.close()
    asyncio.run(run())


def test_camera_ws_contract_and_separate_control_socket():
    from websockets.asyncio.client import connect
    from websockets.exceptions import ConnectionClosed
    async def run():
        h = Harness()
        with phone_socket() as sock:
            camera = Camera(h.robot,now=h.clock); transport = CameraTransport(camera,h.hub)
            port = sock.getsockname()[1]
            server = Server(h.hub,Settings('127.0.0.1',port,'unused','test','1',h.org,'unused.sqlite',True,True),sock=sock,camera=transport)
            task = asyncio.create_task(server.run())
            await asyncio.wait_for(server.ready.wait(),2)
            try:
                async with connect(f'ws://127.0.0.1:{port}/phone/ws',proxy=None) as control:
                    claims = h.claims(purpose='view')
                    await control.send(json.dumps(dict(t='hello',id='h',robot=h.robot,proto='fh-phone/1',device=claims['device'],ticket=signed(h.key,claims))))
                    welcome = json.loads(await control.recv())
                    assert len(welcome['camera_token']) == 43
                    async with connect(f'ws://127.0.0.1:{port}/phone/camera/ws',proxy=None,max_size=100000) as video:
                        await video.send(json.dumps(dict(t='camera.hello',robot=h.robot,token=welcome['camera_token'])))
                        assert json.loads(await video.recv())['state'] == 'NO_VIDEO'
                        camera.submit(jpeg()); camera.sample()
                        frame = json.loads(await video.recv())
                        from apps.contracts.models import CameraFrame
                        assert CameraFrame.model_validate(frame).width == 424
                        started = time.monotonic()
                        await control.send(json.dumps(dict(t='stop',id='s',robot=h.robot)))
                        while True:
                            response = json.loads(await control.recv())
                            if response.get('id') == 's':
                                break
                        assert time.monotonic()-started < .1, 'camera delayed STOP reply'
                        assert response['ok'] and h.hub.session.core.latch
                        await control.close()
                        with pytest.raises(ConnectionClosed):
                            await asyncio.wait_for(video.recv(),1)
            finally:
                server.stopping.set(); await task
                h.verifier.close()
    asyncio.run(run())


def test_measured_slow_camera_socket_preserves_stop_and_deadman():
    from websockets.asyncio.client import connect
    class BlockedTransport(CameraTransport):
        async def _frames(self, ws, queue):
            self.started.set()
            # Simulate a peer whose TCP output cannot accept the queued image.
            await asyncio.Event().wait()
    async def run():
        h = Harness()
        with phone_socket() as sock:
            camera = Camera(h.robot, now=h.clock)
            transport = BlockedTransport(camera,h.hub)
            transport.started = asyncio.Event()
            port=sock.getsockname()[1]
            server = Server(h.hub,Settings('127.0.0.1',port,'unused','test','1',h.org,'unused.sqlite',True,True),sock=sock,camera=transport)
            task=asyncio.create_task(server.run())
            await asyncio.wait_for(server.ready.wait(),2)
            try:
                async with connect(f'ws://127.0.0.1:{port}/phone/ws',proxy=None) as control:
                    claims=h.claims()
                    await control.send(json.dumps(dict(t='hello',id='h',robot=h.robot,proto='fh-phone/1',device=claims['device'],ticket=signed(h.key,claims))))
                    welcome=json.loads(await control.recv())
                    async with connect(f'ws://127.0.0.1:{port}/phone/camera/ws',proxy=None) as video:
                        await video.send(json.dumps(dict(t='camera.hello',robot=h.robot,token=welcome['camera_token'])))
                        await asyncio.wait_for(transport.started.wait(),1)
                        # Actual TCP STOP round trips while the camera writer never returns.
                        samples=[]
                        for i in range(30):
                            started=time.monotonic()
                            await control.send(json.dumps(dict(t='stop',id=str(i),robot=h.robot)))
                            while True:
                                reply=json.loads(await asyncio.wait_for(control.recv(),1))
                                if reply.get('id') == str(i):
                                    break
                            samples.append(time.monotonic()-started)
                            assert reply['ok']
                        p95=sorted(samples)[28]
                        assert p95 <= .1, f'camera blocked STOP p95 {p95:.6f}s'
                        assert h.hub.session.core.latch and h.hub.session.core.out == (0.,0.,0.)
                        # Re-establish motion through the existing Hub test interface,
                        # then run the real independent watchdog with inputs stopped.
                        peer=next(p for p in h.hub.peers if h.hub.peers[p].user is not None)
                        assert h.take(peer)['ok']
                        h.unlock(peer); h.cmd(peer,0); h.cmd(peer)
                        assert h.hub.session.core.out[0] == .6
                        started=time.monotonic(); h.clock.t += .301
                        while h.hub.session.core.out[0] != 0 and time.monotonic()-started < .4:
                            await asyncio.sleep(.005)
                        elapsed=time.monotonic()-started
                        assert h.hub.session.core.out == (0.,0.,0.) and elapsed <= .4
                        print(f'slow-camera STOP n=30 p95_ms={p95*1000:.3f} fake-clock-deadman-watchdog_ms={elapsed*1000:.3f}')
            finally:
                server.stopping.set(); await task; h.verifier.close()
    asyncio.run(run())
