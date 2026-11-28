"""PhoneState / LEASE_HELD show who holds the Hub (web sim tab, 11/28): holder_type USER | RUN | null, holder_name.

Phone direct: USER + the name the phone sent (if any). Server relay: the person behind it (name from the
server unlock). Schedule run (RUN:<run_id> lease): RUN, no name. Fake SDK only.
"""
import json

from apps.contracts import models as C
from test_phone import Harness, signed
from test_run_relay import cloud, free_phone, send_run, server_control  # noqa: F401
from test_scenario_run import r, uid  # noqa: F401


def phone_state(h, peer):
    body = h.hub.state(peer)
    C.PhoneState.model_validate({'t': 'state', **body} if 't' not in body else body)
    return body


def test_nobody_holds(r):
    other, _, _ = r.connect(surface='pc', exp=int(r.clock.wall()) + 600)
    free_phone(r)
    s = phone_state(r, other)
    assert (s['holder_type'], s['holder_name']) == (None, None)


def test_phone_direct_holder_with_and_without_name():
    h = Harness()
    payload = h.claims()
    peer = object()
    hello = h.send(peer, 'hello', proto='fh-phone/1', device=payload['device'], ticket=signed(h.key, payload),
                   display_name='김현장')
    assert hello['t'] == 'hello'
    assert h.take(peer)['ok']
    other, _, _ = h.connect()
    s = phone_state(h, other)
    assert (s['holder_type'], s['holder_name']) == ('USER', '김현장')
    held = h.take(other)
    assert held['error']['code'] == 'LEASE_HELD'
    assert (held['holder_type'], held['holder_name']) == ('USER', '김현장')
    C.PhoneReply.model_validate(held)
    h.hub.close(); h.verifier.close()
    h = Harness()
    first, _, _ = h.connect()
    assert h.take(first)['ok']
    second, _, _ = h.connect()
    s = phone_state(h, second)
    assert (s['holder_type'], s['holder_name']) == ('USER', None)
    h.hub.close(); h.verifier.close()


def test_ok_reply_has_no_holder_fields():
    h = Harness()
    peer, _, _ = h.connect()
    reply = h.take(peer)
    assert reply['ok'] and 'holder_type' not in reply and 'holder_name' not in reply
    h.hub.close(); h.verifier.close()


def test_server_relay_shows_the_person_and_their_name(cloud):
    r = cloud
    free_phone(r)
    r.observer.receive({'t': 'lease', 'lease_id': r.lease, 'holder_type': 'USER'})
    r.state(True)
    r.observer.receive({'t': 'unlock', 'lease_id': r.lease, 'stop_gen': r.hub.session._generation(), 'user_id': r.user,
                        'display_name': '박관제'})
    r.state(False)
    s = phone_state(r, r.peer)
    assert (s['holder_type'], s['holder_name'], s['controller']) == ('USER', '박관제', r.user)
    held = r.send(r.peer, 'lease.take')
    assert held['error']['code'] == 'LEASE_HELD' and (held['holder_type'], held['holder_name']) == ('USER', '박관제')
    r.run_id = uid()
    assert send_run(r, 'run.start')['code'] == 'OK'
    # The run machine now holds the Hub: RUN with no name (Codex L5). The starter stays the relay's user.
    s = phone_state(r, r.peer)
    assert (s['holder_type'], s['holder_name']) == ('RUN', None)
    assert r.hub.peers[r.observer.relay].user == r.user and r.hub.peers[r.observer.relay].name == '박관제'


def test_server_relay_without_name_is_null(cloud):
    r = cloud
    free_phone(r)
    server_control(r)
    s = phone_state(r, r.peer)
    assert (s['holder_type'], s['holder_name']) == ('USER', None)


def test_contract_fields():
    assert C.PhoneState.model_fields['holder_type'].annotation is not None
    assert 'holder_name' in C.PhoneReply.model_fields and 'display_name' in C.AgentUnlock.model_fields
    assert 'display_name' in C.PhoneHello.model_fields


def test_schedule_run_lease_is_run_without_name(cloud):
    r = cloud
    free_phone(r)
    run_id = uid()
    r.observer.receive({'t': 'lease', 'lease_id': r.lease, 'holder_type': 'RUN:' + run_id})
    r.state(True)
    r.observer.receive({'t': 'unlock', 'lease_id': r.lease, 'stop_gen': 0, 'user_id': r.user,
                        'display_name': '이름 있어도'})
    r.state(False)
    s = phone_state(r, r.peer)
    assert (s['holder_type'], s['holder_name']) == ('RUN', None)


