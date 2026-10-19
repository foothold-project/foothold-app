"""Measured data reaches wire state independently of unchanged Core feedback."""
import asyncio
import json
import threading
import time

import pytest

from foothold_agent.link.client import Client, Settings
from foothold_agent.link.session import Session
from foothold_agent.ros_bridge.node import Inputs, SENSOR_TOPICS
from foothold_agent.ros_bridge.telemetry import MapBinding, Telemetry
from test_ros_bridge import Clock, Loop, state, make_sink
from test_ros_bridge_review import Harness

FLOOR = '00000000-0000-4000-8000-000000000001'
VERSION = '00000000-0000-4000-8000-000000000002'


def measured(now):
    telemetry = Telemetry(now=now, binding=MapBinding('world', 'f1', 'v1', FLOOR, VERSION, 'a'*64, 1, 'run'))
    telemetry.update_state(state(), now())
    telemetry.update_map({'schema': 'v2_map_status/1', 'map_frame': 'map', 'epoch': 1,
        'world_id': 'world', 'floor_id': 'f1', 'map_version': 'v1', 'run_id': 'run',
        'map_accepting': True, 'sim_t': 1., 'pose_map': {'source': 'gt_identity',
            'stamp_sim': 1., 'x': 2., 'y': 3., 'yaw': .25}}, now())
    return telemetry


def test_measured_projection_is_copied_contract_only_and_never_refreshes_core():
    clock = Clock()
    session = Session(now=clock)
    cache = measured(clock)
    sample = cache.snapshot()
    core_age, generation = session.core.state_t, session.core.stop_gen
    session.update_telemetry(sample)
    sample['location']['x'] = 999
    wire = session._state()
    assert wire['speed'] == .5
    assert wire['pose'] == {'floor_id': FLOOR, 'x': 2., 'y': 3., 'yaw': .25, 'confidence': None}
    assert wire['battery'] == {'soc': None}
    assert session.core.state_t == core_age and session.core.stop_gen == generation
    wire['pose']['x'] = 999
    assert session._state()['pose']['x'] == 2.
    # No further bridge callback is needed to expire both speed and map pose.
    clock.t = 1.001
    assert session._state()['speed'] is None
    assert all(v is None for v in session._state()['pose'].values())


@pytest.mark.parametrize('condition', ['reset', 'rewind', 'stale', 'clock_unverified', 'missing', 'invalid'])
def test_each_invalid_measurement_condition_clears_wire_values(condition):
    clock = Clock()
    session, cache = Session(now=clock), measured(clock)
    session.update_telemetry(cache.snapshot())
    assert session._state()['speed'] == .5
    if condition == 'reset':
        cache.update_state(state(sim_t=2., reset_in_progress=True), clock())
    elif condition == 'rewind':
        cache.update_state(state(sim_t=.5), clock())
    elif condition == 'stale':
        clock.t = 1.001
    elif condition == 'missing':
        cache.update_state(state(sim_t=2., vx=None), clock())
    elif condition == 'invalid':
        cache.update_state(state(sim_t=2., vx=float('nan')), clock())
    sample = cache.snapshot()
    if condition == 'clock_unverified':
        sample['observation']['clock'] = 'unverified'
    session.update_telemetry(sample)
    wire = session._state()
    assert wire['speed'] is None  # missing does not mean stationary
    assert wire['battery']['soc'] is None  # no source battery in simulation
    if condition != 'missing':
        assert all(v is None for v in wire['pose'].values())


def test_owning_loop_updates_measurements_and_explicit_invalidation():
    clock, loop = Clock(), Loop()
    sink, _ = make_sink(clock)
    client = Client(Session(now=clock), sink, Settings('ws://127.0.0.1/agent', 'fake-only'))
    inputs = Inputs(loop, sink, client.on_robot_state, now=clock,
                    on_telemetry=client.update_telemetry, on_devices=client.update_devices)
    inputs.state(state())
    assert client.session._state()['speed'] is None  # ROS callback cannot access Session
    loop.drain()
    assert client.session._state()['speed'] == .5
    inputs.reject('bad-source')
    loop.drain()
    assert client.session._state()['speed'] is None


