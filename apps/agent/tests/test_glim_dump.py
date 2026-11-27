"""Fake shutdown/dump and DDS boundary tests; no ROS/systemctl/robot access."""
import json
import os
import signal
import subprocess
import sys
import time
from types import ModuleType, SimpleNamespace as NS

import numpy as np
import pytest

from foothold_agent.mapping.glim_dump import DumpSession, run_service, write_json
from foothold_agent.mapping.inputs import CloudBus
from foothold_agent.slam_source import Source
from test_slam_mapping import (runtime,command,pose,cloud,configure_dump,own_services,
    finish_dump,FRONTEND,CLOUD,FINAL_POSE,MAP)


def start_dump(tmp_path, *, clock=None):
    clock=clock or NS(t=0.)
    rt=runtime(tmp_path,now=lambda:clock.t);rt.online=True
    configure_dump(rt,tmp_path)
    start=command();rt.command(start);rt.step();own_services(rt)
    rt.receive(FRONTEND,pose());rt.receive(CLOUD,cloud([[-1,0,.3]]));rt.step()
    rt.command(command('save',start));rt.step()
    return rt,clock,start


def close(rt):
    rt.services.owned.clear();rt.close();rt.io.shutdown(wait=True)


def test_pose_stamped_keeps_frame_stamp_provider_and_rejects_wrong_shape():
    source=Source({'FH_MAPPING_GLIM_FRAME':'glim_map','FH_MAPPING_GLIM_CLOUD_TOPIC':'/foothold_glim/map',
        'FH_MAPPING_GLIM_ODOM_TOPIC':'/foothold_glim/pose','FH_MAPPING_GLIM_POSE_TYPE':'PoseStamped'},'glim')
    sample=pose(frame='glim_map');sample.pose=sample.pose.pose
    p,q,body=source.decode_pose(sample)
    assert p==(0,0,.3) and q==(1,0,0,0)
    assert body['source']=='/foothold_glim/pose' and body['provider']=='glim'
    for invalid in (pose(frame='glim_map'),pose(frame='odom')):
        with pytest.raises((ValueError,AttributeError)):source.decode_pose(invalid)
    sample.header.stamp.nanosec=10**9
    with pytest.raises(ValueError):source.decode_pose(sample)
    with pytest.raises(ValueError):Source({'FH_MAPPING_POINT_LIO_POSE_TYPE':'auto'})


def test_dds_subscription_selects_message_type_and_rejects_shared_topic_conflict(monkeypatch):
    calls=[]
    class Subscriber:
        def __init__(self,topic,kind):calls.append((topic,kind))
        def Init(self,*args):pass
        def Close(self):pass
    for name,items in {
        'unitree_sdk2py.core.channel':{'ChannelSubscriber':Subscriber},
        'unitree_sdk2py.idl.nav_msgs.msg.dds_':{'Odometry_':'odom'},
        'unitree_sdk2py.idl.geometry_msgs.msg.dds_':{'PoseStamped_':'pose'},
        'unitree_sdk2py.idl.sensor_msgs.msg.dds_':{'PointCloud2_':'cloud'},
    }.items():
        module=ModuleType(name);module.__dict__.update(items);monkeypatch.setitem(sys.modules,name,module)
    bus=CloudBus()
    bus.subscribe('rt/live',lambda _:None,odometry=True)
    handle=bus.subscribe('rt/final',lambda _:None,pose_type='PoseStamped')
    bus.subscribe('rt/cloud',lambda _:None)
    assert calls==[('rt/live','odom'),('rt/final','pose'),('rt/cloud','cloud')]
    with pytest.raises(ValueError):bus.subscribe('rt/final',lambda _:None,odometry=True)
    handle.Close();assert 'rt/final' not in bus.types
    bus.close()


def test_runtime_subscribes_glim_pose_without_treating_map_topic_as_final(tmp_path):
    rt=runtime(tmp_path);calls=[]
    rt.final.pose_type='PoseStamped'
    rt.channel=NS(cloud_bus=NS(subscribe=lambda topic,cb,**kwargs:calls.append((topic,kwargs))))
    rt.acquire()
    assert (FRONTEND,{'pose_type':'Odometry'}) in calls
    assert (FINAL_POSE,{'pose_type':'PoseStamped'}) in calls
    assert (MAP,{}) in calls  # coarse live preview; verified final still requires dump receipts
    assert rt.source is rt.live and not rt.final_received
    close(rt)


