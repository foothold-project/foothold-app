"""Run start/control relay reuses the posture lease, approval and stop gates (11/28 05:09 · 05:14)."""
from dataclasses import replace
from uuid import uuid4

import pytest
from pydantic import ValidationError
from sqlalchemy import create_engine
from sqlalchemy.orm import Session as DBSession

from apps.contracts import models as C
from apps.server.fh_server.leases import LeaseError
from apps.server.fh_server.models import (Assignment, Building, Floor, MapVersion, Scenario,
                                          ScenarioVersion, Site, Upload)
from apps.server.fh_server import realtime as R
from .test_server_drive import trial
from .test_server_drive_flag_stop import relay
from .test_realtime import app_token, hello, receive, reply, screen, send, state, take


def start_fields(**kw):
    return dict(lease_id=str(uuid4()), run_id=str(uuid4()), screen_id=str(uuid4()),
                scenario_id=str(uuid4()), scenario_version=1, floor_id=str(uuid4()),
                map_version_id=str(uuid4()), assignment_id=str(uuid4()), **kw)


def test_contract_shapes_match_phone_run_and_require_assignment():
    rid = uuid4()
    from pydantic import TypeAdapter
    screen_adapter = TypeAdapter(C.ScreenMessage)
    fields = start_fields()
    msg = screen_adapter.validate_python({'t': 'run.start', 'id': 'r1', 'robot': str(rid), **fields})
    assert isinstance(msg, C.ScreenRunStart)
    # Same field names as the phone direct frame, plus the required assignment.
    assert set(C.PhoneRunStart.model_fields) - {'t', 'id', 'proto', 'robot'} == set(C.ScreenRunStart.model_fields) - {'t', 'id', 'proto', 'robot'}
    with pytest.raises(ValidationError):
        screen_adapter.validate_python({'t': 'run.start', 'id': 'r1', 'robot': str(rid),
                                        **{k: v for k, v in fields.items() if k != 'assignment_id'}})
    control = dict(t='run.control', id='r2', robot=str(rid), lease_id=str(uuid4()), run_id=str(uuid4()),
                   screen_id=str(uuid4()))
    for op in ('pause', 'resume', 'abort'):
        assert isinstance(screen_adapter.validate_python({**control, 'op': op}), C.ScreenRunControl)
    for bad in ({**control, 'op': 'return'}, {**control, 'op': 'pause', 'resume_token': 'x'},
                {k: v for k, v in {**control, 'op': 'abort'}.items() if k != 'lease_id'}):
        with pytest.raises(ValidationError):
            screen_adapter.validate_python(bad)
    agent = TypeAdapter(C.ServerAgentMessage)
    body = agent.validate_python({'t': 'run.start', 'request_id': 'r1', 'user_id': str(uuid4()), **fields})
    assert isinstance(body, C.AgentRunStart)
    assert isinstance(agent.validate_python({'t': 'run.control', 'request_id': 'r2', 'user_id': str(uuid4()),
        **{k: control[k] for k in ('lease_id', 'run_id', 'screen_id')}, 'op': 'pause'}), C.AgentRunControl)
    result = C.RunCommandResult(request_id='r1', op='start', run_id=uuid4(), status='REJECTED', code='SOMETHING_NEW')
    assert result.code == 'SOMETHING_NEW'
    with pytest.raises(ValidationError):
        C.RunCommandResult(request_id='r1', op='start', run_id=uuid4(), status='RUNNING', code='OK')
    assert C.AgentState.model_fields['run_result'].default is None
    assert 'run_result' in C.ScreenState.model_fields and 'run' in C.ScreenState.model_fields


def synthetic_assignment(seeded, *, robot='mine', status='ACTIVE'):
    engine = create_engine(seeded['urls']['migrate'])
    with DBSession(engine) as db:
        org, owner = seeded['org'], seeded['users']['one']
        site = Site(org_id=org, name='synthetic-run'); db.add(site); db.flush()
        building = Building(org_id=org, site_id=site.id, name='synthetic'); db.add(building); db.flush()
        floor = Floor(org_id=org, building_id=building.id, name='synthetic', level=1)
        image = Upload(org_id=org, image_path='synthetic.png', image_sha256=b'x'*32,
            png_sha256=b'x'*32, size_bytes=1, width=1, height=1, metadata_json={}, created_by=owner)
        db.add_all([floor, image]); db.flush()
        version = MapVersion(org_id=org, floor_id=floor.id, number=1, upload_id=image.id,
            status='APPROVED', image_path='synthetic.png', image_sha256=b'x'*32, width=1, height=1,
            resolution=1, origin_x=0, origin_y=0, origin_yaw=0, features={}, reason='synthetic',
            source='IMPORT', created_by=owner)
        scenario = Scenario(org_id=org, name='synthetic', latest_version=1, version=1, created_by=owner)
        db.add_all([version, scenario]); db.flush()
        fixed = ScenarioVersion(org_id=org, scenario_id=scenario.id, name='synthetic', number=1,
            required_devices=[], waypoints=[], finish={'mode': 'STAY'}, notes='', floor_ids=[floor.id],
            map_version_ids=[version.id], est_distance_m=0, created_by=owner)
        db.add(fixed); db.flush()
        row = Assignment(org_id=org, scenario_version_id=fixed.id, robot_id=seeded['robots'][robot],
            status=status, memo='', created_by=seeded['users']['admin'])
        db.add(row); db.commit()
        result = dict(assignment_id=str(row.id), scenario_id=str(scenario.id), scenario_version=1,
                      floor_id=str(floor.id), map_version_id=str(version.id))
    engine.dispose()
    return result


