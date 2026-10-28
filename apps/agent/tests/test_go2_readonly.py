"""Fake DDS only; HTTP tests bind loopback in FH_TEST_PORT_RANGE, no multicast."""

import ast
from contextlib import contextmanager
from http.client import HTTPConnection
import importlib
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import threading
from types import ModuleType, SimpleNamespace as NS

import pytest

from foothold_agent.go2_readonly import State
from foothold_agent.go2_readonly.http import Access, ReadonlyAdvertisement, make_server
from foothold_agent.go2_readonly.sdk import Subscriptions


class Clock:
    t = 0.
    offset = 0.

    def __call__(self):
        return self.t

    def wall(self):
        return 1800000000. + self.t + self.offset


def low(tick=1, soc=72, voltage=29.4, roll=.1, pitch=-.2):
    return NS(tick=tick, bms_state=NS(soc=soc), power_v=voltage,
              imu_state=NS(rpy=[roll, pitch, 0.]))


def sport(sec=1, nsec=0, mode=3, error=0):
    return NS(stamp=NS(sec=sec, nanosec=nsec), mode=mode, error_code=error)


def measured():
    clock = Clock()
    state = State(now=clock, wall=clock.wall)
    state.lowstate(low())
    state.sportmodestate(sport())
    return state, clock


def fake_sdk(monkeypatch, fail_topic=None):
    calls, callbacks = [], {}

    def forbidden(*args, **kwargs):
        raise AssertionError('publisher/request client construction is forbidden')

    class Subscriber:
        def __init__(self, topic, data_type):
            assert topic in ('rt/lowstate', 'rt/sportmodestate')
            self.topic = topic
            calls.append(('subscribe', topic, data_type))

        def Init(self, callback, queue):
            assert queue == 0
            callbacks[self.topic] = callback
            if self.topic == fail_topic:
                raise RuntimeError('fake subscription failure')

        def Close(self):
            calls.append(('close', self.topic))

    module = ModuleType('unitree_sdk2py.core.channel')
    module.ChannelFactoryInitialize = lambda domain, nic: calls.append(('initialize', domain, nic))
    module.ChannelSubscriber = Subscriber
    module.ChannelPublisher = module.DataWriter = module.CreateSendChannel = forbidden
    module.Client = module.SportClient = forbidden
    def missing(name):
        if name.startswith('__'):
            raise AttributeError(name)
        return forbidden()
    module.__getattr__ = missing
    idl = ModuleType('unitree_sdk2py.idl.unitree_go.msg.dds_')
    idl.LowState_, idl.SportModeState_ = type('LowState_', (), {}), type('SportModeState_', (), {})
    monkeypatch.setitem(sys.modules, module.__name__, module)
    monkeypatch.setitem(sys.modules, idl.__name__, idl)
    return calls, callbacks, forbidden


def test_real_adapter_against_fake_sdk_has_exactly_two_subscribers_and_zero_commands(monkeypatch):
    calls, callbacks, _ = fake_sdk(monkeypatch)
    state, clock = measured()
    adapter = Subscriptions(state, 'eth-test')
    adapter.start()
    clock.t = 1
    callbacks['rt/lowstate'](low(tick=2, soc=31))
    callbacks['rt/sportmodestate'](sport(sec=2, mode=7))
    assert state.snapshot()['battery']['soc'] == 31
    assert state.snapshot()['mode'] == 7
    adapter.close()
    adapter.close()
    assert [c[:2] for c in calls] == [
        ('initialize', 0), ('subscribe', 'rt/lowstate'), ('subscribe', 'rt/sportmodestate'),
        ('close', 'rt/sportmodestate'), ('close', 'rt/lowstate')]
    assert calls[0][2] == 'eth-test'


def test_fake_sdk_traps_publisher_and_sport_request_mutations(monkeypatch):
    _, _, forbidden = fake_sdk(monkeypatch)
    # Prove the fake boundary fails if either command-construction mutation is introduced.
    for constructor in ('ChannelPublisher', 'SportClient'):
        with pytest.raises(AssertionError, match='forbidden'):
            getattr(sys.modules['unitree_sdk2py.core.channel'], constructor)('rt/api/sport/request')
    assert callable(forbidden)


