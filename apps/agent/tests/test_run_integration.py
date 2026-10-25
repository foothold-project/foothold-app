"""ROS-free integration regressions for product goals, arrival and durable rejection."""
from concurrent.futures import Future
from copy import deepcopy
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import struct
import time
from types import SimpleNamespace
from uuid import uuid4
import zlib

import pytest

from test_scenario_run import r, start, pause, uid
from foothold_agent.executor.nav2 import Binding, NavExecutor
from foothold_agent.executor.nav2.actions import GoalActions
from foothold_agent.executor.map_proof import VerifiedPlan
from foothold_agent.executor.run_outbox import RunOutbox
from foothold_agent.executor.scenario import ScenarioSource
from foothold_agent.executor.scenario_run import ScenarioRun
from foothold_agent.phone.observer import Observer
from foothold_agent.ros_bridge.run_maps import RunMaps
from foothold_agent.ros_bridge.run_nav import RunNav
from foothold_agent.safety.core import Z


def drain(out):
    deadline = time.monotonic()+2
    while (out.jobs or out.quarantine_jobs) and time.monotonic() < deadline:
        out.poll()
        time.sleep(.001)
    assert not out.jobs and not out.quarantine_jobs


def proof(r, b, *, x=0., received_at=None, **extra):
    return dict(binding=b, received_at=r.clock() if received_at is None else received_at,
        pose=dict(floor_id=r.start['floor_id'],map_version_id=r.start['map_version_id'],
                  x=x,y=0.,yaw=2.5,confidence=None),**extra)


def rejected(message, *, disposition='QUARANTINE', code='RUN_REPORT_MAP', **extra):
    return dict(t='run.report_rejected',agent_instance_id=message['agent_instance_id'],
        report_seq=message['report_seq'],run_id=message.get('run_id',message.get('data',{}).get('run_id')),
        disposition=disposition,code=code,**extra)


def test_plan_url_has_api_v1_and_origin_has_no_path(monkeypatch):
    seen=[]
    class Reply:
        def __enter__(self): return self
        def __exit__(self,*a): pass
        def read(self,n): return b'{}'
    class Opener:
        def open(self,request,timeout):
            seen.append(request.full_url)
            return Reply()
    monkeypatch.setattr('urllib.request.build_opener',lambda *a:Opener())
    source=ScenarioSource('https://data.example','test-token')
    request=dict(scenario_id=uid(),scenario_version=7)
    try:
        assert source.fetch(request).result(timeout=2)=={}
        assert seen==['https://data.example/api/v1/agent/scenarios/'+request['scenario_id']+'?version=7']
    finally: source.pool.shutdown()
    with pytest.raises(ValueError): ScenarioSource('https://data.example/api/v1','x')


def test_zero_cmd_does_not_stall_run_or_refresh_nav_source(r):
    b=start(r)
    r.runs.nav.intent(b,(.6,0,0))
    r.hub.tick()
    r.clock.t=.1
    other,_,_=r.connect(purpose='view')
    assert r.cmd(other,0)['applied']==list(Z)
    assert not r.hub.session.core.need_neutral
    assert r.runs.nav.source_received()==0
    r.runs.nav.intent(b,(.6,0,0))
    r.hub.tick()
    assert r.outputs[-1].velocity==(.6,0,0)
    r.clock.t=.400001
    r.cmd(other,0)
    assert r.runs.snapshot()['fail_code']=='NAV_TIMEOUT'
    assert r.outputs[-1].velocity==Z and r.hub.session.core.latch


@pytest.mark.parametrize('distance,age,arrived',[(.5,1.,True),(.500001,1.,False),(.5,1.000001,False),(.499999,.999999,True)])
def test_arrival_position_and_age_boundaries_without_still_or_yaw_gate(r,distance,age,arrived):
    b=start(r)
    assert r.runs.nav.feedback(b,'SUCCEEDED')
    r.clock.t=1.1
    r.state(False)
    r.runs.arrival=lambda b,g:proof(r,b,x=distance,received_at=r.clock()-age,body_still=False)
    r.hub.tick()
    assert (r.runs.snapshot()['status']=='COMPLETED') is arrived
    assert r.outputs[-1].velocity==Z


