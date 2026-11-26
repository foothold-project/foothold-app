"""Fake SDK only: high-level mapping, authority, STOP and one-shot RPC races."""
import threading
import time
import pytest
from foothold_agent.go2_direct.actions import ACTIONS, FLAGS, DANGEROUS, LOWLEVEL, LOWLEVEL_QUERY, NO_FACTORY, arguments
from foothold_agent.go2_direct.sdk import SportBoundary
from foothold_agent.go2_direct.approval import Approval
from test_go2_posture import rig


def params(action):
    return dict(roll=.1, pitch=-.1, yaw=0.) if action == 'Euler' else dict(level=0) if action == 'SpeedLevel' else dict(enabled=True) if action in FLAGS else dict(mode='normal') if action == 'SelectMode' else {}


def send(frame, action='Hello', **kw):
    frame('action', request_id=kw.pop('request_id', 'request'), action=action,
          params=kw.pop('params', params(action)), lease_id=kw.pop('lease_id', 'fake-lease'), confirmed=kw.pop('confirmed', action in DANGEROUS), **kw)


@pytest.mark.parametrize('action', sorted(ACTIONS - NO_FACTORY))
def test_each_mapping_is_exactly_one_call_and_never_repeated(action):
    _, sink, normal, _, session, _, measured, frame = rig(0)
    calls = []
    def rpc(*args):
        calls.append((action, args))
        return (0, {'name': 'normal', 'form': '0'}) if action == 'CheckMode' else (0, True) if action == 'AutoRecoveryGet' else 0
    setattr(normal, action, rpc)
    send(frame, action)
    sink.drain(); sink.drain()
    if action == 'SelectMode':
        assert not calls
        assert sink.actions.result['code'] == 'MODE_READ_ONLY'
    else:
        # STOP has one additional existing safety pre-stop, not an action retry.
        assert calls == [(action, arguments(action, params(action)))] * (2 if action == 'StopMove' else 1)
        assert sink.actions.result['status'] == 'SUCCEEDED'
        assert sink.actions.result['sdk_code'] == 0
    assert session._state()['action_result'] == sink.actions.result


@pytest.mark.parametrize('condition,code', [('lease', 'NOT_AUTHORIZED'), ('approval', 'NOT_AUTHORIZED'), ('stale', 'STALE_STATE'), ('moving', 'MOVING'), ('ramp', 'MOVING'), ('input', 'MOVING'), ('posture', 'BUSY')])
def test_gates(condition, code):
    clock, sink, normal, _, session, _, measured, frame = rig(0)
    normal.Hello = lambda: pytest.fail('must not invoke')
    if condition == 'lease': session.lease_confirmed = False
    if condition == 'approval': session.posture_gate = lambda: False
    if condition == 'stale': clock.value += .201
    if condition == 'moving': measured(0, velocity=(.1, 0, 0))
    if condition == 'ramp': sink._ramp_velocity = (.1, 0, 0)
    if condition == 'input': session.core.intent = session.core.out = sink.pending = (.1, 0, 0)
    if condition == 'posture': sink.request_posture('pose', 'stand_down', 'fake-lease')
    send(frame)
    assert sink.actions.result['status'] == 'REJECTED'
    assert sink.actions.result['code'] == code


@pytest.mark.parametrize('action', sorted(DANGEROUS))
@pytest.mark.parametrize('condition,code', [('unconfirmed','CONFIRM_REQUIRED'), ('lying','STANDING_REQUIRED'), ('unknown','STANDING_REQUIRED'), ('moving','MOVING')])
def test_danger_requires_extra_confirmation_standing_and_still(action, condition, code):
    _, sink, normal, _, _, _, measured, frame = rig(0)
    if condition == 'lying': measured(5, body_height=.1)
    if condition == 'unknown': measured(7)
    if condition == 'moving': measured(0, velocity=(.1,0,0))
    send(frame, action, confirmed=condition != 'unconfirmed')
    assert sink.actions.result['code'] == code


