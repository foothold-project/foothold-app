"""Scenario/1 data recording: isolated DB, synthetic plans, no simulator."""
import base64
import json
from datetime import timedelta
from pathlib import Path
from uuid import UUID, uuid4

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session, sessionmaker
from starlette.websockets import WebSocketDisconnect

from apps.contracts import models as C
from apps.server.fh_server.floor_maps import approved_bindings, repository_registration
from apps.server.fh_server.models import AgentPlanMap, Building, Event, Floor, MapVersion, Robot, Run, RunReport, RunReportRejection, RunStep, ScenarioVersion, Upload, User, now
from apps.server.fh_server.runs import record, map_proof, reject, sample_path
from apps.server.fh_server.security import digest
from apps.server.fh_server.sim_maps import load_worlds, sync_worlds
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
    # Synthetic simulation provenance, written with the migration role; no real map assets.
    engine = create_engine(seeded['urls']['migrate'])
    with Session(engine) as db:
        version = db.get(MapVersion, UUID(body['waypoints'][0]['map_version_id']))
        floor = db.get(Floor, version.floor_id)
        building = db.get(Building, floor.building_id)
        upload = db.get(Upload, version.upload_id)
        floor.provenance, floor.sim_floor_id = 'SIMULATION', 'f1'
        building.sim_world_id = 'synthetic-world'
        version.provenance, version.source, version.status = 'SIMULATION', 'IMPORT', 'APPROVED'
        upload.provenance = 'SIMULATION'
        upload.metadata_json = {**upload.metadata_json, 'connected_gt': dict(
            world_id='synthetic-world', ros_floor_id='f1', source='SIMULATION',
            sha256=version.image_sha256.hex(), source_pgm_sha256='a' * 64)}
        db.commit()
    engine.dispose()
    started = dict(run_id=str(uuid4()), scenario_id=result['id'], scenario_version=1,
        floor_id=body['waypoints'][0]['floor_id'], map_version_id=body['waypoints'][0]['map_version_id'],
        user_id=str(seeded['users']['one']), device_id=str(uuid4()), surface='pc', screen_id=str(uuid4()), simulation=True)
    with Session(client.app.state.engine) as db:
        started['map_proof'] = map_proof(db, db.get(Robot, seeded['robots']['mine']),
            UUID(started['floor_id']), UUID(started['map_version_id']), reject).model_dump(mode='json')
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
    assert save(s, event(s))['disposition'] == 'QUARANTINE'
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
    gap = save(s, update(s, seq=3))
    assert gap['code'] == 'RUN_REPORT_SEQUENCE' and gap['expected_report_seq'] == 2
    assert gap['disposition'] == 'RETRY'
    assert stored(s)[0].status == 'QUEUED' and len(stored(s, RunReport)) == 1
    save(s, update(s))
    assert save(s, update(s, status='PAUSED'))['code'] == 'RUN_REPORT_CONFLICT'
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
    seq = 2 if mutate == 'active' else 1
    raw = dict(t='event', code='RUN_STARTED', severity='INFO', robot_at=None,
        data=s['started'], agent_instance_id=s['instance'], report_seq=seq, monotonic_s=float(seq))
    result = save(s, raw)
    assert result['disposition'] == 'QUARANTINE'
    assert len(stored(s, RunReportRejection)) == 1
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
    assert stored(s)[0].wait_reason is None and stored(s)[0].status == 'QUEUED'
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
        rejected = receive(ws, 'run.report_rejected')
        assert rejected['disposition'] == 'RETRY' and rejected['code'] == 'RUN_REPORT_SEQUENCE'
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
        rejected = receive(ws, 'run.report_rejected')
        assert rejected['disposition'] == 'RETRY' and rejected['code'] == 'RUN_REPORT_STORAGE'
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
    assert save(s, update(s, seq=0))['code'] == 'RUN_REPORT_INSTANCE'
    save(s, update(s, seq=1, status='FAILED', fail_code='AGENT_RESTARTED'))
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
            assert conn.scalar(text('SELECT version_num FROM alembic_version')) == '0020'
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


