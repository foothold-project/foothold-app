"""Automatic marker boundaries with fake time and sockets; no server/robot I/O."""
import asyncio
from datetime import timedelta
from types import SimpleNamespace
from uuid import uuid4

import pytest

from apps.server.fh_server.api import APIError
from apps.server.fh_server.leases import Arbiter, Actor, Holder
from apps.server.fh_server.models import now
from apps.server.fh_server.realtime import Peer, Realtime
from apps.server.fh_server.security import digest


@pytest.fixture
def relay():
    rid, owner = str(uuid4()), uuid4()
    sent = []

    async def send_json(body):
        sent.append(body)

    rt = Realtime.__new__(Realtime)
    rt.clock = lambda: 100.
    rt.field_clock = now
    rt.settings = SimpleNamespace(drive_enabled=lambda rid: True)
    rt.robot_changes = set()
    rt.field_approvals = {rid: owner}
    rt.field_changed_at = {}
    rt.api_error = APIError
    peer = Peer(SimpleNamespace(send_json=send_json, headers={'authorization': 'Bearer fake-only'}),
                auth_checked=100., last_rx=100., server_drive=True)
    rt.agents = {rid: peer}
    rt.arbiter = Arbiter(rt.clock)
    rt.apply = lambda effects: None
    rt.put = lambda peer, body: None
    return rt, rid, owner, peer, sent


@pytest.mark.parametrize('reason', ['owner', 'auth', 'link', 'closing', 'change', 'switch', 'old_peer'])
def test_automatic_gate_checks_every_final_send(relay, reason):
    rt, rid, owner, peer, sent = relay
    assert rt.field_approved(rid)
    if reason == 'owner': rt.field_approvals[rid] = None
    elif reason == 'auth': peer.auth_checked -= .501
    elif reason == 'link': peer.last_rx -= 3
    elif reason == 'closing': peer.closing = True
    elif reason == 'change': rt.robot_changes.add(rid)
    elif reason == 'switch': rt.settings.drive_enabled = lambda rid: False
    else: rt.agents[rid] = Peer(None)
    assert not rt.field_approved(rid)

    async def verify():
        assert not await rt.send_body(peer, {'t': 'cmd', 'axes': [0, 0, 0]})
        assert not await rt.send_body(peer, {'t': 'unlock'})
        assert not await rt.send_body(peer, {'t': 'lease', 'lease_id': 'old', 'holder_type': 'USER'})
        await rt.send_body(peer, {'t': 'field_approval', 'expires_at': 'queued-positive'})
        assert sent[-1] == {'t': 'field_approval', 'expires_at': None}
        assert await rt.send_body(peer, {'t': 'stop'})
        assert await rt.send_body(peer, {'t': 'lease', 'lease_id': None, 'holder_type': None})

    asyncio.run(verify())


@pytest.mark.parametrize('missing', ['owner', 'serial', 'simulation', 'token'])
def test_auto_eligibility_requires_paired_owned_authenticated_real_robot(relay, missing):
    rt, rid, owner, peer, sent = relay
    robot = SimpleNamespace(owner_user_id=owner, serial='1234-5678', simulation=False,
                            agent_token_hash=digest('fake-only'))
    if missing == 'owner': robot.owner_user_id = None
    elif missing == 'serial': robot.serial = None
    elif missing == 'simulation': robot.simulation = True
    else: robot.agent_token_hash = digest('different-fake')
    batch = rt.verify_agents([(rid, peer)], {rid: robot})
    if missing == 'token':
        assert isinstance(batch[rid][0], APIError)
    else:
        assert batch.field_approvals[rid] == (None, peer)


def test_owner_change_revokes_lease_and_stale_snapshot_cannot_restore_it(relay):
    rt, rid, owner, peer, sent = relay
    actor = Actor(str(owner), str(uuid4()), str(uuid4()))
    rt.arbiter.robot(rid).holder = Holder(actor, 'old-lease', 0, 0)
    rt.set_field_approval(rid, uuid4())
    assert rt.arbiter.robot(rid).holder is None
    rt.set_field_approval(rid, None)
    rt.set_field_approval(rid, owner, observed=99.)
    assert not rt.field_approved(rid)


def test_bounded_wire_marker_renews_without_db_expiry(relay):
    from datetime import datetime
    rt, rid, owner, peer, sent = relay
    start = now()

    async def verify():
        for minute in (0, 31, 61, 24 * 60):
            stamp = start + timedelta(minutes=minute)
            rt.field_clock = lambda: stamp
            assert await rt.send_body(peer, {'t': 'field_approval', 'expires_at': None})
            expiry = datetime.fromisoformat(sent[-1]['expires_at'].replace('Z', '+00:00'))
            assert timedelta(0) < expiry - stamp <= timedelta(seconds=1800)
            assert rt.field_approved(rid)

    asyncio.run(verify())