def test_busy_posture_interlock_and_duplicate_replay_rejected():
    _, sink, normal, _, _, _, _, frame = rig(0)
    normal.Hello = lambda: 0
    send(frame)
    assert not sink.request_posture('pose', 'stand_down', 'fake-lease')
    assert sink.posture_result['code'] == 'BUSY'
    send(frame, request_id='second')
    assert sink.actions.result['code'] == 'BUSY'
    sink.drain()
    send(frame)
    assert sink.actions.result['code'] == 'DUPLICATE'


@pytest.mark.parametrize('transition,code', [('stop','STOPPED'), ('approval','AUTHORITY_LOST'), ('lease','LEASE_CHANGED'), ('close','DISCONNECTED'), ('timeout','TIMEOUT')])
def test_inflight_rpc_does_not_block_stop_or_accept_late_success(transition, code):
    clock, sink, normal, emergency, session, _, _, frame = rig(0)
    entered, release = threading.Event(), threading.Event()
    def hello():
        entered.set(); assert release.wait(2); return 0
    normal.Hello = hello
    send(frame)
    worker = threading.Thread(target=sink.drain)
    worker.start()
    try:
        assert entered.wait(1)
        before = time.monotonic()
        if transition == 'stop': frame('stop', stop_ref=25)
        elif transition == 'approval': session.posture_gate = lambda: False
        elif transition == 'lease': frame('lease', lease_id=None, holder_type=None)
        elif transition == 'close': session.shutdown()
        elif transition == 'timeout': clock.value += 3
        sink.check_watchdog()
        assert time.monotonic()-before < .1
        assert ('StopMove', ()) in emergency.calls
        assert sink.actions.result['code'] == code
        assert sink.posture_busy  # in-flight call cannot be replaced even after cancellation
    finally:
        release.set(); worker.join(2)
    assert sink.actions.result['code'] == code
    assert not sink.posture_busy


@pytest.mark.parametrize('result,code', [(73,'SDK_REJECTED'), (True,'SDK_REJECTED'), (None,'SDK_REJECTED'), (TimeoutError(),'TIMEOUT'), (NotImplementedError(),'UNSUPPORTED'), (RuntimeError('private'),'SDK_ERROR')])
def test_failures_keep_numeric_sdk_code_and_do_not_expose_exception(result, code):
    _, sink, normal, _, session, _, _, frame = rig(0)
    def hello():
        if isinstance(result, Exception): raise result
        return result
    normal.Hello = hello
    send(frame); sink.drain()
    assert sink.actions.result['code'] == code
    assert sink.actions.result['sdk_code'] == (result if type(result) is int else None)
    assert 'private' not in str(sink.actions.result)
    assert session.connected


@pytest.mark.parametrize('action', sorted(ACTIONS - NO_FACTORY - {'SelectMode', 'StopMove', 'CheckMode'}))
def test_boundary_approval_covers_every_highlevel_action(action):
    clock, _, normal, _, _, _, _, _ = rig(0)
    boundary = SportBoundary(normal, Approval('fake', 'fake-serial', 1100), now=clock, wall=clock)
    clock.value = 1100
    with pytest.raises(PermissionError): getattr(boundary, action)(*arguments(action, params(action)))


def test_action_argument_validation_without_sdk():
    _, sink, normal, _, _, _, _, frame = rig(0)
    send(frame, 'Euler', params=dict(roll=9, pitch=0, yaw=0))
    assert sink.actions.result['code'] == 'INVALID_ARGUMENTS'
    for name in ('ReleaseMode', 'Move', 'lowcmd', '_Call'):
        assert not sink.actions.request('invalid', name, {}, 'fake-lease')
    boundary = SportBoundary(normal, Approval('fake','serial',1100))
    for name in ('ReleaseMode', 'lowcmd', '_Call'):
        with pytest.raises(AttributeError): getattr(boundary, name)