def test_partial_sdk_start_failure_closes_both_subscriptions(monkeypatch):
    calls, _, _ = fake_sdk(monkeypatch, 'rt/sportmodestate')
    adapter = Subscriptions(State(), 'eth0')
    with pytest.raises(RuntimeError, match='fake'):
        adapter.start()
    assert calls[-2:] == [('close', 'rt/sportmodestate'), ('close', 'rt/lowstate')]
    with pytest.raises(RuntimeError, match='once'):
        adapter.start()


@pytest.mark.parametrize('nic', ['', None, 'eth0<x>', 'x' * 16])
def test_nic_must_be_explicit_before_sdk_import(nic):
    with pytest.raises(ValueError):
        Subscriptions(State(), nic)


def test_import_contract_has_no_motion_core_ros_or_request_dependencies():
    package = Path(importlib.import_module('foothold_agent.go2_readonly').__file__).parent
    allowed_sdk = {
        'unitree_sdk2py.core.channel': {'ChannelFactoryInitialize', 'ChannelSubscriber'},
        'unitree_sdk2py.idl.unitree_go.msg.dds_': {'LowState_', 'SportModeState_'},
    }
    forbidden = ('publisher', 'sportclient', 'stopmove', 'standup', 'datawriter',
                 'createsendchannel', 'move', 'request', 'client')
    for path in package.glob('*.py'):
        tree = ast.parse(path.read_text())
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom):
                module = node.module or ''
                if module.startswith('unitree_sdk2py'):
                    assert {n.name for n in node.names} <= allowed_sdk[module]
                if module.startswith('foothold_agent'):
                    assert module == 'foothold_agent.discovery'
                assert not module.startswith(('rclpy', 'cyclonedds', 'rospy'))
            if isinstance(node, ast.Import):
                assert all(not n.name.startswith(('unitree_sdk2py', 'cyclonedds', 'rclpy',
                                                  'foothold_agent.safety')) for n in node.names)
            if isinstance(node, ast.Call):
                name = (node.func.id if isinstance(node.func, ast.Name) else
                        node.func.attr if isinstance(node.func, ast.Attribute) else '')
                assert name.lower() not in forbidden
                if name.lower() == 'write':
                    assert (path.name == 'http.py' and name == 'write'
                            and isinstance(node.func.value, ast.Attribute)
                            and node.func.value.attr == 'wfile')


def test_all_module_imports_and_help_never_join_dds_or_open_network():
    code = '''
import sys, socket
def deny(*a, **kw): raise AssertionError('network or SDK import during help/import')
class Block:
    def find_spec(self, fullname, *a):
        if fullname.startswith(('unitree_sdk2py', 'cyclonedds', 'rclpy',
                                'foothold_agent.phone', 'foothold_agent.safety',
                                'foothold_agent.link', 'foothold_agent.ros_bridge')): deny()
sys.meta_path.insert(0, Block())
class DenySocket(socket.socket):
    def __init__(self, *a, **kw): deny()
socket.socket = DenySocket
from foothold_agent.go2_readonly import state, sdk, http, __main__
__main__.main(['--help'])
'''
    result = subprocess.run([sys.executable, '-c', code], text=True, capture_output=True)
    assert result.returncode == 0, result.stderr


def test_empty_is_offline_and_has_no_fabricated_values():
    value = State().snapshot()
    assert value['connection'] == 'OFFLINE'
    assert value['battery'] == {'soc': None, 'voltage': None}
    assert value['attitude'] == {'roll': None, 'pitch': None}
    assert value['mode'] is value['fallen'] is value['last_received_at'] is None
    assert value['gate'] == 'READ_ONLY' and value['motion_enabled'] is False


