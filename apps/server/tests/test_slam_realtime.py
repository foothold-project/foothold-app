"""Rejected mapping observations must not retire the shared control socket."""
from datetime import timedelta
from threading import Event

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from apps.server.fh_server.api import Settings, create_app
from apps.server.fh_server.models import MappingSession, Robot, User, now
from apps.server.fh_server.security import digest
from .test_maps import P, auth, tree
from .test_realtime import hello, receive, reply, screen, send, state, take


@pytest.fixture
def mapping_wire(seeded, tmp_path):
    engine = create_engine(seeded['urls']['migrate'])
    rid = seeded['robots']['mine']
    with Session(engine) as db:
        robot = db.get(Robot, rid)
        robot.agent_token_hash = digest('synthetic-mapping-ws')
        robot.serial = 'synthetic-mapping-serial'
        robot.field_approval_expires_at = now() + timedelta(minutes=30)
        db.commit()
    app = create_app(Settings(seeded['urls']['app'], seeded['org'],
        files_root=str(tmp_path / 'files'), server_drive_robots=frozenset({rid})))
    try:
        with TestClient(app, base_url='https://testserver') as http:
            floor = tree(http, auth(http))[2]
            yield http, auth(http, 'one'), floor, str(rid), engine
    finally:
        app.state.engine.dispose()
        engine.dispose()


@pytest.mark.parametrize('rejection', ['source', 'owner', 'locked', 'legacy_owner'])
def test_rejected_slam_report_keeps_agent_control_stop_and_state(mapping_wire, seeded, monkeypatch, rejection):
    http, headers, floor, rid, engine = mapping_wire
    rt = http.app.state.realtime
    recorded = Event()
    original = rt.mapping.reject_report
    def rejected(*args):
        original(*args)
        recorded.set()
    monkeypatch.setattr(rt.mapping, 'reject_report', rejected)
    with http.websocket_connect('/api/v1/agent/ws', headers={
            'authorization': 'Bearer synthetic-mapping-ws'}) as ag:
        ag.send_json(hello())
        receive(ag, 'lease')
        receive(ag, 'stop')
        receive(ag, 'field_approval', predicate=lambda m: m['expires_at'] is not None)
        request = {'floor_id': floor}
        if rejection != 'legacy_owner':
            request['source'] = 'point_lio'
        response = http.post(P + f'/robots/{rid}/slam/start', headers=headers, json=request)
        assert response.status_code == 202, response.text
        initial = response.json()
        receive(ag, 'slam')
        message = dict(t='slam.update', session_id=initial['session_id'], floor_id=floor,
            status='RUNNING', phase='STARTED', command_id=initial['command_id'], revision=1, update_seq=1)
        if rejection == 'source':
            message['odom'] = dict(provider='glim', source='/synthetic/pose', frame_id='world_map',
                stamp=dict(sec=123, nanosec=456), x=0, y=0, z=0, yaw=0)
        else:
            with Session(engine) as db:
                if rejection == 'locked':
                    db.get(User, seeded['users']['one']).locked = True
                else:
                    db.get(Robot, rid).owner_user_id = seeded['users']['two']
                db.commit()
        expected_code = 'MAPPING_SOURCE_CONFLICT' if rejection == 'source' else 'MAPPING_OWNER_ONLY'
        # REST continues to expose the actual policy rejection to its caller.
        denied = http.post(P + f'/agent/robots/{rid}/slam/{initial["session_id"]}/progress',
            headers={'authorization': 'Bearer synthetic-mapping-ws'}, json=message)
        assert denied.status_code == (409 if rejection == 'source' else 403)
        assert denied.json()['error']['code'] == expected_code
        with Session(engine) as db:
            assert not db.get(MappingSession, initial['session_id']).progress.get('last_report_rejection')
        ag.send_json(message)
        assert recorded.wait(3), 'WS report rejection was not persisted'
        with Session(engine) as db:
            row = db.get(MappingSession, initial['session_id'])
            first = row.progress['last_report_rejection']
            assert first['code'] == expected_code and first['reason'] and first['received_at']
            assert row.status == initial['status']
            assert row.progress.get('odom') is None
        recorded.clear()
        ag.send_json(message)
        assert recorded.wait(3), 'Repeated WS report was not handled'
        with Session(engine) as db:
            assert db.get(MappingSession, initial['session_id']).progress['last_report_rejection'] == first
        assert str(rid) in rt.agents and not rt.agents[rid].closing
        # A policy-rejected observation cannot block control for a valid owner.
        if rejection == 'source':
            valid = {**message, 'odom': None, 'update_seq': 2, 'last_report_rejection': None}
            assert http.post(P + f'/agent/robots/{rid}/slam/{initial["session_id"]}/progress',
                headers={'authorization': 'Bearer synthetic-mapping-ws'}, json=valid).status_code == 202
            observed = http.get(P + f'/robots/{rid}/slam', headers=headers).json()
            assert observed['last_report_rejection']['code'] == first['code']
            with Session(engine) as db:
                assert db.get(MappingSession, initial['session_id']).progress['last_report_rejection'] == first
            with screen(http, headers) as ws:
                lease = take(ws, ag, rid)
                assert reply(ws, send(ws, 'unlock', rid, lease_id=lease, stop_gen=3))['ok']
                receive(ag, 'unlock')
                assert reply(ws, send(ws, 'cmd', rid, lease_id=lease, seq=0, axes=[0, 0, 0]))['ok']
                assert receive(ag, 'cmd')['axes'] == [0, 0, 0]
                commanded = reply(ws, send(ws, 'cmd', rid, lease_id=lease, seq=1, axes=[1.5, 0, .5]))
                assert commanded['ok'], commanded
                assert receive(ag, 'cmd')['axes'] == [1.5, 0, .5]
        stopper = auth(http, 'two')  # permitted STOP even when the original owner is locked
        assert http.post(P + f'/robots/{rid}/stop', headers=stopper).status_code == 202
        stopped = receive(ag, 'stop')
        accepted = Event()
        accept_state = rt.accept_state
        def observe(*args):
            result = accept_state(*args)
            if result:
                accepted.set()
            return result
        monkeypatch.setattr(rt, 'accept_state', observe)
        ag.send_json(state(10, stop_ref=stopped['stop_ref']))
        assert accepted.wait(3), 'State after rejected mapping report was not accepted'
        assert rt.agents[rid].state is not None
        # Ping exchange on the same connection still works after STOP and state.
        ping = receive(ag, 'ping')
        ag.send_json({'t': 'ping', 'ping_id': ping['ping_id']})
        assert rt.agents[rid].socket is not None and not rt.agents[rid].closing
