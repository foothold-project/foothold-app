"""Offline boundary tests. Never import Unitree, initialize DDS or open sockets."""
import builtins
import json
import threading
from types import SimpleNamespace

import pytest

from foothold_agent.go2_direct import Go2Sink, Limits, OutputError
from foothold_agent.go2_direct import sdk
from foothold_agent.go2_direct.approval import validate


class Clock:
    value = 1000.

    def __call__(self):
        return self.value


class FakeSport:
    def __init__(self):
        self.calls = []
        self.result = 0

    def Move(self, *velocity):
        self.calls.append(('Move', velocity))
        return self.result

    def StopMove(self):
        self.calls.append(('StopMove', ()))
        return self.result


def command(kind='apply', velocity=(0., 0., 0.)):
    return SimpleNamespace(kind=kind, velocity=velocity)


def make_sink(*, offline_test_mode=True):
    clock, normal, emergency = Clock(), FakeSport(), FakeSport()
    sink = Go2Sink(normal, emergency, now=clock, offline_test_mode=offline_test_mode)
    sink.select_source('phone')
    if offline_test_mode:
        sink.drain()
    return sink, normal, emergency, clock


def unlock(sink, clock, sequence=1):
    assert sink.confirm_stopped(generation=sink.generation, sequence=sequence,
                                received_at=clock(), stationary=True)
    sink.apply(command('unlock'), source='phone')
    sink.apply(command(), source='phone')


@pytest.mark.parametrize('kind,velocity', [('unlock', (0., 0., 0.)),
    ('apply', (0., 0., 0.)), ('apply', (.6, 0., 0.))])
def test_default_live_input_requires_workers_before_unlock_or_apply(kind, velocity):
    clock, normal, emergency = Clock(), FakeSport(), FakeSport()
    sink = Go2Sink(normal, emergency, now=clock)
    sink.select_source('phone')
    assert sink.confirm_stopped(generation=sink.generation, sequence=1,
                                received_at=clock(), stationary=True)
    with pytest.raises(OutputError):
        sink.apply(command(kind, velocity), source='phone')
    assert sink.latched and sink.pending == (0., 0., 0.)
    assert not sink._threads and not normal.calls and not emergency.calls
    # STOP remains accepted even before workers start; no motion can be queued.
    sink.apply(command('stop'), source='anything')
    assert sink.latched and sink._stop_requested.is_set()


def test_default_live_manual_drain_requires_workers():
    normal, emergency = FakeSport(), FakeSport()
    sink = Go2Sink(normal, emergency)
    with pytest.raises(OutputError):
        sink.drain()
    assert sink.latched and not normal.calls and not emergency.calls


@pytest.mark.parametrize('alive', [(True,), (True, False)])
def test_live_input_requires_both_workers_alive(alive):
    sink = Go2Sink(FakeSport(), FakeSport())
    sink.select_source('phone')
    sink._threads = [SimpleNamespace(is_alive=lambda value=value: value) for value in alive]
    with pytest.raises(OutputError):
        sink.apply(command(), source='phone')
    assert sink.latched and sink.pending == (0., 0., 0.)


def test_explicit_offline_mode_allows_manual_fakes_but_not_live_workers():
    sink, normal, _, clock = make_sink(offline_test_mode=True)
    unlock(sink, clock)
    sink.apply(command(velocity=(.6, 0., 0.)), source='phone')
    sink.drain()
    assert normal.calls[-1] == ('Move', (.6, 0., 0.))
    with pytest.raises(RuntimeError):
        sink.start_threads()
    with pytest.raises(ValueError):
        Go2Sink(FakeSport(), FakeSport(), offline_test_mode='true')


@pytest.fixture
def marker(tmp_path):
    path = tmp_path/'field-approval.json'
    value = dict(v=1, purpose='go2-field-motion', nic='eth0',
                 robot_serial='TEST-ROBOT', expires_at=1100.)
    path.write_text(json.dumps(value))
    path.chmod(0o600)
    return path, value, {'FH_GO2_DIRECT_ENABLED': '1', 'FH_GO2_DIRECT_NIC': 'eth0',
                         'FH_GO2_FIELD_APPROVAL': str(path)}


