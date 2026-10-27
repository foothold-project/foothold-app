"""Successful receipts replay immutable response bodies, with real concurrent DB writes."""
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from threading import Barrier
from uuid import UUID

import pytest
from sqlalchemy import create_engine, select, text
from sqlalchemy.orm import Session

from apps.server.fh_server import api
from apps.server.fh_server.models import Assignment, IdempotencyReceipt, MapVersion, now
from .test_maps import P, FEATURES, auth, maps, tree, upload, save
from .test_assignments import scenario


def map_body(image, base=None):
    return {'base_version_id': base, 'image': image, 'features': FEATURES, 'reason': '멱등 요청 시험'}


def test_map_save_rollback_replay_before_stale_and_mismatch(maps):
    http, admin, root = maps
    one = auth(http, 'one')
    _, _, floor = tree(http, admin)
    image = upload(http, admin)
    path = P + f'/floors/{floor}/map-versions'
    body = map_body(image)
    headers = {**one, 'Idempotency-Key': 'map-save.1'}
    first = http.post(path, headers=headers, json=body)
    assert first.status_code == 201, first.text
    before = sorted(p.relative_to(root) for p in root.rglob('*') if p.is_file())
    assert http.post(path, headers=headers, json=body).json() == first.json()
    assert sorted(p.relative_to(root) for p in root.rglob('*') if p.is_file()) == before
    assert first.json()['status'] == 'APPROVED'
    assert http.get(P + '/approvals', headers=one).json()['items'] == []
    # Replay remains the original successful response after later map changes.
    replay = http.post(path, headers=headers, json=body)
    assert replay.status_code == first.status_code and replay.json() == first.json()
    assert http.post(path, headers=headers, json={**body, 'reason': '다른 본문'}).status_code == 422
    assert http.post(path, headers=one, json=body).status_code == 409
    second = save(http, admin, floor, image, base=first.json()['id']).json()
    rollback = P + '/map-versions/' + first.json()['id'] + '/rollback'
    rb_body = {'base_version_id': second['id'], 'reason': '되돌림 멱등 요청'}
    rb_headers = {**one, 'Idempotency-Key': 'rollback:1'}
    created = http.post(rollback, headers=rb_headers, json=rb_body)
    assert created.status_code == 201, created.text
    replay = http.post(rollback, headers=rb_headers, json=rb_body)
    assert replay.status_code == 201 and replay.json() == created.json()
    assert http.post(rollback, headers=rb_headers, json={**rb_body, 'reason': '다름'}).status_code == 422
    assert http.post(rollback, headers=headers, json=rb_body).status_code == 422  # cross-route key reuse
    # Direct rollback changes the current pointer, so the old base is stale.
    assert http.post(rollback, headers=one, json=rb_body).status_code == 409
    newest = save(http, admin, floor, image, base=created.json()['id']).json()
    assert http.post(rollback, headers=rb_headers, json=rb_body).json() == created.json()
    assert newest['id'] != created.json()['id']
    assert http.get(P + '/approvals', headers=one).json()['items'] == []


@pytest.mark.parametrize('operation', ['map', 'rollback', 'assignment'])
def test_same_key_concurrently_one_creation_without_org_mutex(maps, seeded, monkeypatch, operation):
    http, admin, _ = maps
    one = auth(http, 'one')
    if operation == 'assignment':
        value, _, _, _ = scenario(http, admin)
        path = P + '/assignments'
        body = {'scenario_id': value['id'], 'scenario_version': 1,
            'robot_id': str(seeded['robots']['mine']), 'memo': '동시 요청'}
        model = Assignment
    else:
        _, _, floor = tree(http, admin)
        image = upload(http, admin)
        model = MapVersion
        if operation == 'map':
            path, body = P + f'/floors/{floor}/map-versions', map_body(image)
        else:
            first = save(http, admin, floor, image).json()
            second = save(http, admin, floor, image, base=first['id']).json()
            path = P + '/map-versions/' + first['id'] + '/rollback'
            body = {'base_version_id': second['id'], 'reason': '동시 되돌림'}
    second_session = auth(http, 'one')
    monkeypatch.setattr(api, 'lock_organization', lambda *a: None)
    gate = Barrier(2)
    original = api.assignments.idempotency.begin
    def synchronized(*args, **kwargs):
        gate.wait(timeout=5)
        return original(*args, **kwargs)
    monkeypatch.setattr(api.assignments.idempotency, 'begin', synchronized)
    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(pool.map(lambda headers: http.post(path, json=body,
            headers={**headers, 'Idempotency-Key': 'concurrent-key'}), [one, second_session]))
    assert [r.status_code for r in responses] == [201, 201], [r.text for r in responses]
    assert responses[0].json() == responses[1].json()
    engine = create_engine(seeded['urls']['app'])
    with Session(engine) as db:
        target = db.get(model, UUID(responses[0].json()['id']))
        assert target is not None
        assert len(list(db.scalars(select(IdempotencyReceipt)))) == 1
        approvals = http.get(P + '/approvals', headers=one).json()['items']
        assert approvals == []
    engine.dispose()


def test_assignment_key_replay_expiry_users_and_header_validation(maps, seeded):
    http, admin, _ = maps
    one = auth(http, 'one')
    value, _, _, _ = scenario(http, admin)
    path = P + '/assignments'
    body = {'scenario_id': value['id'], 'scenario_version': 1,
        'robot_id': str(seeded['robots']['mine']), 'memo': '재요청'}
    for key in ('', 'x' * 129, 'bad key', 'bad/key', 'bad,key'):
        assert http.post(path, headers={**one, 'Idempotency-Key': key}, json=body).status_code == 422
    headers = {**one, 'Idempotency-Key': 'assignment-key'}
    first = http.post(path, headers=headers, json=body)
    assert first.status_code == 201, first.text
    assert http.post(path, headers=headers, json=body).json() == first.json()
    assert http.post(path, headers=headers, json={**body, 'memo': '본문 변경'}).status_code == 422
    assert http.post(path, headers=one, json=body).status_code == 409
    http.delete(path + '/' + first.json()['id'], headers=one)
    assert http.post(path, headers=headers, json=body).json() == first.json()
    # Same literal key belongs to another user, not a shared organization cache.
    other = http.post(path, headers={**admin, 'Idempotency-Key': 'assignment-key'}, json=body)
    assert other.status_code == 201 and other.json()['status'] == 'ACTIVE'
    http.delete(path + '/' + other.json()['id'], headers=admin)
    engine = create_engine(seeded['urls']['migrate'])
    with engine.begin() as conn:
        conn.execute(text('UPDATE idempotency_receipts SET expires_at=:expiry WHERE user_id=:user'),
            {'expiry': now() - timedelta(seconds=1), 'user': seeded['users']['one']})
    engine.dispose()
    expired = http.post(path, headers=headers, json={**body, 'memo': '새 요청'})
    assert expired.status_code == 201 and expired.json()['id'] != first.json()['id']
    # Failed creation does not burn a key: rollback releases the reservation.
    bad = {**body, 'scenario_version': 999}
    new_headers = {**one, 'Idempotency-Key': 'failed-attempt'}
    assert http.post(path, headers=new_headers, json=bad).status_code == 404
    http.delete(path + '/' + expired.json()['id'], headers=one)
    assert http.post(path, headers=new_headers, json=body).status_code == 201