def test_quarantine_is_durable_consumes_sequence_and_keeps_connection(scenario):
    s = scenario
    original = event(s, data={**s['started'], 'user_id': str(s['seeded']['users']['two'])})
    with agent(s['client'], s['seeded']) as ws:
        ws.send_json(original.model_dump(mode='json', exclude_unset=True))
        denied = receive(ws, 'run.report_rejected')
        assert denied['code'] == 'RUN_REPORT_OWNER' and denied['disposition'] == 'QUARANTINE'
        assert not stored(s) and len(stored(s, RunReportRejection)) == 1
        ws.send_json(original.model_dump(mode='json', exclude_unset=True))
        assert receive(ws, 'run.report_rejected') == denied
        # Next report has an independent disposition; no poisoned 1013 reconnect loop.
        ws.send_json(event(s, seq=2).model_dump(mode='json', exclude_unset=True))
        assert receive(ws, 'run.recorded')['report_seq'] == 2
        assert len(stored(s)) == len(stored(s, RunReport)) == 1
    with agent(s['client'], s['seeded']) as ws:
        ws.send_json(original.model_dump(mode='json', exclude_unset=True))
        assert receive(ws, 'run.report_rejected') == denied
    assert len(stored(s, RunReportRejection)) == 1


def test_conflicting_bodies_never_replace_original_decision(scenario):
    s = scenario
    original = event(s)
    ack = save(s, original)
    changed = event(s, data={**s['started'], 'device_id': str(uuid4())})
    denied = save(s, changed)
    assert denied['disposition'] == 'QUARANTINE' and denied['code'] == 'RUN_REPORT_CONFLICT'
    assert save(s, changed) == denied and save(s, original) == ack
    assert len(stored(s, RunReport)) == len(stored(s, RunReportRejection)) == len(stored(s)) == 1
    # A different body at a quarantined identity gets a separately durable conflict.
    bad = update(s, seq=2).model_dump(mode='json', exclude_unset=True)
    bad['step'] = 999
    first = save(s, bad)
    assert first['disposition'] == 'QUARANTINE'
    conflict = save(s, update(s, seq=2))
    assert conflict['code'] == 'RUN_REPORT_CONFLICT'
    assert save(s, bad) == first
    assert save(s, update(s, seq=3))['t'] == 'run.recorded'


@pytest.mark.parametrize('mutate', ['missing_proof', 'bad_status', 'bad_run_id', 'bad_severity', 'missing_monotonic', 'bad_monotonic'])
def test_malformed_identified_report_quarantines_without_retiring(scenario, mutate):
    s = scenario
    raw = event(s).model_dump(mode='json', exclude_unset=True)
    if mutate == 'missing_proof': raw['data'].pop('map_proof')
    elif mutate == 'bad_status': raw = {**update(s, seq=1).model_dump(mode='json', exclude_unset=True), 'status': 'NOPE'}
    elif mutate == 'bad_run_id': raw['data']['run_id'] = 'invalid'
    elif mutate == 'missing_monotonic': raw.pop('monotonic_s')
    elif mutate == 'bad_monotonic': raw['monotonic_s'] = -1.
    else: raw['severity'] = 'NOPE'
    with agent(s['client'], s['seeded']) as ws:
        ws.send_json(raw)
        denied = receive(ws, 'run.report_rejected')
        assert denied['code'] == 'RUN_REPORT_INVALID' and denied['disposition'] == 'QUARANTINE'
        assert not stored(s) and len(stored(s, RunReportRejection)) == 1
        ws.send_json(event(s, seq=2).model_dump(mode='json', exclude_unset=True))
        assert receive(ws, 'run.recorded')['report_seq'] == 2


