"""Synthetic JPEGs and a private PostgreSQL; no devices or simulator."""
import base64
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from datetime import timedelta
import hashlib
import json
from pathlib import Path
from types import SimpleNamespace
from uuid import UUID, uuid4

import pytest
from sqlalchemy import create_engine, select, text
from sqlalchemy.orm import Session
from sqlalchemy import event as sql_event

from apps.contracts import models as C
from apps.server.fh_server import photos
from apps.server.fh_server.api import fail
from apps.server.fh_server.models import Event, Photo, Robot, Run, RunStep, now
from .test_maps import P, auth, maps
from .test_runs import scenario, event, stored, save, update
from .test_realtime import agent, receive

# Complete one-pixel grayscale JPEG, generated from synthetic pixels.
JPEG = base64.b64decode('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oACAEBAAA/APn+v//Z')
CAPS = C.ExecutionCapabilities(contract='scenario/2', revision=7, actions=[
    C.ExecutionCapability(key=key, state='SUPPORTED', reason=None) for key in ('wait', 'photo.rgb')])


def start(s, *, arrive=True):
    s['started'].update(run_contract='scenario/2', execution_capability_revision=7)
    result = photos_record(s, event(s))
    assert result['t'] == 'run.recorded', result
    if arrive:
        assert save(s, waypoint(s, 'RUN_WAYPOINT_ARRIVED', 2))['t'] == 'run.recorded'
    return s


def photos_record(s, message, caps=CAPS):
    from apps.server.fh_server.runs import record
    return record(s['factory'], s['seeded']['org'], str(s['seeded']['robots']['mine']), message, caps)


def waypoint(s, code, seq, results=None, idx=0):
    goal = stored(s)[0].plan['segments'][0]['goals'][idx]
    point = s['body']['waypoints'][idx]
    data = {key: goal[key] for key in ('mission_id', 'mission_version', 'mission_name', 'waypoint_ref')}
    data.update(run_id=s['started']['run_id'], idx=idx, floor_id=point['floor_id'],
        map_version_id=point['map_version_id'], pose=dict(floor_id=point['floor_id'], x=.1, y=.1, yaw=0., confidence=1.),
        agent_instance_id=s['instance'], report_seq=seq, monotonic_s=float(seq))
    if results is not None:
        data['results'] = results
    return event(s, code=code, seq=seq, data=data)


def metadata(s, payload=JPEG, **changes):
    return C.PhotoUploadMetadata(org_id=s['seeded']['org'], robot_id=s['seeded']['robots']['mine'],
        run_id=UUID(s['started']['run_id']), waypoint_idx=0, step_idx=0, source='rgb', captured_at=now(),
        mime='image/jpeg', byte_length=len(payload), sha256=hashlib.sha256(payload).hexdigest(),
        idempotency_key='photo-' + s['started']['run_id']).model_copy(update=changes)


def upload(s, meta=None, payload=JPEG, **headers):
    meta = meta or metadata(s, payload)
    return s['client'].post(P + '/agent/photos', content=payload, headers={
        'authorization': 'Bearer fake-test-' + str(s['seeded']['robots']['mine']),
        'content-type': 'image/jpeg', 'x-photo-metadata': meta.model_dump_json(), **headers})


def test_authenticated_atomic_receipt_replay_and_download(scenario):
    s = start(scenario)
    meta = metadata(s)
    first = upload(s, meta)
    assert first.status_code == 200, first.text
    receipt = C.PhotoUploadReceipt.model_validate(first.json())
    assert receipt.sha256 == meta.sha256
    with ThreadPoolExecutor(max_workers=2) as pool:
        replay = list(pool.map(lambda _: upload(s, meta), range(2)))
    assert all(r.json() == first.json() for r in replay)
    assert len(stored(s, Photo)) == 1
    root = Path(s['client'].app.state.realtime.settings.files_root)
    row = stored(s, Photo)[0]
    assert row.path == f'photos/{meta.org_id}/{receipt.photo_id}.jpg'
    assert (root / row.path).read_bytes() == JPEG
    assert not list(root.rglob('*.tmp'))
    path = P + '/photos/' + str(receipt.photo_id)
    assert s['client'].get(path).status_code == 401
    for user, expected in [('two', 404), ('one', 200), ('admin', 200)]:
        response = s['client'].get(path, headers=auth(s['client'], user))
        assert response.status_code == expected, response.text
        if expected == 200:
            assert response.content == JPEG
            assert response.headers['cache-control'] == 'private, no-store'
            assert s['client'].get(path + '/thumbnail', headers=auth(s['client'], user)).content == JPEG
    events = [e for e in stored(s, Event) if e.code == 'PHOTO_STORED']
    assert len(events) == 1 and events[0].data['photo_id'] == str(receipt.photo_id)
    assert 'jpeg' not in json.dumps(events[0].data) and events[0].run_id == meta.run_id
    # Exact replay remains stable after run termination, but other payloads do not.
    save(s, update(s, seq=3, status='CANCELED'))
    assert upload(s, meta).json() == first.json()
    assert upload(s, meta.model_copy(update={'sha256': '0' * 64})).status_code == 409