@pytest.mark.parametrize('damage',['missing_receipt','wrong_session','wrong_revision','wrong_nonce','missing_points',
    'partial_points','missing_submap','partial_metadata','missing_trajectory','bad_timestamp',
    'partial_attributes','changed_files','symlink','source_frame'])
def test_incomplete_or_unbound_dump_never_replaces_live_revision(tmp_path,damage):
    rt,clock,_=start_dump(tmp_path)
    try:
        finish_dump(rt,[[1,0,.3]])
        path=rt.dump.path;dump=path/'dump'
        if damage=='missing_receipt':(path/'completed.json').unlink()
        elif damage.startswith('wrong_'):
            body=dict(rt.dump.binding)
            key={'wrong_session':'session_id','wrong_revision':'revision','wrong_nonce':'nonce'}[damage]
            body[key]='different' if key!='revision' else 99
            (path/'completed.json').write_text(json.dumps(body))
        elif damage=='missing_points':(dump/'000000'/'points_compact.bin').unlink()
        elif damage=='partial_points':(dump/'000000'/'points_compact.bin').write_bytes(b'partial')
        elif damage=='missing_submap':(dump/'graph.txt').write_text('num_submaps: 2\nnum_all_frames: 2\n')
        elif damage=='partial_metadata':(dump/'000000'/'data.txt').write_text('id: 0\nT_world_origin:')
        elif damage=='missing_trajectory':(dump/'traj_imu.txt').write_text('')
        elif damage=='bad_timestamp':(dump/'traj_imu.txt').write_text('bad 0 0 .3 0 0 0 1\n')
        elif damage=='partial_attributes':(dump/'000000'/'covs_compact.bin').write_bytes(b'partial')
        elif damage=='source_frame':rt.final.frame='different_map'
        elif damage=='changed_files':(dump/'values.bin').write_bytes(b'still writing')
        elif damage=='symlink':
            target=dump/'000000'/'points_compact.bin';target.unlink();target.symlink_to(dump/'values.bin')
        if damage in ('missing_points','partial_points','missing_submap','partial_metadata',
                'missing_trajectory','bad_timestamp','partial_attributes'):
            # Model a malformed writer that nevertheless returned exit zero;
            # its receipt must pass before structural validation rejects it.
            write_json(path/'completed.json',rt.dump.binding)
        # Changing a file resets stability; two observations are needed even
        # for a malformed dump, before structural validation is attempted.
        rt.step();clock.t=2.;rt.step();rt.step()
        assert not rt.final_received and rt.revision==1 and rt.source.source=='point_lio'
        assert set(rt.core.cells)=={(-20,0,6)}
    finally:close(rt)


def test_dump_size_must_be_stable_after_stopped_and_receipt(tmp_path):
    rt,clock,_=start_dump(tmp_path)
    try:
        finish_dump(rt,[[1,0,.3]])
        rt.dump.previous=rt.dump.stable_since=None
        assert not rt.dump.ready(stopped=False)
        assert not rt.dump.ready(stopped=True)
        clock.t=.9;assert not rt.dump.ready(stopped=True)
        clock.t=1.1;assert rt.dump.ready(stopped=True)
    finally:close(rt)


def test_verified_dump_transforms_submaps_and_uploads_only_after_service_stop(tmp_path):
    rt,clock,_=start_dump(tmp_path)
    sent=[]
    def request(sid,suffix,data):
        if suffix=='bundle':
            assert rt.services.status=='STOPPED' and not rt.services.owned
            sent.append(json.loads(data));return {'session_id':sid,'status':'SAVED'}
        return {'accepted':True}
    rt.request=request
    try:
        # No dump, elapsed legacy timeout, services still running: zero upload.
        clock.t=11.;rt.step();assert sent==[] and rt.frozen is None
        finish_dump(rt,[[.01,0,.3]],translation=(1,0,0))
        # A valid receipt alone cannot bypass a still-running service.
        own_services(rt);rt.step();assert rt.revision==1 and not sent
        rt.services.owned.clear();rt.services.status='STOPPED'
        rt.step();clock.t+=2
        for _ in range(20):
            rt.step();clock.t+=.3
            if rt.report_future is not None:rt.report_future.result()
            if rt.save_future is not None:rt.save_future.result()
        assert len(sent)==1 and sent[0]['slam_save']=='SLAM_SAVED'
        assert sent[0]['source']=='glim' and sent[0]['revision']==2
        assert sent[0]['voxels']==[[20,0,6]] and rt.core.status=='SAVED'
        from apps.contracts.models import MappingBundle
        MappingBundle.model_validate(sent[0])
    finally:close(rt)