def test_assignment_must_be_active_for_this_robot_and_version(seeded):
    from sqlalchemy.orm import sessionmaker
    run_assignment_valid = R.run_assignment_valid
    engine = create_engine(seeded['urls']['migrate'])
    factory = sessionmaker(engine)
    rid, org = str(seeded['robots']['mine']), seeded['org']
    good = synthetic_assignment(seeded)
    msg = lambda **kw: C.ScreenRunStart(t='run.start', id='r', robot=rid, lease_id=uuid4(), run_id=uuid4(),
                                        screen_id=uuid4(), **{**good, **kw})
    assert run_assignment_valid(factory, org, rid, msg())
    assert not run_assignment_valid(factory, org, str(seeded['robots']['theirs']), msg())
    assert not run_assignment_valid(factory, org, rid, msg(scenario_version=2))
    assert not run_assignment_valid(factory, org, rid, msg(floor_id=str(uuid4())))
    assert not run_assignment_valid(factory, org, rid, msg(map_version_id=str(uuid4())))
    assert not run_assignment_valid(factory, org, rid, msg(assignment_id=str(uuid4())))
    pending = synthetic_assignment(seeded, status='PENDING')
    assert not run_assignment_valid(factory, org, rid, msg(**pending))
    engine.dispose()


def test_owner_run_start_and_control_reach_agent_and_result_returns(trial, seeded):
    rid = seeded['robots']['mine']
    owner = app_token(trial)
    good = synthetic_assignment(seeded)
    with trial.websocket_connect('/api/v1/agent/ws', headers={
            'authorization': 'Bearer fake-test-' + str(rid)}) as ag:
        ag.send_json(hello())
        receive(ag, 'lease'); receive(ag, 'stop'); receive(ag, 'field_approval')
        with screen(trial, owner) as ws, screen(trial, owner) as second:
            lease = take(ws, ag, rid)
            assert reply(ws, send(ws, 'unlock', rid, lease_id=lease, stop_gen=3))['ok']
            # The unlock names the server-verified holder (the demo Hub's relay controller).
            assert receive(ag, 'unlock')['user_id'] == str(seeded['users']['one'])
            run_id, screen_id = str(uuid4()), str(uuid4())
            ag.send_json(state(3, stop_ref=ag.stop_ref))  # fresh, still measurement
            ident = send(ws, 'run.start', rid, lease_id=lease, run_id=run_id, screen_id=screen_id, **good)
            assert reply(ws, ident)['ok']
            body = receive(ag, 'run.start')
            with pytest.raises(BaseException):  # exactly one run.start reaches the agent
                receive(ag, 'run.start', timeout=.3)
            assert body == dict(t='run.start', request_id=ident, lease_id=lease, run_id=run_id,
                screen_id=screen_id, user_id=str(seeded['users']['one']), **good)
            denied = reply(second, send(second, 'run.control', rid, lease_id=lease, run_id=run_id,
                                        screen_id=screen_id, op='pause'))
            assert denied['error']['code'] == 'LEASE_MISMATCH'
            pause = send(ws, 'run.control', rid, lease_id=lease, run_id=run_id, screen_id=screen_id, op='pause')
            assert reply(ws, pause)['ok']
            assert receive(ag, 'run.control')['op'] == 'pause'
            bad = reply(ws, send(ws, 'run.start', rid, lease_id=lease, run_id=str(uuid4()),
                                 screen_id=screen_id, **{**good, 'scenario_version': 2}))
            assert bad['error']['code'] == 'RUN_ASSIGNMENT_INVALID'
            assert reply(ws, send(ws, 'sub', robots=[str(rid)], streams=['state']))['ok']
            snapshot = dict(run_id=run_id, status='PAUSED', step=0, progress={'done': 0, 'total': 2},
                            wait_reason=None, fail_code=None)
            ag.send_json(state(3, reported_run=snapshot, run_result=dict(
                request_id=ident, op='start', run_id=run_id, status='REJECTED', code='FORBIDDEN')))
            seen = receive(ws, 'state', predicate=lambda m: m.get('run_result') is not None)
            assert seen['run_result']['code'] == 'FORBIDDEN'
            assert seen['run'] == snapshot


