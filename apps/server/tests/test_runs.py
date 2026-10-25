"""Scenario/1 data recording: isolated DB, synthetic plans, no simulator."""
import base64
import json
from datetime import timedelta
from pathlib import Path
from uuid import UUID, uuid4

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, sessionmaker
from starlette.websockets import WebSocketDisconnect

from apps.contracts import models as C
from apps.server.fh_server.models import Event, Robot, Run, RunReport, RunStep, User, now
from apps.server.fh_server.runs import record, ReportRejected, sample_path
from apps.server.fh_server.security import digest
from .test_missions import setup_scenario
from .test_maps import P, auth, maps
from .test_realtime import agent, receive
from .test_phone_pass import pc, issue
from .test_api import csrf


@pytest.fixture
def scenario(maps, seeded):
    client = maps[0]
    headers = auth(client)
    body, _, _, _ = setup_scenario(client, headers)
    body['waypoints'] = body['waypoints'][:2]
    response = client.post(P + '/scenarios', headers=headers, json=body)
    assert response.status_code == 201, response.text
    result = response.json()
    with Session(client.app.state.engine) as db:
        for rid in seeded['robots'].values():
            robot = db.get(Robot, rid)
            robot.agent_token_hash = digest('fake-test-' + str(rid))
            if rid == seeded['robots']['mine']:
                robot.simulation = True
        db.commit()
    started = dict(run_id=str(uuid4()), scenario_id=result['id'], scenario_version=1,
        floor_id=body['waypoints'][0]['floor_id'], map_version_id=body['waypoints'][0]['map_version_id'],
        user_id=str(seeded['users']['one']), device_id=str(uuid4()), surface='pc', screen_id=str(uuid4()), simulation=True)
    return dict(factory=sessionmaker(client.app.state.engine, expire_on_commit=False),
        client=client, seeded=seeded, started=started, instance=str(uuid4()), body=body)


def event(s, code='RUN_STARTED', seq=1, data=None):
    return C.AgentEvent(t='event', code=code, severity='INFO', robot_at=None,
        data=data or s['started'], agent_instance_id=s['instance'], report_seq=seq, monotonic_s=float(seq))


def update(s, seq=2, status='MOVING', **kw):
    return C.AgentRunUpdate(t='run.update', run_id=s['started']['run_id'], status=status,
        step=0, progress={'done': 0, 'total': 2}, agent_instance_id=s['instance'], report_seq=seq,
        monotonic_s=float(seq), **kw)


def save(s, msg):
    return record(s['factory'], s['seeded']['org'], str(s['seeded']['robots']['mine']), msg)


def stored(s, model=Run):
    with s['factory']() as db:
        return list(db.scalars(select(model)))


def test_fixed_version_agent_auth_and_real_fail_closed(scenario):
    s = scenario; client = s['client']
    path = P + '/agent/scenarios/' + s['started']['scenario_id']
    headers = {'authorization': 'Bearer fake-test-' + str(s['seeded']['robots']['mine'])}
    assert client.get(path + '?version=1').status_code == 401
    assert client.get(path, headers=headers).status_code == 400
    assert client.get(path + '?version=2', headers=headers).status_code == 404
    response = client.get(path + '?version=1', headers=headers)
    assert response.status_code == 200, response.text
    parsed = C.AgentScenario.model_validate(response.json())
    assert parsed.number == 1 and len(parsed.waypoints) == 2 and parsed.waypoints[0].mission_name
    assert response.headers['cache-control'] == 'no-store'
    # Fixed historical mission name is unaffected by mutable parent renames.
    mission = client.get(P + '/missions/' + str(parsed.waypoints[0].mission_id), headers=auth(client)).json()
    renamed = client.put(P + '/missions/' + mission['id'], headers={**auth(client), 'If-Match': '"1"'},
        json={'name': '다음 판', 'steps': mission['steps']})
    assert renamed.status_code == 200
    assert client.get(path + '?version=1', headers=headers).json() == response.json()
    with s['factory'].begin() as db:
        db.get(Robot, s['seeded']['robots']['mine']).simulation = False
    denied = client.get(path + '?version=1', headers=headers)
    assert denied.status_code == 422 and denied.json()['error']['code'] == 'PRECHECK_FAILED'
    with pytest.raises(ReportRejected):
        save(s, event(s))
    assert not stored(s)