def test_quarantine_commit_failure_returns_storage_retry(scenario):
    from sqlalchemy import event as sql_event
    s = scenario
    bad = event(s, data={**s['started'], 'user_id': str(s['seeded']['users']['two'])})
    def broken(*args): raise OSError('synthetic quarantine disk failure')
    sql_event.listen(RunReportRejection, 'before_insert', broken)
    try:
        with agent(s['client'], s['seeded']) as ws:
            ws.send_json(bad.model_dump(mode='json', exclude_unset=True))
            frame = receive(ws, 'run.report_rejected')
            assert frame['code'] == 'RUN_REPORT_STORAGE' and frame['disposition'] == 'RETRY'
    finally:
        sql_event.remove(RunReportRejection, 'before_insert', broken)
    assert not stored(s, RunReportRejection) and not stored(s, RunReport) and not stored(s)
    assert save(s, bad)['code'] == 'RUN_REPORT_OWNER'


def test_monotonic_regression_is_permanent_and_cannot_lower_watermark(scenario):
    s = scenario; save(s, event(s))
    raw = update(s).model_dump(mode='json', exclude_unset=True)
    raw['monotonic_s'] = .5
    assert save(s, raw)['code'] == 'RUN_REPORT_INVALID'
    assert save(s, update(s, seq=3))['t'] == 'run.recorded'
    assert stored(s)[0].status == 'MOVING'


def test_human_map_and_forged_pgm_proof_fail_closed(scenario):
    s = scenario
    forged = {**s['started'], 'map_proof': {**s['started']['map_proof'], 'source_pgm_sha256': 'b' * 64}}
    assert save(s, event(s, data=forged))['code'] == 'RUN_REPORT_MAP'
    engine = create_engine(s['seeded']['urls']['migrate'])
    try:
        with Session(engine) as db:
            db.get(MapVersion, UUID(s['started']['map_version_id'])).provenance = 'HUMAN'
            db.commit()
    finally:
        engine.dispose()
    headers = {'authorization': 'Bearer fake-test-' + str(s['seeded']['robots']['mine'])}
    response = s['client'].get(P + '/agent/scenarios/' + s['started']['scenario_id'] + '?version=1', headers=headers)
    assert response.status_code == 422 and response.json()['error']['code'] == 'MAP_PROOF_UNAVAILABLE'
    assert save(s, event(s, seq=2))['code'] == 'RUN_REPORT_MAP'
    assert not stored(s) and not stored(s, AgentPlanMap)


@pytest.mark.parametrize('world_id', ['warehouse', 'rubble'])
@pytest.mark.parametrize('registration', ['missing', 'stored', 'superseded', 'wrong_source',
    'empty_source', 'origin', 'resolution', 'dimensions', 'human'])
