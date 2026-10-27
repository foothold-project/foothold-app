"""S4a tenant boundaries, durable terminal decisions and approval race."""
from concurrent.futures import ThreadPoolExecutor
from threading import Event as ThreadEvent, Lock
from uuid import UUID, uuid4

import pytest
from sqlalchemy import create_engine, select, text, event as sql_event
from sqlalchemy.exc import DBAPIError
from sqlalchemy.orm import Session

from apps.server.fh_server import api
from apps.server.fh_server.models import Approval, Event, Floor, MapVersion, Notification, User
from .test_maps import maps, auth, tree, upload, save, FEATURES, P


# Legacy records are seeded directly; current map APIs never create requests.
from .legacy_approvals import pending_map as request


def setup(maps):
    http, admin, _ = maps
    _, _, floor = tree(http, admin)
    image = upload(http, admin)
    operator = auth(http, 'one')
    return http, admin, operator, floor, image


def current(http, headers):
    return http.get(P + '/sites', headers=headers).json()['items'][0]['buildings'][0]['floors'][0]


def test_operator_request_approve_pointer_counts_preview_events_notifications(maps, seeded):
    http, admin, operator, floor, image = setup(maps)
    first = save(http, admin, floor, image).json()
    # A second active administrator gets requests; locked/foreign users do not.
    second = http.post(P + '/users', headers=admin, json={'username': 'second-admin', 'display_name': '둘째 총괄',
        'role': 'ORG_ADMIN', 'temp_password': 'fake-test-password'})
    assert second.status_code == 201
    version, row = request(http, operator, floor, image, first['id'])
    assert row['kind'] == 'MAP_REVISION' and row['reason'] == version['reason']
    assert row['requester'] == {'id': str(seeded['users']['one']), 'display_name': 'one'}
    assert row['decider'] is None and row['decision_comment'] is None and row['decided_at'] is None
    assert row['target'] == {'type': 'map_version', 'id': version['id']}
    assert row['base_ref'] == {'type': 'map_version', 'id': first['id']}
    assert row['emergency'] is False and row['created_at'].endswith('Z')
    assert http.get(P + f'/approvals/{row["id"]}', headers=admin).json() == {**row, 'preview': {
        'floor_id': floor, 'floor_name': '1층', 'target_version_number': version['number'],
        'base_version_number': first['number']}}
    assert http.get(P + f'/map-versions/{version["id"]}/diff', headers=admin).status_code == 200
    assert current(http, admin)['approved_version_id'] == first['id']
    assert current(http, operator)['pending_count'] == 1
    for headers in (admin, operator):
        assert http.get(P + '/dashboard', headers=headers).json()['approvals_pending'] == 1
    assert http.get(P + '/dashboard', headers=auth(http, 'two')).json()['approvals_pending'] == 0
    requested = http.get(P + '/notifications', headers=admin).json()['items']
    assert len(requested) == 1 and requested[0]['kind'] == 'APPROVAL_REQUESTED'
    assert row['id'] in requested[0]['link'] and '지도 수정' in requested[0]['body']
    decided = http.post(P + f'/approvals/{row["id"]}/approve', headers=admin, json={'comment': '확인했습니다'})
    assert decided.status_code == 200, decided.text
    value = decided.json()
    assert value['status'] == 'APPROVED' and value['decision_comment'] == '확인했습니다'
    assert value['decider']['id'] == str(seeded['users']['admin']) and value['decided_at'].endswith('Z')
    assert current(http, admin)['approved_version_id'] == version['id'] and current(http, admin)['pending_count'] == 0
    assert http.get(P + '/dashboard', headers=admin).json()['approvals_pending'] == 0
    assert http.get(P + f'/map-versions/{version["id"]}', headers=admin).json()['status'] == 'APPROVED'
    notice = http.get(P + '/notifications', headers=operator).json()['items']
    assert len(notice) == 1 and notice[0]['kind'] == 'APPROVAL_DECIDED' and row['id'] in notice[0]['link']
    assert 'admin' in notice[0]['body'] and 'one' in notice[0]['body'] and '승인' in notice[0]['body']
    engine = create_engine(seeded['urls']['app'])
    try:
        with Session(engine) as db:
            events = list(db.scalars(select(Event).where(Event.approval_id == UUID(row['id'])).order_by(Event.id)))
            assert [ev.code for ev in events] == ['APPROVAL_REQUESTED', 'APPROVAL_DECIDED']
            assert all(ev.category == 'APPROVAL' and ev.data['map_version_id'] == version['id'] for ev in events)
            assert set(db.scalars(select(Notification.user_id).where(Notification.event_id == events[0].id))) == {
                seeded['users']['admin'], UUID(second.json()['id'])}
    finally:
        engine.dispose()