def test_started_atomic_steps_receipt_and_dedup(scenario):
    s = scenario
    ack = save(s, event(s))
    assert ack == dict(t='run.recorded', agent_instance_id=s['instance'], report_seq=1)
    run = stored(s)[0]
    assert run.assignment_id is None and run.simulation and run.status == 'QUEUED'
    assert run.plan['segments'][0]['goals'][0]['mission_name']
    assert [r.status for r in stored(s, RunStep)] == ['PENDING', 'PENDING']
    assert save(s, event(s)) == ack
    assert len(stored(s)) == len(stored(s, RunReport)) == 1
    assert len([e for e in stored(s, Event) if e.code == 'RUN_STARTED']) == 1


def test_sequence_conflicts_and_replay(scenario):
    s = scenario; save(s, event(s))
    with pytest.raises(ReportRejected, match='SEQUENCE'):
        save(s, update(s, seq=3))
    assert stored(s)[0].status == 'QUEUED' and len(stored(s, RunReport)) == 1
    save(s, update(s))
    with pytest.raises(ReportRejected, match='CONFLICT'):
        save(s, update(s, status='PAUSED'))
    save(s, update(s, seq=3, status='PAUSED', wait_reason='LINK_LOST'))
    assert stored(s)[0].wait_reason == 'LINK_LOST'
    save(s, update(s, seq=4, status='CANCELED', fail_code='PAUSE_TIMEOUT'))
    run = stored(s)[0]
    assert run.status == 'CANCELED' and run.fail_code == 'PAUSE_TIMEOUT'
    assert run.wait_reason is None and run.ended_at
    save(s, update(s, seq=5))
    assert stored(s)[0].status == 'CANCELED'
    # Terminal run frees the partial unique index for another ID.
    s['started']['run_id'] = str(uuid4())
    save(s, event(s, seq=6))
    assert len(stored(s)) == 2


@pytest.mark.parametrize('mutate', ['simulation', 'foreign_user', 'other_owner', 'map', 'real', 'active'])
def test_start_rejects_provenance_scope_and_conflicts(scenario, mutate):
    s = scenario
    if mutate == 'simulation': s['started']['simulation'] = False
    elif mutate == 'foreign_user': s['started']['user_id'] = str(s['seeded']['users']['foreign'])
    elif mutate == 'other_owner': s['started']['user_id'] = str(s['seeded']['users']['two'])
    elif mutate == 'map': s['started']['map_version_id'] = str(uuid4())
    elif mutate == 'real':
        with s['factory'].begin() as db:
            db.get(Robot, s['seeded']['robots']['mine']).simulation = False
        s['started']['simulation'] = False; s['started']['surface'] = 'phone'
    elif mutate == 'active':
        save(s, event(s)); s['started']['run_id'] = str(uuid4())
    with pytest.raises((ReportRejected, IntegrityError)):
        save(s, event(s, seq=2 if mutate == 'active' else 1))
    assert len(stored(s, RunReport)) == (1 if mutate == 'active' else 0)


def test_waypoint_events_and_display_only_results(scenario):
    s = scenario; save(s, event(s))
    point = s['body']['waypoints'][0]
    goal = stored(s)[0].plan['segments'][0]['goals'][0]
    payload = dict(run_id=s['started']['run_id'], idx=0, waypoint_ref=point['waypoint_ref'],
        mission_id=point['mission_id'], mission_version=point['mission_version'], mission_name=goal['mission_name'],
        floor_id=point['floor_id'], map_version_id=point['map_version_id'],
        pose=dict(floor_id=point['floor_id'], x=.1, y=.1, yaw=0, confidence=1),
        agent_instance_id=s['instance'], report_seq=2, monotonic_s=2.)
    save(s, event(s, code='RUN_WAYPOINT_ARRIVED', seq=2, data=payload))
    payload.update(report_seq=3, monotonic_s=3., results={'mode': 'DISPLAY_ONLY'})
    save(s, event(s, code='RUN_WAYPOINT_RECORDED', seq=3, data=payload))
    step = next(r for r in stored(s, RunStep) if r.idx == 0)
    assert step.status == 'DONE' and step.arrived_at and step.done_at
    assert step.results['mode'] == 'DISPLAY_ONLY' and step.results['mission_version'] == 1
    assert all(e.run_id == UUID(s['started']['run_id']) for e in stored(s, Event) if e.code.startswith('RUN_'))


