"""Safety state-machine tests use specification literals, never implementation constants."""
import itertools

import pytest

from apps.server.fh_server.leases import Actor, Arbiter, LeaseError


class Clock:
    def __init__(self):
        self.at = 0.0
        self.wall = 1_000_000

    def __call__(self):
        return self.at

    def step(self, seconds):
        self.at += seconds


@pytest.fixture
def rig():
    clock = Clock()
    ids = itertools.count()
    arbiter = Arbiter(clock, lambda: str(next(ids)))
    return clock, arbiter, Actor('a', 'sa', 'ca'), Actor('b', 'sb', 'cb')


def held(rig):
    c, a, owner, other = rig
    a.take('r', owner)
    a.state('r', True, [0, 0, 0], 1)
    assert a.robot('r').holder.actor == owner
    return rig


def test_take_and_transfer_require_fresh_stop_ack_order(rig):
    c, a, owner, other = held(rig)
    a.request('r', other)
    req = a.robot('r').request
    effects = a.respond('r', owner, req.id, True)
    agent = [e.body for e in effects if e.target == 'agent']
    assert agent == [{'t': 'lease', 'lease_id': None, 'holder_type': None},
                     {'t': 'stop', 'by_user_id': other.user}]
    assert a.robot('r').holder is None
    for state in [(False, [0, 0, 0], 2), (True, [0.1, 0, 0], 2), (True, [0, 0, 0], 1)]:
        assert a.state('r', *state) == []
        assert a.robot('r').holder is None
    effects = a.state('r', True, [0, 0, 0], 2)
    assert a.robot('r').holder.actor == other
    assert any(e.body.get('result') == 'ACCEPTED' for e in effects)
    assert any(e.target == 'agent' and e.body.get('lease_id') is not None for e in effects)


@pytest.mark.parametrize('late', [False, True])
def test_transfer_timeout_free_and_late_ack_cannot_grant(rig, late):
    c, a, owner, other = held(rig)
    a.request('r', other)
    a.respond('r', owner, a.robot('r').request.id, True)
    c.step(2)
    if late:
        assert a.state('r', True, [0, 0, 0], 2) == []
    effects = a.tick()
    assert a.robot('r').holder is None
    assert a.robot('r').transfer is None
    assert any(e.body.get('error') == 'STOP_CONFIRM_FAILED' for e in effects)
    assert a.state('r', True, [0, 0, 0], 3) == []


def test_timeout_at_ten_seconds_and_thirty_second_cooldown(rig):
    c, a, owner, other = held(rig)
    a.request('r', other)
    c.step(9.999)
    c.wall -= 86_400  # NTP wall-clock correction cannot move a safety deadline.
    assert a.tick() == []
    c.step(.001)
    effects = a.tick()
    assert any(e.body.get('result') == 'TIMEOUT' for e in effects)
    assert a.robot('r').holder.actor == owner
    a.robot('r').holder.heartbeat = c.at  # keep the existing holder alive
    c.step(29.999)
    c.wall += 172_800
    with pytest.raises(LeaseError) as error:
        a.request('r', other)
    assert (error.value.status, error.value.code) == (429, 'LEASE_REQUEST_COOLDOWN')
    c.at = 40
    a.request('r', other)
    assert a.robot('r').request is not None


def test_decline_cooldown_starts_when_decided(rig):
    c, a, owner, other = held(rig)
    a.request('r', other)
    c.step(3)
    effects = a.respond('r', owner, a.robot('r').request.id, False)
    assert any(e.body.get('result') == 'DECLINED' for e in effects)
    c.step(29.999)
    with pytest.raises(LeaseError, match='30초'):
        a.request('r', other)
    c.at = 33
    a.request('r', other)


def test_heartbeat_expires_at_fifteen_only_valid_cmd_refreshes(rig):
    c, a, owner, other = held(rig)
    lease = a.robot('r').holder.lease_id
    c.step(14.999)
    a.cmd('r', owner, lease, 0, [0, 0, 0])
    c.step(14.999)
    assert a.tick() == []
    with pytest.raises(LeaseError):
        a.cmd('r', other, lease, 1, [1, 0, 0])
    c.wall -= 1_000_000
    c.step(.001)
    effects = a.tick()
    assert a.robot('r').holder is None
    assert [e.body['t'] for e in effects[:2]] == ['lease', 'stop']
    assert any(e.body.get('op') == 'EXPIRE' for e in effects)


@pytest.mark.parametrize('op', ['release', 'hidden'])
def test_release_hidden_immediate_null_before_stop(rig, op):
    c, a, owner, _ = held(rig)
    effects = getattr(a, op)('r', owner)
    assert a.robot('r').holder is None
    assert effects[0].body == {'t': 'lease', 'lease_id': None, 'holder_type': None}
    assert effects[1].body['t'] == 'stop'


def test_connection_and_device_bound_single_lease(rig):
    c, a, owner, other = held(rig)
    lease = a.robot('r').holder.lease_id
    for actor in (other, Actor('a', 'sa', 'new-tab'), Actor('a', 'new-device', 'ca')):
        with pytest.raises(LeaseError):
            a.cmd('r', actor, lease, 1, [0, 0, 0])
        with pytest.raises(LeaseError):
            a.take('r', actor)
    assert a.robot('r').holder.actor == owner


def test_cmd_lease_sequence_and_fifty_ms_boundaries(rig):
    c, a, owner, _ = held(rig)
    lease = a.robot('r').holder.lease_id
    with pytest.raises(LeaseError) as error:
        a.cmd('r', owner, 'old', 0, [1, 0, 0])
    assert error.value.code == 'LEASE_MISMATCH'
    a.cmd('r', owner, lease, 0, [0, 0, 0])
    c.step(.05)
    with pytest.raises(LeaseError) as error:
        a.cmd('r', owner, lease, 0, [1, 0, 0])
    assert error.value.code == 'CMD_SEQ'
    a.cmd('r', owner, lease, 1, [1, 0, 0])
    c.step(.049999)
    with pytest.raises(LeaseError) as error:
        a.cmd('r', owner, lease, 2, [0, 0, 0])
    assert error.value.code == 'CMD_RATE_LIMIT'
    c.step(.000001)
    a.cmd('r', owner, lease, 2, [0, 0, 0])


def test_unlock_cas_and_stop_invalidates_pending_transfer(rig):
    c, a, owner, other = held(rig)
    lease = a.robot('r').holder.lease_id
    with pytest.raises(LeaseError) as error:
        a.unlock('r', owner, lease, 0)
    assert error.value.code == 'STOP_GEN_MISMATCH'
    assert a.unlock('r', owner, lease, 1)[0].body['t'] == 'unlock'
    a.request('r', other)
    a.respond('r', owner, a.robot('r').request.id, True)
    effects = a.stop('r', owner)
    assert effects[0].body['t'] == 'stop'
    assert a.state('r', True, [0, 0, 0], 2) == []
    assert a.robot('r').holder is None


def test_restart_has_no_lease_or_cooldown(rig):
    c, a, owner, other = held(rig)
    a.request('r', other)
    a.respond('r', owner, a.robot('r').request.id, False)
    restarted = Arbiter(c)
    assert restarted.robot('r').holder is None
    assert restarted.robot('r').cooldown == {}
    restarted.take('r', other)
