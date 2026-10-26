"""Diagnose PC 1013 without changing any safety policy or browser timers."""
import pytest

from test_phone import h


@pytest.mark.parametrize('release', [False, True])
def test_pc_view_connection_still_needs_ping_after_lease_release(h, release):
    pc, _, welcome = h.connect(surface='pc')
    assert welcome['ping_interval_ms'] == 1000 and welcome['link_timeout_ms'] == 3000
    if release:
        assert h.take(pc)['ok']
        assert h.send(pc, 'lease.release')['ok']
    assert h.hub.owner is None and pc in h.hub.peers
    # Receiving states and releasing authority do not substitute for a ping.
    h.clock.t = 2.99
    assert h.hub.tick() == []
    assert h.hub.state(pc)['t'] == 'state'
    h.clock.t = 3
    expired = h.hub.tick()
    assert len(expired) == 1 and expired[0][0] is pc
    assert (expired[0][1].code, expired[0][1].close_code) == ('PHONE_LINK_LOST', 1013)
    assert pc not in h.hub.peers


def test_independent_phone_does_not_close_live_pc_viewer(h):
    pc, _, _ = h.connect(surface='pc')
    phone, _, _ = h.connect()
    for second in range(1, 6):
        h.clock.t = second
        for peer in (pc, phone):
            assert h.send(peer, 'ping', client_time_ms=second * 1000)['ok']
        assert h.hub.tick() == []
        assert pc in h.hub.peers and phone in h.hub.peers