def test_null_base_initial_request_and_stale_commit_other_pending_unchanged(maps, seeded):
    http, admin, operator, floor, image = setup(maps)
    one, first = request(http, operator, floor, image)
    two, second = request(http, operator, floor, image)
    assert first['base_ref'] is None and current(http, admin)['approved_version_id'] is None
    assert http.post(P + f'/approvals/{first["id"]}/approve', headers=admin).status_code == 200
    assert http.get(P + f'/approvals/{second["id"]}', headers=admin).json()['status'] == 'PENDING'
    stale = http.post(P + f'/approvals/{second["id"]}/approve', headers=admin)
    assert stale.status_code == 409 and stale.json()['error']['code'] == 'APPROVAL_STALE'
    assert stale.json()['error']['detail']['approved_version_id'] == one['id']
    assert current(http, admin)['approved_version_id'] == one['id'] and current(http, admin)['pending_count'] == 0
    assert http.get(P + '/dashboard', headers=admin).json()['approvals_pending'] == 0
    decided = http.get(P + f'/approvals/{second["id"]}', headers=operator).json()
    assert decided['status'] == 'STALE' and decided['decider']['id'] == str(seeded['users']['admin'])
    assert http.get(P + f'/map-versions/{two["id"]}', headers=admin).json()['status'] == 'PENDING'
    assert http.post(P + f'/approvals/{second["id"]}/cancel', headers=operator).status_code == 409
    notices = http.get(P + '/notifications', headers=operator).json()['items']
    assert len(notices) == 2 and '지도가 바뀌어' in notices[0]['body']
    events = http.get(P + '/events?category=APPROVAL', headers=admin).json()['items']
    assert any(ev['code'] == 'APPROVAL_STALE' and ev['data']['approval_id'] == second['id'] for ev in events)


@pytest.mark.parametrize('decision', ['approve', 'reject', 'cancel'])
def test_reject_reason_cancel_requester_only_and_terminal_409(maps, decision):
    http, admin, operator, floor, image = setup(maps)
    version, row = request(http, operator, floor, image)
    path = P + f'/approvals/{row["id"]}'
    assert http.post(path + '/cancel', headers=admin).status_code == 403
    for reason in ({}, {'reason': ''}, {'reason': '   '}, {'reason': None}):
        assert http.post(path + '/reject', headers=admin, json=reason).status_code == 400
    assert http.get(path, headers=admin).json()['status'] == 'PENDING'
    headers = operator if decision == 'cancel' else admin
    body = {'reason': '경계를 다시 확인해 주세요'} if decision == 'reject' else {}
    response = http.post(path + '/' + decision, headers=headers, json=body)
    expected = {'approve': 'APPROVED', 'reject': 'REJECTED', 'cancel': 'CANCELED'}[decision]
    assert response.status_code == 200 and response.json()['status'] == expected
    assert http.get(P + f'/map-versions/{version["id"]}', headers=admin).json()['status'] == expected
    assert current(http, admin)['pending_count'] == 0
    for action, who, payload in [('approve', admin, {}), ('reject', admin, {'reason': '다시'}), ('cancel', operator, {})]:
        repeat = http.post(path + '/' + action, headers=who, json=payload)
        assert repeat.status_code == 409 and repeat.json()['error']['code'] == 'ALREADY_DECIDED'
    if decision == 'reject':
        assert http.get(path, headers=operator).json()['decision_comment'] == body['reason']
    notices = http.get(P + '/notifications', headers=operator).json()['items']
    if decision == 'cancel':
        assert notices == []  # acting requester does not receive their own result
    else:
        assert len(notices) == 1 and row['id'] in notices[0]['link']
    assert http.get(P + '/notifications', headers=admin).json()['unread_count'] == 1
    events = http.get(P + '/events?category=APPROVAL', headers=admin).json()['items']
    assert len(events) == 2 and events[0]['code'] == ('APPROVAL_CANCELED' if decision == 'cancel' else 'APPROVAL_DECIDED')