@pytest.mark.parametrize('change', [dict(v=True), dict(expires_at=999),
    dict(expires_at=3000), dict(expires_at=float('nan')), dict(nic='wlan0'),
    dict(robot_serial=''), dict(purpose='read-only-pairing')])
def test_marker_rejects_invalid_fields(marker, change):
    path, value, env = marker
    path.write_text(json.dumps(dict(value, **change)))
    with pytest.raises(PermissionError):
        validate(env, now=1000.)


def test_marker_file_boundary(marker, tmp_path):
    path, _, env = marker
    assert validate(env, now=1000.).nic == 'eth0'
    path.chmod(0o644)
    with pytest.raises(PermissionError):
        validate(env, now=1000.)
    path.chmod(0o600)
    link = tmp_path/'symlink'
    link.symlink_to(path)
    with pytest.raises(OSError):
        validate(dict(env, FH_GO2_FIELD_APPROVAL=str(link)), now=1000.)
    path.write_text('[]')
    with pytest.raises(PermissionError):
        validate(env, now=1000.)


def test_sdk_is_not_imported_before_gates(marker, monkeypatch):
    original = builtins.__import__

    def guarded(name, *args, **kwargs):
        assert not name.startswith('unitree_sdk2py'), 'must fail before SDK import'
        return original(name, *args, **kwargs)

    monkeypatch.setattr(builtins, '__import__', guarded)
    _, _, env = marker
    with pytest.raises(PermissionError):
        sdk.connect({}, observed_serial='TEST-ROBOT')
    with pytest.raises(PermissionError):
        sdk.connect(env, observed_serial='WRONG', wall=lambda: 1000.)
    monkeypatch.setattr(sdk.socket, 'if_nameindex', lambda: [(1, 'lo')])
    with pytest.raises(ValueError):
        sdk.connect(env, observed_serial='TEST-ROBOT', wall=lambda: 1000.)
    monkeypatch.setattr(sdk.socket, 'if_nameindex', lambda: [(2, 'eth0')])
    monkeypatch.setenv('CYCLONEDDS_URI', 'unreviewed')
    with pytest.raises(PermissionError):
        sdk.connect(env, observed_serial='TEST-ROBOT', wall=lambda: 1000.)


def test_explicit_factory_uses_only_fake_sdk_and_no_motion(marker, monkeypatch):
    original = builtins.__import__
    instances, initialized = [], []

    class FakeClient(FakeSport):
        def __init__(self):
            super().__init__()
            instances.append(self)

        def SetTimeout(self, value):
            self.timeout = value

        def Init(self):
            self.initialized = True

    def fake_import(name, *args, **kwargs):
        if name == 'unitree_sdk2py.core.channel':
            return SimpleNamespace(ChannelFactoryInitialize=lambda *a: initialized.append(a))
        if name == 'unitree_sdk2py.go2.sport.sport_client':
            return SimpleNamespace(SportClient=FakeClient)
        if name.startswith('unitree_sdk2py'):
            raise AssertionError('unexpected SDK import')
        return original(name, *args, **kwargs)

    for key in ('CYCLONEDDS_URI', 'CYCLONEDDS_HOME', 'LD_LIBRARY_PATH'):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setattr(builtins, '__import__', fake_import)
    monkeypatch.setattr(sdk.socket, 'if_nameindex', lambda: [(2, 'eth0')])
    clock = Clock()
    _, _, env = marker
    clients = sdk.connect(env, observed_serial='TEST-ROBOT', wall=clock, monotonic=clock)
    assert initialized == [(0, 'eth0')]
    assert len(clients) == 2 and clients[0].client is not clients[1].client
    assert all(c.initialized and c.timeout == .1 and not c.calls for c in instances)
    clock.value = 1100.
    with pytest.raises(PermissionError):
        clients[0].Move(.6, 0., 0.)
    assert clients[0].Move(0., 0., 0.) == 0
    assert clients[1].StopMove() == 0


