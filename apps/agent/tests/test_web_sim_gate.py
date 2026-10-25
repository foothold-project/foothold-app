"""Signed PC identity is gated by local startup config, using the same Core."""
import pytest

from test_phone import h, physical_h, signed
from foothold_agent.phone.hub import PhoneError
from foothold_agent.phone.tickets import TicketError
from foothold_agent.safety.core import Z


@pytest.mark.parametrize('purpose', ['control', 'view'])
def test_pc_hello_denied_on_physical_agent(physical_h, purpose):
    with pytest.raises(PhoneError) as exc:
        physical_h.connect(surface='pc', purpose=purpose)
    assert exc.value.code == 'WEB_SIM_ONLY' and exc.value.close_code == 4403
    assert physical_h.hub.owner is None
    assert all(c.velocity in (None, Z) for c in physical_h.outputs)


@pytest.mark.parametrize('fixture', ['h', 'physical_h'])
@pytest.mark.parametrize('surface', [None, 'phone', 'pc'])
def test_surface_admission_and_stop(request, fixture, surface):
    harness = request.getfixturevalue(fixture)
    if fixture == 'physical_h' and surface == 'pc':
        return  # covered above, including view-only tickets
    peer, _, _ = harness.connect(**({} if surface is None else dict(surface=surface)))
    assert harness.take(peer)['ok']
    assert harness.send(peer, 'stop')['ok']
    assert harness.hub.session.core.latch


def test_pc_uses_existing_deadman_and_stop_latch(h):
    peer, _, _ = h.connect(surface='pc')
    assert h.take(peer)['ok']
    h.unlock(peer)
    h.cmd(peer, 0)
    assert h.cmd(peer)['applied'] == [.6, 0, 0]
    h.clock.t = .30001
    h.hub.tick()
    assert h.outputs[-1].velocity == Z
    assert h.clock.t <= .4
    assert h.cmd(peer)['applied'] == list(Z)
    h.cmd(peer, 0)
    assert h.cmd(peer)['applied'] == [.6, 0, 0]
    assert h.send(peer, 'stop')['ok']
    assert h.cmd(peer)['applied'] == list(Z)


@pytest.mark.parametrize('kind', ['lease.take', 'lease.request', 'unlock', 'cmd'])
def test_pc_rechecked_after_hello_but_stop_remains_open(h, kind):
    peer, _, _ = h.connect(surface='pc')
    assert h.take(peer)['ok']
    h.hub.simulation = False  # defense even if local mode changes after admission
    fields = dict(lease_id=h.hub.session.lease_id)
    if kind == 'cmd':
        fields.update(seq=1, vx=.6, vy=0, wz=0)
    elif kind == 'unlock':
        fields['stop_gen'] = h.hub.session.core.stop_gen
    else:
        fields = {}
    result = h.send(peer, kind, **fields)
    assert not result['ok'] and result['error']['code'] == 'WEB_SIM_ONLY'
    assert result['error']['detail']['status'] == 403
    assert h.send(peer, 'stop')['ok']
    assert h.hub.session.core.latch and h.outputs[-1].velocity == Z


@pytest.mark.parametrize('surface', ['', 'PC', 'tablet', None, True, 1, []])
def test_invalid_signed_surface_rejected(h, surface):
    with pytest.raises(TicketError):
        h.verifier.verify(signed(h.key, h.claims(surface=surface)))