@pytest.mark.parametrize('change,expected', [
    ({'robot_id': uuid4()}, 403), ({'org_id': uuid4()}, 403), ({'run_id': uuid4()}, 404),
    ({'step_idx': 1}, 422), ({'waypoint_idx': 199}, 422),
    ({'sha256': '0' * 64}, 422), ({'byte_length': 4}, 422),
    ({'captured_at': now() + timedelta(days=2)}, 422),
    ({'captured_at': now() - timedelta(days=2)}, 422),
])
def test_scope_plan_hash_and_capture_time(scenario, change, expected):
    s = start(scenario)
    response = upload(s, metadata(s, **change))
    assert response.status_code == expected, response.text
    assert not stored(s, Photo)


@pytest.mark.parametrize('payload', [b'abcd', b'\xff\xd8\xff\xd9', JPEG[:-2], JPEG + b'junk',
                                    b'\xff\xd8\xff\xe0\xff\xff\xff\xd9'])
def test_malformed_jpeg_records_failure_without_file(scenario, payload):
    s = start(scenario)
    response = upload(s, payload=payload)
    assert response.status_code == 422, response.text
    assert not stored(s, Photo)
    assert any(e.code == 'PHOTO_STORE_FAILED' for e in stored(s, Event))


def test_size_mime_auth_and_state(scenario):
    s = scenario
    assert upload(s, **{'authorization': 'Bearer wrong'}).status_code == 403
    assert upload(s, metadata(s).model_copy(update={'byte_length': 65537}), payload=b'x' * 65537).status_code == 422
    start(s, arrive=False)
    assert upload(s, **{'content-type': 'image/png'}).status_code == 415
    assert upload(s).status_code == 409
    assert save(s, waypoint(s, 'RUN_WAYPOINT_ARRIVED', 2))['t'] == 'run.recorded'
    meta = metadata(s)
    assert upload(s, meta, payload=b'x' * 65537).status_code == 413
    assert upload(s, meta).status_code == 200
    assert upload(s, meta.model_copy(update={'idempotency_key': 'different-key'})).status_code == 409


def test_disk_failure_retry_orphan_recovery_and_capacity(scenario, monkeypatch):
    s = start(scenario); meta = metadata(s)
    root = Path(s['client'].app.state.realtime.settings.files_root)
    folder = root / 'photos' / str(meta.org_id)
    folder.mkdir(parents=True)
    orphan, pending = folder / f'{uuid4()}.jpg', folder / f'{uuid4()}.tmp'
    orphan.write_bytes(JPEG); pending.write_bytes(b'partial')
    with monkeypatch.context() as patch:
        patch.setattr(photos.os, 'replace', lambda *a: (_ for _ in ()).throw(OSError('synthetic full disk')))
        response = upload(s, meta)
    assert response.status_code == 503, response.text
    assert not orphan.exists() and not pending.exists() and not list(folder.glob('*'))
    assert stored(s, Photo)[0].status == 'FAILED'
    assert any(e.code == 'PHOTO_STORE_FAILED' for e in stored(s, Event))
    response = upload(s, meta)
    assert response.status_code == 200, response.text
    assert stored(s, Photo)[0].status == 'STORED'
    assert (root / stored(s, Photo)[0].path).read_bytes() == JPEG
    # A second waypoint cannot exceed either admission limit; original is retained.
    with s['factory'].begin() as db:
        run = db.get(Run, meta.run_id); run.step = 1
        db.get(RunStep, (meta.run_id, 1)).status = 'ARRIVED'
    second = meta.model_copy(update={'waypoint_idx': 1, 'idempotency_key': 'second-waypoint'})
    for limits in (replace(photos.LIMITS, max_retained=1), replace(photos.LIMITS, max_storage_bytes=len(JPEG))):
        with pytest.raises(Exception) as error:
            photos.save_photo(s['factory'], s['client'].app.state.realtime.settings, meta.robot_id, second,
                JPEG, photos.digest('fake-test-' + str(meta.robot_id)), fail, limits)
        assert error.value.status == 507
    assert len(stored(s, Photo)) == 1