def test_agent_repository_map_proof_legacy_registration(maps, seeded, monkeypatch, world_id, registration):
    client, _, files = maps
    root = Path(__file__).resolve().parents[2] / 'simmgr/worlds'
    canonical, _, _ = repository_registration(world_id)
    row = list(next(row for row in load_worlds(root) if row[0]['world_id'] == world_id))
    meta = row[1]
    if registration != 'stored':
        meta.pop('connected_gt')
    if registration == 'wrong_source':
        meta['connected_gt'] = {**canonical['connected_gt'], 'source_pgm_sha256': 'f' * 64}
    elif registration == 'empty_source':
        meta['connected_gt'] = {}
    elif registration == 'origin':
        meta['origin'] = [meta['origin'][0] + 1, *meta['origin'][1:]]
    elif registration == 'resolution':
        meta['resolution'] *= 2
    elif registration == 'dimensions':
        row[3] += 1
    # Import only into the fixture's private DB/files; stored metadata stays immutable.
    with Session(client.app.state.engine) as db, db.begin():
        with monkeypatch.context() as patch:
            patch.setattr('apps.server.fh_server.sim_maps.load_worlds', lambda _: [tuple(row)])
            version_id, = sync_worlds(db, seeded['org'], seeded['users']['admin'], root, files)
        robot = db.get(Robot, seeded['robots']['mine'])
        robot.simulation = True
        robot.agent_token_hash = digest('fake-repository-test-token')
        scenario = db.scalar(select(ScenarioVersion))
        scenario_id = scenario.scenario_id
    if registration in ('superseded', 'human'):
        engine = create_engine(seeded['urls']['migrate'])
        try:
            with Session(engine) as db, db.begin():
                version = db.get(MapVersion, UUID(version_id))
                if registration == 'superseded':
                    version.status = 'SUPERSEDED'
                else:
                    version.provenance = 'HUMAN'
        finally:
            engine.dispose()
    response = client.get(P + f'/agent/scenarios/{scenario_id}?version=1',
        headers={'authorization': 'Bearer fake-repository-test-token'})
    accepted = registration in ('missing', 'stored', 'superseded')
    if accepted:
        assert response.status_code == 200, response.text
        proof, = C.ProvenAgentScenario.model_validate(response.json()).map_proofs
        assert proof.source_pgm_sha256 == canonical['connected_gt']['source_pgm_sha256']
        assert str(proof.map_version_id) == version_id
    else:
        assert response.status_code == 422, response.text
        assert response.json()['error']['code'] == 'MAP_PROOF_UNAVAILABLE'
    with Session(client.app.state.engine) as db:
        version = db.get(MapVersion, UUID(version_id))
        assert db.get(Upload, version.upload_id).metadata_json == meta  # No backfill, even on success.
        if registration in ('missing', 'stored'):
            assert approved_bindings(db, seeded['org'], world_id)[0].source_pgm_sha256 == proof.source_pgm_sha256
        else:
            with pytest.raises(ValueError):
                approved_bindings(db, seeded['org'], world_id)
        if not accepted:
            assert not list(db.scalars(select(AgentPlanMap)))


def test_agent_v5_map_without_connected_gt_stays_unavailable(scenario):
    s = scenario
    engine = create_engine(s['seeded']['urls']['migrate'])
    try:
        with Session(engine) as db, db.begin():
            version = db.get(MapVersion, UUID(s['started']['map_version_id']))
            floor = db.get(Floor, version.floor_id)
            db.get(Building, floor.building_id).sim_world_id = 'v5_building'
            floor.sim_floor_id = 'l1'
            upload = db.get(Upload, version.upload_id)
            upload.metadata_json = {k: v for k, v in upload.metadata_json.items() if k != 'connected_gt'}
    finally:
        engine.dispose()
    response = s['client'].get(P + '/agent/scenarios/' + s['started']['scenario_id'] + '?version=1',
        headers={'authorization': 'Bearer fake-test-' + str(s['seeded']['robots']['mine'])})
    assert response.status_code == 422 and response.json()['error']['code'] == 'MAP_PROOF_UNAVAILABLE'
    assert not stored(s, AgentPlanMap)


def test_image_access_requires_agent_org_robot_and_fixed_plan_version(scenario):
    s = scenario; client = s['client']
    path = P + '/agent/map-versions/' + s['started']['map_version_id'] + '/image'
    def token(robot='mine'):
        return {'authorization': 'Bearer fake-test-' + str(s['seeded']['robots'][robot])}
    assert client.get(path).status_code == 401
    assert client.get(path, headers=auth(client)).status_code == 403
    assert client.get(path, headers={'authorization': 'Bearer wrong'}).status_code == 403
    assert client.get(path, headers=token()).status_code == 403
    plan = client.get(P + '/agent/scenarios/' + s['started']['scenario_id'] + '?version=1', headers=token())
    assert plan.status_code == 200
    proof = C.ProvenAgentScenario.model_validate(plan.json()).map_proofs[0]
    assert proof.model_dump(mode='json') == s['started']['map_proof']
    image = client.get(path, headers=token())
    assert image.status_code == 200 and image.headers['content-type'] == 'image/png'
    import hashlib
    assert hashlib.sha256(image.content).hexdigest() == proof.image_sha256
    assert proof.image_sha256 != proof.source_pgm_sha256
    assert image.headers['cache-control'] == 'private, no-store'
    assert client.get(path, headers=token('theirs')).status_code == 403
    assert client.get(path, headers=token('foreign')).status_code == 403
    with s['factory']() as db:
        other = db.scalar(select(MapVersion.id).where(MapVersion.id != UUID(s['started']['map_version_id'])))
    assert client.get(P + '/agent/map-versions/' + str(other) + '/image', headers=token()).status_code == 403
    with s['factory'].begin() as db:
        db.get(Robot, s['seeded']['robots']['mine']).agent_token_hash = digest('rotated-test-token')
    assert client.get(path, headers=token()).status_code == 403