def test_success_before_source_expiry_survives_raw_feedback_and_blocks_nonzero(r):
    b=start(r)
    r.runs.nav.intent(b,(.6,0,0))
    r.hub.tick()
    r.clock.t=.25
    assert r.runs.nav.feedback(b,'SUCCEEDED')
    r.clock.t=.31
    before=len(r.outputs)
    r.state(False)  # Session._advance and Hub._emit run BEFORE ScenarioRun.tick
    assert r.runs.snapshot()['status']=='MOVING'
    assert not r.runs.nav.intent(b,(.6,0,0))
    r.hub._emit(r.hub.session.executor_command(r.start['run_id'],(1,0,0)))
    assert all(c.velocity==Z for c in r.outputs[before:])
    assert r.runs.nav.source_received()==0
    r.runs.arrival=lambda b,g:proof(r,b)
    r.hub.tick()
    assert r.runs.snapshot()['status']=='COMPLETED'


def test_success_cannot_resurrect_already_expired_source(r):
    b=start(r)
    r.clock.t=.300001
    assert not r.runs.nav.feedback(b,'SUCCEEDED')
    r.hub.tick()
    assert r.runs.snapshot()['fail_code']=='NAV_TIMEOUT'


def test_success_pose_wait_is_bounded_and_stop_still_wins(r):
    b=start(r)
    r.runs.nav.feedback(b,'SUCCEEDED')
    r.clock.t=2.9
    r.send(r.peer,'ping',client_time_ms=2900)
    r.state(False)
    r.hub.tick()
    assert r.runs.snapshot()['status']=='MOVING'
    r.clock.t=3.
    r.state(False)
    r.hub.tick()
    assert r.runs.snapshot()['fail_code']=='NAV_TIMEOUT'
    assert b in r.actions.cancels and r.hub.session.core.latch


def test_stop_during_success_wait_preserves_reason_after_grant(r):
    b=start(r)
    r.runs.nav.feedback(b,'SUCCEEDED')
    assert r.send(r.peer,'stop')['ok']
    assert r.runs.snapshot()['wait_reason']=='STOPPED_BY_USER'
    assert r.take(r.peer)['ok']
    assert r.runs.snapshot()['wait_reason']=='STOPPED_BY_USER'
    r.hub.disconnect(r.peer)
    assert r.runs.snapshot()['wait_reason']=='STOPPED_BY_USER'


def test_next_goal_waits_for_cancellation_and_ignores_old_success(r):
    r.data['waypoints'].append({**r.data['waypoints'][0],'waypoint_ref':'p1'})
    old=start(r)
    r.actions.canceled=False
    r.runs.arrival=lambda b,g:proof(r,b)
    r.runs.nav.feedback(old,'SUCCEEDED')
    r.hub.tick()
    assert len(r.actions.goals)==1
    assert r.runs.next_goal_pending and r.runs.binding is None
    assert old in r.actions.cancels
    assert not r.runs.nav.feedback(old,'SUCCEEDED')
    r.clock.t=.31
    r.state(False)
    r.hub.tick()
    assert len(r.actions.goals)==1 and r.outputs[-1].velocity==Z
    r.actions.canceled=True
    r.hub.tick()
    new=r.runs.binding
    assert new.goal_id!=old.goal_id and new.run_id==old.run_id
    assert len(r.actions.goals)==2
    assert not r.runs.nav.feedback(old,'SUCCEEDED')
    assert r.runs.nav.feedback(new,'SUCCEEDED')
    r.hub.tick()
    assert r.runs.snapshot()['progress']=={'done':2,'total':2}
    assert r.runs.snapshot()['status']=='COMPLETED'


def test_cancel_wait_has_finite_deadline(r):
    r.data['waypoints'].append(deepcopy(r.data['waypoints'][0]))
    b=start(r)
    r.actions.canceled=False
    r.runs.arrival=lambda b,g:proof(r,b)
    r.runs.nav.feedback(b,'SUCCEEDED')
    r.hub.tick()
    r.clock.t=2.9
    r.send(r.peer,'ping',client_time_ms=2900)
    r.clock.t=3.
    r.state(False)
    r.hub.tick()
    assert r.runs.snapshot()['fail_code']=='NAV_TIMEOUT'
    assert len(r.actions.goals)==1