def test_visibility_404_tenant_pagination_filters_and_admin_only_decisions(maps, seeded):
    http, admin, operator, floor, image = setup(maps)
    other = auth(http, 'two')
    _, one = request(http, operator, floor, image)
    _, two = request(http, other, floor, image)
    for headers, expected in ((operator, [one['id']]), (other, [two['id']])):
        assert [r['id'] for r in http.get(P + '/approvals', headers=headers).json()['items']] == expected
    page = http.get(P + '/approvals?limit=1', headers=admin).json()
    assert page['items'][0]['id'] == one['id'] and page['next_cursor']
    assert http.get(P + '/approvals', params={'cursor': page['next_cursor']}, headers=admin).json()['items'][0]['id'] == two['id']
    assert http.get(P + '/approvals?cursor=bad', headers=admin).status_code == 400
    assert http.get(P + '/approvals?status=OPEN', headers=admin).status_code == 400
    for action, payload in [('approve', {}), ('reject', {'reason': '반려'}), ('cancel', {})]:
        real = http.post(P + f'/approvals/{two["id"]}/{action}', headers=operator, json=payload)
        missing = http.post(P + f'/approvals/{uuid4()}/{action}', headers=operator, json=payload)
        assert real.status_code == missing.status_code == 404 and real.json() == missing.json()
    for action in ('approve', 'reject'):
        assert http.post(P + f'/approvals/{one["id"]}/{action}', headers=operator,
            json={'reason': '안 됨'} if action == 'reject' else {}).status_code == 403
    assert http.get(P + f'/approvals/{two["id"]}', headers=operator).status_code == 404
    assert http.get(P + '/approvals').status_code == 401
    engine = create_engine(seeded['urls']['migrate'])
    try:
        # Use a second app configured for the other organization: same endpoint,
        # valid foreign admin, our approval ID must be indistinguishable from absent.
        from fastapi.testclient import TestClient
        from apps.server.fh_server.api import Settings, create_app
        with Session(engine) as db:
            foreign_org = db.get(User, seeded['users']['foreign']).org_id
        app = create_app(Settings(seeded['urls']['app'], foreign_org))
        with TestClient(app) as foreign:
            foreign_headers = auth(foreign, 'foreign')
            assert foreign.get(P + '/approvals', headers=foreign_headers).json()['items'] == []
            for suffix in ('', '/approve', '/reject', '/cancel'):
                method = foreign.get if not suffix else foreign.post
                kw = {'json': {'reason': 'foreign'}} if suffix == '/reject' else {}
                a = method(P + f'/approvals/{one["id"]}' + suffix, headers=foreign_headers, **kw)
                b = method(P + f'/approvals/{uuid4()}' + suffix, headers=foreign_headers, **kw)
                assert a.status_code == b.status_code == 404 and a.json() == b.json()
        app.state.engine.dispose()
    finally:
        engine.dispose()
    http.post(P + f'/approvals/{one["id"]}/cancel', headers=operator)
    assert [r['id'] for r in http.get(P + '/approvals?status=PENDING', headers=admin).json()['items']] == [two['id']]
    assert [r['id'] for r in http.get(P + '/approvals?status=CANCELED', headers=operator).json()['items']] == [one['id']]


