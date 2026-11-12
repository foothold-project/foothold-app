"""Synthetic room uploads with fake connected peers; no DDS/robot/simulator."""
import asyncio
from uuid import uuid4

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from apps.contracts import models as C
from apps.server.fh_server.models import MappingSession, MapVersion, Robot, Floor, Building, Site
from apps.server.fh_server.realtime import Peer
from apps.server.fh_server.security import digest
from .test_maps import maps, auth, tree, P  # noqa: F401
from .test_voxel_maps import room, pcd


@pytest.fixture
def setup(maps, seeded):
    http, admin, root = maps
    floor = tree(http, admin)[2]
    engine = create_engine(seeded['urls']['migrate'])
    with Session(engine) as db:
        robots = db.scalars(select(Robot)).all()
        for r in robots:
            r.agent_token_hash = digest('mapping-token' if r.id == seeded['robots']['mine'] else str(r.id))
        db.commit()
    rid = str(seeded['robots']['mine'])
    rt = http.app.state.realtime
    peer = Peer(socket=None, last_rx=rt.clock())
    rt.agents[rid] = peer
    yield http, auth(http, 'one'), floor, rid, rt, peer, engine
    rt.agents.pop(rid, None)
    engine.dispose()


def start(s):
    http, headers, floor, rid, rt, peer, _ = s
    peer.last_rx = rt.clock()
    return http.post(P+f'/robots/{rid}/slam/start', headers=headers, json={'floor_id': floor})


def action(s, op, sid):
    http, headers, _, rid, rt, peer, _ = s
    peer.last_rx = rt.clock()
    return http.post(P+f'/robots/{rid}/slam/{op}', headers=headers, json={'session_id': sid})


def upload(s, sid, data=None, token='mapping-token'):
    http, _, _, rid, rt, peer, _ = s
    peer.last_rx = rt.clock()
    return http.post(P+f'/agent/robots/{rid}/slam/{sid}/point-cloud',
        headers={'authorization': 'Bearer '+token}, content=data if data is not None else pcd(room(), True))


def test_scope_and_only_rest_authorized_mapping_frames(setup):
    s = setup
    http, headers, floor, rid, rt, peer, engine = s
    assert http.post(P+f'/robots/{rid}/slam/start', headers=auth(http, 'admin'), json={'floor_id': floor}).status_code == 403
    assert http.post(P+f'/robots/{rid}/slam/start', headers=auth(http, 'two'), json={'floor_id': floor}).status_code == 403
    with Session(engine) as db:
        r = db.get(Robot, rid)
        r.simulation = True
        db.commit()
    assert start(s).status_code == 422
    with Session(engine) as db:
        db.get(Robot, rid).simulation = False
        db.commit()
    peer.closing = True
    assert start(s).status_code == 409
    peer.closing = False
    assert rt.blocked_agent_control(peer, {'t': 'slam', 'op': 'start'})
    response = start(s)
    assert response.status_code == 202, response.text
    body = next(body for body in list(peer.queue._queue) if body.get('t') == 'slam')
    assert body == {'t': 'slam', 'op': 'start', 'session_id': response.json()['session_id'], 'floor_id': floor}
    assert not rt.blocked_agent_control(peer, body)
    assert rt.blocked_agent_control(peer, {**body, 'floor_id': str(uuid4())})
    rt.mapping.consume(rid, body)
    assert rt.blocked_agent_control(peer, body)
    assert start(s).json()['error']['code'] == 'MAPPING_ACTIVE'
    sid = response.json()['session_id']
    assert action(s, 'save', str(uuid4())).status_code == 409
    assert action(s, 'cancel', sid).status_code == 200
    assert action(s, 'cancel', sid).status_code == 200
    assert action(s, 'save', sid).status_code == 409
    assert upload(s, sid).status_code == 409


def test_real_human_floor_only(setup):
    s = setup
    _, _, floor, _, _, _, engine = s
    with Session(engine) as db:
        f = db.get(Floor, floor)
        site = db.get(Site, db.get(Building, f.building_id).site_id)
        site.purpose = 'SIM'
        db.commit()
    assert start(s).json()['error']['code'] == 'MAPPING_REAL_ONLY'


def test_save_publishes_exact_twin_and_retry_is_idempotent(setup):
    s = setup
    http, headers, floor, rid, rt, peer, engine = s
    first = start(s)
    sid = first.json()['session_id']
    assert upload(s, sid).status_code == 409  # cannot bypass operator save
    assert action(s, 'save', sid).status_code == 202
    queue_size = peer.queue.qsize()
    assert action(s, 'save', sid).status_code == 202
    assert peer.queue.qsize() == queue_size
    saved = upload(s, sid)
    assert saved.status_code == 201, saved.text
    result = saved.json()
    assert result['map']['source'] == 'SLAM' and result['map']['provenance'] == 'HUMAN'
    assert result['map']['status'] == 'APPROVED' and result['voxels']['terrain_id']
    assert upload(s, sid).json() == result
    polled = http.get(P+f'/robots/{rid}/slam', headers=headers)
    assert polled.json()['status'] == 'SAVED' and polled.json()['map_version_id'] == result['map']['id']
    assert polled.headers['cache-control'] == 'private, no-store'
    assert action(s, 'cancel', sid).status_code == 409
    second = start(s).json()['session_id']
    assert action(s, 'save', second).status_code == 202
    other = upload(s, second)
    assert other.status_code == 201, other.text
    assert other.json()['map']['number'] == 2
    # Earlier immutable source/twin remains readable after replacing the approved pointer.
    with Session(engine) as db:
        old = db.get(MapVersion, result['map']['id'])
        assert old.source == 'SLAM' and old.floor_id == db.get(Floor, floor).id
        assert db.get(MappingSession, sid).result == result