def test_stop_during_method_lookup_prevents_starting_cancelled_action():
    _, sink, normal, emergency, _, _, _, frame = rig(0)
    calls = []
    class LookupSport(type(normal)):
        @property
        def Hello(self):
            frame('stop', stop_ref=25)
            sink.check_watchdog()
            return lambda: calls.append('Hello') or 0
    normal.__class__ = LookupSport
    send(frame)
    sink.drain()
    assert not calls
    assert sink.actions.result['code'] == 'STOPPED'
    assert ('StopMove', ()) in emergency.calls


def test_check_mode_uses_bounded_readonly_switcher_and_never_selects(monkeypatch):
    import sys
    from types import ModuleType
    clock, _, normal, _, _, _, _, _ = rig(0)
    calls = []
    class Switcher:
        def SetTimeout(self, value): calls.append(('timeout', value))
        def Init(self): calls.append(('init',))
        def CheckMode(self): calls.append(('check',)); return 0, {'name': 'normal'}
    for name in ('unitree_sdk2py', 'unitree_sdk2py.comm', 'unitree_sdk2py.comm.motion_switcher', 'unitree_sdk2py.comm.motion_switcher.motion_switcher_client'):
        monkeypatch.setitem(sys.modules, name, ModuleType(name))
    sys.modules['unitree_sdk2py.comm.motion_switcher.motion_switcher_client'].MotionSwitcherClient = Switcher
    boundary = SportBoundary(normal, Approval('fake','serial',1100), now=clock, wall=clock)
    assert boundary.CheckMode() == (0, {'name': 'normal'})
    assert calls == [('timeout', .1), ('init',), ('check',)]
    assert boundary.CheckMode()[0] == 0
    assert calls.count(('init',)) == 1
    with pytest.raises(AttributeError): boundary.SelectMode('normal')
    clock.value = 1100
    with pytest.raises(PermissionError): boundary.CheckMode()


@pytest.mark.parametrize('sdk_code,reason', [(3102,'SDK_SEND_FAILED'), (3103,'UNSUPPORTED'), (3104,'TIMEOUT'), (3105,'SDK_VERSION_MISMATCH'), (3106,'SDK_ARGUMENTS'), (3107,'SDK_AUTHORITY'), (3203,'UNSUPPORTED'), (3204,'SDK_ARGUMENTS'), (3205,'SDK_AUTHORITY'), (3206,'SDK_AUTHORITY'), (3207,'SDK_BUSY')])
def test_documented_sdk_errors_keep_number_and_plain_reason(sdk_code, reason):
    _, sink, normal, _, _, _, _, frame = rig(0)
    normal.Hello = lambda: sdk_code
    send(frame); sink.drain()
    assert sink.actions.result['sdk_code'] == sdk_code
    assert sink.actions.result['code'] == reason
    assert sink.actions.result['status'] == 'FAILED'



def test_routine_held_stop_is_published_without_cancelling_own_action():
    _, sink, normal, emergency, session, _, measured, frame = rig(0)
    entered, release = threading.Event(), threading.Event()
    def hello():
        entered.set(); assert release.wait(2); return 0
    normal.Hello = hello
    send(frame)
    worker = threading.Thread(target=sink.drain)
    worker.start()
    try:
        assert entered.wait(1)
        # Core keeps publishing the same STOP while waiting for measured stop.
        session.core.st = {**session.core.st, 'stop_requested': False}
        frame('ping')
        assert sink.actions.result['status'] == 'RUNNING'
        assert sink.latched
        sink.check_watchdog()
        assert ('StopMove', ()) in emergency.calls
        assert sink.actions.result['status'] == 'RUNNING'
    finally:
        release.set(); worker.join(2)
    assert sink.actions.result['status'] == 'SUCCEEDED'


