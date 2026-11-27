"""Actual progress endpoint with a private synthetic database; no robot/server access."""
import pytest

pytest.importorskip('sqlalchemy')  # Run this endpoint case in the server test venv.

from apps.server.tests.conftest import postgres, migrated, seeded  # noqa: F401
from apps.server.tests.test_maps import maps  # noqa: F401
from apps.server.tests.test_mapping import setup  # noqa: F401
from apps.server.tests.test_slam_mapping import start, report, current
from apps.server.fh_server.realtime import Peer


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
