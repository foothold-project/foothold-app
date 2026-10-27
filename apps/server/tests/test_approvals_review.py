"""PR32 R1-R7: approval review, text, recipients, previews and DB grants."""
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event as sql_event, text

from apps.server.fh_server.api import Settings, create_app
from .test_maps import maps, auth, save, FEATURES, P
from .test_approvals import setup, request, current


def test_approval_revalidates_deleted_connector_pair_and_preserves_pending(maps):
    http, admin, operator, floor, image = setup(maps)
    first = save(http, admin, floor, image).json()
    building = current(http, admin)['building_id']
    pair = http.post(P + f'/buildings/{building}/floors', headers=admin, json={'name': '짝 층', 'level': 2})
    assert pair.status_code == 201
    pair = pair.json()['id']
    features = {**FEATURES, 'connectors': [{'id': 'pair', 'kind': 'STAIRS', 'pair_floor_id': pair, 'x': 1, 'y': 1, 'yaw': 0}]}
    pending, row = request(http, operator, floor, image, first['id'], features=features)
    assert http.delete(P + f'/floors/{pair}', headers=admin).status_code == 204
    before = current(http, admin)
    events = http.get(P + '/events?category=APPROVAL', headers=admin).json()
    notices = http.get(P + '/notifications', headers=operator).json()
    try:
        response = http.post(P + f'/approvals/{row["id"]}/approve', headers=admin)
    except Exception as exc:
        pytest.fail(f'approval raised {type(exc).__name__} instead of returning INVALID_FEATURES')
    assert response.status_code == 422 and response.json()['error']['code'] == 'INVALID_FEATURES'
    assert response.json()['error']['detail']['element'] == 'features.connectors.0.pair_floor_id'
    assert http.get(P + f'/approvals/{row["id"]}', headers=operator).json()['status'] == 'PENDING'
    assert http.get(P + f'/map-versions/{pending["id"]}', headers=admin).json()['status'] == 'PENDING'
    assert current(http, admin) == before and before['approved_version_id'] == first['id']
    assert http.get(P + '/events?category=APPROVAL', headers=admin).json() == events
    assert http.get(P + '/notifications', headers=operator).json() == notices


def test_promoted_requester_can_only_cancel_and_receives_no_own_decision_notice(maps, seeded):
    http, admin, operator, floor, image = setup(maps)
    _, row = request(http, operator, floor, image)
    response = http.patch(P + f'/users/{seeded["users"]["one"]}', headers=admin, json={'role': 'ORG_ADMIN'})
    assert response.status_code == 200
    path = P + f'/approvals/{row["id"]}'
    for action, body in [('approve', {}), ('reject', {'reason': '본인 반려'})]:
        response = http.post(path + '/' + action, headers=operator, json=body)
        assert response.status_code == 403 and response.json()['error']['code'] == 'FORBIDDEN'
        assert http.get(path, headers=admin).json()['status'] == 'PENDING'
        assert current(http, admin)['approved_version_id'] is None
    assert http.post(path + '/cancel', headers=operator).status_code == 200
    assert http.get(P + '/notifications', headers=operator).json()['items'] == []


def test_decision_kind_and_canonical_notification_preference(maps):
    http, admin, operator, floor, image = setup(maps)
    assert http.patch(P + '/me', headers=operator, json={'notify_prefs': {'APPROVAL_DECIDED': False}}).status_code == 200
    _, row = request(http, operator, floor, image)
    assert http.post(P + f'/approvals/{row["id"]}/approve', headers=admin).status_code == 200
    assert http.get(P + '/notifications', headers=operator).json()['items'] == []
    assert http.patch(P + '/me', headers=operator, json={'notify_prefs': {'APPROVAL_DECIDED': True}}).status_code == 200
    base = current(http, admin)['approved_version_id']
    _, row = request(http, operator, floor, image, base)
    assert http.post(P + f'/approvals/{row["id"]}/reject', headers=admin, json={'reason': '다시 확인'}).status_code == 200
    notices = http.get(P + '/notifications', headers=operator).json()['items']
    assert len(notices) == 1 and notices[0]['kind'] == 'APPROVAL_DECIDED'