def test_conversion_and_independent_freshness():
    state, clock = measured()
    value = state.snapshot()
    assert value['connection'] == 'ONLINE'
    assert value['battery'] == {'soc': 72, 'voltage': 29.4}
    assert value['attitude'] == {'roll': .1, 'pitch': -.2}
    assert value['mode'] == 3 and value['error_code'] == 0 and value['fallen'] is False
    assert value['sources']['lowstate']['age_s'] == 0
    assert value['last_received_at'].endswith('+00:00')
    clock.t = 2.01
    state.sportmodestate(sport(sec=2))
    value = state.snapshot()
    assert value['connection'] == 'STALE'
    assert value['battery']['soc'] is value['fallen'] is None
    assert value['mode'] == 3
    clock.t = 13
    assert state.snapshot()['connection'] == 'OFFLINE'
    assert state.snapshot()['mode'] is None
    state.lowstate(low(tick=2))
    assert state.snapshot()['connection'] == 'STALE'
    state.sportmodestate(sport(sec=3))
    assert state.snapshot()['connection'] == 'ONLINE'


@pytest.mark.parametrize('age,expected', [(2., 'ONLINE'), (2.001, 'STALE'),
                                          (10., 'STALE'), (10.001, 'OFFLINE')])
def test_freshness_boundaries(age, expected):
    state, clock = measured()
    clock.t = age
    assert state.snapshot()['connection'] == expected


def test_missing_topic_cannot_be_online_and_persistent_one_topic_is_stale():
    clock = Clock()
    state = State(now=clock, wall=clock.wall)
    state.lowstate(low())
    assert state.snapshot()['connection'] == 'STALE'
    clock.t = 50
    state.lowstate(low(tick=2))
    assert state.snapshot()['connection'] == 'STALE'
    assert state.snapshot()['mode'] is None


def test_duplicates_regressions_and_malformed_stamps_cannot_refresh():
    state, clock = measured()
    sample = sport(sec=2)
    state.sportmodestate(sample)
    clock.t = 3
    state.lowstate(low(tick=1, soc=100))
    state.lowstate(low(tick=0))
    state.sportmodestate(sample)
    sample.mode = 7  # Mutating the same callback object is not a new DDS receipt.
    state.sportmodestate(sample)
    state.sportmodestate(sport(sec=1))
    state.sportmodestate(sport(sec=0))
    state.lowstate(NS())
    state.sportmodestate(sport(nsec=1000000000))
    assert state.snapshot()['connection'] == 'STALE'
    assert all(s['age_s'] == 3 for s in state.snapshot()['sources'].values())


@pytest.mark.parametrize('stamp', [None, 0, 42])
def test_unset_or_constant_sport_stamp_uses_distinct_receipts_and_expires(stamp):
    clock = Clock()
    state = State(now=clock, wall=clock.wall)
    for tick in range(1, 5):
        clock.t = tick * 3
        sample = (NS(mode=3, error_code=0) if stamp is None else sport(sec=stamp))
        state.lowstate(low(tick=tick))
        state.sportmodestate(sample)
        assert state.snapshot()['connection'] == 'ONLINE'
        assert state.snapshot()['mode'] == 3
    clock.t += 2.01
    assert state.snapshot()['connection'] == 'STALE'
    assert state.snapshot()['mode'] is None
    clock.t += 8
    assert state.snapshot()['connection'] == 'OFFLINE'


@pytest.mark.parametrize('stamp', [None, 0, 42])
def test_same_sport_object_cannot_refresh_even_if_mutated(stamp):
    clock = Clock()
    state = State(now=clock, wall=clock.wall)
    sample = NS(mode=3, error_code=0) if stamp is None else sport(sec=stamp)
    state.sportmodestate(sample)
    clock.t = 3
    sample.mode = 7
    if stamp is not None:
        sample.stamp.sec += 1
    state.sportmodestate(sample)
    state.lowstate(low())
    assert state.snapshot()['connection'] == 'STALE'
    assert state.snapshot()['sources']['sportmodestate']['age_s'] == 3
    assert state.snapshot()['mode'] is None


