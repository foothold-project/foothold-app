"""Reconnect and Point-LIO continuity using fake clocks, DDS, services and bags."""
import asyncio
import json
import threading
from types import SimpleNamespace as NS

import pytest

from foothold_agent.mapping.onboard import DISCONNECT_GRACE_SECONDS, POINTLIO_WAIT_SECONDS
from foothold_agent.mapping.raw_recording import MAX_BYTES, MIN_FREE_BYTES
from test_mapping_service_invariants import (
    always_on_runtime, prime, drain, close_runtime, assert_pointlio_read_only,
)
from test_raw_recording import ProcessLane
from test_slam_mapping import FRONTEND, CLOUD, pose, cloud, command, wait_for, configure_dump


def begin(rt):
    prime(rt)
    start=command(); rt.command(start); drain(rt)
    wait_for(lambda:rt.services.status=='STARTED' and not rt.services.starting)
    prime(rt,2)
    return start


def record(rt, tmp_path):
    lane=ProcessLane()
    rt.env.update(FH_MAPPING_RAW_RECORD_ENABLED='true', FH_MAPPING_RAW_RECORD_DIR=str(tmp_path/'sessions'))
    rt.raw.popen,rt.raw.killpg=lane.popen,lane.killpg
    rt.raw.disk_usage=lambda _:NS(free=MIN_FREE_BYTES)
    rt.raw.poll_interval=.005
    return lane


@pytest.mark.parametrize('duration',[3,240])
def test_disconnect_keeps_local_data_bag_and_same_session_progress(tmp_path,duration):
    rt,clock,active,calls=always_on_runtime(tmp_path)
    lane=record(rt,tmp_path)
    reports=[]
    rt.request=lambda sid,suffix,data:reports.append(json.loads(data)) or {'accepted':True}
    try:
        start=begin(rt)
        wait_for(lambda:rt.raw.snapshot()['status']=='RECORDING')
        rt.step()
        if rt.report_future:rt.report_future.result(3)
        rt.step()
        before=len(reports)
        seq=rt.update_seq
        rt.connection(False)
        # Continue healthy robot-clock samples throughout the transport outage.
        for i in range(1,int(duration/.4)+1):
            clock.t=min(duration,i*.4)
            rt.receive(FRONTEND,pose(stamp=i+2))
            rt.receive(CLOUD,cloud(points=((1+i*.01,0,.3),),stamp=i+2))
            rt.step()
        assert len(reports)==before and rt.update_seq==seq
        assert rt.core.session_id==start['session_id'] and len(rt.core.cells)>1
        assert rt.services.owned=={'foothold-glim'} and active=={'foothold-pointlio','foothold-glim'}
        assert rt.raw.snapshot()['status']=='RECORDING' and not lane.signals
        assert len(rt.pending_samples)==0 and len(rt.changes)<=len(rt.core.cells)
        rt.connection(True); drain(rt)
        assert reports[-1]['session_id']==start['session_id']
        assert reports[-1]['update_seq']>seq and reports[-1]['status']=='RUNNING'
        assert reports[-1]['point_count']==len(rt.core.cells)
        assert all(action!='stop' for action,_ in calls)
        assert_pointlio_read_only(calls)
    finally:
        close_runtime(rt)
        if rt.raw.thread:rt.raw.thread.join(2)