@pytest.mark.parametrize('field,value',[('map_proofs',None),('image_sha256','not-sha'),('source_pgm_sha256','a'*63),('width',True),('origin',[0,float('nan'),0]),('world_id',None)])
def test_proof_malformed_fails_closed(r,field,value):
    if field=='map_proofs': r.data[field]=value
    else: r.data['map_proofs'][0][field]=value
    assert r.send(r.peer,'run.start',**r.start)['ok']
    r.hub.tick()
    assert r.runs.snapshot()['fail_code']=='MAP_VERSION_MISMATCH'
    assert not r.actions.goals


def test_started_and_all_reports_are_proven_durable(r):
    from apps.contracts.models import DurableAgentEvent,DurableAgentRunUpdate
    start(r)
    for m in r.runs.journal.entries.values():
        (DurableAgentEvent if m['t']=='event' else DurableAgentRunUpdate).model_validate(m)
    first=next(iter(r.runs.journal.entries.values()))
    assert first['code']=='RUN_STARTED' and first['data']['map_proof']==r.data['map_proofs'][0]


@pytest.mark.parametrize('code',['RUN_REPORT_STORAGE','RUN_REPORT_SEQUENCE'])
@pytest.mark.parametrize('ahead',[False,True])
def test_retry_replays_identical_original_including_ack_loss_b4(r,code,ahead):
    start(r)
    out=r.runs.journal
    drain(out)
    observer=Observer(r.hub)
    observer.connect()
    original=out.replay()
    frame=rejected(original[0],disposition='RETRY',code=code,
        **({'expected_report_seq':original[0]['report_seq']+(20 if ahead else 0)} if code=='RUN_REPORT_SEQUENCE' else {}))
    before=(r.hub.owner,r.hub.session.core.stop_gen)
    observer.receive(frame)
    assert observer.reconnect_required
    assert out.replay()==original and not out.has_quarantine
    observer.disconnect()
    observer.connect()
    replay=[m for m in observer.tick().messages if 'report_seq' in m]
    assert replay==original
    assert before==(r.hub.owner,r.hub.session.core.stop_gen)


def test_missing_retry_leading_record_blocks_run_without_deleting(r):
    start(r)
    out=r.runs.journal
    drain(out)
    observer=Observer(r.hub);observer.connect()
    first=out.replay()[0]
    observer.receive(rejected(first,disposition='RETRY',code='RUN_REPORT_SEQUENCE',expected_report_seq=0))
    assert r.runs.snapshot()['wait_reason']=='RECORDING_UNAVAILABLE'
    assert r.hub.session.core.latch and out.replay()[0]==first


def test_quarantine_moves_original_and_fails_current_run(r,tmp_path):
    r.runs.journal.close()
    path=str(tmp_path/'outside-episode.sqlite')
    r.runs.journal=out=RunOutbox(path)
    b=start(r)
    r.runs.nav.intent(b,(.6,0,0));r.hub.tick()
    assert r.outputs[-1].velocity==(.6,0,0)
    drain(out)
    observer=Observer(r.hub);observer.connect()
    original=out.replay()[0]
    assert original['code']=='RUN_STARTED'
    frame=rejected(original)
    observer.receive(frame)
    assert r.runs.snapshot()['status']=='FAILED'
    assert r.runs.snapshot()['fail_code']=='RECORDING_REJECTED'
    assert b in r.actions.cancels and r.hub.session.core.latch and r.outputs[-1].velocity==Z
    drain(out)
    assert original not in out.replay()
    archived=out.quarantine.execute('SELECT body,rejection FROM rejected').fetchone()
    assert json.loads(archived[0])==original and json.loads(archived[1])==frame
    assert any(m.get('fail_code')=='RECORDING_REJECTED' for m in out.replay())
    observer.disconnect();observer.connect()
    assert r.runs.recording_rejected
    assert r.take(r.peer)['ok']
    r.unlock(r.peer)
    r.cmd(r.peer,0)
    request={**r.start,'run_id':uid(),'lease_id':r.hub.session.lease_id}
    assert r.send(r.peer,'run.start',**request)['error']['code']=='RECORDING_UNAVAILABLE'
    assert len(r.actions.goals)==1
    assert os.stat(path).st_mode&0o777==0o600
    assert os.stat(path+'.quarantine').st_mode&0o777==0o600
    out.close()
    r.runs.journal=out=RunOutbox(path)
    assert out.has_quarantine
    assert original not in out.replay()
    sim=ScenarioRun(r.hub,journal=out)
    assert not sim.recording_rejected  # process restart only; normal gates still required
    r.hub.simulation=False
    physical=ScenarioRun(r.hub,journal=out)
    assert physical.recording_rejected
    assert out.quarantine.execute('SELECT count(*) FROM rejected').fetchone()[0]==1