@pytest.mark.parametrize('value', ['벨\x07문자', '행\n나눔', '뒤\u202e집기', '숨김\u200b문자'])
def test_reason_and_comment_reject_control_and_format_characters(maps, value):
    http, admin, operator, floor, image = setup(maps)
    first = save(http, admin, floor, image).json()
    second = save(http, admin, floor, image, base=first['id']).json()
    _, row = request(http, operator, floor, image, second['id'])
    path = P + f'/approvals/{row["id"]}'
    bodies = [
        (f'/floors/{floor}/map-versions', operator, {'base_version_id': second['id'], 'image': image,
            'features': FEATURES, 'reason': value}),
        (f'/map-versions/{first["id"]}/rollback', operator, {'base_version_id': second['id'], 'reason': value}),
        (f'/approvals/{row["id"]}/approve', admin, {'comment': value}),
        (f'/approvals/{row["id"]}/reject', admin, {'reason': value}),
    ]
    for route, headers, body in bodies:
        response = http.post(P + route, headers=headers, json=body)
        assert response.status_code == 400 and response.json()['error']['code'] == 'VALIDATION', route
        assert http.get(path, headers=admin).json()['status'] == 'PENDING'
        assert current(http, admin)['approved_version_id'] == second['id']
    assert http.post(path + '/approve', headers=admin, json={'comment': '현장 확인 완료'}).status_code == 200


def test_list_batches_users_once_and_detail_preview_for_both_map_kinds(maps):
    http, admin, operator, floor, image = setup(maps)
    first = save(http, admin, floor, image).json()
    second = save(http, admin, floor, image, base=first['id']).json()
    for _ in range(5):
        request(http, operator, floor, image, second['id'])
    _, row = request(http, operator, floor, image, second['id'], copied_from=first['id'])
    assert http.post(P + f'/approvals/{row["id"]}/approve', headers=admin).status_code == 200
    statements = []
    def queried(conn, cursor, statement, *args):
        if statement.startswith('SELECT ') and 'FROM users' in statement:
            statements.append(statement)
    sql_event.listen(http.app.state.engine, 'before_cursor_execute', queried)
    try:
        response = http.get(P + '/approvals', headers=admin)
    finally:
        sql_event.remove(http.app.state.engine, 'before_cursor_execute', queried)
    assert response.status_code == 200 and len(response.json()['items']) == 6
    assert sum(row['decider'] is not None for row in response.json()['items']) == 1
    # Authentication reads the actor once; serialization must use one IN query.
    assert len(statements) == 2 and sum(' IN (' in sql for sql in statements) == 1
    expected = dict(floor_id=floor, floor_name='1층', base_version_number=second['number'])
    for row in response.json()['items']:
        detail = http.get(P + f'/approvals/{row["id"]}', headers=admin)
        assert detail.status_code == 200
        target = http.get(P + f'/map-versions/{row["target"]["id"]}', headers=admin).json()
        assert detail.json()['preview'] == {**expected, 'target_version_number': target['number']}
    assert {row['kind'] for row in response.json()['items']} == {'MAP_REVISION', 'MAP_ROLLBACK'}


@pytest.mark.parametrize('privilege', ['DELETE', 'TRUNCATE', 'UPDATE', 'UPDATE (reason)'])
def test_startup_rejects_unsafe_approval_privilege(seeded, privilege):
    engine = create_engine(seeded['urls']['migrate'])
    try:
        with engine.begin() as conn:
            conn.execute(text(f'GRANT {privilege} ON approvals TO fh_app'))
        app = create_app(Settings(seeded['urls']['app'], seeded['org']))
        try:
            with pytest.raises(RuntimeError, match='restricted fh_app'):
                with TestClient(app):
                    pass
        finally:
            app.state.engine.dispose()
    finally:
        with engine.begin() as conn:
            conn.execute(text(f'REVOKE {privilege} ON approvals FROM fh_app'))
            conn.execute(text('GRANT UPDATE (status, decider_id, decided_at, decision_comment) ON approvals TO fh_app'))
        engine.dispose()