def test_commit_failure_cleans_bytes_and_never_returns_receipt(scenario):
    s = start(scenario); meta = metadata(s)
    failures = []
    def broken(*a):
        if not failures:
            failures.append(True)
            raise OSError('synthetic insert failure')
    sql_event.listen(Photo, 'before_insert', broken)
    try:
        assert upload(s, meta).status_code == 503
    finally:
        sql_event.remove(Photo, 'before_insert', broken)
    root = Path(s['client'].app.state.realtime.settings.files_root)
    assert not list((root / 'photos').rglob('*.jpg'))
    assert not [e for e in stored(s, Event) if e.code == 'PHOTO_STORED']
    assert upload(s, meta).status_code == 200


def executed(photo):
    return dict(mode='EXECUTED', run_contract='scenario/2', execution_capability_revision=7, steps=[
        dict(step_idx=0, action='PHOTO', source='rgb', status='SUCCEEDED', failure_code=None,
            failure_reason=None, photo={k: photo[k] for k in ('photo_id', 'source', 'captured_at', 'sha256')}),
        dict(step_idx=1, action='WAIT', source=None, status='SUCCEEDED', failure_code=None,
            failure_reason=None, photo=None)])


def test_executed_results_bind_photo_and_reject_display_only(scenario):
    s = start(scenario)
    response = upload(s); assert response.status_code == 200, response.text
    result = executed(response.json())
    assert save(s, waypoint(s, 'RUN_WAYPOINT_RECORDED', 3, {'mode': 'DISPLAY_ONLY'}))['t'] == 'run.report_rejected'
    result['steps'][0]['photo']['photo_id'] = str(uuid4())
    assert save(s, waypoint(s, 'RUN_WAYPOINT_RECORDED', 4, result))['code'] == 'RUN_REPORT_PLAN'
    result['steps'][0]['photo']['photo_id'] = response.json()['photo_id']
    assert save(s, waypoint(s, 'RUN_WAYPOINT_RECORDED', 5, result))['t'] == 'run.recorded'
    assert next(row for row in stored(s, RunStep) if row.idx == 0).results == result
    assert save(s, waypoint(s, 'RUN_WAYPOINT_ARRIVED', 6, idx=1))['t'] == 'run.recorded'
    # A valid committed photo from another waypoint is still forbidden.
    assert save(s, waypoint(s, 'RUN_WAYPOINT_RECORDED', 7, result, idx=1))['code'] == 'RUN_REPORT_PLAN'


def test_v1_rejects_executed_and_v2_requires_proof_revision(scenario):
    s = scenario
    s['started'].update(run_contract='scenario/2', execution_capability_revision=7)
    missing = {**s['started']}; missing.pop('map_proof')
    raw = event(s).model_dump(mode='json', exclude_unset=True); raw['data'] = missing
    assert photos_record(s, raw)['code'] == 'RUN_REPORT_INVALID'
    assert photos_record(s, event(s, seq=2), CAPS.model_copy(update={'revision': 8}))['t'] == 'run.report_rejected'
    assert photos_record(s, event(s, seq=3), None)['t'] == 'run.report_rejected'
    s['started'].pop('run_contract'); s['started'].pop('execution_capability_revision')
    assert save(s, event(s, seq=4))['t'] == 'run.recorded'
    save(s, waypoint(s, 'RUN_WAYPOINT_ARRIVED', 5))
    results = dict(mode='EXECUTED', run_contract='scenario/2', execution_capability_revision=7, steps=[])
    assert save(s, waypoint(s, 'RUN_WAYPOINT_RECORDED', 6, results))['code'] == 'RUN_REPORT_PLAN'