def test_reports_failure_retry_cancel_and_token_recheck(setup):
    s = setup
    http, headers, floor, rid, rt, peer, engine = s
    sid = start(s).json()['session_id']
    report = C.AgentMappingUpdate(session_id=sid, floor_id=floor, status='RUNNING', point_count=50,
        preview=C.MappingPreview(resolution=.1, cells=[(0,0)], path=[], robot=(0,0,0))).model_dump(mode='json')
    endpoint = P+f'/agent/robots/{rid}/slam/{sid}/progress'
    rt.mapping.report(rid, C.AgentMappingUpdate.model_validate(report))
    assert http.post(endpoint, headers={'authorization': 'Bearer mapping-token'}, json=report).status_code == 202
    assert http.get(P+f'/robots/{rid}/slam', headers=headers).json()['point_count'] == 50
    assert action(s, 'save', sid).status_code == 202
    # delayed RUNNING may not undo SAVING
    rt.mapping.report(rid, C.AgentMappingUpdate.model_validate(report))
    assert http.get(P+f'/robots/{rid}/slam', headers=headers).json()['status'] == 'SAVING'
    bad = upload(s, sid, b'bad')
    assert bad.status_code == 422, bad.text
    assert http.get(P+f'/robots/{rid}/slam', headers=headers).json()['status'] == 'FAILED'
    assert action(s, 'save', sid).status_code == 202
    assert upload(s, sid, token='bad').status_code == 403
    assert upload(s, sid).status_code == 201
    rt.mapping.report(rid, C.AgentMappingUpdate.model_validate({**report, 'status': 'FAILED'}))
    assert http.get(P+f'/robots/{rid}/slam', headers=headers).json()['status'] == 'SAVED'


def test_disconnect_preview_bound_and_cancel_invalidates_pending(setup):
    s = setup
    http, headers, floor, rid, rt, peer, engine = s
    sid = start(s).json()['session_id']
    command = peer.queue.get_nowait()
    peer.closing = True
    result = http.get(P+f'/robots/{rid}/slam', headers=headers).json()
    assert result['status'] == 'FAILED' and result['error_code'] == 'LINK_LOST'
    assert action(s, 'save', sid).status_code == 409
    assert action(s, 'cancel', sid).status_code == 200
    assert not rt.mapping.command_allowed(rid, command)
    endpoint = P+f'/agent/robots/{rid}/slam/{sid}/progress'
    assert http.post(endpoint, headers={'authorization': 'Bearer mapping-token'}, content=b'x'*65537).status_code == 413


def test_upload_rechecks_owner_and_stale_base_and_size(setup, monkeypatch):
    from apps.server.fh_server import mapping as module
    s = setup
    http, headers, floor, rid, rt, peer, engine = s
    sid = start(s).json()['session_id']
    action(s, 'save', sid)
    url = P+f'/agent/robots/{rid}/slam/{sid}/point-cloud'
    assert http.post(url, headers={'authorization':'Bearer mapping-token',
        'content-length':str(module.MAX_BYTES+1)}, content=b'x').status_code == 413
    convert = module.convert
    def reassign(*args, **kwargs):
        result = convert(*args, **kwargs)
        with Session(engine) as db:
            db.get(Robot, rid).owner_user_id = None
            db.commit()
        return result
    monkeypatch.setattr(module, 'convert', reassign)
    response = upload(s, sid)
    assert response.status_code == 403 and response.json()['error']['code']=='MAPPING_OWNER_ONLY'
    with Session(engine) as db:
        row = db.get(MappingSession, sid)
        assert row.status=='FAILED' and row.result is None
        assert not db.scalars(select(MapVersion).where(MapVersion.floor_id==floor)).all()


def test_cancellation_during_conversion_prevents_publish(setup, monkeypatch):
    from apps.server.fh_server import mapping as module
    s = setup
    http, headers, floor, rid, rt, peer, engine = s
    sid = start(s).json()['session_id']; action(s, 'save', sid)
    convert = module.convert
    def cancel_before_commit(*args, **kwargs):
        result = convert(*args, **kwargs)
        with Session(engine) as db:
            row = db.get(MappingSession, sid)
            row.status = 'CANCELLED'
            db.commit()
        return result
    monkeypatch.setattr(module, 'convert', cancel_before_commit)
    assert upload(s, sid).status_code==409
    with Session(engine) as db:
        assert db.get(MappingSession, sid).status=='CANCELLED'
        assert not db.scalars(select(MapVersion).where(MapVersion.floor_id==floor)).all()


def test_immediate_save_keeps_queued_start_and_cancel_revokes_both(setup):
    s=setup
    _, _, _, rid, rt, peer, _=s
    sid=start(s).json()['session_id']
    start_frame=next(x for x in list(peer.queue._queue) if x.get('t')=='slam')
    action(s,'save',sid)
    save_frame=next(x for x in list(peer.queue._queue) if x.get('op')=='save')
    assert rt.mapping.command_allowed(rid,start_frame)
    assert rt.mapping.command_allowed(rid,save_frame)
    action(s,'cancel',sid)
    assert not rt.mapping.command_allowed(rid,start_frame)
    assert not rt.mapping.command_allowed(rid,save_frame)


def test_authorized_frame_is_actually_sent_once(setup):
    s=setup
    http, _, _, rid, rt, peer, _=s
    sid=start(s).json()['session_id']
    frame=next(x for x in list(peer.queue._queue) if x.get('t')=='slam')
    sent=[]
    class Socket:
        async def send_json(self, body): sent.append(body)
    peer.socket=Socket()
    assert http.portal.call(rt.send_body,peer,frame)
    assert sent==[frame] and not rt.mapping.command_allowed(rid,frame)
    assert not http.portal.call(rt.send_body,peer,frame)
    assert sent==[frame]