def test_legacy_optional_identity_and_secret_scrubbing(scenario):
    s = scenario; save(s, event(s))
    legacy = C.AgentRunUpdate(t='run.update', run_id=s['started']['run_id'], status='PAUSED',
        step=0, progress=None, wait_reason='LINK_LOST')
    assert save(s, legacy) is None
    assert stored(s)[0].wait_reason == 'LINK_LOST'
    msg = event(s, code='RUN_PAUSED', seq=2, data={'run_id': s['started']['run_id'],
        'nested': [{'resume_token': 'must-never-persist', 'reason': 'LINK_LOST'}]})
    save(s, msg)
    assert 'must-never-persist' not in json.dumps([e.data for e in stored(s, Event)])
    assert len(stored(s, RunReport)) == 2


def test_path_sampling_one_hz_map_binding(scenario):
    s = scenario; save(s, event(s))
    pose = dict(floor_id=s['started']['floor_id'], map_version_id=s['started']['map_version_id'], x=.1,y=.2,yaw=0)
    at = now()
    for offset in (0, .1, .9, 1.01):
        sample_path(s['factory'], s['seeded']['org'], str(s['seeded']['robots']['mine']), pose, at+timedelta(seconds=offset))
    assert len(stored(s)[0].path_actual) == 2
    sample_path(s['factory'], s['seeded']['org'], str(s['seeded']['robots']['mine']),
        dict(pose, map_version_id=str(uuid4())), at+timedelta(seconds=2))
    assert len(stored(s)[0].path_actual) == 2


def test_ws_ack_commit_reconnect_and_gap(scenario):
    s = scenario
    for _ in range(2):
        with agent(s['client'], s['seeded']) as ws:
            ws.send_json(event(s).model_dump(mode='json', exclude_unset=True))
            try:
                receipt = receive(ws, 'run.recorded')
            except WebSocketDisconnect as exc:
                pytest.fail(f'Unexpected close {exc.code}: {exc.reason}')
            assert receipt['report_seq'] == 1
            assert len(stored(s, RunReport)) == 1  # visible on a separate DB connection after ACK
    with agent(s['client'], s['seeded']) as ws:
        ws.send_json(update(s, seq=3).model_dump(mode='json', exclude_unset=True))
        with pytest.raises(WebSocketDisconnect) as closed:
            receive(ws, 'run.recorded')
        assert closed.value.code == 1013
    with agent(s['client'], s['seeded']) as ws:
        ws.send_json(update(s).model_dump(mode='json', exclude_unset=True))
        assert receive(ws, 'run.recorded')['report_seq'] == 2
    assert stored(s)[0].status == 'MOVING'


def test_ws_commit_failure_never_acknowledged(scenario, monkeypatch):
    from apps.server.fh_server import runs
    s = scenario
    def broken(*args): raise OSError('fake DB failure')
    monkeypatch.setattr(runs, 'record', broken)
    with agent(s['client'], s['seeded']) as ws:
        ws.send_json(event(s).model_dump(mode='json', exclude_unset=True))
        with pytest.raises(WebSocketDisconnect) as closed:
            receive(ws, 'run.recorded')
        assert closed.value.code == 1013
    assert not stored(s, RunReport)


def test_signed_cancel_scope_and_real_admin_stays_blocked(pc, seeded):
    with Session(pc.app.state.engine) as db:
        db.get(Robot, seeded['robots']['mine']).simulation = True
        db.commit()
    pc.pass_headers = csrf(pc, 'one')
    result = issue(pc, seeded, purpose='view')
    assert result.status_code == 200
    def claims(response):
        return json.loads(base64.urlsafe_b64decode(response.json()['token'].split('.')[1]+'=='))
    assert claims(result)['run_cancel'] is True
    pc.pass_headers = csrf(pc, 'admin')
    assert claims(issue(pc, seeded, purpose='view'))['run_cancel'] is True
    with Session(pc.app.state.engine) as db:
        db.get(Robot, seeded['robots']['mine']).simulation = False
        db.commit()
    assert issue(pc, seeded, purpose='control').status_code == 403
    assert issue(pc, seeded, purpose='view').status_code == 403
    response = pc.post(f"{P}/robots/{seeded['robots']['mine']}/phone-pass", headers=pc.pass_headers,
        json={'purpose': 'view', 'device': str(uuid4()), 'surface': 'pc'})
    assert response.status_code == 403
    pc.pass_headers = csrf(pc, 'two')
    assert issue(pc, seeded, purpose='view').status_code == 404
    assert issue(pc, seeded, robot='foreign', purpose='view').status_code == 404


