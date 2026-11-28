"""Phone-shown QR pairing (u08): offline PostgreSQL only; no real robot or camera."""
from datetime import timedelta
from uuid import UUID, uuid4

from sqlalchemy import select
from sqlalchemy.orm import Session as DBSession

from apps.server.fh_server.models import Pairing, PairingOffer, Robot, now
from apps.server.fh_server.security import digest
from .test_realtime import app_token

P = '/api/v1'
SECRET_KEYS = {'poll_secret', 'agent_token', 'token', 'token_hash', 'poll_hash'}


def offer(client, auth):
    response = client.post(P + '/pairing/offer', headers=auth)
    assert response.status_code == 200, response.text
    assert response.headers['cache-control'] == 'no-store'
    return response.json()


def status(client, auth, offer_id):
    response = client.get(P + f'/pairing/offer/{offer_id}', headers=auth)
    assert response.headers['cache-control'] == 'no-store'
    return response


def robot_claim(client, code, serial='2234-5678'):
    return client.post(P + '/pairing/offer/claim', json={'code': code, 'robot_serial': serial})


def no_secret(value):
    assert not SECRET_KEYS & set(value), value


def test_offer_response_has_no_secret_and_requires_operator(client):
    assert client.post(P + '/pairing/offer').status_code == 401
    assert client.get(P + f'/pairing/offer/{uuid4()}').status_code == 401
    assert client.post(P + '/pairing/offer', headers=app_token(client, 'admin')).status_code == 403
    made = offer(client, app_token(client))
    assert set(made) == {'offer_id', 'code', 'expires_at'}
    no_secret(made)
    with DBSession(client.app.state.engine) as db:
        row = db.get(PairingOffer, UUID(made['offer_id']))
        assert row.code_hash == digest(made['code']) and made['code'].encode() not in repr(vars(row)).encode()


def test_full_flow_key_goes_to_robot_only(client, seeded):
    own = app_token(client)
    made = offer(client, own)
    waiting = status(client, own, made['offer_id']).json()
    assert waiting['state'] == 'WAITING' and waiting['robot_serial'] is None
    no_secret(waiting)

    claimed = robot_claim(client, made['code'])
    assert claimed.status_code == 200, claimed.text
    assert claimed.headers['cache-control'] == 'no-store'
    robot_side = claimed.json()
    assert set(robot_side) == {'pairing_id', 'expires_at', 'poll_secret'}

    read = status(client, own, made['offer_id']).json()
    assert read['state'] == 'READ' and read['robot_serial'] == '2234-5678'
    assert read['pairing_id'] == robot_side['pairing_id']
    no_secret(read)
    assert robot_side['poll_secret'] not in str(read)

    poll = P + f'/pairing/{robot_side["pairing_id"]}/poll'
    assert client.post(poll, json={'poll_secret': robot_side['poll_secret']}).json() == {'state': 'waiting'}
    confirmed = client.post(P + f'/pairing/{robot_side["pairing_id"]}/confirm', headers=own,
                            json={'name': 'QR 기체'})
    assert confirmed.status_code == 200, confirmed.text
    robot = confirmed.json()
    assert robot['owner']['id'] == str(seeded['users']['one'])

    paired = status(client, own, made['offer_id'])
    assert paired.json()['state'] == 'PAIRED' and paired.json()['robot_id'] == robot['id']
    no_secret(paired.json())
    key = client.post(poll, json={'poll_secret': robot_side['poll_secret']}).json()
    assert key['state'] == 'paired'
    for text in (paired.text, confirmed.text, status(client, own, made['offer_id']).text):
        assert key['agent_token'] not in text
    with DBSession(client.app.state.engine) as db:
        assert db.get(Robot, UUID(robot['id'])).agent_token_hash == digest(key['agent_token'])


def test_second_claim_with_same_code_refused(client):
    own = app_token(client)
    made = offer(client, own)
    assert robot_claim(client, made['code']).status_code == 200
    again = robot_claim(client, made['code'], serial='3234-5678')
    assert again.status_code == 404 and again.json()['error']['code'] == 'PAIRING_NOT_FOUND'
    assert status(client, own, made['offer_id']).json()['robot_serial'] == '2234-5678'


