"""Synthetic data, fake DDS/HTTP only; never imports the actual SDK."""
import asyncio
import base64
import json
import os
from pathlib import Path
import struct
import subprocess
import sys
import threading
import time
from types import SimpleNamespace as NS
from uuid import uuid4

import numpy as np
import pytest

from foothold_agent.link.client import Settings
from foothold_agent.mapping.grid import OccGrid
from foothold_agent.mapping.world import WorldAccumulator
from foothold_agent.mapping.uslam_control import Control
from foothold_agent.mapping.onboard import OnboardRuntime
from foothold_agent.mapping.inputs import FRONTEND, CLOUD, MAP


FIXTURES = Path(__file__).parent / 'fixtures'


def command(op='start', previous=None):
    return dict(t='slam', op=op, source='unitree_uslam', session_id=(previous or {}).get('session_id', str(uuid4())),
                floor_id=(previous or {}).get('floor_id', str(uuid4())), command_id=str(uuid4()),
                revision=1, requested_at='2026-11-25T00:00:00Z')


def cloud(points=((1,0,.3),), stamp=1, frame='map'):
    data = np.asarray(points, dtype='<f4').tobytes()
    return NS(data=data, width=len(points), height=1, point_step=12, row_step=len(data), is_bigendian=False,
              fields=[NS(name=k, offset=i*4, datatype=7, count=1) for i,k in enumerate('xyz')],
              header=NS(frame_id=frame, stamp=NS(sec=stamp, nanosec=0)))


def pose(stamp=1, frame='map'):
    return NS(header=NS(frame_id=frame, stamp=NS(sec=stamp, nanosec=0)), child_frame_id='base_link',
              pose=NS(pose=NS(position=NS(x=0.,y=0.,z=.3), orientation=NS(w=1.,x=0.,y=0.,z=0.))))


def runtime(tmp_path, **kwargs):
    return OnboardRuntime(NS(connected=True, link_lost=False, reconnect_required=False), NS(),
        Settings('wss://example.invalid/api/v1/agent/ws', 'fake'), str(uuid4()),
        {'FH_MAPPING_CACHE_DIR':str(tmp_path)}, request=lambda *args: {'accepted':True}, **kwargs)


def test_reference_fixture_matches_web_and_projection_never_clears():
    fixture = json.loads((FIXTURES/'uslam_room.json').read_text())
    grid = OccGrid(fixture['size'], mode='scan')
    projection = OccGrid(fixture['size'])
    for frame in fixture['frames']:
        grid.add(frame['points'], frame['pose'], budget_ms=float('inf'))
        projection.add(frame['points'], frame['pose'], budget_ms=float('inf'))
    assert grid.L.min() < -10 and grid.L.max() == 40
    assert projection.L.min() == 0 and projection.L.max() == 40
    compiled = os.environ.get('FH_OCCGRID_JS')
    if compiled:
        actual = json.loads(subprocess.check_output(['node', str(FIXTURES/'occgrid_reference.cjs'),
            compiled, str(FIXTURES/'uslam_room.json')]))
        assert actual['c0'] == grid.c0 and actual['r0'] == grid.r0
        assert base64.b64decode(actual['L']) == grid.L.tobytes()
    else:
        # Golden generated from the exact web fixture; separate opt-in live TS comparison.
        golden = json.loads((FIXTURES/'uslam_room_golden.json').read_text())
        import hashlib
        assert hashlib.sha256(grid.L.tobytes()).hexdigest() == golden['sha256']


def test_world_cells_delta_rebuild_negative_and_no_pose_transform():
    core = WorldAccumulator(budget_ms=100)
    assert core.command({k:v for k,v in command().items() if k in ('t','op','session_id','floor_id')})
    core.add_world([[-.01,0,.3],[-.02,0,.3],[1.01,0,.3]], [0,0,.3], [1,0,0,0], stamp=1, frame='map')
    assert set(core.cells) == {(-1,0,6),(20,0,6)}
    core.add_world([[1.01,0,.3]], [1,0,.3], [0,0,0,1], stamp=2, frame='map', replace=True)
    assert set(core.cells) == {(20,0,6)} and core.removed == {(-1,0,6)}
    assert core.grid.mode == 'projection' and not (core.grid.L < 0).any()
    with pytest.raises(ValueError):
        core.add_world([[1,0,0]], [0,0,0], [1,0,0,0], stamp=2, frame='odom')


