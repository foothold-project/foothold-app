"""Fake SDK only: high-level mapping, authority, STOP and one-shot RPC races."""
import threading
import time
import pytest
from foothold_agent.go2_direct.actions import ACTIONS, FLAGS, DANGEROUS, arguments
from foothold_agent.go2_direct.sdk import SportBoundary
from foothold_agent.go2_direct.approval import Approval
from test_go2_posture import rig


def params(action):
    return dict(roll=.1, pitch=-.1, yaw=0.) if action == 'Euler' else dict(level=0) if action == 'SpeedLevel' else dict(enabled=True) if action in FLAGS else dict(mode='normal') if action == 'SelectMode' else {}


def send(frame, action='Hello', **kw):
    frame('action', request_id=kw.pop('request_id', 'request'), action=action,
          params=kw.pop('params', params(action)), lease_id=kw.pop('lease_id', 'fake-lease'), confirmed=kw.pop('confirmed', action in DANGEROUS), **kw)


@pytest.mark.parametrize('action', sorted(ACTIONS))
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


@pytest.mark.parametrize('action', sorted(ACTIONS - {'SelectMode', 'StopMove', 'CheckMode'}))
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