def test_expired_code_refused_and_offer_expires(client):
    own = app_token(client)
    made = offer(client, own)
    with DBSession(client.app.state.engine) as db:
        db.get(PairingOffer, UUID(made['offer_id'])).expires_at = now() - timedelta(seconds=1)
        db.commit()
    assert status(client, own, made['offer_id']).json()['state'] == 'EXPIRED'
    assert robot_claim(client, made['code']).status_code == 404
    with DBSession(client.app.state.engine) as db:
        assert db.get(PairingOffer, UUID(made['offer_id'])).state == 'EXPIRED'


def test_read_but_unconfirmed_offer_expires_and_key_stays_closed(client):
    own = app_token(client)
    made = offer(client, own)
    robot_side = robot_claim(client, made['code']).json()
    with DBSession(client.app.state.engine) as db:
        db.get(PairingOffer, UUID(made['offer_id'])).expires_at = now() - timedelta(seconds=1)
        db.get(Pairing, UUID(robot_side['pairing_id'])).expires_at = now() - timedelta(seconds=1)
        db.commit()
    assert status(client, own, made['offer_id']).json()['state'] == 'EXPIRED'
    assert client.post(P + f'/pairing/{robot_side["pairing_id"]}/confirm', headers=own,
                       json={'name': 'late'}).status_code == 404


def test_new_offer_invalidates_old_code_immediately(client):
    own = app_token(client)
    first = offer(client, own)
    second = offer(client, own)
    assert first['code'] != second['code']
    assert status(client, own, first['offer_id']).json()['state'] == 'EXPIRED'
    assert robot_claim(client, first['code']).status_code == 404
    assert robot_claim(client, second['code']).status_code == 200


def test_new_offer_after_read_closes_old_pairing(client):
    own = app_token(client)
    first = offer(client, own)
    robot_side = robot_claim(client, first['code']).json()
    offer(client, own)
    assert status(client, own, first['offer_id']).json()['state'] == 'EXPIRED'
    assert client.post(P + f'/pairing/{robot_side["pairing_id"]}/confirm', headers=own,
                       json={'name': 'old'}).status_code == 404
    assert client.post(P + f'/pairing/{robot_side["pairing_id"]}/poll',
                       json={'poll_secret': robot_side['poll_secret']}).json() == {'state': 'consumed'}


def test_conflicting_robot_marks_offer_failed(client, seeded):
    own, other = app_token(client), app_token(client, 'two')
    with DBSession(client.app.state.engine) as db:
        db.get(Robot, seeded['robots']['theirs']).serial = '4234-5678'
        db.commit()
    made = offer(client, own)
    robot_side = robot_claim(client, made['code'], serial='4234-5678').json()
    failed = client.post(P + f'/pairing/{robot_side["pairing_id"]}/confirm', headers=own, json={'name': 'x'})
    assert failed.status_code == 409
    assert status(client, own, made['offer_id']).json()['state'] == 'FAILED'
    assert robot_claim(client, made['code']).status_code == 404
    # Another operator never sees or confirms this offer.
    assert status(client, other, made['offer_id']).status_code == 404


def test_other_org_offer_and_other_user_status_refused(client, seeded):
    own = app_token(client)
    made = offer(client, own)
    assert status(client, app_token(client, 'two'), made['offer_id']).status_code == 404
    with DBSession(client.app.state.engine) as db:
        foreign_org = db.scalar(select(Robot.org_id).where(Robot.id == seeded['robots']['foreign']))
        code = 'F' * 24
        db.add(PairingOffer(org_id=foreign_org, created_by=seeded['users']['foreign'],
            code_hash=digest(code), expires_at=now() + timedelta(minutes=5), state='WAITING'))
        db.commit()
    assert robot_claim(client, code).status_code == 404


def test_legacy_start_flow_still_works(client):
    from .test_pairing import paired
    robot, credential, _ = paired(client, app_token(client), serial='5234-5678')
    assert credential['state'] == 'paired' and robot['robot_serial'] == '5234-5678'
