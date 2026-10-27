"""ADR-003 §11: organization editing is immediate, legacy requests survive."""
import copy

import pytest
from sqlalchemy import create_engine, text

from .legacy_approvals import pending_assignment, pending_map
from .test_assignments import assignment, listing, scenario
from .test_maps import FEATURES, P, auth, maps, save, tree, upload


def assert_no_approvals(seeded):
    engine = create_engine(seeded['urls']['app'])
    try:
        with engine.connect() as conn:
            assert conn.scalar(text('SELECT count(*) FROM approvals')) == 0
    finally:
        engine.dispose()


@pytest.mark.parametrize('actor', ['one', 'admin'])
def test_map_features_and_rollback_publish_with_same_events(maps, seeded, actor):
    http, _, _ = maps
    headers = auth(http, actor)
    _, building, floor = tree(http, headers)
    pair = http.post(P + f'/buildings/{building}/floors', headers=headers,
        json={'name': '짝 층', 'level': 2}).json()['id']
    image = upload(http, headers)
    features = copy.deepcopy(FEATURES)
    features['zones'] = [{'id': 'zone', 'name': '감속', 'type': 'SLOW', 'polygon': [[0, 0], [1, 0], [1, 1]]}]
    features['waypoints'] = [{'id': 'point', 'name': '입구', 'x': 1, 'y': 1, 'yaw': 0}]
    features['edits'] = [{'id': 'wall', 'op': 'WALL', 'polyline': [[0, 0], [1, 1]], 'width': .1}]
    connector = {'id': 'stairs', 'kind': 'STAIRS', 'x': 1, 'y': 1, 'yaw': 0}
    features['connectors'] = [{**connector, 'pair_floor_id': pair}]
    first = save(http, headers, floor, image, features=features).json()
    paired = save(http, headers, pair, image,
        features={**FEATURES, 'connectors': [{**connector, 'pair_floor_id': floor}]}).json()
    assert first['status'] == paired['status'] == 'APPROVED'
    path = P + '/floor-connectors?building_id=' + building
    assert http.get(path, headers=headers).json()['items'][0]['active']
    # Removing features immediately removes the active connector projection.
    second = save(http, headers, floor, image, base=first['id']).json()
    assert second['status'] == 'APPROVED'
    assert all(not c['active'] for c in http.get(path, headers=headers).json()['items'])
    response = http.post(P + '/map-versions/' + first['id'] + '/rollback', headers=headers,
        json={'base_version_id': second['id'], 'reason': '즉시 복원'})
    assert response.status_code == 201, response.text
    restored = response.json()
    assert restored['status'] == 'APPROVED' and restored['features'] == first['features']
    assert restored['copied_from_id'] == first['id'] and restored['created_by'] == str(seeded['users'][actor])
    assert http.get(path, headers=headers).json()['items'][0]['active']
    floor_row = http.get(P + '/sites', headers=headers).json()['items'][0]['buildings'][0]['floors'][0]
    assert floor_row['approved_version_id'] == restored['id'] and floor_row['pending_count'] == 0
    engine = create_engine(seeded['urls']['app'])
    try:
        with engine.connect() as conn:
            codes = list(conn.scalars(text("SELECT code FROM events WHERE code LIKE 'MAP_VERSION_%' ORDER BY id")))
            assert codes == ['MAP_VERSION_APPROVED'] * 3 + ['MAP_VERSION_ROLLED_BACK']
    finally:
        engine.dispose()
    assert_no_approvals(seeded)


@pytest.mark.parametrize('actor', ['one', 'admin'])
def test_assignment_is_direct_active_and_has_no_request(maps, seeded, actor):
    http, admin, _ = maps
    headers = auth(http, actor)
    value, _, _, _ = scenario(http, admin)
    response = assignment(http, headers, value, seeded['robots']['mine'])
    assert response.status_code == 201, response.text
    row = response.json()
    assert row['status'] == 'ACTIVE' and row['approval_id'] is None
    assert row['created_by'] == str(seeded['users'][actor])
    assert listing(http, headers, status='ACTIVE') == [row]
    assert http.get(P + '/notifications', headers=admin).json()['items'] == []
    assert http.delete(P + '/assignments/' + row['id'], headers=headers).status_code == 204
    assert listing(http, headers)[0]['status'] == 'REMOVED'
    assert_no_approvals(seeded)