def test_tick_wrap_and_wall_clock_jump_do_not_break_monotonic_freshness():
    state, clock = measured()
    state.lowstate(low(tick=0xFFFFFFFE))
    clock.t = 1
    clock.offset = -1000
    state.lowstate(low(tick=3))
    assert state.snapshot()['sources']['lowstate']['age_s'] == 0
    assert state.snapshot()['last_received_at'] == state.snapshot()['sources']['lowstate']['received_at']
    assert state.snapshot()['connection'] == 'ONLINE'
    clock.t = -1
    assert state.snapshot()['connection'] != 'ONLINE'
    assert state.snapshot()['battery']['soc'] is None


@pytest.mark.parametrize('value', [None, True, -1, 101, math.inf, math.nan, '72'])
def test_bad_soc_is_unknown(value):
    state = State()
    state.lowstate(low(soc=value))
    assert state.snapshot()['battery']['soc'] is None
    json.dumps(state.snapshot(), allow_nan=False)


@pytest.mark.parametrize('value', [None, True, 0, -1, math.inf, math.nan, 101])
def test_bad_voltage_is_unknown(value):
    state = State()
    state.lowstate(low(voltage=value))
    assert state.snapshot()['battery']['voltage'] is None


@pytest.mark.parametrize('roll,pitch,fallen', [(1.1, 0., True), (0., -1.1, True),
                                            (.2, -.1, False), (math.nan, 0., None),
                                            (0., None, None), (4., 0., None)])
def test_fallen_is_labelled_tilt_estimate_not_authority(roll, pitch, fallen):
    state = State()
    state.lowstate(low(roll=roll, pitch=pitch))
    assert state.snapshot()['fallen'] is fallen
    assert state.snapshot()['fallen_source'] == 'imu_tilt_estimate'
    assert state.snapshot()['motion_enabled'] is False


def test_invalid_mode_error_and_mutation_of_returned_snapshot():
    state, _ = measured()
    state.sportmodestate(sport(sec=2, mode=True, error=-1))
    value = state.snapshot()
    assert value['mode'] is value['error_code'] is None
    value['battery']['soc'] = 999
    assert state.snapshot()['battery']['soc'] == 72


@contextmanager
def running_http():
    state, clock = measured()
    access = Access(now=clock)
    first, last = map(int, os.environ.get('FH_TEST_PORT_RANGE', '9610:9619').split(':'))
    server = None
    for port in range(first, last + 1):
        try:
            server = make_server(('127.0.0.1', port), state, access)
            break
        except OSError:
            continue
    assert server is not None, 'no free test port in FH_TEST_PORT_RANGE'
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        def request(method='GET', path='/go2/status', code=None):
            connection = HTTPConnection('127.0.0.1', server.server_port, timeout=3)
            try:
                headers = {} if code is None else {'X-Foothold-Code': code}
                connection.request(method, path, headers=headers)
                response = connection.getresponse()
                raw = response.read()
                return response.status, dict(response.headers), json.loads(raw) if raw else None
            finally:
                connection.close()
        yield state, clock, access, request
    finally:
        server.shutdown()
        server.server_close()
        thread.join(3)


def test_http_code_required_get_only_and_no_control_routes():
    with running_http() as (state, clock, access, request):
        status, headers, body = request()
        assert status == 401 and 'battery' not in body
        status, headers, body = request(code=access.code)
        assert status == 200 and body['connection'] == 'ONLINE'
        assert headers['Cache-Control'] == 'no-store'
        assert 'Access-Control-Allow-Origin' not in headers
        for path in ('/phone/ws', '/cmd', '/stop', '/go2/status?code=' + access.code):
            assert request(path=path, code=access.code)[0] == 404
        for method in ('POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD'):
            assert request(method=method, code=access.code)[0] == 405
        clock.t = 3
        assert request(code=access.code)[2]['connection'] == 'STALE'
        clock.t = 11
        assert request(code=access.code)[2]['connection'] == 'OFFLINE'
        clock.t = 1800
        assert request(code=access.code)[0] == 401