def test_unmatched_quarantine_does_not_invent_ack_or_stop(r):
    start(r);drain(r.runs.journal)
    observer=Observer(r.hub);observer.connect()
    first=r.runs.journal.replay()[0]
    frame=rejected(first);frame['run_id']=uid()
    observer.receive(frame)
    assert r.runs.snapshot()['status']=='MOVING'
    assert not r.runs.journal.has_quarantine


def test_archive_commit_failure_keeps_raw_outbox(r):
    start(r);out=r.runs.journal;drain(out)
    original=out.replay()[0]
    key=(original['agent_instance_id'],original['report_seq'])
    failure=Future();failure.set_exception(OSError('archive disk unavailable'))
    out.quarantine_jobs.append((failure,key))
    r.hub.tick()
    assert out.entries[key]==original
    assert r.runs.snapshot()['wait_reason']=='RECORDING_UNAVAILABLE'
    assert r.hub.session.core.latch


def test_interrupted_archive_move_recovery_keeps_archive_and_suppresses_replay(tmp_path):
    path=str(tmp_path/'out.sqlite')
    out=RunOutbox(path)
    m=out.append(dict(t='run.update',run_id=uid(),status='FAILED'),0.)
    drain(out)
    with out.quarantine:
        out.quarantine.execute('INSERT INTO rejected VALUES (?,?,?,?)',
            (m['agent_instance_id'],m['report_seq'],json.dumps(m),json.dumps(rejected(m))))
    out.close()
    out=RunOutbox(path)
    try:
        assert out.replay()==[] and out.has_quarantine
        assert out.quarantine.execute('SELECT count(*) FROM rejected').fetchone()[0]==1
    finally: out.close()


def test_product_action_port_multiple_generations_and_cancel_requires_terminal():
    actions=GoalActions();actions.health(True)
    b=Binding(uid(),uid(),1,1,'world','floor','map')
    new=Binding(b.run_id,uid(),1,1,'world','floor','map')
    actions.submit(b,{'x':0})
    assert actions.take()[0][0]==b
    actions.cancel(b)
    assert actions.take()[1]==b and not actions.cancel_confirmed(b)
    with pytest.raises(ValueError): actions.submit(new,{'x':1})
    actions.complete(b)
    assert actions.cancel_confirmed(b)
    actions.submit(new,{'x':1})
    actions.complete(b)  # stale terminal callback must not finish the new goal
    assert not actions.cancel_confirmed(new)


def test_ros_result_capture_ignores_old_generation_and_cancel_ack_alone():
    class Nav:
        def __init__(self): self.feedbacks=[]
        def feedback(self,b,status): self.feedbacks.append((b,status))
    old,new=object(),object()
    actions=GoalActions();actions.health(True);actions.submit(new,{})
    ros=RunNav.__new__(RunNav)
    ros.nav,ros.actions,ros.active=Nav(),actions,new
    cleared=[];ros._clear_subscription=lambda:cleared.append(True)
    nonterminal=Future();nonterminal.set_result(SimpleNamespace(status=2))
    ros._result(nonterminal,new)
    assert not actions.cancel_confirmed(new)
    terminal=Future();terminal.set_result(SimpleNamespace(status=5))
    ros._result(terminal,old)
    assert not actions.cancel_confirmed(new) and cleared==[]
    ros._result(terminal,new)
    assert actions.cancel_confirmed(new) and cleared==[True]


def png(w,h,pixels):
    def chunk(kind,value):return struct.pack('!I',len(value))+kind+value+struct.pack('!I',zlib.crc32(kind+value))
    return b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('!IIBBBBB',w,h,8,0,0,0,0))+chunk(b'IDAT',zlib.compress(b''.join(b'\0'+pixels[y*w:(y+1)*w] for y in range(h))))+chunk(b'IEND',b'')