def test_point_cap_and_time_budget_are_bounded():
    tick = NS(t=0.)
    def now():
        tick.t += .001
        return tick.t
    core = WorldAccumulator(cap=100, now=now, budget_ms=10)
    core.add_world(np.tile([[1.,0.,.3]], (1000000,1)), [0,0,.3], [1,0,0,0], stamp=1, frame='map')
    assert len(core.cells) <= 100 and core.truncated


def test_control_disabled_allowlist_single_flight_no_replay_and_timeout():
    clock, writes = NS(t=0.), []
    control = Control(writes.append, now=lambda: clock.t)
    assert not control.request('mapping/start', 'disabled') and writes == []
    control.enabled = lambda: True
    assert not control.request('guess/rpc', 'bad')
    assert control.request('mapping/start', 'one')
    assert not control.request('mapping/stop', 'two')
    clock.t = 11
    assert control.tick() == 'UNKNOWN'
    control.disconnect()
    assert not control.request('mapping/start', 'one') and writes == ['mapping/start']


def test_control_exact_fresh_ack_only():
    clock = NS(t=1.)
    control = Control(lambda _:None, enabled=lambda: True, now=lambda:clock.t,
        acknowledgments={'mapping/start':'VERIFIED_START'})
    assert control.request('mapping/start','one')
    clock.t = 2.
    control.on_log('VERIFIED_START', .5)
    control.on_log('prefix VERIFIED_START', 1.5)
    assert control.status == 'WAITING'
    control.on_log('VERIFIED_START', 1.5)
    assert control.status == 'ACKNOWLEDGED'


def test_dds_boundary_response_first_default_no_writer_and_exact_allowlist(monkeypatch):
    from foothold_agent.go2_direct.uslam_commands import CommandChannel
    calls = []
    class Reader:
        def __init__(self,*args): calls.append('reader')
        def Init(self,*args): calls.append('read_init')
        def Close(self): calls.append('read_close')
    class Writer:
        def __init__(self,*args): calls.append('writer')
        def Init(self): calls.append('write_init')
        def Write(self,msg): calls.append(msg.data)
        def Close(self): calls.append('write_close')
    monkeypatch.setitem(sys.modules,'unitree_sdk2py.core.channel',NS(ChannelSubscriber=Reader,ChannelPublisher=Writer))
    monkeypatch.setitem(sys.modules,'unitree_sdk2py.idl.std_msgs.msg.dds_',NS(String_=lambda **kw:NS(**kw)))
    enabled=NS(value=False)
    bridge=CommandChannel(lambda _:None,lambda:enabled.value)
    bridge.open()
    with pytest.raises(PermissionError): bridge.publish('mapping/start')
    assert calls == ['reader','read_init']
    enabled.value=True
    with pytest.raises(PermissionError): bridge.publish('other')
    bridge.publish('mapping/start')
    assert calls == ['reader','read_init','writer','write_init','mapping/start']
    bridge.close()


def test_runtime_synchronized_frontend_only_bad_frame_stamp_and_no_replay(tmp_path):
    rt=runtime(tmp_path)
    rt.online=True
    start=command();rt.command(start);rt.step()
    assert rt.phase=='UNKNOWN' and rt.control.status=='DISABLED'
    for msg in (pose(frame='odom'),pose()):
        rt.receive(FRONTEND,msg);rt.step()
    rt.receive(CLOUD,cloud(frame='odom'));rt.step()
    assert not rt.core.cells
    rt.receive(CLOUD,cloud());rt.step()
    assert rt.core.cells
    version=rt.core.version
    rt.receive(CLOUD,cloud());rt.step()
    assert rt.core.version==version
    rt.suspend();rt.online=True
    rt.command(start);rt.step()
    assert rt.core.version==version and len(rt.control.seen)==1
    rt.io.shutdown(wait=True)