@pytest.mark.parametrize('reconnect_at_deadline',[False,True])
def test_five_minute_disconnect_cleans_up_and_retained_data_saves(tmp_path,reconnect_at_deadline):
    rt,clock,active,calls=always_on_runtime(tmp_path)
    lane=record(rt,tmp_path)
    uploads=[]
    def request(sid,suffix,data):
        if suffix=='bundle':uploads.append(json.loads(data))
        return {'session_id':sid,'status':'RECEIVED_ONLY'} if suffix=='bundle' else {'accepted':True}
    rt.request=request
    try:
        start=begin(rt)
        wait_for(lambda:rt.raw.snapshot()['status']=='RECORDING')
        cells=dict(rt.core.cells)
        rt.connection(False)
        clock.t=DISCONNECT_GRACE_SECONDS-1
        rt.cleanup_disconnected()
        assert rt.services.owned and not lane.signals and rt.local_recording_allowed()
        clock.t=DISCONNECT_GRACE_SECONDS+1
        rt.connection(reconnect_at_deadline)
        wait_for(lambda:not rt.services.owned and rt.raw.snapshot()['status']=='STOPPED')
        assert rt.services_disconnected and rt.session_services_ready()
        assert rt.core.cells==cells and active=={'foothold-pointlio'}
        rt.connection(True)
        prime(rt,3)
        assert rt.core.error_code=='MAPPING_SERVICES_DISCONNECTED' and rt.core.cells==cells
        rt.command(command('save',start)); drain(rt)
        clock.t+=11
        for _ in range(12):drain(rt)
        assert len(uploads)==1 and uploads[0]['slam_save']=='UNKNOWN'
        assert {tuple(key) for key in uploads[0]['voxels']}==set(cells)
        assert_pointlio_read_only(calls)
    finally:
        close_runtime(rt)
        if rt.raw.thread:rt.raw.thread.join(2)


def test_one_second_pointlio_gap_waits_without_accumulating_then_resumes(tmp_path):
    rt,clock,_,calls=always_on_runtime(tmp_path)
    lane=record(rt,tmp_path)
    try:
        start=begin(rt)
        wait_for(lambda:rt.raw.snapshot()['status']=='RECORDING')
        cells=dict(rt.core.cells)
        clock.t=.6;drain(rt)
        assert rt.core.status=='UNKNOWN' and rt.core.reason=='위치 자료를 기다리는 중'
        assert rt.core.cells==cells and rt.services.owned=={'foothold-glim'}
        rt.services.monitor()
        assert rt.services.status=='STARTED' and rt.raw.allowed() and rt.services.recording_ready()
        # A cloud alone cannot resume collection against a stale pose.
        rt.receive(CLOUD,cloud(points=((9,0,.3),),stamp=3)); drain(rt)
        assert rt.core.cells==cells
        clock.t=1.
        msg=pose(stamp=4);msg.pose.pose.position.x=.1
        rt.receive(FRONTEND,msg);rt.receive(CLOUD,cloud(points=((2,0,.3),),stamp=4));drain(rt)
        assert rt.core.status=='RUNNING' and rt.core.error_code is None
        assert len(rt.core.cells)>len(cells) and rt.core.session_id==start['session_id']
        assert rt.raw.snapshot()['status']=='RECORDING' and not lane.signals
        assert_pointlio_read_only(calls)
    finally:
        close_runtime(rt)
        if rt.raw.thread:rt.raw.thread.join(2)