def test_hello_devices_require_actual_received_subscription_and_no_fake_battery():
    clock, loop = Clock(), Loop()
    sink, _ = make_sink(clock)
    session = Session(now=clock)
    inputs = Inputs(loop, sink, lambda raw: None, now=clock, on_devices=session.update_devices)
    assert session.connect().messages[0]['devices'] == []
    for topic in SENSOR_TOPICS:
        inputs.sensor(topic)
    loop.drain()  # all three survive a single coalesced mailbox delivery
    hello = session.connect().messages[0]
    assert {d['kind'] for d in hello['devices']} == {'LIDAR', 'CAMERA_RGB', 'CAMERA_DEPTH'}
    assert {d['key'] for d in hello['devices']} == set(SENSOR_TOPICS)
    assert all(d['state'] == 'OK' for d in hello['devices'])
    hello['devices'].clear()
    assert len(session.identity['devices']) == 3
    assert session._state()['battery'] == {'soc': None}


def test_same_stamp_changing_age_does_not_mask_core_source_disconnect():
    h = Harness()
    h.moving()
    stamp, age = h.session.core.st['sim_t'], h.session.core.state_t
    for i in range(1, 26):
        h.clock.t = age + i*.1
        h.inputs.state(state(sim_t=stamp, stop_requested=False, cmd_age_s=i*.1))
        h.inputs.stale()
        h.loop.drain()
        h.session.tick()
    assert h.session.core.state_t == age
    assert h.session.core.sim_block() == '시뮬 상태 끊김'


def test_close_has_bounded_join_and_reports_stuck_watchdog():
    sink, _ = make_sink()
    class Stuck:
        def join(self, timeout=None):
            self.timeout = timeout
        def is_alive(self):
            return True
    sink._watchdog = stuck = Stuck()
    with pytest.raises(RuntimeError, match='watchdog did not stop'):
        sink.close()
    assert stuck.timeout is not None and 0 < stuck.timeout <= .5


def test_both_close_callers_time_out_when_publisher_never_returns():
    sink, _ = make_sink()
    entered, release = threading.Event(), threading.Event()
    def stuck():
        entered.set()
        release.wait(15)
    sink._emergency = stuck
    errors = []
    def close():
        start = time.monotonic()
        try:
            sink.close()
        except RuntimeError as exc:
            errors.append((str(exc), time.monotonic()-start))
    first = threading.Thread(target=close, daemon=True)
    second = threading.Thread(target=close, daemon=True)
    try:
        first.start()
        assert entered.wait(3)
        second.start()
        first.join(4)
        second.join(4)
        assert not first.is_alive() and not second.is_alive()
        assert len(errors) == 2 and all('timed out' in e and t < 4 for e, t in errors)
        assert not sink._close_complete.is_set()
    finally:
        release.set()
        first.join(1)
        if second.ident is not None:
            second.join(1)


def test_client_fake_server_receives_measurements_then_stale_null():
    serve = pytest.importorskip("websockets.asyncio.server", reason="install agent [link] for WS integration").serve
    async def scenario():
        clock = Clock()
        session = Session(now=clock)
        sink, _ = make_sink(clock)
        seen = asyncio.get_running_loop().create_future()
        async def peer(ws):
            try:
                frames = []
                while True:
                    frame = json.loads(await ws.recv())
                    if frame['t'] != 'state':
                        continue
                    frames.append(frame)
                    if len(frames) == 1:
                        assert frame['speed'] == .5 and frame['pose']['x'] == 2.
                        assert frame['devices_changed'][0]['state'] == 'OK'
                        clock.t = 1.001
                    else:
                        assert frame['speed'] is None and frame['pose']['x'] is None
                        assert frame['devices_changed'][0]['state'] == 'MISSING'
                        assert frame['battery']['soc'] is None
                        seen.set_result(frames)
                        await ws.wait_closed()
                        return
            except BaseException as exc:
                if not seen.done():
                    seen.set_exception(exc)
        async def run_client(port):
            client = Client(session, sink, Settings(f'ws://127.0.0.1:{port}/agent', 'fake-only'))
            client.update_telemetry(measured(clock).snapshot())
            client.update_devices([{'key': 'lidar', 'kind': 'LIDAR', 'label': 'L1', 'state': 'OK',
                                    'received_monotonic_s': clock()}])
            task = asyncio.create_task(client.run())
            try:
                await asyncio.wait_for(seen, 3)
            finally:
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
        from foothold_agent.link.testing import reserved_socket
        with reserved_socket() as sock:
            port = sock.getsockname()[1]
            async with serve(peer, sock=sock):
                await run_client(port)
    asyncio.run(scenario())