def test_code_rate_limit_and_non_ascii_header_never_exposes_status():
    with running_http() as (_, clock, access, request):
        for _ in range(5):
            assert request(code='é')[0] == 401
        status, headers, body = request(code=access.code)
        assert status == 429 and headers['Retry-After'] == '60'
        assert 'battery' not in body
        clock.t = 60
        assert request(code=access.code)[0] == 200


def test_readonly_discovery_contract_has_http_mode_and_no_pairing_secret():
    ad = ReadonlyAdvertisement('192.0.2.8', 9610, name='상태 전용')
    assert ad.properties == {
        b'v': b'1', b'name': '상태 전용'.encode(), b'model': b'Go2 EDU',
        b'mode': b'go2-readonly', b'agent': b'http://192.0.2.8:9610/go2/status'}
    assert b'rid' not in ad.properties


def test_cli_invalid_configuration_and_bind_failure_precede_dds(monkeypatch):
    from foothold_agent.go2_readonly import __main__ as cli
    monkeypatch.setattr(cli.socket, 'if_nameindex', lambda: [(1, 'fake-nic')])
    calls, _, _ = fake_sdk(monkeypatch)
    for args in (['--nic', 'missing'], ['--nic', 'fake-nic', '--listen', '0.0.0.0'],
                 ['--nic', 'fake-nic', '--advertise']):
        with pytest.raises(SystemExit) as error:
            cli.main(args)
        assert error.value.code == 2
    monkeypatch.setattr(cli.signal, 'signal', lambda *a: None)
    monkeypatch.setattr(cli, 'make_server', lambda *a: (_ for _ in ()).throw(OSError('bind failure')))
    assert cli.main(['--nic', 'fake-nic']) == 1
    assert not calls


def test_cli_thread_start_failure_never_waits_for_unstarted_http_worker(monkeypatch):
    from foothold_agent.go2_readonly import __main__ as cli
    calls, _, _ = fake_sdk(monkeypatch)
    monkeypatch.setattr(cli.socket, 'if_nameindex', lambda: [(1, 'fake-nic')])
    monkeypatch.setattr(cli.signal, 'signal', lambda *a: None)
    closed = []

    class BrokenThread:
        def __init__(self, **kwargs):
            pass

        def start(self):
            raise RuntimeError('no threads available')

        def is_alive(self):
            return False

    def forbidden_shutdown():
        pytest.fail('shutdown waits forever if serve_forever never started')

    server = NS(serve_forever=lambda: None, shutdown=forbidden_shutdown,
                server_close=lambda: closed.append(True))
    monkeypatch.setattr(cli, 'make_server', lambda *a: server)
    monkeypatch.setattr(cli.threading, 'Thread', BrokenThread)
    assert cli.main(['--nic', 'fake-nic']) == 1
    assert closed == [True]
    assert calls[-2:] == [('close', 'rt/sportmodestate'), ('close', 'rt/lowstate')]


@pytest.mark.parametrize('json_output', [False, True])
def test_cli_keeps_field_code_visible_by_default_without_real_network(monkeypatch, capsys, json_output):
    from foothold_agent.go2_readonly import __main__ as cli
    fake_sdk(monkeypatch)
    monkeypatch.setattr(cli.socket, 'if_nameindex', lambda: [(1, 'fake-nic')])
    monkeypatch.setattr(cli.signal, 'signal', lambda *a: None)
    waits = iter([False, False, True])
    monkeypatch.setattr(cli, 'threading', NS(
        Event=lambda: NS(wait=lambda _: next(waits)),
        Thread=lambda **kw: NS(start=lambda: None, is_alive=lambda: False)))
    monkeypatch.setattr(cli, 'make_server', lambda *a: NS(
        serve_forever=lambda: None, server_close=lambda: None))
    args = ['--nic', 'fake-nic'] + (['--json'] if json_output else [])
    assert cli.main(args) == 0
    lines = capsys.readouterr().out.splitlines()
    assert lines[1].startswith('Field code (30 minutes; restart to renew): ')
    assert len(lines) == (4 if json_output else 2)
    if json_output:
        assert all(json.loads(line)['connection'] == 'OFFLINE' for line in lines[2:])
