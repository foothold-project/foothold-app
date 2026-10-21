"""The link echoes causal STOP references without changing safety Core policy."""
import pytest

from foothold_agent.link.session import Session


def test_stop_reference_echo_only_after_latched_zero():
    session = Session(lambda: 0)
    session.connect()
    effects = session.receive({'t': 'stop', 'stop_ref': 17, 'by_user_id': None})
    states = [m for m in effects.messages if m['t'] == 'state']
    assert states[-1]['stop_ref'] == 17
    assert states[-1]['latched'] is True
    assert states[-1]['applied'] == [0, 0, 0]
    assert any(m.kind == 'stop' for m in effects.motion)
    # lease-null itself does not acknowledge a subsequent STOP.
    state = session.receive({'t': 'lease', 'lease_id': None, 'holder_type': None}).messages[-1]
    assert state['stop_ref'] == 17


@pytest.mark.parametrize('bad', [None, 0, -1, True, 1.0, 2**53])
def test_invalid_reference_still_stops_without_acknowledging(bad):
    session = Session(lambda: 0)
    session.connect()
    session.receive({'t': 'stop', 'stop_ref': 3})
    session.core.latch = False
    effects = session.receive({'t': 'stop', 'stop_ref': bad})
    assert effects.messages[-1]['stop_ref'] == 3
    assert session.core.latch
    assert all(m.velocity == (0, 0, 0) for m in effects.motion)


def test_reference_boundary_and_reconnect_epoch():
    session = Session(lambda: 0)
    session.connect()
    assert session.receive({'t': 'stop', 'stop_ref': 2**53 - 1}).messages[-1]['stop_ref'] == 2**53 - 1
    session.disconnect()
    states = [m for m in session.connect().messages if m['t'] == 'state']
    assert states[-1]['stop_ref'] == 0
    assert session.receive({'t': 'stop', 'stop_ref': 1}).messages[-1]['stop_ref'] == 1


@pytest.mark.parametrize('condition', ['unlatched', 'nonzero'])
def test_unapplied_stop_never_echoes_new_reference(monkeypatch, condition):
    session = Session(lambda: 0)
    session.connect()
    if condition == 'unlatched':
        session.core.latch = False
        monkeypatch.setattr(session.core, 'stop', lambda reason: None)
    else:
        monkeypatch.setattr(session.core, 'applied', lambda: (1, 0, 0))
    effect = session.receive({'t': 'stop', 'stop_ref': 9})
    assert effect.messages[-1]['stop_ref'] == 0


def test_unlock_safe_integer_upper_bound(monkeypatch):
    session = Session(lambda: 0)
    session.connect()
    session.receive({'t': 'lease', 'lease_id': 'fake-lease', 'holder_type': 'USER'})
    generations = []
    monkeypatch.setattr(session.core, 'resume', lambda lease, gen: generations.append(gen) or True)
    session.receive({'t': 'unlock', 'lease_id': 'fake-lease', 'stop_gen': 2**53})
    assert generations == []
    session.receive({'t': 'unlock', 'lease_id': 'fake-lease', 'stop_gen': 2**53 - 1})
    assert generations == [2**53 - 1]


@pytest.mark.parametrize('operation', ['connect', 'stop'])
def test_core_generation_exhaustion_is_bounded_and_never_confirms(operation):
    session = Session(lambda: 0)
    session.connect()
    session.core.stop_gen = 2**53 - 1
    effects = session.connect() if operation == 'connect' else session.receive({'t': 'stop', 'stop_ref': 7})
    assert session.core.stop_gen > 2**53 - 1  # original Core is unchanged
    states = [m for m in effects.messages if m['t'] == 'state']
    assert states and all(m['stop_gen'] == 2**53 - 1 and m['stop_ref'] == 0 for m in states)
    assert any(m.get('code') == 'STOP_GEN_EXHAUSTED' for m in effects.messages)
    assert session.core.latch and not session.lease_confirmed
    session.receive({'t': 'lease', 'lease_id': 'fake-old-grant', 'holder_type': 'USER'})
    assert not session.lease_confirmed
    assert all(m.velocity == (0, 0, 0) for m in session.receive({
        't': 'cmd', 'lease_id': 'fake-old-grant', 'seq': 1, 'axes': [1, 0, 0]}).motion)
