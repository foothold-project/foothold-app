"""Synthetic data, fake DDS/HTTP only; never imports the actual SDK."""
import asyncio
import base64
import json
import os
from pathlib import Path
import struct
import shutil
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
from foothold_agent.mapping.onboard import OnboardRuntime
from foothold_agent.slam_source import Source
FRONTEND,CLOUD,MAP='rt/aft_mapped_to_init','rt/cloud_registered','rt/glim/final_cloud'
FINAL_POSE='rt/glim/final_odom'


FIXTURES = Path(__file__).parent / 'fixtures'


def command(op='start', previous=None):
    return dict(t='slam', op=op, source='point_lio', session_id=(previous or {}).get('session_id', str(uuid4())),
                pipeline='point_lio+glim',final_source='glim',
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
    env=kwargs.pop('env',{'FH_MAPPING_POINT_LIO_FRAME':'map','FH_MAPPING_GLIM_FRAME':'map',
        'FH_MAPPING_GLIM_CLOUD_TOPIC':'/glim/final_cloud','FH_MAPPING_GLIM_ODOM_TOPIC':'/glim/final_odom'})
    env['FH_MAPPING_CACHE_DIR']=str(tmp_path)
    return OnboardRuntime(NS(connected=True, link_lost=False, reconnect_required=False), NS(),
        Settings('wss://example.invalid/api/v1/agent/ws', 'fake'), str(uuid4()),
        env, request=lambda *args: {'accepted':True}, **kwargs)


def test_reference_fixture_matches_web_and_projection_never_clears():
    fixture = json.loads((FIXTURES/'slam_room.json').read_text())
    grid = OccGrid(fixture['size'], mode='scan')
    projection = OccGrid(fixture['size'])
    for frame in fixture['frames']:
        grid.add(frame['points'], frame['pose'], budget_ms=float('inf'))
        projection.add(frame['points'], frame['pose'], budget_ms=float('inf'))
    assert grid.L.min() < -10 and grid.L.max() == 40
    assert projection.L.min() == 0 and projection.L.max() == 40
    if shutil.which('node'):   # 웹에서 지운 occgrid.ts 를 옮겨 둔 fixture(RB-SLAM-WEB3)
        actual = json.loads(subprocess.check_output(['node', str(FIXTURES/'occgrid_reference.cjs'),
            str(FIXTURES/'slam_room.json')]))
        assert actual['c0'] == grid.c0 and actual['r0'] == grid.r0
        assert base64.b64decode(actual['L']) == grid.L.tobytes()
    else:
        # Golden generated from the same reference fixture; used when node is not installed.
        golden = json.loads((FIXTURES/'slam_room_golden.json').read_text())
        import hashlib
        assert hashlib.sha256(grid.L.tobytes()).hexdigest() == golden['sha256']


def test_world_cells_delta_rebuild_negative_and_no_pose_transform():
    core = WorldAccumulator(frame='map',budget_ms=100)
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
    core = WorldAccumulator(frame='map',cap=100,now=now,budget_ms=10)
    core.add_world(np.tile([[1.,0.,.3]], (1000000,1)), [0,0,.3], [1,0,0,0], stamp=1, frame='map')
    assert len(core.cells) <= 100 and core.truncated








def test_runtime_synchronized_frontend_only_bad_frame_stamp_and_no_replay(tmp_path):
    rt=runtime(tmp_path)
    rt.online=True
    start=command();rt.command(start);rt.step()
    assert rt.phase=='UNKNOWN' and rt.services.status=='DISABLED'
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
    assert rt.core.version==version and len(rt.seen)==1
    second=command();rt.command(second);rt.step()
    rt.receive(FRONTEND,pose());rt.receive(CLOUD,cloud());rt.step()
    assert rt.core.session_id==second['session_id'] and rt.core.version==1 and rt.core.cells
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
            return {'session_id':session,'status':'RECEIVED_ONLY'}
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
    assert (tmp_path/(start['session_id']+'.bundle.json')).read_bytes()==calls[0]
    assert rt.report_body()[0]['error_code']=='MAPPING_SAVE_FAILED'
    rt.command(command('save',start));rt.step()
    deadline=time.monotonic()+10
    while rt.save_future is None and time.monotonic()<deadline:
        tick.t+=.3;rt.step();time.sleep(.01)
    assert rt.save_future is not None
    while not rt.save_future.done() and time.monotonic()<deadline: time.sleep(.01)
    rt.step()
    assert rt.core.status=='SAVED' and calls[0]==calls[1]
    body=json.loads(calls[0])
    assert body['grid']['resolution']==.05 and body['slam_save']=='UNKNOWN'
    assert not (tmp_path/(start['session_id']+'.bundle.json')).exists()
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
    draft=os.environ.get('FH_SLAM_CONTRACT_MODULE')
    if draft:
        import importlib.util
        registry=Path(draft).with_name('mapping_sources.py')
        if registry.exists():
            registry_spec=importlib.util.spec_from_file_location('apps.contracts.mapping_sources',registry)
            registry_module=importlib.util.module_from_spec(registry_spec)
            sys.modules[registry_spec.name]=registry_module
            registry_spec.loader.exec_module(registry_module)
        spec=importlib.util.spec_from_file_location('apps.contracts._slam_draft',draft)
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
    from apps.contracts.mapping_sources import ADAPTERS
    assert rt.source.source in ADAPTERS
    assert ADAPTERS[rt.source.source].accepts_odom(body['odom']['source'])
    contracts.MappingBundle.model_validate(dict(session_id=rt.core.session_id,revision=rt.revision,
        frame_id=rt.frame,resolution=.05,voxels=list(rt.core.cells),grid=rt.grid_body(),source=rt.source.source,slam_save='UNKNOWN'))
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
    rt.command(command('save',dict(session_id=rt.core.session_id,floor_id=rt.core.floor_id)));rt.step()
    rt.final.frame='corrected_world'
    rt.receive(FINAL_POSE,pose(frame='corrected_world'));rt.receive(MAP,cloud(points,frame='corrected_world'));rt.step()
    assert rt.rebuild is not None and rt.revision==old_revision
    for _ in range(30):
        if rt.rebuild is None: break
        rt.step()
    assert rt.rebuild is None and rt.revision==old_revision+1
    assert len(rt.core.cells)==10000 and (-20,0,6) not in rt.core.cells
    assert rt.core.truncated  # 3D spans 510 m; the bounded 2D window is 100 m
    assert rt.core.grid.mode=='projection' and not (rt.core.grid.L < 0).any()
    assert rt.reset and len(rt.changes)==10000
    assert rt.source.source=='glim' and rt.frame=='corrected_world'
    assert rt.last_odom['provider']=='glim' and rt.last_odom['frame_id']=='corrected_world'
    revision=rt.revision
    rt.receive(FRONTEND,pose(stamp=2));rt.receive(CLOUD,cloud(stamp=2));rt.step()
    assert rt.revision==revision and rt.source.source=='glim' and len(rt.core.cells)==10000
    late_pose=pose(stamp=3,frame='corrected_world');late_pose.pose.pose.position.x=1.
    rt.receive(FINAL_POSE,late_pose)
    rt.receive(MAP,cloud(stamp=3,frame='corrected_world'));rt.step()
    assert rt.rebuild is None and rt.revision==revision and len(rt.core.cells)==10000
    assert rt.last_odom['x']==0.
    rt.io.shutdown(wait=True)


def wait_for(check,timeout=3):
    deadline=time.monotonic()+timeout
    while not check() and time.monotonic()<deadline:time.sleep(.005)
    assert check()


def test_service_switch_default_off_and_names_allowlist():
    from foothold_agent.mapping.services import Services
    calls=[]
    services=Services({},lambda:True,run=lambda *args:calls.append(args))
    assert not services.start() and calls==[] and services.thread is None
    with pytest.raises(ValueError):Services({'FH_MAPPING_POINT_LIO_SERVICE':'ssh'},lambda:True)
    services.close()


def test_services_stop_only_units_started_by_this_session():
    from foothold_agent.mapping.services import Services
    calls=[];active={'foothold-pointlio'}
    def run(action,name):
        calls.append((action,name))
        if action=='is-active':return 0 if name in active else 3
        if action=='start':active.add(name)
        if action=='stop':active.discard(name)
        return 0
    services=Services({'FH_MAPPING_SERVICE_CONTROL_ENABLED':'true'},lambda:True,run=run)
    assert services.start()
    wait_for(lambda:services.status=='STARTED')
    assert services.owned=={'foothold-glim'}
    services.stop();wait_for(lambda:not services.owned)
    assert active=={'foothold-pointlio'}
    assert ('stop','foothold-pointlio') not in calls
    services.close();services.thread.join(1)


def test_hung_service_start_never_holds_stop_and_cancel_cleans_owned_units():
    from foothold_agent.mapping.services import Services
    from foothold_agent.go2_direct.server import DriveSession
    entered,release=threading.Event(),threading.Event();calls=[]
    def run(action,name):
        calls.append((action,name))
        if action=='is-active':return 3
        if action=='start':entered.set();release.wait(3)
        return 0
    services=Services({'FH_MAPPING_SERVICE_CONTROL_ENABLED':'true'},lambda:True,run=run)
    assert services.start() and entered.wait(1)
    feedback=NS(telemetry=lambda:{},sample=lambda:None,posture_snapshot=lambda:dict(state='UNKNOWN',mode=None))
    session=DriveSession(feedback);session.connect()
    before=time.monotonic();effects=session.receive({'t':'stop','stop_ref':1})
    assert time.monotonic()-before<.1 and any(c.kind=='stop' for c in effects.motion)
    services.stop();release.set();wait_for(lambda:services.status=='STOPPED')
    assert not services.owned and ('start','foothold-glim') not in calls
    services.close();services.thread.join(1)


def test_disconnect_closes_readers_then_stops_owned_services_without_restart(tmp_path):
    clock=NS(t=0.);enabled=NS(value=True);calls=[];closed=[]
    def run(action,name):
        calls.append((action,name));return 3 if action=='is-active' else 0
    rt=runtime(tmp_path,now=lambda:clock.t,enabled=lambda:enabled.value,service_run=run)
    rt.env['FH_MAPPING_SERVICE_CONTROL_ENABLED']='true'
    rt.channel=NS(cloud_bus=NS(subscribe=lambda topic,*a,**k:NS(Close=lambda:closed.append(topic))))
    rt.online=True
    thread=threading.Thread(target=rt.worker,daemon=True);thread.start()
    start=command();rt.command(start)
    wait_for(lambda:rt.services.status=='STARTED')
    enabled.value=False
    wait_for(lambda:bool(closed))
    clock.t=11
    wait_for(lambda:not rt.services.owned)
    enabled.value=True;rt.online=True;rt.command(start)
    time.sleep(.08)
    assert len([c for c in calls if c[0]=='start'])==2
    assert all('/uslam/' not in topic for topic in closed)
    rt.close();thread.join(1);rt.io.shutdown(wait=True)


def test_missing_frame_and_unapproved_glim_final_are_visible_reasons(tmp_path):
    rt=runtime(tmp_path,env={});rt.online=True
    start=command();rt.command(start);rt.step()
    assert rt.report_body()[0]['error_code']=='MAPPING_FRAME_REQUIRED'
    assert rt.services.thread is None
    rt.command(command('save',start));rt.step()
    assert rt.report_body()[0]['error_code']=='GLIM_FINAL_CONFIGURATION_REQUIRED'
    rejected={**command(),'source':'unitree_uslam'}
    rt.command(rejected)
    assert not rt.commands
    rt.close();rt.io.shutdown(wait=True)


def test_mapping_command_is_received_without_movement_approval():
    from foothold_agent.setup.runtime import GatedSession
    from foothold_agent.go2_direct.feedback import Feedback
    gate=NS(inputs=object(),allowed=lambda:False)
    session=GatedSession(Feedback('1234-5678'),gate)
    received=[];session.mapping=NS(command=received.append)
    effects=session.receive(command())
    assert len(received)==1 and effects.motion==() and session.core.latch


def test_cancel_stops_owned_services_and_duplicate_start_never_restarts(tmp_path):
    calls=[]
    def run(action,name):
        calls.append((action,name));return 3 if action=='is-active' else 0
    rt=runtime(tmp_path,service_run=run);rt.env['FH_MAPPING_SERVICE_CONTROL_ENABLED']='true';rt.online=True
    start=command();rt.command(start);rt.step()
    wait_for(lambda:rt.services.status=='STARTED')
    rt.command(command('cancel',start));rt.step()
    wait_for(lambda:not rt.services.owned)
    rt.command(start);rt.step()
    assert len([c for c in calls if c[0]=='start'])==2 and rt.core.status=='CANCELLED'
    rt.close();rt.io.shutdown(wait=True)


def test_cancel_before_service_worker_takes_job_performs_no_start():
    from foothold_agent.mapping.services import Services
    calls=[]
    services=Services({'FH_MAPPING_SERVICE_CONTROL_ENABLED':'true'},lambda:True,run=lambda *a:calls.append(a))
    services.launch=lambda:None
    assert services.start() and services.pending
    services.stop();services.close();services.worker()
    assert not services.pending and calls==[] and services.status=='STOPPED'


def test_samples_received_before_service_start_completion_are_not_accumulated(tmp_path):
    clock=NS(t=10.2)
    rt=runtime(tmp_path,now=lambda:clock.t);rt.online=True
    rt.command(command());rt.step()
    rt.services.status='STARTED';rt.services.ready_at=10.1
    rt.consume_samples({FRONTEND:(10.,pose()),CLOUD:(10.,cloud())})
    assert not rt.core.cells
    rt.receive(FRONTEND,pose(stamp=2));rt.receive(CLOUD,cloud(stamp=2));rt.step()
    assert rt.core.cells and rt.core.status=='RUNNING'
    rt.close();rt.io.shutdown(wait=True)


def test_new_service_job_resets_previously_owned_graph_before_start():
    from foothold_agent.mapping.services import Services
    calls=[];active=set()
    def run(action,name):
        calls.append((action,name))
        if action=='is-active':return 0 if name in active else 3
        if action=='start':active.add(name)
        if action=='stop':active.discard(name)
        return 0
    services=Services({'FH_MAPPING_SERVICE_CONTROL_ENABLED':'true'},lambda:True,run=run)
    services.start();wait_for(lambda:services.status=='STARTED')
    boundary=len(calls)
    services.start();wait_for(lambda:services.status=='STARTED' and len(calls)>boundary)
    following=calls[boundary:]
    assert [action for action,_ in following[:2]]==['stop','stop']
    assert len([c for c in following if c[0]=='start'])==2
    services.close();services.thread.join(1)


def test_cancel_while_service_state_query_hangs_never_starts_unit():
    from foothold_agent.mapping.services import Services
    entered,release=threading.Event(),threading.Event();calls=[]
    def run(action,name):
        calls.append((action,name))
        if action=='is-active':entered.set();release.wait(2);return 3
        return 0
    services=Services({'FH_MAPPING_SERVICE_CONTROL_ENABLED':'true'},lambda:True,run=run)
    services.start();assert entered.wait(1)
    services.stop();release.set();wait_for(lambda:services.status=='STOPPED')
    assert all(action!='start' for action,_ in calls)
    services.close();services.thread.join(1)


def test_attaching_observer_and_empty_status_never_imports_numpy_on_control_loop(tmp_path,monkeypatch):
    import builtins
    original=builtins.__import__
    def guarded(name,*args,**kwargs):
        assert name!='numpy','numpy must initialize on the calculation worker'
        return original(name,*args,**kwargs)
    monkeypatch.setattr(builtins,'__import__',guarded)
    rt=runtime(tmp_path,env={})
    assert rt.core.grid._L is None
    rt.command(command());rt.step()
    assert rt.report_body()[0]['error_code']=='MAPPING_FRAME_REQUIRED'
    assert rt.core.grid._L is None
    rt.close();rt.io.shutdown(wait=True)


def test_time_cut_keeps_points_spread_across_the_entire_scan():
    clock=NS(t=0.)
    def now():clock.t+=.001;return clock.t
    core=WorldAccumulator(frame='world',cap=256,budget_ms=6,now=now)
    points=np.column_stack((np.linspace(-8,8,256),np.zeros(256),np.full(256,.3)))
    core.add_world(points,[0,0,.3],[1,0,0,0],stamp=1,frame='world')
    assert core.truncated and min(k[0] for k in core.cells)<-150 and max(k[0] for k in core.cells)>150


def test_world_bounds_match_the_contract_tile_coordinate_range():
    core=WorldAccumulator(frame='world')
    with pytest.raises(ValueError):
        core.add_world([[10000,0,.3]],[0,0,.3],[1,0,0,0],stamp=1,frame='world')
    core.add_world([[-10000,0,.3]],[-10000,0,.3],[1,0,0,0],stamp=2,frame='world')
    assert set(core.cells)=={(-200000,0,6)}


def test_router_keeps_old_four_key_pcd_and_new_pipeline_commands_separate():
    from foothold_agent.mapping.runtime import MappingRouter
    from foothold_agent.mapping.core import Accumulator
    async def scenario():
        router=MappingRouter(NS(connected=True,link_lost=False,reconnect_required=False),NS(),
            Settings('wss://example.invalid/api/v1/agent/ws','fake'),str(uuid4()),{},
            enabled=lambda:True,command_allowed=lambda:True)
        for mapper in (router.legacy,router.onboard):
            mapper.online=True;mapper.request=lambda *args:{'accepted':True}
        old={k:v for k,v in command().items() if k in ('t','op','session_id','floor_id')}
        router.command(old);router.legacy.step()
        assert type(router.legacy.core) is Accumulator and router.legacy.core.session_id==old['session_id']
        router.legacy.core.add([[1,0,.3]],[0,0,.3],[1,0,0,0],stamp=1,frame='odom')
        assert b'DATA binary\n' in router.legacy.core.pcd()
        new=command();router.command(new);router.onboard.step()
        assert router.onboard.core.session_id==new['session_id'] and router.legacy.core.session_id==old['session_id']
        assert router.onboard.services.thread is None
        router.close();router.legacy_task.cancel()
        await asyncio.gather(router.legacy_task,return_exceptions=True)
        router.legacy.io.shutdown(wait=True);router.onboard.io.shutdown(wait=True)
    asyncio.run(scenario())


def test_runtime_uses_source_adapter_topics_and_world_frame(tmp_path):
    from foothold_agent.slam_source import Source
    source=Source({'FH_MAPPING_POINT_LIO_FRAME':'synthetic_world'})
    source.cloud_topic,source.map_topic,source.odom_topic='synthetic/cloud','synthetic/full','synthetic/pose'
    rt=runtime(tmp_path,source=source);rt.online=True
    rt.command(command());rt.step()
    rt.receive(source.odom_topic,pose(frame='synthetic_world'))
    rt.receive(source.cloud_topic,cloud(frame='synthetic_world'))
    rt.step()
    assert rt.core.cells and rt.core.frame=='synthetic_world'
    assert rt.last_odom['frame_id']=='synthetic_world'
    assert rt.report_body()[0]['voxels']['frame_id']=='synthetic_world'
    rt.io.shutdown(wait=True)


def test_floor_z_stays_fixed_with_moving_pose_and_resets_for_each_revision(tmp_path):
    rt=runtime(tmp_path);rt.online=True
    start=command();rt.command(start);rt.step()
    try:
        for stamp,z in ((1,.4),(2,.401),(3,.2)):
            sample=pose(stamp=stamp);sample.pose.pose.position.z=z
            rt.receive(FRONTEND,sample);rt.receive(CLOUD,cloud([[stamp,0,.4]],stamp=stamp));rt.step()
            body,_,_=rt.report_body()
            assert rt.core.last_pose[2]==z
            assert body['grid']['floor_z']==.4-.3
            assert body['tiles'] and all(t['floor_z']==.4-.3 for t in body['tiles'])
        rt.command(command('save',start));rt.step()
        final_pose=pose(stamp=4);final_pose.pose.pose.position.z=.8
        rt.receive(FINAL_POSE,final_pose);rt.receive(MAP,cloud([[1,0,.8]],stamp=4));rt.step()
        assert rt.revision==2
        assert rt.grid_body()['floor_z']==.8-.3
        assert all(t['floor_z']==.8-.3 for t in rt.report_body()[0]['tiles'])
        rt.command(command());rt.step()
        assert rt.core.floor_z is None
        rt.receive(FRONTEND,pose());rt.receive(CLOUD,cloud());rt.step()
        assert rt.grid_body()['floor_z']==0.
    finally:
        rt.close();rt.io.shutdown(wait=True)


@pytest.mark.parametrize('status',['SAVED','RECEIVED_ONLY'])
def test_bundle_confirmed_receipt_removes_only_its_session_file(tmp_path,status):
    rt=runtime(tmp_path);sid=str(uuid4())
    other=tmp_path/(str(uuid4())+'.bundle.json');other.write_bytes(b'keep')
    rt.request=lambda *args:{'session_id':sid,'status':status}
    try:
        assert rt.store_bundle(b'{}',sid,threading.Event())['status']==status
        assert not (tmp_path/(sid+'.bundle.json')).exists()
        assert other.read_bytes()==b'keep'
    finally:
        rt.close();rt.io.shutdown(wait=True)


@pytest.mark.parametrize('response',[{'accepted':True},{'status':'SAVING'},
    {'status':'SAVED','session_id':str(uuid4())}])
def test_unconfirmed_bundle_receipt_retains_retry_file(tmp_path,response):
    from foothold_agent.mapping.runtime import TransferError
    rt=runtime(tmp_path);sid=str(uuid4())
    rt.request=lambda *args:response
    try:
        with pytest.raises(TransferError,match='수신 확인'):
            rt.store_bundle(b'{}',sid,threading.Event())
        assert (tmp_path/(sid+'.bundle.json')).read_bytes()==b'{}'
    finally:
        rt.close();rt.io.shutdown(wait=True)


@pytest.mark.parametrize('stage',['cached','writing','uploading'])
def test_cancel_removes_only_its_bundle_even_during_store(tmp_path,monkeypatch,stage):
    rt=runtime(tmp_path);rt.online=True
    start=command();rt.command(start);rt.step()
    sid=start['session_id'];path=tmp_path/(sid+'.bundle.json')
    other=tmp_path/(str(uuid4())+'.bundle.json');other.write_bytes(b'keep')
    cancelled=rt.bundle_cancelled
    entered,release=threading.Event(),threading.Event()
    def request(*args):
        entered.set();assert release.wait(3)
        raise OSError('cancelled upload')
    future=None
    try:
        if stage=='cached':
            path.write_bytes(b'{}')
        else:
            rt.request=request
            if stage=='writing':
                replace=os.replace
                def delayed_replace(*args):
                    entered.set();assert release.wait(3)
                    return replace(*args)
                monkeypatch.setattr(os,'replace',delayed_replace)
            future=rt.io.submit(rt.store_bundle,b'{}',sid,cancelled)
            assert entered.wait(1)
        rt.command(command('cancel',start));rt.step()
        assert rt.core.status=='CANCELLED' and cancelled.is_set()
        assert not path.exists()
        # Replacing the current session must not lose the old upload's cancel flag.
        rt.command(command());rt.step()
        assert not rt.bundle_cancelled.is_set()
        release.set()
        if future is not None:
            if stage=='uploading':
                with pytest.raises(OSError):future.result(timeout=3)
            else:
                future.result(timeout=3)
        assert not path.exists() and other.read_bytes()==b'keep'
    finally:
        release.set();rt.close();rt.io.shutdown(wait=True)


@pytest.mark.parametrize('key',['FH_MAPPING_POINT_LIO_SERVICE','FH_MAPPING_GLIM_SERVICE'])
@pytest.mark.parametrize('name',['foothold-robot','foothold-policy-cpp','foothold-depth'])
@pytest.mark.parametrize('suffix',['','.service','.service.service'])
def test_mapping_services_reject_control_units_before_any_operation(key,name,suffix,caplog):
    from foothold_agent.mapping.services import Services
    calls=[]
    with pytest.raises(ValueError,match='allowlist'):
        Services({'FH_MAPPING_SERVICE_CONTROL_ENABLED':'true',key:name+suffix},
            lambda:True,run=lambda *args:calls.append(args))
    assert calls==[]
    assert 'invalid_mapping_service_allowlist' in caplog.text


@pytest.mark.parametrize('truncated',[False,True])
def test_verified_glim_progress_and_bundle_agree_when_truncated(tmp_path,truncated):
    rt=runtime(tmp_path);rt.online=True;rt.final.final_verified=True
    start=command();rt.command(start);rt.step()
    try:
        rt.command(command('save',start));rt.step()
        points=[[1,0,.3],[200,0,.3]] if truncated else [[1,0,.3]]
        rt.receive(FINAL_POSE,pose());rt.receive(MAP,cloud(points));rt.step()
        assert rt.final_received and rt.core.truncated==truncated
        body=rt.report_body()[0]
        assert body['phase']==('UNKNOWN' if truncated else 'SLAM_SAVED')
        assert body['status']==('UNKNOWN' if truncated else 'FINALIZING')
        assert json.loads(rt.frozen)['slam_save']==('UNKNOWN' if truncated else 'SLAM_SAVED')
    finally:
        rt.close();rt.io.shutdown(wait=True)