def test_old_start_ack_cannot_confirm_save(tmp_path):
    rt=runtime(tmp_path,command_allowed=lambda:True)
    rt.env['FH_USLAM_COMMANDS']='1'
    rt.bridge=NS(publish=lambda _:None)
    rt.online=True
    start=command();rt.command(start);rt.step()
    assert rt.control.pending=='mapping/start'
    rt.command(command('save',start));rt.step()
    assert rt.phase=='UNKNOWN' and rt.control.pending is None
    rt.io.shutdown(wait=True)


def test_save_freezes_one_pair_and_retries_same_bytes(tmp_path):
    tick=NS(t=0.)
    rt=runtime(tmp_path,now=lambda:tick.t)
    calls=[]
    def request(session,suffix,data):
        if suffix=='bundle':
            assert not rt.changes and not rt.tiles.pending
            calls.append(data)
            if len(calls)==1: raise OSError('fake timeout')
        return {'accepted':True}
    rt.request=request
    rt.online=True
    start=command();rt.command(start);rt.step()
    rt.receive(FRONTEND,pose());rt.receive(CLOUD,cloud());rt.step()
    rt.command(command('save',start));rt.step()
    tick.t=11.;rt.step()
    deadline=time.monotonic()+10
    while rt.save_future is None and time.monotonic()<deadline:
        tick.t+=.3;rt.step();time.sleep(.01)
    assert rt.save_future is not None
    while not rt.save_future.done() and time.monotonic()<deadline: time.sleep(.01)
    rt.step()
    assert rt.save_failed
    rt.command(command('save',start));rt.step()
    deadline=time.monotonic()+10
    while rt.save_future is None and time.monotonic()<deadline:
        tick.t+=.3;rt.step();time.sleep(.01)
    assert rt.save_future is not None
    while not rt.save_future.done() and time.monotonic()<deadline: time.sleep(.01)
    rt.step()
    assert rt.core.status=='SAVED' and calls[0]==calls[1]
    body=json.loads(calls[0])
    assert body['grid']['resolution']==.05 and body['robot_save']=='UNKNOWN'
    assert (tmp_path/(start['session_id']+'.bundle.json')).read_bytes()==calls[0]
    rt.io.shutdown(wait=True)


def test_hung_observation_init_and_http_do_not_block_stop(tmp_path):
    from foothold_agent.go2_direct.server import DriveSession
    release=threading.Event()
    rt=runtime(tmp_path)
    rt.online=True
    rt.request=lambda *args:release.wait(5)
    rt.command(command());rt.step()
    assert rt.report_future is not None
    rt.channel=NS(cloud_bus=NS(subscribe=lambda *a,**k:release.wait(5)))
    worker=threading.Thread(target=rt.acquire,daemon=True);worker.start()
    feedback=NS(telemetry=lambda:{},sample=lambda:None,posture_snapshot=lambda:dict(state='UNKNOWN',mode=None))
    session=DriveSession(feedback);session.connect()
    started=time.monotonic();effects=session.receive({'t':'stop','stop_ref':1})
    assert time.monotonic()-started < .1
    assert session.core.latch and any(c.kind=='stop' for c in effects.motion)
    assert not rt.report_future.done()
    release.set();worker.join(1)
    rt.io.shutdown(wait=True)