@pytest.mark.parametrize('velocity', [(True, 0, 0), (float('inf'), 0, 0),
    (float('nan'), 0, 0), (.2, 0, 0), (.6, 0, .1), (0, 0)])
def test_limits_reject_nonfinite_and_unreviewed_alphabet(velocity):
    with pytest.raises(ValueError):
        Limits().project(velocity)


def test_limits_clamp_only_and_cannot_expand():
    assert Limits().project((1, 1, 1)) == (.6, 0., .5)
    assert Limits().project((-1, 0, 0)) == (0., 0., 0.)
    with pytest.raises(ValueError):
        Limits(vx=(-.6, .6))
    with pytest.raises(ValueError):
        Limits(vy=(0., .2))
    with pytest.raises(ValueError):
        Limits(vx=(0., .3)).project((.6, 0., 0.))


def test_latched_neutral_and_source_rules():
    sink, normal, _, clock = make_sink()
    sink.apply(command(velocity=(.6, 0., 0.)), source='phone')
    assert sink.pending == (0., 0., 0.) and sink.latched
    assert sink.confirm_stopped(generation=sink.generation, sequence=1,
                                received_at=clock(), stationary=True)
    sink.apply(command('unlock'), source='phone')
    sink.apply(command(velocity=(.6, 0., 0.)), source='phone')
    assert sink.pending == (0., 0., 0.)
    sink.apply(command(), source='phone')
    sink.apply(command(velocity=(.6, 0., 0.)), source='phone')
    sink.drain()
    assert normal.calls[-1] == ('Move', (.6, 0., 0.))
    sink.apply(command(), source='phone')
    sink.drain()
    assert not sink.latched and normal.calls[-1] == ('Move', (0., 0., 0.))
    sink.apply(command('stop'), source='anything')
    sink.drain()
    assert sink.latched and normal.calls[-1][0] == 'StopMove'
    sink.select_source('nav2')
    with pytest.raises(ValueError):
        sink.apply(command(velocity=(.6, 0., 0.)), source='phone')
    assert sink.latched


def test_no_stale_or_replayed_feedback_unlock():
    sink, _, _, clock = make_sink()
    for values in [dict(generation=sink.generation-1, sequence=1, received_at=clock()),
                   dict(generation=sink.generation, sequence=1, received_at=clock()-.21),
                   dict(generation=sink.generation, sequence=1, received_at=clock()+1)]:
        assert not sink.confirm_stopped(**values, stationary=True)
    assert not sink.confirm_stopped(generation=sink.generation, sequence=1,
                                    received_at=clock(), stationary=False)
    assert sink.confirm_stopped(generation=sink.generation, sequence=1,
                                received_at=clock(), stationary=True)
    assert not sink.confirm_stopped(generation=sink.generation, sequence=1,
                                    received_at=clock(), stationary=True)
    clock.value += .21
    sink.apply(command('unlock'), source='phone')
    assert sink.latched


@pytest.mark.parametrize('stalled', ['input', 'output'])
def test_watchdog_stops_and_never_auto_unlocks(stalled):
    sink, _, emergency, clock = make_sink()
    unlock(sink, clock)
    sink.apply(command(velocity=(.6, 0., 0.)), source='phone')
    sink.drain()
    clock.value += .31
    if stalled == 'output':
        sink.apply(command(velocity=(.6, 0., 0.)), source='phone')
    assert sink.check_watchdog()
    assert emergency.calls[-2:] == [('Move', (0., 0., 0.)), ('StopMove', ())]
    assert sink.latched
    sink.apply(command(velocity=(.6, 0., 0.)), source='phone')
    assert sink.pending == (0., 0., 0.) and sink.latched
    assert not sink.check_watchdog()


def test_output_itself_rejects_expired_input_before_watcher():
    sink, normal, _, clock = make_sink()
    unlock(sink, clock)
    sink.apply(command(velocity=(.6, 0., 0.)), source='phone')
    clock.value += .31
    sink.drain()
    assert sink.latched
    assert normal.calls[-2:] == [('Move', (0., 0., 0.)), ('StopMove', ())]


