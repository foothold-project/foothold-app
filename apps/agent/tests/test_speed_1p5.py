"""Offline speed envelope and unchanged safety gates; no DDS or real robot."""
import math

import pytest

from apps.contracts.server_drive import ALLOWED as DRIVE_AXES
from foothold_agent.go2_direct.sink import ALLOWED, SERVER_ALLOWED, Limits, server_velocity
from foothold_agent.phone.protocol import LIMITS, project_velocity, simulation_velocity
from foothold_agent.safety.core import Core, Z, quantize, quantize_phone
from test_phone import physical_h, h
from test_phone_policy_compat import phone_transform
from test_go2_direct import command, make_sink, unlock


@pytest.mark.parametrize('wz', [-.5, 0, .5])
def test_phone_and_unchanged_server_share_exact_forward_ceiling(wz):
    velocity = (1.5, 0, wz)
    assert max(v[0] for v in DRIVE_AXES) == LIMITS['vx_max'] == 1.5
    assert SERVER_ALLOWED == DRIVE_AXES
    assert velocity in ALLOWED and velocity in SERVER_ALLOWED
    assert server_velocity(velocity) == Limits().project(velocity) == velocity
    axes, clipped = project_velocity(*velocity)
    assert not clipped and quantize_phone(*axes) == (velocity, '')
    # The original Core alphabet and default remain unchanged.
    assert quantize(*axes) == ((.6, 0, wz), '')
    assert Core().velocity_projection is quantize
    assert Limits().project((1.51, 0, wz)) == velocity
    assert project_velocity(1.51, 0, wz) == (axes, True)
    with pytest.raises(ValueError):
        server_velocity((1.51, 0, wz))


@pytest.mark.parametrize('vx', [1.5, math.nextafter(1.5, 2), 1.51])
def test_simulation_forward_boundary_is_rejected_without_clipping(h, vx):
    owner, _ = h.moving()
    ack = h.cmd(owner, vx)
    expected = (vx, 0, 0) if vx == 1.5 else Z
    assert tuple(ack['applied']) == expected
    assert ack['clipped'] is (vx != 1.5)
    assert simulation_velocity(vx, 0, 0)[0] == expected


@pytest.mark.parametrize('event', ['stop', 'deadman', 'disconnect', 'state_timeout'])
def test_physical_phone_1p5_stops_and_never_restores_old_input(physical_h, event):
    h = physical_h
    owner, _ = h.moving()
    assert h.outputs[-1].velocity == (1.5, 0, 0)
    if event == 'stop':
        h.send(owner, 'stop')
    elif event == 'disconnect':
        h.hub.disconnect(owner)
    elif event == 'state_timeout':
        h.clock.t = 1.01
        h.hub.tick()
    else:
        h.clock.t = .30001
        h.state(False)
        h.hub.tick()
    assert h.outputs[-1].velocity == Z
    assert h.hub.session.core.need_neutral
    if event != 'disconnect':
        assert h.cmd(owner, 1.5)['applied'] == list(Z)
    if event in ('stop', 'disconnect'):
        assert h.hub.session.core.latch
    if event == 'deadman':
        h.cmd(owner, 0)
        assert h.cmd(owner, 1.5)['applied'] == [1.5, 0, 0]


@pytest.mark.parametrize('event', ['stop', 'watchdog', 'drain_expiry'])
def test_1p5_sdk_stop_and_watchdog_discard_pending_motion(event):
    sink, normal, emergency, clock = make_sink()
    unlock(sink, clock)
    sink.apply(command(velocity=(1.5, 0, 0)), source='phone')
    sink.drain()
    assert normal.calls[-1] == ('Move', (1.5, 0, 0))
    if event == 'stop':
        sink.apply(command('stop'), source='phone')
    else:
        clock.value += .30001
    if event == 'watchdog':
        assert sink.check_watchdog()
        assert emergency.calls[-2:] == [('Move', Z), ('StopMove', ())]
    sink.drain()
    assert sink.latched and sink.pending == Z
    assert normal.calls[-2:] == [('Move', Z), ('StopMove', ())]
    sink.apply(command(velocity=(1.5, 0, 0)), source='phone')
    sink.drain()
    assert normal.calls[-1] == ('Move', Z)


@pytest.mark.parametrize('turn', [-1, 0, 1])
def test_shipped_web_transform_through_physical_hub_to_fake_sdk(physical_h, phone_transform, turn):
    h = physical_h
    owner, _ = h.moving()
    welcome = h.connect()[2]
    request = phone_transform(welcome, [1, turn, 1], {'sim_max_vx': .2})
    ack = h.cmd(owner, **request)
    assert ack['applied'] == [1.5, 0, turn * .5] and not ack['clipped']
    sink, normal, _, clock = make_sink()
    unlock(sink, clock)
    sink.apply(command(velocity=ack['applied']), source='phone')
    sink.drain()
    assert normal.calls[-1] == ('Move', (1.5, 0, turn * .5))