def test_tiles_negative_origin_coalescing_ack_and_oldest_first():
    from foothold_agent.mapping.tiles import Tiles
    grid=OccGrid(128)
    tiles=Tiles()
    grid.add([[-1,0,.3],[1,0,.3]], [0,0,.3], budget_ms=100)
    tiles.changed(grid)
    batch=tiles.take(grid,limit=1)
    assert batch[0]['tx']==-1 and len(batch[0]['cells'])==4096
    assert 2 in batch[0]['cells']
    key=(batch[0]['tx'],batch[0]['ty'])
    # Force an updated tile while its old version is in flight.
    grid.dirty.add(grid.at(-1,0));tiles.changed(grid)
    tiles.acknowledge(batch)
    assert key in tiles.pending and next(iter(tiles.pending))==key
    latest=tiles.take(grid,limit=1);tiles.acknowledge(latest)
    assert key not in tiles.pending and tiles.pending


def test_setup_observes_without_motion_approval_and_closes_on_identity_change(monkeypatch):
    from foothold_agent.setup import runtime as setup
    from foothold_agent.setup.view import Status
    from foothold_agent.link.client import Client
    from test_setup_pairing import credentials, NIC_VALUE, low, sport

    async def scenario():
        stop=asyncio.Event();made=[];received=[];state={};changed=NS(value=False)
        inputs=setup.Inputs()
        def pulse():
            n=state.get('n',0)+1;state['n']=n
            inputs.lowstate(low(n,sn=(9,9) if changed.value else (1234,5678)))
            inputs.sportmodestate(sport(n))
            state['pulse']=asyncio.get_running_loop().call_later(.01,pulse)
        async def background():
            await asyncio.Future()
        class FakeClient(Client):
            async def run(self):
                state['client']=self
                self._emit(self.session.connect())
                while not stop.is_set():
                    self._emit(self.session.receive({'t':'ping'}))
                    await asyncio.sleep(.02)
        class Media:
            def __init__(self,enabled):
                self.enabled=enabled;self.closed=False
                self.source=NS(close=lambda:setattr(self,'closed',True))
            async def run(self): await asyncio.Future()
        def observation(*args):
            item=Media(args[-1]);made.append(item);return item
        def mapping(observer, *args, enabled, **kwargs):
            state['mapping_enabled']=enabled
            observer.mapping=NS(command=received.append,close=lambda:None)
            return asyncio.create_task(background())
        def forbidden(*args,**kw):
            raise AssertionError('observation must not construct motion objects')
        recorder=NS(notice='',stopped=threading.Event(),start=lambda:None,close=lambda:None)
        monkeypatch.setattr(setup,'observation_publisher',observation)
        import foothold_agent.mapping.runtime as mapping_module
        monkeypatch.setattr(mapping_module,'attach',mapping)
        pulse()
        task=asyncio.create_task(setup.run(credentials(),NIC_VALUE,inputs,NS(cloud_bus=NS()),
            ready=True,check_nic=lambda:True,status=Status(),stop=stop,client_factory=FakeClient,
            connect=forbidden,sink_factory=forbidden,media_factory=forbidden,
            recorder_factory=lambda *a,**k:recorder))
        try:
            async with asyncio.timeout(3):
                while not made: await asyncio.sleep(.01)
            client=state['client']
            assert client.sink.active is None and state['mapping_enabled']()
            client.session.receive(command())
            assert received and client.session.core.latch
            changed.value=True
            async with asyncio.timeout(3):
                while not made[0].closed: await asyncio.sleep(.01)
            assert not made[0].enabled() and not state['mapping_enabled']()
        finally:
            stop.set();state['pulse'].cancel();await asyncio.wait_for(task,3)
    asyncio.run(scenario())


def test_large_cloud_and_bundle_encoding_leave_control_loop_runnable(tmp_path):
    from foothold_agent.mapping.onboard import encode
    from foothold_agent.go2_direct.server import DriveSession
    rt=runtime(tmp_path)
    rt.online=True
    start=command();rt.command(start);rt.step()
    rt.receive(FRONTEND,pose());rt.step()
    sample=cloud(np.tile([[1.,0.,.3]],(1000000,1)))
    ready=threading.Event()
    def heavy():
        ready.set()
        rt.consume_samples({CLOUD:(rt.now(),sample)})
        encode({'cells':[0]*4000000})
    worker=threading.Thread(target=heavy,daemon=True);worker.start();ready.wait(1)
    feedback=NS(telemetry=lambda:{},sample=lambda:None,posture_snapshot=lambda:dict(state='UNKNOWN',mode=None))
    session=DriveSession(feedback);session.connect()
    latency=[]
    while worker.is_alive():
        started=time.monotonic();effects=session.receive({'t':'stop','stop_ref':1})
        latency.append(time.monotonic()-started)
        assert any(c.kind=='stop' for c in effects.motion)
        time.sleep(.001)
    assert latency and max(latency)<.2
    worker.join(1);rt.io.shutdown(wait=True)