def local_maps(tmp_path):
    pixels=bytes([0,205,254,254])
    image=png(2,2,pixels);pgm=b'P5\n2 2\n255\n'+pixels
    (tmp_path/'map.png').write_bytes(image);(tmp_path/'map.pgm').write_bytes(pgm)
    b=dict(floor_id=uid(),map_version_id=uid(),image_sha256=hashlib.sha256(image).hexdigest(),
           source_pgm_sha256=hashlib.sha256(pgm).hexdigest(),source='SIMULATION',world_id='warehouse',
           ros_floor_id='f1',origin=[0.,0.,0.],resolution=.05,width=2,height=2)
    registration={**b,'sha256':b['image_sha256']};registration.pop('image_sha256')
    floors=SimpleNamespace(bindings={'f1':registration},run_id='episode-owner')
    maps=RunMaps(floors,[dict(map_version_id=b['map_version_id'],image_path=str(tmp_path/'map.png'),pgm_path=str(tmp_path/'map.pgm'))])
    plan=VerifiedPlan();plan.map_proof=b
    request={k:b[k] for k in ('floor_id','map_version_id')}
    snapshot=dict(floor_context={**registration,'current_floor_id':'f1','run_id':'episode-owner','epoch':1,'floor_state':'on_floor'},observation={'episode':1})
    grid=dict(sha256=maps.assets[b['map_version_id']]['occupancy_sha256'],width=2,height=2,resolution=.05,origin=[0.,0.,0.])
    return maps,request,plan,snapshot,grid


@pytest.mark.parametrize('field',['image_sha256','source_pgm_sha256','origin','resolution','width','height','world_id','ros_floor_id','floor_id','map_version_id'])
def test_actual_assets_live_floor_and_map_proof_all_match(tmp_path,field):
    maps,request,plan,snapshot,grid=local_maps(tmp_path)
    assert maps.matches(request,plan,snapshot,grid)
    plan.map_proof[field]=[1.,0.,0.] if field=='origin' else 'wrong'
    assert not maps.matches(request,plan,snapshot,grid)


@pytest.mark.parametrize('change',['epoch','run_id','grid','row_flip'])
def test_map_live_epoch_owner_and_occupancy_axis_fail_closed(tmp_path,change):
    maps,request,plan,snapshot,grid=local_maps(tmp_path)
    if change=='epoch':snapshot['observation']['episode']=2
    elif change=='run_id':snapshot['floor_context']['run_id']='other-episode'
    elif change=='grid':grid=None
    else:grid['sha256']=hashlib.sha256(bytes([100,255,0,0])).hexdigest()
    assert not maps.matches(request,plan,snapshot,grid)


def test_png_and_pgm_must_have_identical_raster(tmp_path):
    maps,request,plan,snapshot,grid=local_maps(tmp_path)
    (tmp_path/'map.pgm').write_bytes(b'P5\n2 2\n255\n'+bytes([254,254,0,205]))
    with pytest.raises(ValueError,match='raster mismatch'):
        RunMaps(maps.floors,[dict(map_version_id=request['map_version_id'],image_path=str(tmp_path/'map.png'),pgm_path=str(tmp_path/'map.pgm'))])


def test_no_started_report_before_plan_and_map_verification(r):
    pending=Future()
    r.runs.source.fetch=lambda request:pending
    assert r.send(r.peer,'run.start',**r.start)['ok']
    r.hub.tick()
    assert r.runs.snapshot()['status']=='PREPARING'
    assert r.runs.journal.entries=={}
    bad=deepcopy(r.data);bad['map_proofs'][0]['image_sha256']='invalid'
    pending.set_result(bad)
    r.hub.tick()
    assert r.runs.snapshot()['fail_code']=='MAP_VERSION_MISMATCH'
    assert r.runs.journal.entries=={} and not r.runs.journal.has_quarantine
    assert any(m['t']=='run.update' and m['status']=='FAILED' and m['fail_code']=='MAP_VERSION_MISMATCH' for m in r.hub.drain(r.peer))
    assert not r.actions.goals