def test_timeout_persists_received_only_and_old_topic_flag_cannot_confirm(tmp_path):
    rt,clock,_=start_dump(tmp_path)
    try:
        rt.env['FH_MAPPING_GLIM_FINAL_TOPIC_VERIFIED']='true'
        rt.services.owned.clear();rt.services.status='STOPPED'
        rt.receive(FINAL_POSE,pose());rt.receive(MAP,cloud())
        clock.t=181.;rt.step()
        assert not rt.final_received and rt.source.source=='point_lio'
        assert json.loads(rt.frozen)['slam_save']=='UNKNOWN'
        # Late receipts cannot change the immutable fallback bundle.
        finish_dump(rt,[[1,0,.3]]);before=rt.frozen;rt.step()
        assert rt.frozen==before and rt.revision==1
    finally:close(rt)


@pytest.mark.parametrize('configured',[False,True],ids=['default-10s','dump-timeout'])
@pytest.mark.parametrize('failure',['returncode','exception'])
def test_persistent_stop_failure_uploads_unknown_once_within_timeout(tmp_path,caplog,configured,failure):
    clock=NS(t=0.);sent=[];reports=[];stops=[]
    def run(action,name):
        assert action=='stop'
        stops.append(name)
        if failure=='exception':raise OSError('fake unavailable user bus')
        return 1
    rt=runtime(tmp_path,now=lambda:clock.t,service_run=run);rt.online=True
    rt.env['FH_MAPPING_SERVICE_CONTROL_ENABLED']='true'
    rt.services.launch=lambda:None  # drive failed cleanup deterministically, no systemctl
    if configured:configure_dump(rt,tmp_path)
    def request(sid,suffix,data):
        body=json.loads(data)
        if suffix=='bundle':
            sent.append((clock.t,body))
            return {'session_id':sid,'status':'RECEIVED_ONLY'}
        reports.append(body)
        return {'accepted':True}
    rt.request=request
    def step():
        rt.step()
        for future in (rt.report_future,rt.save_future):
            if future is not None:future.result(timeout=3)
    try:
        start=command();rt.command(start);step();own_services(rt);rt.services.pending=False
        rt.receive(FRONTEND,pose());rt.receive(CLOUD,cloud([[-1,0,.3]]));step()
        if configured:
            # Even a complete bound receipt may not bypass failed service stop.
            finish_dump(rt,[[1,0,.3]]);own_services(rt)
        rt.command(command('save',start));step()
        limit=rt.dump_timeout if configured else 10
        assert rt.dump_eligible==configured
        for second in range(1001):
            clock.t=float(second)
            rt.services.cleanup()
            step()
            if second<limit:assert not sent and rt.frozen is None
            if second==limit:
                frozen=rt.frozen
                assert json.loads(frozen)['slam_save']=='UNKNOWN'
        assert len(sent)==1 and limit<=sent[0][0]<=limit+3
        assert sent[0][1]['slam_save']=='UNKNOWN' and sent[0][1]['source']=='point_lio'
        assert sent[0][1]['voxels']==[[-20,0,6]] and rt.revision==1
        assert rt.frozen==frozen and not rt.final_received
        assert all(body['phase']!='SLAM_SAVED' for body in reports)
        assert rt.services.status=='UNKNOWN' and rt.services.owned=={rt.services.glim}
        assert rt.services.stop_requested and stops and 'event=stop_failed' in caplog.text
        assert any(body['error_code']=='GLIM_FINAL_UNCONFIRMED' and '정지' in body['reason'] for body in reports)
    finally:close(rt)