@pytest.mark.parametrize('source,offset', [('server', 1), ('phone', 0), ('nav2', 0)])
def test_new_core_stop_generation_or_other_source_cancels_while_repeated_hold_does_not(source, offset):
    from foothold_agent.link.session import MotionCommand
    _, sink, normal, _, session, _, _, frame = rig(0)
    send(frame)
    sink.apply(MotionCommand('stop', stop_generation=session.core.stop_gen), source='server')
    assert sink.actions.result['status'] == 'RUNNING'
    sink.apply(MotionCommand('stop', stop_generation=session.core.stop_gen+offset), source=source)
    assert sink.actions.result['code'] == 'STOPPED'
    normal.Hello = lambda: pytest.fail('cancelled action must never start')
    sink.drain()



def test_request_ids_are_scoped_to_the_lease_not_a_previous_browser_connection():
    _, sink, normal, _, _, _, measured, frame = rig(0)
    calls = []
    normal.Hello = lambda: calls.append('Hello') or 0
    send(frame); sink.drain()
    frame('lease', lease_id='new-lease', holder_type='USER')
    measured(0)
    send(frame, lease_id='new-lease')
    sink.drain()
    assert calls == ['Hello','Hello']
    assert sink.actions.result['status'] == 'SUCCEEDED'



def test_failed_rpc_requests_stop_on_the_existing_independent_lane():
    _, sink, normal, emergency, _, _, _, frame = rig(0)
    sink.check_watchdog()
    emergency.calls.clear()
    normal.Hello = lambda: 3104
    send(frame); sink.drain()
    assert sink.actions.result['code'] == 'TIMEOUT'
    assert sink.check_watchdog()
    assert ('StopMove', ()) in emergency.calls
    assert sink.error is None


def start_rig(tmp_path, monkeypatch, port=None):
    from foothold_agent.policy import trace
    flag = tmp_path / 'foothold-start-active'
    monkeypatch.setattr(trace, 'START_FLAG', flag)
    if port is None: monkeypatch.delenv('FH_START_MOVE_PORT', raising=False)
    else: monkeypatch.setenv('FH_START_MOVE_PORT', str(port))
    r = rig(0)
    for name in ACTIONS:
        setattr(r[2], name, lambda *a, name=name: pytest.fail(f'{name} must not invoke during START'))
    flag.touch()
    return flag, r


def test_start_active_blocks_sport_actions_and_drive(tmp_path, monkeypatch):
    # 팀장 11/25 20:50: START 저수준 제어 중에는 이 프로그램이 순정 동작 · 걷기를 보내지 않는다 (조종 권한 하나).
    # 팀장 11/26 08:01: 그중 실행기 동작 (LOWLEVEL) 만 실행기로 넘기고, 나머지는 LOWLEVEL_UNSUPPORTED.
    # 팀장 11/26 10:19: 읽기 전용 조회 (LOWLEVEL_QUERY) 는 #498 처럼 순정 SDK 로.
    flag, (_, sink, normal, _, session, _, measured, frame) = start_rig(tmp_path, monkeypatch)
    for i, action in enumerate(sorted(ACTIONS - set(LOWLEVEL) - LOWLEVEL_QUERY)):
        send(frame, action, request_id=f'r{i}')
        sink.drain(); sink.drain()
        assert sink.actions.result['status'] == 'REJECTED' and sink.actions.result['code'] == 'LOWLEVEL_UNSUPPORTED', action
    assert sink.movement_reason(neutral=True).startswith('START 저수준 제어 중')
    assert session._state()['control'] == 'LOWLEVEL'
    normal.CheckMode = lambda: (0, {'name': 'normal', 'form': '0'})
    normal.StopMove = lambda: 0   # #498 부터 조회 앞 안전 정지가 순정 StopMove 로 나감 (미확인 위험 · 보고에 적음)
    send(frame, 'CheckMode', request_id='read')
    sink.drain(); sink.drain()
    assert (sink.actions.result['status'], sink.actions.result['code']) == ('SUCCEEDED', 'SDK_ACCEPTED')
    flag.unlink()
    assert session._state()['control'] == 'FACTORY'
    assert sink.movement_reason(neutral=True) is None or 'START' not in sink.movement_reason(neutral=True)