def test_server_never_emits_run_commands():
    source = (Path(__file__).parents[1] / 'fh_server' / 'realtime.py').read_text()
    assert not any("'t': '"+name+"'" in source for name in ('run.start', 'run.control', 'run.confirm'))


def test_concurrent_duplicate_receipts_and_restart_boundary(scenario):
    from concurrent.futures import ThreadPoolExecutor
    s = scenario
    with ThreadPoolExecutor(max_workers=2) as pool:
        receipts = list(pool.map(lambda _: save(s, event(s)), range(2)))
    assert receipts[0] == receipts[1] and len(stored(s, RunReport)) == 1
    s['instance'] = str(uuid4())
    with pytest.raises(ReportRejected, match='INSTANCE'):
        save(s, update(s, seq=0))
    save(s, update(s, seq=0, status='FAILED', fail_code='AGENT_RESTARTED'))
    assert stored(s)[0].status == 'FAILED'


def test_receipt_failure_rolls_back_run_steps_and_event(scenario):
    from sqlalchemy import event as sql_event
    s = scenario
    def fail_receipt(*args): raise OSError('synthetic receipt failure')
    sql_event.listen(RunReport, 'before_insert', fail_receipt)
    try:
        with pytest.raises(OSError): save(s, event(s))
    finally:
        sql_event.remove(RunReport, 'before_insert', fail_receipt)
    assert not stored(s) and not stored(s, RunStep) and not stored(s, RunReport)
    assert not [e for e in stored(s, Event) if e.code == 'RUN_STARTED']
    save(s, event(s))
    assert len(stored(s)) == 1


def test_populated_migration_downgrade_refuses_data_loss(scenario, monkeypatch):
    from alembic import command
    from alembic.config import Config
    from sqlalchemy import text
    from sqlalchemy.exc import DBAPIError
    from .conftest import CONFIG
    s = scenario; save(s, event(s))
    monkeypatch.setenv('FH_MIGRATE_DATABASE_URL', s['seeded']['urls']['migrate'])
    with pytest.raises(DBAPIError, match='Retire run records'):
        command.downgrade(Config(str(CONFIG)), '0017')
    migration_engine = create_engine(s['seeded']['urls']['migrate'])
    try:
        with migration_engine.connect() as conn:
            assert conn.scalar(text('SELECT version_num FROM alembic_version')) == '0018'
    finally:
        migration_engine.dispose()
    assert len(stored(s)) == len(stored(s, RunReport)) == 1


def test_issuer_does_not_sign_cancel_for_non_owner(pc, seeded):
    with Session(pc.app.state.engine) as db:
        robot = db.get(Robot, seeded['robots']['mine'])
        robot.simulation = True
        db.commit()
        user = db.get(User, seeded['users']['two'])
        result = pc.app.state.phone_pass_issuer.issue(db, user, robot,
            C.PhonePassRequest(device=uuid4(), purpose='view'))
        claims = json.loads(base64.urlsafe_b64decode(result['token'].split('.')[1] + '=='))
        assert claims['run_cancel'] is False


def test_identified_existing_alerts_keep_atomic_notifications(scenario):
    from apps.server.fh_server.models import Notification
    s = scenario; save(s, event(s))
    warning = event(s, code='BATTERY_LOW', seq=2,
        data={'run_id': s['started']['run_id'], 'soc': 20})
    save(s, warning)
    recipients = {r.user_id for r in stored(s, Notification)}
    assert recipients == {s['seeded']['users']['one'], s['seeded']['users']['admin']}
    save(s, warning)
    assert len(stored(s, Notification)) == 2


def test_durable_reconnect_does_not_fabricate_pause_or_server_run_lease(scenario):
    s = scenario; save(s, event(s)); save(s, update(s))
    rt = s['client'].app.state.realtime
    rid = str(s['seeded']['robots']['mine'])
    with agent(s['client'], s['seeded'], run={'run_id': s['started']['run_id'], 'status': 'RUNNING', 'step': 0}):
        assert rt.runs[rid]['status'] == 'MOVING'
        assert rt.arbiter.robot(rid).holder is None
        assert rt.arbiter.robot(rid).transfer is None
    assert stored(s)[0].status == 'MOVING'