@pytest.mark.parametrize('fault',['jump','pose-stamp-backwards','cloud-stamp-backwards','origin-reset','restart-small-reset','timeout','late-first-tick'])
def test_pointlio_gap_never_attaches_a_discontinuous_or_late_frame(tmp_path,fault):
    rt,clock,active,calls=always_on_runtime(tmp_path)
    try:
        begin(rt)
        if fault=='origin-reset':
            # The estimator's origin moved while still publishing samples.
            msg=pose(stamp=3);msg.pose.pose.position.x=1.5
            rt.receive(FRONTEND,msg);rt.receive(CLOUD,cloud(stamp=3));drain(rt)
            msg=pose(stamp=4);msg.pose.pose.position.x=3.
            rt.receive(FRONTEND,msg);rt.receive(CLOUD,cloud(stamp=4));drain(rt)
        if fault=='restart-small-reset':
            msg=pose(stamp=3);msg.pose.pose.position.x=.1
            rt.receive(FRONTEND,msg);rt.receive(CLOUD,cloud(stamp=3));drain(rt)
        cells,odom,stamps=dict(rt.core.cells),rt.last_odom,dict(rt.input_stamps)
        if fault!='late-first-tick':
            clock.t=.6;drain(rt)
            assert rt.core.error_code=='MAPPING_INPUT_WAITING'
        if fault=='restart-small-reset':
            active.remove(rt.services.pointlio);rt.services.monitor()
            assert rt.services.status=='STARTED'
            active.add(rt.services.pointlio);rt.services.monitor()
            assert rt.services.pointlio_restarted
        clock.t=POINTLIO_WAIT_SECONDS+1 if fault in ('timeout','late-first-tick') else 1.
        msg=pose(stamp=1 if fault=='pose-stamp-backwards' else 5)
        if fault=='jump':msg.pose.pose.position.x=2.01
        rt.receive(FRONTEND,msg)
        rt.receive(CLOUD,cloud(points=((9,0,.3),),stamp=1 if fault=='cloud-stamp-backwards' else 5))
        drain(rt)
        assert rt.core.status=='UNKNOWN' and rt.core.error_code=='MAPPING_SERVICES_UNAVAILABLE'
        assert (dict(rt.core.cells),rt.last_odom,dict(rt.input_stamps))==(cells,odom,stamps)
        prime(rt,6)
        assert rt.core.cells==cells and not rt.session_receiving_ready()
        assert_pointlio_read_only(calls)
    finally:
        close_runtime(rt)


def test_raw_size_limit_still_applies_offline(tmp_path):
    rt,_,_,_=always_on_runtime(tmp_path)
    lane=record(rt,tmp_path)
    try:
        begin(rt);wait_for(lambda:rt.raw.snapshot()['status']=='RECORDING')
        rt.connection(False)
        rt.raw.size=lambda _:MAX_BYTES
        wait_for(lambda:rt.raw.snapshot()['status']=='LIMIT')
        assert len(lane.signals)==1 and rt.services.owned=={'foothold-glim'}
        assert rt.raw.snapshot()['cause']=='size_limit'
    finally:
        close_runtime(rt)
        if rt.raw.thread:rt.raw.thread.join(2)


def test_faulted_session_never_uses_glim_dump_even_if_stop_is_still_pending(tmp_path):
    rt,clock,_,_=always_on_runtime(tmp_path)
    stop=rt.services.stop
    uploads=[]
    def request(sid,suffix,data):
        if suffix=='bundle':uploads.append(json.loads(data))
        return {'session_id':sid,'status':'RECEIVED_ONLY'} if suffix=='bundle' else {'accepted':True}
    rt.request=request
    try:
        configure_dump(rt,tmp_path)
        start=begin(rt)
        cells=dict(rt.core.cells)
        rt.services.stop=lambda:None  # Service thread has not confirmed the stop yet.
        clock.t=1.
        msg=pose(stamp=3);msg.pose.pose.position.x=9.
        rt.receive(FRONTEND,msg);rt.receive(CLOUD,cloud(stamp=3));drain(rt)
        assert rt.services_fault and rt.services.status=='STARTED'
        rt.command(command('save',start));drain(rt)
        assert not rt.dump_eligible
        rt.services.stop=stop;stop()
        wait_for(lambda:not rt.services.owned)
        clock.t+=11
        for _ in range(12):drain(rt)
        assert len(uploads)==1 and uploads[0]['slam_save']=='UNKNOWN'
        assert {tuple(key) for key in uploads[0]['voxels']}==set(cells)
    finally:
        rt.services.stop=stop
        close_runtime(rt)