def test_start_lowlevel_actions_without_runner_port_are_not_connected(tmp_path, monkeypatch):
    _, (_, sink, _, _, _, _, _, frame) = start_rig(tmp_path, monkeypatch)
    for i, action in enumerate(sorted(LOWLEVEL)):
        send(frame, action, request_id=f'r{i}')
        sink.drain()
        assert (sink.actions.result['status'], sink.actions.result['code']) == ('REJECTED', 'RUNNER_NOT_CONNECTED'), action
    assert sink.actions.job is None and not sink.actions.busy


def test_start_lowlevel_actions_go_to_runner_as_remote_keys(tmp_path, monkeypatch):
    import json, socket
    rx = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); rx.bind(('127.0.0.1', 0)); rx.settimeout(1.)
    try:
        _, (_, sink, _, _, _, _, _, frame) = start_rig(tmp_path, monkeypatch, rx.getsockname()[1])
        seqs = []
        for i, action in enumerate(sorted(LOWLEVEL)):
            send(frame, action, request_id=f'r{i}')
            assert (sink.actions.result['status'], sink.actions.result['code']) == ('SUCCEEDED', 'RUNNER_SENT'), action
            msg = json.loads(rx.recv(512))
            assert msg['key'] == LOWLEVEL[action] and msg['action'] == action and msg['request_id'] == f'r{i}'
            seqs.append(msg['seq'])
        assert seqs == sorted(seqs) and len(set(seqs)) == len(seqs)
        assert sink.actions.job is None
        # 같은 요청 다시 · 위험 동작 확인 없음 · 조종권 없음은 보내지 않는다
        send(frame, 'Sit', request_id='r0'); assert sink.actions.result['code'] == 'DUPLICATE'
        send(frame, 'Damp', request_id='d', confirmed=False); assert sink.actions.result['code'] == 'CONFIRM_REQUIRED'
        send(frame, 'Sit', request_id='x', lease_id='other'); assert sink.actions.result['code'] == 'NOT_AUTHORIZED'
        rx.settimeout(.05)
        with pytest.raises(socket.timeout): rx.recv(512)
    finally:
        rx.close()


def test_start_posture_lie_down_goes_to_runner_and_stand_up_is_grey(tmp_path, monkeypatch):
    import json, socket
    rx = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); rx.bind(('127.0.0.1', 0)); rx.settimeout(1.)
    try:
        _, (_, sink, _, _, _, _, _, frame) = start_rig(tmp_path, monkeypatch, rx.getsockname()[1])
        frame('posture', request_id='up', lease_id='fake-lease', action='stand_up')
        assert (sink.posture_result['status'], sink.posture_result['code']) == ('REJECTED', 'LOWLEVEL_UNSUPPORTED')
        frame('posture', request_id='down', lease_id='fake-lease', action='stand_down')
        assert (sink.posture_result['status'], sink.posture_result['code']) == ('SUCCEEDED', 'RUNNER_SENT')
        assert json.loads(rx.recv(512))['key'] == 'L2+A'
        assert sink._posture is None
    finally:
        rx.close()



def test_greet_has_no_factory_sdk_call(tmp_path, monkeypatch):
    # 팀장 11/26 10:17: 인사 (Greet) 는 순정 SDK 번호가 없다. 순정에서는 번호를 지어내지 않고 거부한다.
    from foothold_agent.policy import trace
    monkeypatch.setattr(trace, 'START_FLAG', tmp_path / 'foothold-start-active')
    clock, sink, normal, _, _, _, _, frame = rig(0)
    normal.Greet = lambda: pytest.fail('no factory Greet')
    send(frame, 'Greet'); sink.drain(); sink.drain()
    assert (sink.actions.result['status'], sink.actions.result['code']) == ('REJECTED', 'FACTORY_UNSUPPORTED')
    assert sink.actions.job is None
    boundary = SportBoundary(normal, Approval('fake', 'fake-serial', 1100), now=clock, wall=clock)
    with pytest.raises(AttributeError): boundary.Greet