def test_cancel_before_late_goal_acceptance_and_terminal_proof():
    actions=GoalActions();actions.health(True)
    b=Binding(uid(),uid(),1,1,'world','floor','a'*64)
    actions.submit(b,{})
    actions.take()
    actions.cancel(b)
    handle=SimpleNamespace(accepted=True)
    result=Future()
    cancelled=[]
    handle.get_result_async=lambda:result
    handle.cancel_goal_async=lambda:cancelled.append(True)
    ros=RunNav.__new__(RunNav)
    ros.active,ros.actions,ros.nav=b,actions,SimpleNamespace(binding=None,feedback=lambda *a:False)
    ros.handle,ros.cancel_sent=None,False
    ros._clear_subscription=lambda:None
    response=Future();response.set_result(handle)
    ros._goal_response(response,b)
    assert cancelled==[True]
    assert not actions.cancel_confirmed(b)
    result.set_result(SimpleNamespace(status=5))
    assert actions.cancel_confirmed(b)


@pytest.mark.parametrize('cancel_wait',[False,True])
def test_wait_deadline_on_tick_alone_precedes_ack_and_has_no_reentrant_output(r,cancel_wait):
    if cancel_wait:r.data['waypoints'].append(deepcopy(r.data['waypoints'][0]))
    b=start(r)
    r.runs.nav.feedback(b,'SUCCEEDED')
    if cancel_wait:
        r.actions.canceled=False
        r.runs.arrival=lambda b,g:proof(r,b)
    r.hub.tick()
    r.clock.t=2.9
    r.send(r.peer,'ping',client_time_ms=2900)
    r.clock.t=3.
    if cancel_wait:r.actions.canceled=True
    # No state feedback before this tick; the run deadline itself must win.
    r.hub.tick()
    assert r.runs.snapshot()['fail_code']=='NAV_TIMEOUT'
    assert r.hub.session.core.latch and len(r.actions.goals)==1


def test_episode_cleanup_does_not_delete_durable_outbox(tmp_path):
    import shutil
    episode=tmp_path/'episodes'/'episode-one';episode.mkdir(parents=True)
    (episode/'ephemeral').write_text('ephemeral')
    path=tmp_path/'durable.sqlite'
    out=RunOutbox(path)
    original=out.append(dict(t='run.update',run_id=uid(),status='FAILED'),1.)
    out.close()
    shutil.rmtree(episode)
    recovered=RunOutbox(path)
    try: assert recovered.replay()==[original]
    finally: recovered.close()


def test_retry_must_match_outbox_run_as_well_as_instance_and_sequence(r):
    start(r);drain(r.runs.journal)
    observer=Observer(r.hub);observer.connect()
    first=r.runs.journal.replay()[0]
    frame=rejected(first,disposition='RETRY',code='RUN_REPORT_STORAGE')
    frame['run_id']=uid()
    observer.receive(frame)
    assert not observer.reconnect_required
    assert r.runs.snapshot()['status']=='MOVING'


@pytest.mark.parametrize('operation',['stop','pause'])
def test_stop_before_proven_start_is_local_only_without_orphan_reports(r,operation):
    pending=Future();r.runs.source.fetch=lambda request:pending
    assert r.send(r.peer,'run.start',**r.start)['ok']
    if operation=='stop': assert r.send(r.peer,'stop')['ok']
    else: pause(r)
    assert r.runs.snapshot()['status']=='PAUSED'
    assert r.hub.session.core.latch and r.outputs[-1].velocity==Z
    assert not r.actions.goals and r.runs.journal.entries=={}
    assert not r.runs.journal.has_quarantine
    assert any(m['t']=='run.update' and m['status']=='PAUSED' for m in r.hub.drain(r.peer))
    pending.set_result(deepcopy(r.data))
    r.hub.tick()
    assert not r.actions.goals and r.runs.journal.entries=={}



def test_stop_after_start_append_preserves_unacked_original_and_fifo(r):
    start(r)
    original=deepcopy(next(iter(r.runs.journal.entries.values())))
    assert original['code']=='RUN_STARTED'
    assert r.send(r.peer,'stop')['ok']
    drain(r.runs.journal)
    replay=r.runs.journal.replay()
    assert replay[0]==original
    assert replay[-1]['status']=='PAUSED' and replay[-1]['wait_reason']=='STOPPED_BY_USER'
    assert [m['report_seq'] for m in replay]==list(range(1,len(replay)+1))