@pytest.mark.parametrize('op',['cancel','start'])
def test_cancel_and_session_replacement_fence_old_dump(tmp_path,op):
    rt,clock,start=start_dump(tmp_path)
    try:
        finish_dump(rt,[[1,0,.3]])
        rt.command(command(op,start if op=='cancel' else None));rt.step()
        assert not rt.final_received and rt.revision==1
        if op=='cancel':assert rt.core.status=='CANCELLED'
        else:assert rt.core.session_id!=start['session_id'] and not rt.core.cells
    finally:close(rt)


@pytest.mark.parametrize('code,stopped,receipt',[(0,True,True),(1,True,False),(0,False,False),(-9,True,False)])
def test_service_receipt_requires_signalled_successful_child_exit(tmp_path,monkeypatch,code,stopped,receipt):
    session=DumpSession(tmp_path,'test-session',2,'glim_map');session.prepare()
    handlers={};argv=[];signals=[]
    monkeypatch.setattr(signal,'signal',lambda sig,handler:handlers.setdefault(sig,handler))
    class Child:
        def __init__(self,args,**kwargs):argv.extend(args)
        def poll(self):return None
        def send_signal(self,sig):signals.append(sig)
        def wait(self):
            if stopped:handlers[signal.SIGINT](signal.SIGINT,None)
            return code
    monkeypatch.setattr('foothold_agent.mapping.glim_dump.subprocess.Popen',Child)
    assert run_service(tmp_path,['glim_rosnode','--existing-option'])==code
    assert argv[-1]=='dump_path:='+str(session.path/'dump')
    assert (session.path/'completed.json').exists()==receipt
    assert signals==([signal.SIGINT] if stopped else [])
    with pytest.raises(ValueError,match='already used'):run_service(tmp_path,['glim_rosnode'])


def test_existing_session_output_is_never_reused_or_deleted(tmp_path):
    session=DumpSession(tmp_path,'session',2,'glim_map');session.prepare()
    with pytest.raises(FileExistsError):DumpSession(tmp_path,'session',2,'glim_map').prepare()
    assert (session.path/'request.json').exists()


def test_change_during_stream_never_commits_partially_rebuilt_geometry(tmp_path):
    rt,clock,_=start_dump(tmp_path)
    try:
        finish_dump(rt,[[1,0,.3]])
        rt.step()
        assert rt.rebuild is not None and rt.revision==1
        points=rt.dump.path/'dump'/'000000'/'points_compact.bin'
        points.write_bytes(np.asarray([[2,0,.3]],dtype='<f4').tobytes())
        rt.step()
        assert rt.dump_failed and rt.revision==1 and not rt.final_received
        assert set(rt.core.cells)=={(-20,0,6)}
    finally:close(rt)


def test_real_wrapper_forwards_sigint_and_writes_receipt_only_after_child_exit(tmp_path):
    session=DumpSession(tmp_path/'root','fake-session',2,'glim_map');session.prepare()
    ready=tmp_path/'child-ready'
    child=tmp_path/'fake_glim.py'
    child.write_text('import os,signal,sys,time\nfrom pathlib import Path\n'
        +'signal.signal(signal.SIGINT,lambda *args:sys.exit(0))\n'
        +f'Path({str(ready)!r}).write_text(str(os.getpid()))\n'
        +'while True: time.sleep(.01)\n')
    env={**os.environ,'FH_MAPPING_GLIM_DUMP_ROOT':str(session.root)}
    process=subprocess.Popen([sys.executable,'-m','foothold_agent.mapping.glim_dump',
        sys.executable,str(child)],env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
    try:
        deadline=time.monotonic()+5
        while not ready.exists() and process.poll() is None and time.monotonic()<deadline:
            time.sleep(.01)
        assert ready.exists()
        assert not (session.path/'completed.json').exists()
        process.send_signal(signal.SIGINT)
        _,error=process.communicate(timeout=5)
        assert process.returncode==0,error.decode()
        assert json.loads((session.path/'completed.json').read_text())==session.binding
    finally:
        if process.poll() is None:
            process.kill();process.wait()
            if ready.exists():
                try:os.kill(int(ready.read_text()),signal.SIGKILL)
                except ProcessLookupError:pass