@pytest.mark.parametrize('same_request', [False, True])
def test_two_approvals_concurrently_only_one_even_without_org_lock(maps, seeded, monkeypatch, same_request):
    http, admin, operator, floor, image = setup(maps)
    one, first = request(http, operator, floor, image)
    two, second = request(http, operator, floor, image)
    other_session = auth(http, 'admin')
    monkeypatch.setattr(api, 'lock_organization', lambda *args: None)
    # Both requests reach the DB lock while a separate transaction holds it.
    # Omitting either required row lock must fail this assertion-driven probe.
    reached, mutex = ThreadEvent(), Lock()
    count = 0
    target = 'approvals' if same_request else 'floors'
    def queried(conn, cursor, statement, *args):
        nonlocal count
        if statement.startswith('SELECT ' + target) and 'FOR UPDATE' in statement:
            with mutex:
                count += 1
                if count == 2:
                    reached.set()
    engine = create_engine(seeded['urls']['migrate'])
    sql_event.listen(http.app.state.engine, 'before_cursor_execute', queried)
    try:
        with Session(engine) as blocker, ThreadPoolExecutor(max_workers=2) as pool:
            model, identifier = (Approval, first['id']) if same_request else (Floor, floor)
            blocker.scalar(select(model).where(model.id == identifier).with_for_update())
            rows = [first, first if same_request else second]
            futures = [pool.submit(http.post, P + f'/approvals/{row["id"]}/approve', headers=headers)
                for row, headers in zip(rows, [admin, other_session])]
            try:
                assert reached.wait(3), 'both decisions must acquire their required row lock'
            finally:
                blocker.commit()
            try:
                responses = [future.result(timeout=5) for future in futures]
            except Exception as exc:
                pytest.fail(f'approval race raised {type(exc).__name__} instead of 200/409')
        assert sorted(r.status_code for r in responses) == [200, 409]
        conflict = next(r for r in responses if r.status_code == 409)
        assert conflict.json()['error']['code'] == ('ALREADY_DECIDED' if same_request else 'APPROVAL_STALE')
        winner = next(r.json()['target']['id'] for r in responses if r.status_code == 200)
        assert current(http, admin)['approved_version_id'] == winner
        assert sorted(r['status'] for r in http.get(P + '/approvals', headers=admin).json()['items']) == (
            ['APPROVED', 'PENDING'] if same_request else ['APPROVED', 'STALE'])
    finally:
        sql_event.remove(http.app.state.engine, 'before_cursor_execute', queried)
        engine.dispose()


def test_rollback_request_approval_and_pending_rejected_canceled_cannot_rollback(maps):
    http, admin, operator, floor, image = setup(maps)
    first = save(http, admin, floor, image).json()
    second = save(http, admin, floor, image, base=first['id'], features={**FEATURES, 'waypoints': [
        {'id': 'new', 'name': '새 지점', 'x': 1, 'y': 1, 'yaw': 0}]}).json()
    assert http.get(P + f'/map-versions/{first["id"]}', headers=operator).json()['status'] == 'SUPERSEDED'
    version, row = request(http, operator, floor, image, second['id'], copied_from=first['id'])
    assert version['status'] == 'PENDING'
    assert current(http, admin)['approved_version_id'] == second['id']
    assert row['kind'] == 'MAP_ROLLBACK' and row['target']['id'] == version['id']
    assert version['copied_from_id'] == first['id'] and row['base_ref']['id'] == second['id']
    assert http.post(P + f'/approvals/{row["id"]}/approve', headers=admin).status_code == 200
    assert current(http, admin)['approved_version_id'] == version['id']
    assert http.get(P + f'/map-versions/{version["id"]}', headers=admin).json()['features'] == first['features']
    # Earlier approved snapshot stays eligible for direct admin rollback as well.
    direct = http.post(P + f'/map-versions/{second["id"]}/rollback', headers=admin,
        json={'base_version_id': version['id'], 'reason': '다시 이전 판'})
    assert direct.status_code == 201 and direct.json()['status'] == 'APPROVED'
    base = direct.json()['id']
    for state in ('PENDING', 'REJECTED', 'CANCELED'):
        pending, row = request(http, operator, floor, image, base)
        if state != 'PENDING':
            action = 'reject' if state == 'REJECTED' else 'cancel'
            response = http.post(P + f'/approvals/{row["id"]}/{action}',
                headers=admin if action == 'reject' else operator,
                json={'reason': '반려 시험'} if action == 'reject' else {})
            assert response.status_code == 200
        for who in (admin, operator):
            response = http.post(P + f'/map-versions/{pending["id"]}/rollback', headers=who,
                json={'base_version_id': base, 'reason': '금지된 대상'})
            assert response.status_code == 409 and response.json()['error']['code'] == 'ROLLBACK_NOT_APPROVED'