def test_negotiated_scenario_and_catalog_live_capabilities(scenario):
    s = scenario; client = s['client']; rid = str(s['seeded']['robots']['mine'])
    path = P + '/agent/scenarios/' + s['started']['scenario_id'] + '?version=1'
    headers = {'authorization': 'Bearer fake-test-' + rid}
    query = '&run_contract=scenario/2&execution_capability_revision=7'
    assert client.get(path + query, headers=headers).status_code == 422
    with agent(client, s['seeded'], execution_capabilities=CAPS.model_dump(mode='json'), devices=[
            dict(key='rgb', kind='CAMERA_RGB', label='Synthetic camera', state='OK')]) as ws:
        response = client.get(path + query, headers=headers)
        assert response.status_code == 200, response.text
        plan = C.ExecutableAgentScenario.model_validate(response.json())
        assert plan.waypoints[0].mission_steps[0].action == 'PHOTO'
        assert plan.waypoints[0].required_capabilities == ['photo.rgb', 'wait']
        old = client.get(path, headers=headers).json()
        assert 'run_contract' not in old and 'mission_steps' not in old['waypoints'][0]
        assert client.get(path + query.replace('=7', '=8'), headers=headers).status_code == 422
        catalog = client.get(P + '/actions?robot_id=' + rid, headers=auth(client, 'one')).json()
        assert catalog[1]['available']
        assert not catalog[0]['options'][1]['available']  # depth remains unsupported
        s['started'].update(run_contract='scenario/2', execution_capability_revision=7)
        # The report writer must use the authenticated hello capability snapshot.
        peer = client.app.state.realtime.agents[rid]
        peer.state['devices'] = [dict(kind='CAMERA_RGB', state='OK')]
        # Use DB recording helper for deterministic plan equality as well as WS ACK.
        from apps.server.fh_server.runs import execution_capabilities
        assert execution_capabilities(client.app.state.realtime, rid).revision == 7
        ws.send_json(event(s).model_dump(mode='json', exclude_unset=True))
        assert receive(ws, 'run.recorded')['report_seq'] == 1
        assert stored(s)[0].plan['run_contract'] == 'scenario/2'
    assert not client.get(P + '/actions?robot_id=' + rid, headers=auth(client, 'one')).json()[1]['available']


def test_jpeg_dimension_bounds_and_truncation():
    assert photos.jpeg_dimensions(JPEG) == (1, 1)
    sof = JPEG.index(b'\xff\xc0')
    for width, height in ((0, 1), (641, 1), (1, 361)):
        changed = bytearray(JPEG)
        changed[sof+5:sof+7] = height.to_bytes(2, 'big')
        changed[sof+7:sof+9] = width.to_bytes(2, 'big')
        with pytest.raises(ValueError): photos.jpeg_dimensions(bytes(changed))
    for offset in range(len(JPEG)):
        with pytest.raises(ValueError): photos.jpeg_dimensions(JPEG[:offset])


def test_lost_commit_response_preserves_file_and_receipt(scenario):
    from sqlalchemy.orm import sessionmaker
    s = start(scenario); meta = metadata(s)
    lost = []
    class LostCommit(Session):
        def commit(self):
            super().commit()
            if not lost:
                lost.append(True)
                raise OSError('synthetic lost COMMIT reply')
    factory = sessionmaker(s['client'].app.state.engine, class_=LostCommit, expire_on_commit=False)
    result = photos.save_photo(factory, s['client'].app.state.realtime.settings, meta.robot_id, meta,
        JPEG, photos.digest('fake-test-' + str(meta.robot_id)), fail)
    assert isinstance(result, C.PhotoUploadReceipt)
    assert upload(s, meta).json() == result.model_dump(mode='json')
    assert (Path(s['client'].app.state.realtime.settings.files_root) / stored(s, Photo)[0].path).read_bytes() == JPEG
    assert len([e for e in stored(s, Event) if e.code == 'PHOTO_STORED']) == 1


def test_failed_step_cannot_claim_completed_run(scenario):
    s = start(scenario)
    assert save(s, update(s, seq=3, status='COMPLETED'))['code'] == 'RUN_REPORT_STATE'
    result = dict(mode='EXECUTED', run_contract='scenario/2', execution_capability_revision=7, steps=[
        dict(step_idx=0, action='PHOTO', source='rgb', status='FAILED', failure_code='UPLOAD_FAILED',
             failure_reason='synthetic upload failure', photo=None)])
    assert save(s, waypoint(s, 'RUN_WAYPOINT_RECORDED', 4, result))['t'] == 'run.recorded'
    assert next(row for row in stored(s, RunStep) if row.idx == 0).status == 'FAILED'
    assert save(s, update(s, seq=5, status='COMPLETED'))['code'] == 'RUN_REPORT_STATE'
    assert save(s, update(s, seq=6, status='FAILED', fail_code='ACTION_FAILED'))['t'] == 'run.recorded'


def test_photo_migration_refuses_populated_downgrade(scenario, monkeypatch):
    from alembic import command
    from alembic.config import Config
    from sqlalchemy.exc import DBAPIError
    from .conftest import CONFIG
    s = start(scenario)
    assert upload(s).status_code == 200
    monkeypatch.setenv('FH_MIGRATE_DATABASE_URL', s['seeded']['urls']['migrate'])
    with pytest.raises(DBAPIError, match='Retire photo records'):
        command.downgrade(Config(str(CONFIG)), '0019')
    assert len(stored(s, Photo)) == 1