def test_legacy_start_and_cause_cannot_write_persistent_run(scenario):
    s = scenario
    raw = event(s).model_dump(mode='json', exclude_unset=True)
    for key in ('agent_instance_id', 'report_seq', 'monotonic_s'): raw.pop(key)
    assert save(s, raw) is None
    assert not stored(s) and not stored(s, RunReport) and not stored(s, RunStep)
    save(s, event(s))
    raw.update(code='RUN_PAUSED', data={'run_id': s['started']['run_id']})
    before = len(stored(s, Event))
    assert save(s, raw) is None
    assert len(stored(s, Event)) == before and stored(s)[0].status == 'QUEUED'


def test_current_agent_durable_outbox_commit_ack_replay(scenario, tmp_path, monkeypatch):
    monkeypatch.syspath_prepend(str(Path(__file__).resolve().parents[2] / 'agent'))
    from foothold_agent.executor.run_outbox import RunOutbox
    s = scenario
    outbox = RunOutbox(str(tmp_path / 'agent-journal.sqlite'))
    try:
        raw = event(s).model_dump(mode='json', exclude_unset=True)
        original = outbox.append(raw, 1.)
        for future, _, _ in outbox.jobs: future.result(timeout=5)
        outbox.poll()
        assert outbox.replay() == [original]
        with agent(s['client'], s['seeded']) as ws:
            for _ in range(2):
                ws.send_json(outbox.replay()[0])
                ack = receive(ws, 'run.recorded')
                C.RunRecorded.model_validate(ack)
            assert len(stored(s, RunReport)) == 1
        assert outbox.ack(ack['agent_instance_id'], ack['report_seq'])
        for future, _, _ in outbox.jobs: future.result(timeout=5)
        outbox.poll()
        assert not outbox.replay()
        assert len(stored(s)) == len(stored(s, RunReport)) == 1
    finally:
        outbox.close()


def test_quarantine_only_downgrade_preserves_decisions(scenario, monkeypatch):
    from alembic import command
    from alembic.config import Config
    from sqlalchemy.exc import DBAPIError
    from .conftest import CONFIG
    s = scenario
    assert save(s, event(s, data={**s['started'], 'user_id': str(s['seeded']['users']['two'])}))['disposition'] == 'QUARANTINE'
    monkeypatch.setenv('FH_MIGRATE_DATABASE_URL', s['seeded']['urls']['migrate'])
    with pytest.raises(DBAPIError, match='Retire run rejection'):
        command.downgrade(Config(str(CONFIG)), '0018')
    assert len(stored(s, RunReportRejection)) == 1 and not stored(s)


def test_durable_hash_includes_scrubbed_secret_fields(scenario):
    s = scenario; save(s, event(s))
    raw = event(s, code='RUN_PAUSED', seq=2, data={'run_id': s['started']['run_id'],
        'token': 'synthetic-sensitive-value-a'}).model_dump(mode='json', exclude_unset=True)
    assert save(s, raw)['t'] == 'run.recorded'
    raw['data']['token'] = 'synthetic-sensitive-value-b'
    assert save(s, raw)['code'] == 'RUN_REPORT_CONFLICT'
    assert 'synthetic-sensitive-value' not in json.dumps([row.data for row in stored(s, Event)])