def test_drain_first_cannot_erase_expired_output_deadline():
    sink, normal, emergency, clock = make_sink()
    unlock(sink, clock)
    sink.apply(command(velocity=(.6, 0., 0.)), source='phone')
    sink.drain()
    generation = sink.generation
    clock.value += .20
    sink.apply(command(velocity=(.6, 0., 0.)), source='phone')
    clock.value += .11
    before = len(normal.calls)
    # No late apply and no watchdog first: output must check its OLD clock.
    sink.drain()
    assert sink.latched and sink.pending == (0., 0., 0.)
    assert sink.generation > generation and sink._stop_requested.is_set()
    assert normal.calls[before:] == [('Move', (0., 0., 0.)), ('StopMove', ())]
    assert sink.check_watchdog()
    assert emergency.calls[-2:] == [('Move', (0., 0., 0.)), ('StopMove', ())]
    sink.apply(command(velocity=(.6, 0., 0.)), source='phone')
    sink.drain()
    assert sink.latched and ('Move', (.6, 0., 0.)) not in normal.calls[before:]


def test_late_sdk_return_cannot_refresh_expired_output_before_watcher():
    sink, normal, emergency, clock = make_sink()
    unlock(sink, clock)
    original = normal.Move

    def delayed_return(*velocity):
        if velocity != (0., 0., 0.):
            clock.value += .20
            sink.apply(command(velocity=velocity), source='phone')
            clock.value += .11
        return original(*velocity)

    normal.Move = delayed_return
    sink.apply(command(velocity=(.6, 0., 0.)), source='phone')
    sink.drain()
    assert sink.latched and sink.pending == (0., 0., 0.)
    assert sink._stop_requested.is_set()
    assert normal.calls[-2:] == [('Move', (0., 0., 0.)), ('StopMove', ())]
    assert sink.check_watchdog() and emergency.calls[-1][0] == 'StopMove'


@pytest.mark.parametrize('expired', ['input', 'output'])
def test_late_nonzero_apply_cannot_erase_expired_deadline(expired):
    sink, normal, _, clock = make_sink()
    unlock(sink, clock)
    sink.apply(command(velocity=(.6, 0., 0.)), source='phone')
    sink.drain()
    generation = sink.generation
    clock.value += .20
    if expired == 'input':
        sink.drain()  # Output stays fresh while input is absent.
    else:
        sink.apply(command(velocity=(.6, 0., 0.)), source='phone')
    clock.value += .11
    before = len(normal.calls)
    # Reviewer reproduction order: late input -> output -> watchdog.
    sink.apply(command(velocity=(.6, 0., 0.)), source='phone')
    sink.drain()
    sink.check_watchdog()
    assert sink.latched and sink.pending == (0., 0., 0.)
    assert sink.generation > generation
    assert ('Move', (.6, 0., 0.)) not in normal.calls[before:]
    # Continuing fresh input cannot resume without a new stop/unlock/neutral.
    sink.apply(command(velocity=(.6, 0., 0.)), source='phone')
    sink.drain()
    assert sink.latched and ('Move', (.6, 0., 0.)) not in normal.calls[before:]


def test_switch_source_while_moving_latches_and_discards_pending_command():
    sink, normal, _, clock = make_sink()
    unlock(sink, clock)
    sink.apply(command(velocity=(.6, 0., 0.)), source='phone')
    sink.drain()
    assert normal.calls[-1] == ('Move', (.6, 0., 0.))
    generation = sink.generation
    sink.select_source('nav2')
    assert sink.source == 'nav2'
    assert sink.latched and sink.pending == (0., 0., 0.)
    assert sink.generation > generation
    sink.apply(command(velocity=(.6, 0., 0.)), source='nav2')
    sink.drain()
    assert sink.latched and normal.calls[-1][0] == 'StopMove'


def test_select_unknown_source_is_rejected():
    sink, _, _, _ = make_sink()
    with pytest.raises(ValueError):
        sink.select_source('evil')
    assert sink.source == 'phone'