@pytest.mark.parametrize('resource', ['missions', 'scenarios'])
@pytest.mark.parametrize('creator,editor', [('admin', 'one'), ('one', 'two'), ('one', 'admin')])
def test_shared_edit_archive_preserves_versions_and_optional_mine(maps, seeded, resource, creator, editor):
    http, admin, _ = maps
    writer, reader = auth(http, creator), auth(http, editor)
    if resource == 'missions':
        body = {'name': '공유 임무', 'steps': [{'action': 'WAIT', 'params': {'seconds': 1}}]}
    else:
        value, _, _, _ = scenario(http, admin)
        body = {key: value[key] for key in ('name', 'waypoints', 'finish', 'notes')}
    created = http.post(P + '/' + resource, headers=writer, json=body)
    assert created.status_code == 201, created.text
    first = created.json()
    path = P + '/' + resource + '/' + first['id']
    assert first['id'] in {v['id'] for v in http.get(P + '/' + resource, headers=reader).json()['items']}
    if resource == 'scenarios':
        assert first['id'] not in {v['id'] for v in http.get(P + '/scenarios?mine=true', headers=reader).json()['items']}
    changed = {**body, 'name': '동료가 바꾼 이름'}
    response = http.put(path, headers={**reader, 'If-Match': '"1"'}, json=changed)
    assert response.status_code == 200, response.text
    second = response.json()
    assert second['number'] == second['version'] == 2
    assert second['created_by'] == first['created_by']
    assert second['version_created_by'] == str(seeded['users'][editor])
    assert http.get(path + '?version=1', headers=reader).json()['name'] == body['name']
    assert http.put(path, headers={**reader, 'If-Match': '"1"'}, json=changed).status_code == 409
    for _ in range(2):
        assert http.delete(path, headers=reader).status_code == 204
    assert http.get(path, headers=writer).json()['archived_at']
    assert http.put(path, headers={**writer, 'If-Match': '"3"'}, json=body).status_code == 409
    assert_no_approvals(seeded)


def test_direct_map_save_with_legacy_pending_keeps_record_until_stale_decision(maps, seeded):
    http, admin, _ = maps
    one = auth(http, 'one')
    _, _, floor = tree(http, admin)
    image = upload(http, one)
    pending, approval = pending_map(http, one, floor, image)
    direct = save(http, one, floor, image)
    assert direct.status_code == 201 and direct.json()['status'] == 'APPROVED'
    assert http.get(P + '/approvals/' + approval['id'], headers=admin).json()['status'] == 'PENDING'
    decision = http.post(P + '/approvals/' + approval['id'] + '/approve', headers=admin)
    assert decision.status_code == 409 and decision.json()['error']['code'] == 'APPROVAL_STALE'
    assert http.get(P + '/approvals/' + approval['id'], headers=one).json()['status'] == 'STALE'
    assert http.get(P + '/map-versions/' + pending['id'], headers=one).json()['status'] == 'PENDING'
    assert len(http.get(P + '/approvals', headers=admin).json()['items']) == 1


@pytest.mark.parametrize('decision', ['approve', 'reject', 'remove'])
def test_legacy_pending_assignment_blocks_duplicate_then_can_be_processed(maps, seeded, decision):
    http, admin, _ = maps
    one = auth(http, 'one')
    value, _, _, _ = scenario(http, admin)
    old = pending_assignment(http, one, value, seeded['robots']['mine'])
    assert assignment(http, one, value, seeded['robots']['mine']).status_code == 409
    if decision == 'remove':
        response = http.delete(P + '/assignments/' + old['id'], headers=one)
        expected, approval_status = 'REMOVED', 'CANCELED'
        assert response.status_code == 204
    else:
        response = http.post(P + '/approvals/' + old['approval_id'] + '/' + decision, headers=admin,
            json={'reason': '옛 요청 반려'} if decision == 'reject' else {})
        assert response.status_code == 200, response.text
        expected, approval_status = ('ACTIVE', 'APPROVED') if decision == 'approve' else ('REJECTED', 'REJECTED')
    assert listing(http, one)[0]['status'] == expected
    assert http.get(P + '/approvals/' + old['approval_id'], headers=admin).json()['status'] == approval_status
    if decision != 'approve':
        direct = assignment(http, one, value, seeded['robots']['mine']).json()
        assert direct['status'] == 'ACTIVE' and direct['approval_id'] is None
    assert len(http.get(P + '/approvals', headers=admin).json()['items']) == 1