def test_progress_and_bundle_validate_against_server_contract(tmp_path):
    from apps.contracts import models as contracts
    draft=os.environ.get('FH_USLAM_CONTRACT_MODULE')
    if draft:
        import importlib.util
        spec=importlib.util.spec_from_file_location('apps.contracts._uslam_draft',draft)
        contracts=importlib.util.module_from_spec(spec)
        sys.modules[spec.name]=contracts
        spec.loader.exec_module(contracts)
    if not hasattr(contracts,'MappingBundle'):
        pytest.skip('server contract PR #476 is not yet integrated')
    rt=runtime(tmp_path)
    rt.online=True
    rt.command(command());rt.step()
    rt.receive(FRONTEND,pose());rt.receive(CLOUD,cloud());rt.step()
    body,_,_=rt.report_body()
    contracts.AgentMappingUpdate.model_validate(body)
    assert body['odom']['stamp']=={'sec':1,'nanosec':0} and body['tiles']
    contracts.MappingBundle.model_validate(dict(session_id=rt.core.session_id,revision=rt.revision,
        frame_id=rt.frame,resolution=.05,voxels=list(rt.core.cells),grid=rt.grid_body(),robot_save='UNKNOWN'))
    rt.io.shutdown(wait=True)


def test_progress_splits_byte_limit_and_acknowledges_only_sent_oldest_changes(tmp_path):
    tick=NS(t=0.);sent=[]
    rt=runtime(tmp_path,now=lambda:tick.t)
    rt.request=lambda session,suffix,data:sent.append(data) or {'accepted':True}
    rt.online=True;rt.command(command());rt.step()
    rt.report_future.result();rt.step()
    keys=[(i-5000,0,0) for i in range(10000)]
    rt.core.cells={key:(0,0,0) for key in keys}
    for key in keys:rt.changes[key]=(True,1)
    rt.core.grid.add([[1,0,.3]], [0,0,.3],budget_ms=100)
    rt.tiles.changed(rt.core.grid)
    for _ in range(12):
        tick.t+=1;rt.step()
        if rt.report_future is not None:
            rt.report_future.result();rt.step()
    assert all(len(data)<=65536 for data in sent)
    batches=[json.loads(data)['voxels']['added'] for data in sent]
    assert [tuple(key) for batch in batches for key in batch]==keys
    assert not rt.changes and not rt.tiles.pending
    rt.io.shutdown(wait=True)


def test_full_map_rebuild_is_chunked_complete_and_replaces_old_revision(tmp_path):
    rt=runtime(tmp_path);rt.online=True
    rt.command(command());rt.step()
    rt.receive(FRONTEND,pose());rt.receive(CLOUD,cloud([[-1,0,.3]]));rt.step()
    old_revision=rt.revision
    points=np.column_stack((np.arange(10000)*.051,np.zeros(10000),np.full(10000,.3)))
    rt.receive(MAP,cloud(points));rt.step()
    assert rt.rebuild is not None and rt.revision==old_revision
    for _ in range(10):
        if rt.rebuild is None: break
        rt.step()
    assert rt.rebuild is None and rt.revision==old_revision+1
    assert len(rt.core.cells)==10000 and (-20,0,6) not in rt.core.cells
    assert rt.core.grid.mode=='projection' and not (rt.core.grid.L < 0).any()
    assert rt.reset and len(rt.changes)==10000
    rt.io.shutdown(wait=True)
