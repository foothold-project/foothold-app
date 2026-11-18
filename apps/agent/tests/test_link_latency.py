"""The existing server socket echoes an opaque challenge without granting motion."""
from foothold_agent.link.session import Session
from test_go2_direct import Clock


def test_ping_echo_is_immediate_and_cannot_acknowledge_stop_or_unlock():
    session = Session(now=Clock())
    session.connect()
    generation = session.core.stop_gen
    effects = session.receive(dict(t='ping', ping_id='fake-roundtrip-token'))
    assert {'t': 'ping', 'ping_id': 'fake-roundtrip-token'} in effects.messages
    assert session.core.latch and session.core.stop_gen == generation
    assert session.stop_ref == 0 and session.core.st is None
    assert all(command.velocity == (0, 0, 0) for command in effects.motion)


def test_legacy_invalid_or_disconnected_ping_does_not_echo():
    session = Session(now=Clock())
    assert not session.receive(dict(t='ping', ping_id='fake')).messages
    session.connect()
    for value in (None, 12, '', 'x'*65):
        assert not any(m['t'] == 'ping' for m in session.receive(dict(t='ping', ping_id=value)).messages)
