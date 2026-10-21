"""Review repros promoted to regressions; all synthetic images stay in memory."""
import asyncio
import json
import socket
import threading
import time

import pytest

from test_camera import WS, jpeg, Harness, phone_socket, signed
from foothold_agent.camera import Camera, CameraTransport, jpeg_size
from foothold_agent.phone.server import Server, Settings


def test_token_cannot_reopen_after_first_video_closes():
    async def run():
        h=Harness();tasks=[]
        try:
            peer,_,_=h.connect(purpose='view')
            transport=CameraTransport(Camera(h.robot),h.hub)
            hello=dict(t='camera.hello',robot=h.robot,token=transport.issue(peer))
            first=WS(hello);task=asyncio.create_task(transport.handler(first));tasks.append(task)
            await asyncio.wait_for(first.sending.wait(),1)
            first.input.put_nowait('close only video');await task
            assert peer in h.hub.peers and peer not in transport.active
            second=WS(hello);retry=asyncio.create_task(transport.handler(second));tasks.append(retry)
            await asyncio.sleep(.03)
            assert retry.done() and second.code==4403 and not second.frames
        finally:
            for task in tasks:task.cancel()
            await asyncio.gather(*tasks,return_exceptions=True)
            h.hub.close();h.verifier.close()
    asyncio.run(run())


def test_active_camera_rejects_even_a_fresh_parent_token():
    async def run():
        h=Harness();tasks=[]
        try:
            peer,_,_=h.connect()
            transport=CameraTransport(Camera(h.robot),h.hub)
            first=WS(dict(t='camera.hello',robot=h.robot,token=transport.issue(peer)))
            task=asyncio.create_task(transport.handler(first));tasks.append(task)
            await asyncio.wait_for(first.sending.wait(),1)
            second=WS(dict(t='camera.hello',robot=h.robot,token=transport.issue(peer)))
            retry=asyncio.create_task(transport.handler(second));tasks.append(retry)
            await asyncio.sleep(.03)
            assert retry.done() and second.code==4403 and not second.frames
        finally:
            for task in tasks:task.cancel()
            await asyncio.gather(*tasks,return_exceptions=True)
            h.hub.close();h.verifier.close()
    asyncio.run(run())


@pytest.mark.parametrize('same_address',[False,True])
def test_pending_capacity_is_bounded_per_address_and_globally(same_address):
    async def run():
        h=Harness();tasks=[]
        transport=CameraTransport(Camera(h.robot),h.hub)
        try:
            limit=2 if same_address else 16
            for i in range(limit+1):
                ws=WS({});ws.input.get_nowait()
                ws.remote_address=('127.0.0.2' if same_address else f'127.0.0.{i+2}',9438)
                task=asyncio.create_task(transport.handler(ws));tasks.append(task)
                await asyncio.sleep(.001)
            assert tasks[-1].done() and ws.code==1013
            assert transport.pending==limit
        finally:
            for task in tasks:task.cancel()
            await asyncio.gather(*tasks,return_exceptions=True)
            assert not transport.waiting_addresses
            h.hub.close();h.verifier.close()
    asyncio.run(run())


def test_slow_camera_timeout_has_transport_reason():
    async def run():
        h=Harness();peer,_,_=h.connect()
        transport=CameraTransport(Camera(h.robot),h.hub)
        ws=WS(dict(t='camera.hello',robot=h.robot,token=transport.issue(peer)),block=True)
        task=asyncio.create_task(transport.handler(ws))
        try:
            await asyncio.sleep(.3)
            assert task.done() and ws.code==1013
            assert peer in h.hub.peers
        finally:
            task.cancel();await asyncio.gather(task,return_exceptions=True)
            h.hub.close();h.verifier.close()
    asyncio.run(run())


def worst_jpeg():
    tail=jpeg()[3:]
    return b'\xff\xd8'+b'\xff'*(65536-2-len(tail))+tail


def test_source_throttle_precedes_jpeg_parse(monkeypatch):
    import foothold_agent.camera.stream as module
    count=[];yields=[];parse=module.jpeg_size
    monkeypatch.setattr(module.time,'sleep',lambda seconds:yields.append(seconds))
    monkeypatch.setattr(module,'jpeg_size',lambda data:(count.append(1) or parse(data)))
    camera=Camera('synthetic',now=lambda:0)
    assert sum(camera.submit(worst_jpeg()) for _ in range(1000))==1
    assert len(count)==1 and yields==[0]*999


def test_worst_frame_flood_keeps_tick_cadence():
    async def run():
        camera=Camera('synthetic');stop=threading.Event();frame=worst_jpeg()
        assert jpeg_size(frame)==(424,240)
        def flood():
            while not stop.is_set():camera.submit(frame)
        thread=threading.Thread(target=flood,daemon=True)
        async def ticks():
            stamps=[time.monotonic()]
            for _ in range(20):
                await asyncio.sleep(.05);stamps.append(time.monotonic())
            return max(b-a for a,b in zip(stamps,stamps[1:]))
        baseline=await ticks();thread.start()
        try:loaded=await ticks()
        finally:stop.set();thread.join(1)
        print(f'worst JPEG tick baseline_ms={baseline*1000:.3f} loaded_ms={loaded*1000:.3f}')
        assert loaded<=max(.075,baseline+.020)
    asyncio.run(run())


def test_20ms_rtt_and_nagle_diagnosis():
    from websockets.asyncio.client import connect
    class NagleServer(Server):
        async def _read(self,ws,peer):
            ws.transport.get_extra_info('socket').setsockopt(socket.IPPROTO_TCP,socket.TCP_NODELAY,0)
            await super()._read(ws,peer)
    async def measure(cls):
        h=Harness()
        with phone_socket() as sock:
            port=sock.getsockname()[1]
            server=cls(h.hub,Settings('127.0.0.1',port,'unused','test','1',h.org,'unused.sqlite',True,True),sock=sock)
            task=asyncio.create_task(server.run());await server.ready.wait()
            try:
                async with connect(f'ws://127.0.0.1:{port}/phone/ws',proxy=None) as ws:
                    c=h.claims()
                    await ws.send(json.dumps(dict(t='hello',id='h',robot=h.robot,proto='fh-phone/1',device=c['device'],ticket=signed(h.key,c))))
                    await ws.recv();samples=[]
                    for i in range(60):
                        started=time.monotonic()
                        await ws.send(json.dumps(dict(t='stop',id=str(i),robot=h.robot)))
                        while json.loads(await ws.recv()).get('id')!=str(i):pass
                        samples.append(time.monotonic()-started);await asyncio.sleep(.02)
                    return sorted(samples)[56]
            finally:server.stopping.set();await task;h.verifier.close()
    async def run():
        off=await measure(NagleServer);on=await measure(Server)
        print(f'20ms STOP p95 NODELAY=0 {off*1000:.3f}ms NODELAY=1 {on*1000:.3f}ms')
        assert on<.020
    asyncio.run(run())
