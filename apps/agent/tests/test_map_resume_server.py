"""Actual progress endpoint with a private synthetic database; no robot/server access."""
import pytest

pytest.importorskip('sqlalchemy')  # Run this endpoint case in the server test venv.

from apps.server.tests.conftest import postgres, migrated, seeded  # noqa: F401
from apps.server.tests.test_maps import maps  # noqa: F401
from apps.server.tests.test_mapping import setup  # noqa: F401
from apps.server.tests.test_slam_mapping import start, report, current
from apps.server.fh_server.realtime import Peer
from apps.server.fh_server.models import MappingSession
from apps.server.tests.test_mapping import action
from sqlalchemy.orm import Session


@pytest.mark.parametrize('duration',[3,240])
def test_server_accepts_same_session_progress_after_new_connection(setup,duration):
    s=setup
    _,_,_,rid,rt,_,_=s
    initial=start(s)
    voxels=dict(revision=1,seq=1,reset=True,frame_id='world_map',added=[[1,0,0]])
    assert report(s,initial,update_seq=1,point_count=1,voxels=voxels).status_code==202
    assert current(s)['status']=='RUNNING'
    old=rt.agents.pop(rid)
    disconnected=current(s)
    assert disconnected['session_id']==initial['session_id']
    assert disconnected['status']=='UNKNOWN' and disconnected['error_code']=='LINK_LOST'
    # Only the server's synthetic clock advances; the DB session stays open.
    original_clock=rt.clock
    at=original_clock()+duration
    rt.clock=lambda:at
    rt.agents[rid]=Peer(socket=None,last_rx=at)
    try:
        assert rt.agents[rid] is not old
        voxels.update(seq=2,reset=False,added=[[2,0,0]])
        assert report(s,initial,update_seq=2,point_count=2,voxels=voxels).status_code==202
        resumed=current(s)
        assert resumed['session_id']==initial['session_id']
        assert resumed['command_id']==initial['command_id']
        assert resumed['status']=='RUNNING' and resumed['update_seq']==2
        assert resumed['point_count']==2 and resumed.get('error_code') is None
        assert resumed['voxels']['added']==[[2,0,0]] and resumed['voxels']['seq']==2
    finally:
        rt.clock=original_clock


@pytest.mark.parametrize('status',['CANCELLED','SAVED','RECEIVED_ONLY','FAILED'])
def test_terminal_server_session_returns_status_without_accepting_new_data(setup,status):
    s=setup
    _,_,_,rid,rt,_,engine=s
    initial=start(s)
    assert report(s,initial,point_count=1).status_code==202
    rt.agents.pop(rid)
    if status=='CANCELLED':
        assert action(s,'cancel',initial['session_id']).status_code==200
    else:
        with Session(engine) as db:
            row=db.get(MappingSession,initial['session_id'])
            row.status=status
            db.commit()
    with Session(engine) as db:
        before=dict(db.get(MappingSession,initial['session_id']).progress)
    rt.agents[rid]=Peer(socket=None,last_rx=rt.clock())
    response=report(s,initial,update_seq=2,point_count=999)
    assert response.status_code==202 and response.json()=={'accepted':True,'status':status}
    with Session(engine) as db:
        row=db.get(MappingSession,initial['session_id'])
        assert row.status==status and row.progress==before


def test_offline_web_cancel_stops_agent_glim_and_bag_on_first_reconnected_progress(setup,tmp_path):
    import json
    from test_map_resume import record
    from test_mapping_service_invariants import always_on_runtime,prime,drain,close_runtime
    from test_slam_mapping import FRONTEND,CLOUD,pose,cloud,wait_for
    s=setup
    http,_,_,rid,server,peer,_=s
    initial=start(s)
    agent,clock,active,calls=always_on_runtime(tmp_path)
    lane=record(agent,tmp_path)
    replies=[]
    def request(sid,suffix,data):
        assert suffix=='progress'
        response=http.post(f'/api/v1/agent/robots/{rid}/slam/{sid}/progress',
            headers={'authorization':'Bearer mapping-token'},json=json.loads(data))
        assert response.status_code==202,response.text
        replies.append(response.json())
        return response.json()
    agent.request=request
    try:
        prime(agent)
        agent.command(next(frame for frame in peer.queue._queue if frame.get('t')=='slam'))
        drain(agent)
        wait_for(lambda:agent.services.status=='STARTED')
        prime(agent,2);drain(agent)
        wait_for(lambda:agent.raw.snapshot()['status']=='RECORDING')
        agent.connection(False);server.agents.pop(rid)
        assert action(s,'cancel',initial['session_id']).status_code==200
        assert current(s)['status']=='CANCELLED'
        clock.t=.1;prime(agent,3)
        before=dict(agent.core.cells),agent.last_odom,dict(agent.input_stamps)
        count=len(replies)
        server.agents[rid]=Peer(socket=None,last_rx=server.clock())
        agent.connection(True);drain(agent)
        assert replies[count:]==[{'accepted':True,'status':'CANCELLED'}]
        agent.receive(FRONTEND,pose(stamp=4))
        agent.receive(CLOUD,cloud(points=((9,0,.3),),stamp=4));drain(agent)
        wait_for(lambda:not agent.services.owned and agent.raw.snapshot()['status']=='STOPPED')
        assert agent.core.status=='CANCELLED' and agent.remote_terminal
        assert (dict(agent.core.cells),agent.last_odom,dict(agent.input_stamps))==before
        assert ('stop',agent.services.glim) in calls and lane.signals
        assert active=={agent.services.pointlio} and len(replies)==count+1
    finally:
        close_runtime(agent)
        if agent.raw.thread:agent.raw.thread.join(2)