def test_explicit_stop_wakes_emergency_worker_while_normal_move_is_blocked():
    sink, normal, emergency, clock = make_sink(offline_test_mode=False)
    entered, release, stopped = threading.Event(), threading.Event(), threading.Event()
    original_move, original_stop = normal.Move, emergency.StopMove

    def blocked_move(*velocity):
        if velocity != (0., 0., 0.):
            entered.set()
            assert release.wait(2), 'test must release fake SDK'
        return original_move(*velocity)

    def record_stop():
        result = original_stop()
        stopped.set()
        return result

    normal.Move = blocked_move
    emergency.StopMove = record_stop
    sink.start_threads()
    try:
        unlock(sink, clock)
        sink.apply(command(velocity=(.6, 0., 0.)), source='phone')
        assert entered.wait(1)
        generation = sink.generation
        sink.apply(command('stop'), source='anything')
        # The clock never advances: this must be STOP, not deadline expiry.
        assert stopped.wait(1), 'STOP must not wait for normal Move or watchdog expiry'
        assert not release.is_set() and clock() == 1000.
        assert sink.latched and sink.pending == (0., 0., 0.)
        assert sink.generation > generation
        assert emergency.calls[-2:] == [('Move', (0., 0., 0.)), ('StopMove', ())]
    finally:
        release.set()
        sink.close()
    assert not any(worker.is_alive() for worker in sink._threads)
    assert normal.calls[-2:] == [('Move', (0., 0., 0.)), ('StopMove', ())]


def test_stop_and_unlock_do_not_refresh_input_deadline():
    sink, _, _, clock = make_sink()
    unlock(sink, clock)
    clock.value += .20
    sink.apply(command('stop'), source='phone')
    assert sink.confirm_stopped(generation=sink.generation, sequence=2,
                                received_at=clock(), stationary=True)
    sink.apply(command('unlock'), source='phone')
    sink.drain()
    clock.value += .11
    assert sink.check_watchdog()


@pytest.mark.parametrize('bad_code', [1, None, False])
def test_sdk_failure_still_attempts_both_stop_operations(bad_code):
    sink, normal, emergency, _ = make_sink()
    normal.result = bad_code
    sink.apply(command('stop'), source='phone')
    with pytest.raises(OutputError):
        sink.drain()
    assert [x[0] for x in normal.calls[-2:]] == ['Move', 'StopMove']
    assert [x[0] for x in emergency.calls[-2:]] == ['Move', 'StopMove']
    assert sink.error is not None and sink.latched
    with pytest.raises(OutputError):
        sink.apply(command(), source='phone')


def test_blocked_move_does_not_own_emergency_lane_and_late_move_is_compensated():
    sink, normal, emergency, clock = make_sink()
    unlock(sink, clock)
    entered, release = threading.Event(), threading.Event()
    original = normal.Move

    def blocking(*velocity):
        if velocity != (0., 0., 0.):
            entered.set()
            assert release.wait(2), 'test must release blocked fake SDK'
        return original(*velocity)

    normal.Move = blocking
    sink.apply(command(velocity=(.6, 0., 0.)), source='phone')
    worker = threading.Thread(target=sink.drain)
    worker.start()
    try:
        assert entered.wait(1)
        clock.value += .31
        assert sink.check_watchdog()
        assert emergency.calls[-1][0] == 'StopMove' and sink.latched
    finally:
        release.set()
        worker.join(2)
    assert not worker.is_alive()
    assert normal.calls[-3:] == [('Move', (.6, 0., 0.)),
                                ('Move', (0., 0., 0.)), ('StopMove', ())]


def test_closed_output_and_same_client_are_rejected():
    normal = FakeSport()
    with pytest.raises(ValueError):
        Go2Sink(normal, normal)
    sink, normal, emergency, _ = make_sink()
    sink.close()
    before = list(normal.calls)
    sink.drain()
    assert normal.calls == before and emergency.calls[-1][0] == 'StopMove'
    with pytest.raises(OutputError):
        sink.apply(command(), source='phone')