def test_coalesced_measurement_does_not_erase_new_source_core_progress():
    clock, loop = Clock(), Loop()
    sink, _ = make_sink(clock)
    session = Session(now=clock)
    inputs = Inputs(loop, sink, session.on_robot_state, now=clock)
    inputs.state(state(sim_t=1., vx=.1))
    inputs.state(state(sim_t=1., vx=.2))
    loop.drain()
    assert session.core.st['sim_t'] == 1. and session.core.st['vx'] == .2
    clock.t = .1
    inputs.state(state(sim_t=2., vx=.3))
    inputs.state(state(sim_t=2., vx=.4))
    loop.drain()
    assert session.core.st['sim_t'] == 2. and session.core.st['vx'] == .4
    assert session.core.state_t == .1


def test_runner_seeds_startup_cache_and_connects_owner_callbacks(monkeypatch):
    from types import SimpleNamespace
    from foothold_agent.ros_bridge import __main__ as runner
    actual_client = Client
    clock = Clock()
    cache = measured(clock)
    observed = {}
    class Bridge:
        def __init__(self, config):
            self.inputs = SimpleNamespace(telemetry=cache, device_observations=lambda: [
                {'key': 'startup', 'kind': 'LIDAR', 'label': 'L1', 'state': 'OK', 'received_monotonic_s': 0.}])
        async def start(self, on_state, *, on_telemetry, on_devices):
            observed.update(state=on_state, telemetry=on_telemetry, devices=on_devices)
            return SimpleNamespace(apply=lambda command: None)
        async def wait_failure(self):
            await asyncio.Event().wait()
        def close(self):
            observed['closed'] = True
    class RunningClient(actual_client):
        async def run(self):
            assert self.session._state()['speed'] == .5
            assert [d['key'] for d in self.session._state()['devices_changed']] == ['startup']
            observed['telemetry'](None)
            assert self.session._state()['speed'] is None
            observed['devices']([{'key': 'actual', 'kind': 'LIDAR', 'label': 'L1', 'state': 'OK'}])
            assert self.session.connect().messages[0]['devices'][0]['key'] == 'actual'
            observed['state'](state())
            assert self.session.core.st is not None
    monkeypatch.setattr(runner, 'RosNode', Bridge)
    monkeypatch.setattr(runner, 'Client', RunningClient)
    monkeypatch.setattr(runner, 'Session', lambda: Session(now=clock))
    asyncio.run(runner.run(SimpleNamespace(settings=Settings('ws://127.0.0.1/agent', 'fake-only'))))
    assert observed['closed'] is True


def test_reset_invalidates_snapshot_before_core_can_emit_state():
    clock, loop = Clock(), Loop()
    sink, _ = make_sink(clock)
    session = Session(now=clock)
    observed = []
    def feedback(raw):
        observed.append(session._state()['speed'])
        session.on_robot_state(raw)
    inputs = Inputs(loop, sink, feedback, now=clock, on_telemetry=session.update_telemetry)
    inputs.state(state())
    loop.drain()
    assert observed == [.5]
    clock.t = .1
    inputs.state(state(sim_t=2., reset_in_progress=True))
    loop.drain()
    assert observed[-1] is None


@pytest.mark.parametrize('value', [float('nan'), float('inf'), True, 10**1000, -1, '0.5'])
def test_malformed_local_values_never_reach_json_wire(value):
    clock = Clock()
    session, cache = Session(now=clock), measured(clock)
    sample = cache.snapshot()
    sample['speed'] = value
    sample['battery'] = {'soc': value}
    sample['location']['confidence'] = value
    session.update_telemetry(sample)
    wire = session._state()
    assert wire['speed'] is None
    assert wire['battery']['soc'] is None
    assert wire['pose']['confidence'] is None
    json.dumps(wire, allow_nan=False)


@pytest.mark.parametrize('with_state', [True, False])
def test_device_expiry_without_any_later_input_on_hello_and_connected_state(with_state):
    clock, loop = Clock(), Loop()
    sink, _ = make_sink(clock)
    session = Session(now=clock)
    inputs = Inputs(loop, sink, session.on_robot_state, now=clock, on_devices=session.update_devices)
    if with_state:
        inputs.state(state())
        loop.drain()
    clock.t = .5
    inputs.sensor('/v2_map/points')
    loop.drain()
    first_hello = session.connect().messages[0]
    assert len(first_hello['devices']) == 1
    assert first_hello['devices'][0]['state'] == 'OK'
    clock.t = 1.1
    inputs.stale()
    loop.drain()
    assert session._state()['devices_changed'][0]['state'] == 'OK'
    # No ROS bundle or callback after this point. The original receipt is .5.
    clock.t = 1.501
    assert session._state()['devices_changed'][0]['state'] == 'MISSING'
    clock.t = 30
    assert inputs.device_snapshot()[0]['state'] == 'MISSING'
    assert session._state()['devices_changed'][0]['state'] == 'MISSING'
    hello, *rest = session.connect().messages
    assert hello['devices'][0]['state'] == 'MISSING'
    assert all('received_monotonic_s' not in d for d in hello['devices'])
    assert next(s for s in rest if s['t'] == 'state')['devices_changed'][0]['state'] == 'MISSING'
    # Late startup/recovery is reflected without reconnecting.
    inputs.sensor('/v2_map/points')
    loop.drain()
    assert session._state()['devices_changed'][0]['state'] == 'OK'
    if not with_state:
        assert session.core.st is None
    sink.close()