def test_background_worker_keeps_readers_and_accumulates_with_online_permission_false(tmp_path):
    rt,clock,_,_=always_on_runtime(tmp_path)
    closed=[]
    rt.enabled=lambda:rt.observer.connected
    rt.local_enabled=lambda:True
    rt.channel=NS(cloud_bus=NS(subscribe=lambda topic,*a,**k:NS(Close=lambda:closed.append(topic))))
    async def scenario():
        begin(rt)
        task=asyncio.create_task(rt.run())
        async def until(predicate):
            async with asyncio.timeout(3):
                while not predicate():await asyncio.sleep(.005)
        try:
            await until(lambda:bool(rt.handles))
            rt.observer.connected=False
            await until(lambda:rt.disconnected_since is not None)
            assert not rt.enabled() and rt.local_enabled()
            for i in range(1,9):
                clock.t=i*.4
                rt.receive(FRONTEND,pose(stamp=i+2))
                rt.receive(CLOUD,cloud(points=((1+i*.1,0,.3),),stamp=i+2))
                await until(lambda:rt.core.last_cloud_stamp==(i+2)*1_000_000_000)
            assert len(rt.core.cells)>1 and rt.services.owned and not closed
            assert rt.core.status=='RUNNING'
        finally:
            task.cancel();await asyncio.gather(task,return_exceptions=True)
    try:
        asyncio.run(scenario())
    finally:
        close_runtime(rt)


def test_local_permission_loss_stops_offline_mapping_immediately(tmp_path):
    rt,_,_,_=always_on_runtime(tmp_path)
    allowed=NS(value=True)
    rt.local_enabled=lambda:allowed.value
    try:
        begin(rt);rt.connection(False)
        rt.was_enabled=True
        rt.thread=threading.Thread(target=rt.worker,daemon=True);rt.thread.start()
        allowed.value=False
        wait_for(lambda:rt.services_disconnected and not rt.services.owned)
        before=dict(rt.core.cells)
        rt.receive(FRONTEND,pose(stamp=3));rt.receive(CLOUD,cloud(points=((9,0,.3),),stamp=3))
        assert not rt.pending_samples and rt.core.cells==before
    finally:
        close_runtime(rt)


@pytest.mark.parametrize('failure',['identity','nic'])
def test_setup_mapping_permission_survives_server_disconnect_but_not_body_loss(monkeypatch,failure):
    from foothold_agent.mapping import runtime as mapping_runtime
    from foothold_agent.setup.runtime import Inputs,run
    from foothold_agent.setup.view import Status
    from foothold_agent.link.client import Client
    from test_setup_pairing import credentials,NIC_VALUE,low

    async def scenario():
        stop=asyncio.Event();seen={};valid=NS(nic=True,body=True)
        inputs=Inputs()
        inputs.identity=lambda:'1234-5678' if valid.body else 'another-body'
        class FakeClient(Client):
            async def run(self):
                seen['client']=self
                self._emit(self.session.connect())
                await stop.wait()
        def attach(*args,**kwargs):
            seen.update(kwargs)
            return asyncio.create_task(stop.wait())
        monkeypatch.setattr(mapping_runtime,'attach',attach)
        recorder=NS(notice='',stopped=threading.Event(),close=lambda:None)
        task=asyncio.create_task(run(credentials(),NIC_VALUE,inputs,object(),ready=True,
            check_nic=lambda:valid.nic,status=Status(),stop=stop,client_factory=FakeClient,
            recorder_factory=lambda *a,**k:recorder))
        async def until(predicate):
            async with asyncio.timeout(3):
                while not predicate():
                    if task.done():task.result()
                    inputs.lowstate(low(1))
                    await asyncio.sleep(.005)
        try:
            await until(lambda:'local_enabled' in seen)
            assert seen['enabled']() and seen['local_enabled']()
            seen['client'].session.connected=False
            assert not seen['enabled']() and seen['local_enabled']()
            if failure=='identity':valid.body=False
            else:valid.nic=False
            await until(lambda:not seen['local_enabled']())
            assert not seen['local_enabled']()
        finally:
            stop.set();await asyncio.wait_for(task,3)
    asyncio.run(scenario())
