"""Owner-transfer picker: minimum public fields and the existing write boundary."""
import base64
from datetime import timedelta
import json
from uuid import UUID, uuid4

import pytest
from sqlalchemy.orm import Session

from apps.contracts import models as C
from apps.server.fh_server.models import Robot, User, now
from .conftest import login

P = '/api/v1/robots/'


def path(seeded, robot='mine'):
    return P + str(seeded['robots'][robot]) + '/owner-candidates'


def add_operator(db, seeded, name, **fields):
    row = User(org_id=seeded['org'], username='candidate-' + str(uuid4()),
               display_name=name, role='OPERATOR', password_hash='fake-not-for-login', **fields)
    db.add(row)
    db.flush()
    return str(row.id)


def test_owner_gets_only_transferable_operators_and_minimal_fields(client, seeded):
    with Session(client.app.state.engine) as db:
        db.get(User, seeded['users']['two']).display_name = '나 운영자'
        first = add_operator(db, seeded, '가 운영자')
        add_operator(db, seeded, '보관 운영자', archived_at=now())
        # A foreign OPERATOR must be excluded even though its role is eligible.
        db.get(User, seeded['users']['foreign']).role = 'OPERATOR'
        db.commit()
    assert login(client).status_code == 200
    response = client.get(path(seeded))
    assert response.status_code == 200, response.text
    expected = {'items': [
        {'user_id': first, 'display_name': '가 운영자'},
        {'user_id': str(seeded['users']['two']), 'display_name': '나 운영자'},
    ], 'next_cursor': None}
    assert response.json() == expected  # No username, role, email, or other user fields.
    C.RobotOwnerCandidateList.model_validate(response.json())
    assert client.get('/api/v1/users').status_code == 403


def test_name_order_cursor_pages_include_equal_names_once(client, seeded):
    with Session(client.app.state.engine) as db:
        db.get(User, seeded['users']['two']).display_name = '다'
        older = now() - timedelta(days=1)
        same = [add_operator(db, seeded, '가', created_at=older + timedelta(seconds=i))
                for i in range(3)]
        middle = add_operator(db, seeded, '나', created_at=older - timedelta(days=1))
        db.commit()
    assert login(client).status_code == 200
    expected = [*sorted(same, key=UUID), middle, str(seeded['users']['two'])]
    all_rows = client.get(path(seeded)).json()['items']
    assert [row['user_id'] for row in all_rows] == expected
    cursor, collected = None, []
    for _ in expected:
        params = {'limit': 1, **({'cursor': cursor} if cursor else {})}
        response = client.get(path(seeded), params=params)
        assert response.status_code == 200, response.text
        page = response.json()
        assert len(page['items']) == 1
        collected.extend(page['items'])
        cursor = page['next_cursor']
    assert cursor is None
    assert collected == all_rows


@pytest.mark.parametrize('name', ['가' * 128, '😀' * 128])
def test_max_length_unicode_name_cursor_round_trip(client, seeded, name):
    with Session(client.app.state.engine) as db:
        db.get(User, seeded['users']['two']).display_name = '🧭'
        add_operator(db, seeded, name)
        db.commit()
    assert login(client).status_code == 200
    first = client.get(path(seeded), params={'limit': 1}).json()
    assert first['items'][0]['display_name'] == name
    second = client.get(path(seeded), params={'limit': 1, 'cursor': first['next_cursor']})
    assert second.status_code == 200, second.text
    assert second.json() == {'items': [{'user_id': str(seeded['users']['two']), 'display_name': '🧭'}],
                             'next_cursor': None}


@pytest.mark.parametrize('username', ['two', 'admin'])
def test_non_owner_and_admin_denied_for_real_robot(client, seeded, username):
    assert login(client, username).status_code == 200
    response = client.get(path(seeded))
    assert response.status_code == 403
    assert response.json()['error']['code'] == 'FORBIDDEN'


@pytest.mark.parametrize('username', ['one', 'admin'])
def test_unowned_real_robot_has_no_transfer_picker(client, seeded, username):
    with Session(client.app.state.engine) as db:
        db.get(Robot, seeded['robots']['mine']).owner_user_id = None
        db.commit()
    assert login(client, username).status_code == 200
    assert client.get(path(seeded)).status_code == 403


@pytest.mark.parametrize('username,status', [('one', 403), ('two', 403), ('admin', 409)])
def test_simulation_keeps_existing_write_then_managed_error(client, seeded, username, status):
    with Session(client.app.state.engine) as db:
        db.get(Robot, seeded['robots']['mine']).simulation = True
        db.commit()
    assert login(client, username).status_code == 200
    response = client.get(path(seeded))
    assert response.status_code == status
    assert response.json()['error']['code'] == ('SIM_ROBOT_MANAGED' if status == 409 else 'FORBIDDEN')


@pytest.mark.parametrize('kind', ['missing', 'foreign', 'archived'])
def test_missing_or_inaccessible_robot_404(client, seeded, kind):
    target = path(seeded)
    if kind == 'missing':
        target = P + str(uuid4()) + '/owner-candidates'
    elif kind == 'foreign':
        target = path(seeded, 'foreign')
    else:
        with Session(client.app.state.engine) as db:
            db.get(Robot, seeded['robots']['mine']).archived_at = now()
            db.commit()
    assert login(client).status_code == 200
    response = client.get(target)
    assert response.status_code == 404
    assert response.json()['error']['code'] == 'NOT_FOUND'


def test_empty_candidate_list(client, seeded):
    with Session(client.app.state.engine) as db:
        db.get(User, seeded['users']['two']).archived_at = now()
        db.commit()
    assert login(client).status_code == 200
    assert client.get(path(seeded)).json() == {'items': [], 'next_cursor': None}


def test_login_required(client, seeded):
    assert client.get(path(seeded)).status_code == 401


@pytest.mark.parametrize('params', [
    {'limit': 0}, {'limit': 101}, {'cursor': 'bad'}, {'cursor': 'a' * 2049},
    *[{'cursor': base64.urlsafe_b64encode(json.dumps([value, str(uuid4())]).encode()).decode()}
      for value in [None, 1, {}, '', 'a' * 129, '\x00', '\ud800']],
    *[{'cursor': base64.urlsafe_b64encode(json.dumps(['가', value]).encode()).decode()}
      for value in [None, 1, {}, 'bad']],
])
def test_invalid_pagination_is_validation_error(client, seeded, params):
    assert login(client).status_code == 200
    response = client.get(path(seeded), params=params)
    assert response.status_code == 400, response.text
    assert response.json()['error']['code'] == 'VALIDATION'