def test_stale_sensor_bundle_cannot_create_a_device_or_refresh_receipt():
    clock, loop = Clock(), Loop()
    sink, _ = make_sink(clock)
    session = Session(now=clock)
    inputs = Inputs(loop, sink, lambda raw: None, now=clock, on_devices=session.update_devices)
    inputs.sensor('/v2_map/points')
    clock.t = 1.001
    loop.drain()
    assert session.connect().messages[0]['devices'] == []
    assert session._state()['devices_changed'] == []
    sink.close()


@pytest.mark.parametrize('where,field,age', [
    ('observation', 'received_monotonic_s', 1.001),
    ('observation', 'progress_monotonic_s', 1.001),
    ('observation', 'received_monotonic_s', -.1),
    ('observation', 'progress_monotonic_s', -.1),
    ('location', 'received_monotonic_s', 1.001),
    ('location', 'progress_monotonic_s', 1.001),
    ('location', 'received_monotonic_s', -.1),
    ('location', 'progress_monotonic_s', -.1),
])
def test_session_independently_checks_each_measurement_clock(where, field, age):
    clock = Clock()
    snapshot = measured(clock).snapshot()
    snapshot[where][field] = clock() - age
    session = Session(now=clock)
    session.update_telemetry(snapshot)
    wire = session._state()
    assert all(v is None for v in wire['pose'].values())
    assert wire['speed'] == (None if where == 'observation' else .5)


def test_session_measurement_age_accepts_exact_one_second_boundary():
    clock = Clock()
    snapshot = measured(clock).snapshot()
    clock.t = 1.
    session = Session(now=clock)
    session.update_telemetry(snapshot)
    assert session._state()['speed'] == .5 and session._state()['pose']['x'] == 2.


@pytest.mark.parametrize('phase', ['constructor', 'start'])
def test_close_thread_creation_failure_still_attempts_zero_and_stop(monkeypatch, phase):
    from foothold_agent.ros_bridge import sink as module
    sink, outputs = make_sink()
    class NoThread:
        def __init__(self, **kwargs):
            if phase == 'constructor':
                raise RuntimeError('thread resources exhausted')
        def start(self):
            raise RuntimeError('thread resources exhausted')
    monkeypatch.setattr(module.threading, 'Thread', NoThread)
    try:
        sink.close()
    except RuntimeError:
        pass  # A broken fallback must fail on missing outputs, not runtime error.
    assert outputs == [('velocity', (0, 0, 0)), ('stop',)]
    assert sink._close_complete.is_set()


def test_reserved_socket_skips_an_existing_reservation():
    from foothold_agent.link.testing import reserved_socket
    with reserved_socket() as first, reserved_socket() as second:
        assert first.getsockname() != second.getsockname()
        assert all(s.getsockname()[0] == '127.0.0.1' and 9060 <= s.getsockname()[1] < 9080
                   for s in (first, second))


def test_same_stamp_fall_is_reported_once_without_repeated_source_refresh():
    clock, loop = Clock(), Loop()
    sink, _ = make_sink(clock)
    session = Session(now=clock)
    inputs = Inputs(loop, sink, session.on_robot_state, now=clock)
    inputs.state(state(fallen=False))
    loop.drain()
    clock.t = .1
    inputs.state(state(fallen=True))
    loop.drain()
    assert any(e['text'] == '넘어짐 (시뮬 판정)' for e in session.core.events)
    assert session.core.state_t == .1
    for i in range(2, 20):
        clock.t = i*.1
        inputs.state(state(fallen=bool(i % 2), cmd_age_s=i*.1))
        loop.drain()
    assert session.core.state_t == .1
    assert session.core.st['fallen'] is True
    sink.close()