@pytest.mark.parametrize('username', ['admin', 'two'])
def test_non_owner_and_admin_cannot_send_real_run(trial, seeded, username):
    rid = seeded['robots']['mine']
    headers = app_token(trial, username)
    with screen(trial, headers) as ws:
        result = reply(ws, send(ws, 'run.start', rid, **start_fields()))
        assert result['ok'] is False
        assert result['error']['code'] in ('ADMIN_NO_REAL_CONTROL', 'NOT_ROBOT_OWNER')
        result = reply(ws, send(ws, 'run.control', rid, lease_id=str(uuid4()), run_id=str(uuid4()),
                                screen_id=str(uuid4()), op='abort'))
        assert result['error']['code'] in ('ADMIN_NO_REAL_CONTROL', 'NOT_ROBOT_OWNER')


def prepare(relay, op='start'):
    realtime, rid, peer, actor, _ = relay
    lease = str(uuid4())
    realtime.arbiter.robot(rid).holder.lease_id = lease
    peer.state_received_at = 0
    peer.state = {'applied': [0, 0, 0]}
    peer.server_drive_axes = (0, 0, 0)
    while not peer.queue.empty(): peer.queue.get_nowait()
    if op == 'start':
        fields = start_fields(); fields['lease_id'] = lease
        msg = C.ScreenRunStart(t='run.start', id='request', robot=rid, **fields)
    else:
        msg = C.ScreenRunControl(t='run.control', id='request', robot=rid, lease_id=lease,
                                 run_id=uuid4(), screen_id=uuid4(), op=op)
    return realtime, rid, peer, actor, msg


GATES = ['other_connection', 'wrong_lease', 'approval', 'changed', 'switch', 'auth', 'owner', 'run_holder']


@pytest.mark.parametrize('op', ['start', 'pause', 'resume', 'abort'])
@pytest.mark.parametrize('gate', GATES + ['stale', 'applied', 'input'])
def test_run_rechecks_all_server_gates(relay, gate, op):
    realtime, rid, peer, actor, msg = prepare(relay, op)
    if gate == 'other_connection': actor = replace(actor, connection='other')
    if gate == 'wrong_lease': msg = msg.model_copy(update={'lease_id': uuid4()})
    if gate == 'approval': realtime.field_approved = lambda rid: False
    if gate == 'changed': realtime.robot_changes.add(rid)
    if gate == 'switch': peer.server_drive = False
    if gate == 'auth': peer.auth_checked = -1
    if gate == 'owner': realtime.owner_uncertain = True
    if gate == 'run_holder': realtime.arbiter.robot(rid).holder.holder_type = 'RUN'
    if gate == 'stale': peer.state_received_at = -1
    if gate == 'applied': peer.state['applied'] = [.1, 0, 0]
    if gate == 'input': peer.server_drive_axes = (1.5, 0, 0)
    moving_gate = gate in ('stale', 'applied', 'input')
    if moving_gate and op in ('pause', 'abort'):
        # Pause/abort move toward safety; motion never blocks them.
        realtime.send_run(rid, actor, msg)
        assert peer.queue._queue[-1]['t'] == 'run.control'
        return
    with pytest.raises(LeaseError) as raised:
        realtime.send_run(rid, actor, msg)
    if moving_gate:
        assert raised.value.code == 'RUN_MOVING'
    assert peer.queue.empty()


def test_simulation_robot_takes_same_path_without_real_only_gates(relay):
    realtime, rid, peer, actor, msg = prepare(relay)
    peer.simulation, peer.server_drive = True, False
    realtime.field_approved = lambda rid: False
    realtime.send_run(rid, actor, msg)
    body = peer.queue._queue[-1]
    assert body['t'] == 'run.start' and body['request_id'] == 'request' and body['user_id'] == actor.user
    # The lease/holder gates stay for the demo robot.
    realtime, rid, peer, actor, msg = prepare(relay)
    peer.simulation = True
    with pytest.raises(LeaseError):
        realtime.send_run(rid, actor, msg.model_copy(update={'lease_id': uuid4()}))


@pytest.mark.parametrize('op', ['start', 'pause'])
@pytest.mark.parametrize('transition', ['stop', 'release', 'approval', 'lease'])
def test_queued_run_cannot_survive_stop_or_authority_change(relay, transition, op):
    realtime, rid, peer, actor, msg = prepare(relay, op)
    realtime.send_run(rid, actor, msg)
    body = peer.queue._queue[-1]
    assert body['t'].startswith('run.')
    assert not realtime.blocked_agent_control(peer, body)
    if transition == 'stop':
        realtime.apply(realtime.arbiter.stop(rid, actor))
    elif transition == 'release':
        realtime.apply(realtime.arbiter.release(rid, actor))
    elif transition == 'approval':
        realtime.field_approved = lambda rid: False
    else:
        realtime.arbiter.robot(rid).holder.lease_id = 'changed'
    if transition in ('stop', 'release'):
        assert not any(m.get('t', '').startswith('run.') for m in peer.queue._queue)
    else:
        assert realtime.blocked_agent_control(peer, body)