def test_map_status_only_update_grant_and_approval_fk(maps, seeded):
    http, admin, operator, floor, image = setup(maps)
    version, row = request(http, operator, floor, image)
    engine = create_engine(seeded['urls']['app'])
    try:
        with engine.connect() as conn:
            assert conn.scalar(text("SELECT has_column_privilege(current_user, 'map_versions', 'status', 'UPDATE')"))
            assert not conn.scalar(text("SELECT has_table_privilege(current_user, 'map_versions', 'UPDATE')"))
        with engine.begin() as conn:
            conn.execute(text('UPDATE map_versions SET status=status WHERE id=:id'), {'id': version['id']})
        for statement in ('UPDATE map_versions SET features=features', 'UPDATE map_versions SET reason=reason',
                          'DELETE FROM approvals', 'DELETE FROM events'):
            with engine.begin() as conn, pytest.raises(DBAPIError):
                conn.execute(text(statement))
        for statement in ("UPDATE approvals SET status='REJECTED', decider_id=requester_id, decided_at=now()",
                          "UPDATE approvals SET target_id=gen_random_uuid()",
                          "INSERT INTO events(org_id,category,code,severity,message,approval_id,data) "
                          "SELECT org_id,'APPROVAL','FAKE','INFO','fake',gen_random_uuid(),'{}' FROM approvals"):
            with engine.begin() as conn, pytest.raises(DBAPIError):
                conn.execute(text(statement))
    finally:
        engine.dispose()


def test_direct_admin_change_makes_request_stale(maps):
    http, admin, operator, floor, image = setup(maps)
    first = save(http, admin, floor, image).json()
    _, row = request(http, operator, floor, image, first['id'])
    changed = save(http, admin, floor, image, base=first['id']).json()
    response = http.post(P + f'/approvals/{row["id"]}/approve', headers=admin)
    assert response.status_code == 409 and response.json()['error']['code'] == 'APPROVAL_STALE'
    assert current(http, admin)['approved_version_id'] == changed['id']
    assert http.get(P + f'/approvals/{row["id"]}', headers=operator).json()['status'] == 'STALE'


@pytest.mark.parametrize('phase,code', [('request', 'APPROVAL_REQUESTED'), ('approve', 'APPROVAL_DECIDED'),
    ('reject', 'APPROVAL_DECIDED'), ('cancel', 'APPROVAL_CANCELED'), ('stale', 'APPROVAL_STALE')])
def test_missing_template_fails_and_rolls_back_every_effect(maps, seeded, monkeypatch, phase, code):
    from apps.server.fh_server.event_messages import TEMPLATES
    http, admin, operator, floor, image = setup(maps)
    if phase != 'request':
        version, row = request(http, operator, floor, image)
    if phase == 'stale':
        save(http, admin, floor, image)
    before = current(http, admin)
    def snapshot():
        engine = create_engine(seeded['urls']['app'])
        try:
            with Session(engine) as db:
                return {model.__tablename__: db.execute(select(model.__table__).order_by(model.id)).all()
                    for model in (Approval, MapVersion, Event, Notification)}
        finally:
            engine.dispose()
    state = snapshot()
    images = sorted(str(p) for p in maps[2].rglob('*') if p.is_file())
    monkeypatch.delitem(TEMPLATES, code)
    with pytest.raises(KeyError):
        if phase == 'request':
            request(http, operator, floor, image)
        else:
            http.post(P + f'/approvals/{row["id"]}/' + ('approve' if phase == 'stale' else phase),
                headers=operator if phase == 'cancel' else admin,
                json={'reason': '템플릿 시험'} if phase == 'reject' else {})
    assert snapshot() == state
    assert current(http, admin) == before
    assert sorted(str(p) for p in maps[2].rglob('*') if p.is_file()) == images


def test_startup_rejects_content_column_update_grant(seeded):
    from fastapi.testclient import TestClient
    from apps.server.fh_server.api import Settings, create_app
    engine = create_engine(seeded['urls']['migrate'])
    try:
        with engine.begin() as conn:
            conn.execute(text('GRANT UPDATE (features) ON map_versions TO fh_app'))
        app = create_app(Settings(seeded['urls']['app'], seeded['org']))
        try:
            with pytest.raises(RuntimeError, match='restricted fh_app'):
                with TestClient(app):
                    pass
        finally:
            app.state.engine.dispose()
    finally:
        with engine.begin() as conn:
            conn.execute(text('REVOKE UPDATE (features) ON map_versions FROM fh_app'))
        engine.dispose()
