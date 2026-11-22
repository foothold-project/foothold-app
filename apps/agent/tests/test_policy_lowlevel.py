"""저수준 실행기 순서 · 안전 (가짜 SDK · 가짜 정책). 실기 · SDK 없이."""
import struct

import numpy as np
import pytest

from foothold_agent.policy import lowlevel
from foothold_agent.policy.lowlevel import LowLevelRunner, Phase, parse_remote, command_from_remote
from foothold_agent.policy.start import DEFAULT_POSE, SDK_FROM_POLICY


def remote(*keys, lx=0., ly=0., rx=0.):
    bits = sum(1 << lowlevel.KEYS.index(k) for k in keys)
    return b'\x55\x51' + struct.pack('<H5f', bits, lx, rx, 0., 0., ly) + bytes(14)


class Clock:
    def __init__(self): self.t = 100.
    def __call__(self): return self.t


class FakeSdk:
    def __init__(self, clock):
        self.clock, self.calls, self.sent = clock, [], []
        self.quat, self.keys, self.mode_left, self.mode = (1, 0, 0, 0), (), 2, 'mcf'
        self.select_ok = True
        self.q = np.zeros(12)
    def low_state(self):
        self.clock.t += .005
        return self.clock.t, self.quat, (0, 0, 0), self.q, np.zeros(12), remote(*self.keys)
    def send(self, q, dq, kp, kd, tau): self.sent.append((np.array(q), float(kp[0]), float(kd[0])))
    def stand_down(self): self.calls.append('stand_down')
    def release_mode(self):
        self.calls.append('release_mode'); self.mode_left -= 1
        if self.mode_left <= 0: self.mode = ''
    def check_mode(self):
        self.calls.append('check_mode')
        if self.mode == '': return ''
        return self.mode if self.mode_left > 0 else ''
    def select_mode(self, name):
        self.calls.append(f'select_mode:{name}')
        if self.select_ok: self.mode, self.mode_left = name, 1
        return 0 if self.select_ok else 7004
    def recovery_stand(self): self.calls.append('recovery_stand')
    def balance_stand(self): self.calls.append('balance_stand')
    def foot_force(self): return [10, 20, 30, 40]
    def free_walk(self): self.calls.append('free_walk')
    def classic_walk(self, flag=True): self.calls.append(f'classic_walk:{flag}')


class FakePolicy:
    mode = 'off'
    def reset(self): pass
    def depth_needed(self): return False
    def inputs(self, obs, depth=None): return {'obs45': obs}
    def run(self, feed): return {'action': np.zeros((1, 12), np.float32)}


@pytest.fixture
def rig(monkeypatch):
    monkeypatch.setattr(lowlevel.time, 'sleep', lambda s: None)
    clock = Clock(); sdk = FakeSdk(clock)
    return clock, sdk


def test_remote_bytes_and_command_caps():
    r = parse_remote(remote('up', 'start', ly=1., lx=-1., rx=1.))
    assert {'up', 'start'} <= r.keys and 'B' not in r.keys
    assert np.allclose(command_from_remote(r), [1.5, .5, -1.2])


def test_dry_run_never_touches_robot(rig):
    clock, sdk = rig
    run = LowLevelRunner(sdk, FakePolicy(), live=False, clock=clock)
    sdk.keys = ('up', 'start')
    run.tick()
    assert run.phase is Phase.POLICY and run.sent > 0
    assert sdk.sent == [] and sdk.calls == []


def test_live_sequence_standdown_release_standup_policy(rig):
    clock, sdk = rig
    run = LowLevelRunner(sdk, FakePolicy(), live=True, clock=clock)
    sdk.keys = ('up', 'start')
    run.tick()
    assert sdk.calls[:5] == ['check_mode', 'release_mode', 'check_mode', 'release_mode', 'check_mode']   # 기본: 앉히지 않고 바로 넘겨받음
    assert run.phase is Phase.POLICY
    first, last = sdk.sent[0], sdk.sent[-1]
    assert first[1] == lowlevel.STAND_KP and np.isclose(last[1], lowlevel.KP)
    sdk.keys = ()
    run.tick()
    q, kp, kd = sdk.sent[-1]
    assert np.allclose(q, DEFAULT_POSE[SDK_FROM_POLICY]) and kp == lowlevel.KP and kd == lowlevel.KD


def test_l2_b_damps_and_stale_state_damps(rig):
    clock, sdk = rig
    run = LowLevelRunner(sdk, FakePolicy(), live=True, clock=clock)
    sdk.keys = ('up', 'start'); run.tick(); sdk.keys = ()
    sdk.keys = ('L2', 'B'); run.tick()
    assert run.phase is Phase.DAMPING and sdk.sent[-1][1] == 0 and sdk.sent[-1][2] == lowlevel.DAMP_KD
    run2 = LowLevelRunner(sdk, FakePolicy(), live=True, clock=clock)
    run2.phase = Phase.POLICY
    sdk.keys = ()
    orig = sdk.low_state
    sdk.low_state = lambda: (clock.t - 1.,) + orig()[1:]
    run2.tick()
    assert run2.phase is Phase.DAMPING and run2.events[-1].data['reason'] == 'low_state stale'


def test_fall_damps_switches_high_and_recovery_stands(rig):
    clock, sdk = rig
    run = LowLevelRunner(sdk, FakePolicy(), live=True, clock=clock)
    sdk.keys = ('up', 'start'); run.tick(); sdk.keys = ()
    sdk.quat = (0, 1, 0, 0)    # 뒤집힘
    for _ in range(200):
        clock.t += .02
        run.tick()
        if run.phase is Phase.HIGH:
            break
    codes = [e.code for e in run.events]
    assert 'ROBOT_FALL' in codes and 'ROBOT_FALL_RECOVERY_STAND' in codes
    assert sdk.calls[-3:] == ['select_mode:mcf', 'check_mode', 'recovery_stand'] and run.phase is Phase.HIGH


@pytest.mark.parametrize('arrow,gait,call', [('left', 'free_walk', 'free_walk'), ('right', 'classic', 'classic_walk:True')])
def test_arrow_start_returns_to_factory_gait(rig, arrow, gait, call):
    clock, sdk = rig
    run = LowLevelRunner(sdk, FakePolicy(), live=True, clock=clock)
    sdk.keys = ('up', 'start'); run.tick(); sdk.keys = (arrow, 'start'); run.tick()
    assert run.phase is Phase.HIGH and sdk.calls[-4:] == ['select_mode:mcf', 'check_mode', 'recovery_stand', call]
    assert np.allclose(sdk.sent[-1][0], np.zeros(12)) and sdk.sent[-1][1] == 0   # 천천히 앉힌 뒤 감쇠하고 넘김
    assert any(np.allclose(q, lowlevel.SIT_POSE[SDK_FROM_POLICY]) for q, kp, _ in sdk.sent if kp > 0)
    assert run.events[-1].code == 'FACTORY_GAIT' and run.events[-1].data['gait'] == gait


def test_down_start_is_ame2_placeholder(rig):
    clock, sdk = rig
    run = LowLevelRunner(sdk, FakePolicy(), live=True, clock=clock)
    sdk.keys = ('down', 'start'); run.tick()
    assert run.phase is Phase.HIGH and run.events[-1].code == 'AME2_UNAVAILABLE' and sdk.calls == []


def test_stand_only_holds_default_pose_without_policy(rig):
    clock, sdk = rig
    class Boom(FakePolicy):
        def run(self, feed): raise AssertionError('policy must not run in stand-only')
    run = LowLevelRunner(sdk, Boom(), live=True, clock=clock, stand_only=True)
    sdk.keys = ('up', 'start'); run.tick(); sdk.keys = (); run.tick()
    q, kp, kd = sdk.sent[-1]
    assert np.allclose(q, DEFAULT_POSE[SDK_FROM_POLICY]) and kp == lowlevel.KP


def test_failed_select_mode_is_reported_not_claimed(rig):
    clock, sdk = rig
    run = LowLevelRunner(sdk, FakePolicy(), live=True, clock=clock)
    sdk.keys = ('up', 'start'); run.tick(); sdk.keys = ()
    sdk.select_ok = False
    sdk.keys = ('right', 'start'); run.tick()
    codes = [e.code for e in run.events]
    assert 'MODE_HIGH_FAILED' in codes and 'FACTORY_GAIT' not in codes and 'recovery_stand' not in sdk.calls
    assert codes[-1] == 'DAMPING'   # 끝내 안 붙으면 그때 감쇠


def test_l2b_in_factory_mode_sends_nothing_and_restart_from_damping(rig):
    clock, sdk = rig
    run = LowLevelRunner(sdk, FakePolicy(), live=True, clock=clock)
    sdk.keys = ('L2', 'B'); run.tick()
    assert run.phase is Phase.HIGH and sdk.sent == []           # 순정일 때는 펌웨어 몫
    sdk.keys = ('up', 'start'); run.tick(); sdk.keys = ()
    sdk.keys = ('L2', 'B'); run.tick(); sdk.keys = ()
    assert run.phase is Phase.DAMPING
    n = len(sdk.calls)
    sdk.keys = ('up', 'start'); run.tick()                        # 감쇠 뒤 다시: 이미 저수준이라 앉히기 · 해제 없이
    assert run.phase is Phase.POLICY and 'stand_down' not in sdk.calls[n:]


def test_command_slew_matches_sim(rig):
    clock, sdk = rig
    run = LowLevelRunner(sdk, FakePolicy(), live=False, clock=clock)
    sdk.keys = ('up', 'start'); run.tick(); sdk.keys = ()
    import struct
    full = b'\x55\x51' + struct.pack('<H5f', 0, 0., 0., 0., 0., 1.) + bytes(14)   # 왼쪽 막대 끝까지 앞
    sdk.low_state = (lambda f=sdk.low_state: (lambda r: r[:5] + (full,))(f()))
    run.tick()
    assert np.isclose(run.cmd[0], 1.5 / 50)                         # 한 틱 (20 ms) 에 0.03 m/s 만


def test_stop_trace_two_seconds_after_command_release(rig):
    clock, sdk = rig
    run = LowLevelRunner(sdk, FakePolicy(), live=False, clock=clock)
    sdk.keys = ('up', 'start'); run.tick(); sdk.keys = ()
    import struct
    fwd = b'\x55\x51' + struct.pack('<H5f', 0, 0., 0., 0., 0., 1.) + bytes(14)
    orig = sdk.low_state
    sdk.low_state = lambda: orig()[:5] + (fwd,)
    for _ in range(20): clock.t += .02; run.tick()
    sdk.low_state = orig
    for _ in range(150): clock.t += .02; run.tick()
    tr = [e for e in run.events if e.code == 'STOP_TRACE']
    assert len(tr) == 1 and tr[0].data['cmd0'][0] > .05 and tr[0].data['rows'][-1][0] >= 2. and tr[0].data['rows'][0][2] == [10, 20, 30, 40]


def test_sit_first_option_stands_down_before_release(rig):
    clock, sdk = rig
    run = LowLevelRunner(sdk, FakePolicy(), live=True, clock=clock, sit_first=True)
    sdk.keys = ('up', 'start'); run.tick()
    assert sdk.calls[:3] == ['check_mode', 'stand_down', 'release_mode']


def test_l2a_in_policy_sits_down_then_damps(rig):
    clock, sdk = rig
    run = LowLevelRunner(sdk, FakePolicy(), live=True, clock=clock)
    sdk.keys = ('up', 'start'); run.tick(); sdk.keys = ('L2', 'A'); run.tick()
    assert run.phase is Phase.DAMPING and [e.code for e in run.events][-2:] == ['SIT_DOWN', 'DAMPING']
    assert any(np.allclose(q, lowlevel.SIT_POSE[SDK_FROM_POLICY]) for q, kp, _ in sdk.sent if kp > 0)


def test_stick_deadband_zeroes_jitter():
    assert np.allclose(command_from_remote(parse_remote(remote(ly=.03, lx=-.04, rx=.02))), 0)
    assert command_from_remote(parse_remote(remote(ly=.2)))[0] > 0


def test_down_start_logged_once_while_held(rig):
    clock, sdk = rig
    run = LowLevelRunner(sdk, FakePolicy(), live=True, clock=clock)
    sdk.keys = ('down', 'start')
    for _ in range(10): run.tick()
    assert [e.code for e in run.events].count('AME2_UNAVAILABLE') == 1


# ── 앱 명령 (applink · 수행 전 · 가짜 SDK 만) ──
import json as _json
import socket as _socket

from foothold_agent.policy.applink import AppLink, APP_TIMEOUT_S


def _pkt(seq, **kw):
    return _json.dumps({'seq': seq, **kw}).encode()


def test_applink_rejects_bad_packets():
    clock = Clock(); app = AppLink(clock=clock)
    assert app.feed(_pkt(1, vx=.3)) and app.velocity() == (.3, 0., 0.)
    assert not app.feed(_pkt(1, vx=.9))                    # 같은 seq
    assert not app.feed(b'{"seq": 2, "vx": NaN}')          # 유한하지 않음
    assert not app.feed(_pkt(3, mode='jump'))              # 모르는 모드
    assert not app.feed(b'not json') and not app.feed(b'{"seq": 4}' + b' ' * 600)
    assert not app.feed(_pkt(True, vx=1.))                 # bool 은 seq 아님
    assert app.rejected == 6 and app.velocity() == (.3, 0., 0.)
    clock.t += APP_TIMEOUT_S + .01
    assert app.velocity() is None                          # 끊기면 버림


def test_app_velocity_drives_policy_but_remote_wins(rig):
    clock, sdk = rig
    app = AppLink(clock=clock)
    run = LowLevelRunner(sdk, FakePolicy(), live=False, clock=clock, app=app)
    sdk.keys = ('up', 'start'); run.tick(); sdk.keys = ()
    app.feed(_pkt(1, vx=9.))                               # 상한 1.5 로 잘림 · 가감속 1 틱 0.03
    run.tick()
    assert np.isclose(run.cmd[0], 1.5 / 50)
    sdk.keys = ('X',)                                      # 리모컨을 만지면 앱 속도 무시 → 감속
    app.feed(_pkt(2, vx=9.)); run.tick()
    assert run.cmd[0] == 0.                                # 감속 한도 안에서 0 까지
    sdk.keys = ()
    for i in range(5):
        app.feed(_pkt(3 + i, vx=.5)); run.tick()
    assert np.isclose(run.cmd[0], 5 * 1.5 / 50)
    clock.t += APP_TIMEOUT_S + .01                         # 앱 끊김 → 0 으로 감속
    before = run.cmd[0]; run.tick()
    assert run.cmd[0] < before


def test_app_modes_follow_phase_and_remote_priority(rig):
    clock, sdk = rig
    app = AppLink(clock=clock)
    run = LowLevelRunner(sdk, FakePolicy(), live=True, clock=clock, app=app)
    app.feed(_pkt(1, mode='sit')); run.tick()              # 순정에서 앉기는 할 수 없음 → 알리고 버림
    assert run.phase is Phase.HIGH and run.events[-1].code == 'APP_MODE_IGNORED'
    sdk.keys = ('A',); app.feed(_pkt(2, mode='start')); run.tick()
    assert run.phase is Phase.HIGH and run.events[-1].data['reason'] == 'remote active'
    sdk.keys = (); app.feed(_pkt(3, mode='start')); run.tick()
    assert run.phase is Phase.POLICY and 'APP_MODE' in [e.code for e in run.events]
    app.feed(_pkt(4, mode='damp')); run.tick()
    assert run.phase is Phase.DAMPING and run.events[-1].data == {'reason': 'app'}


def test_applink_udp_loopback_only():
    app = AppLink(0)
    try:
        assert app.sock.getsockname()[0] == '127.0.0.1'
        s = _socket.socket(_socket.AF_INET, _socket.SOCK_DGRAM)
        s.sendto(_pkt(1, vx=.2, mode='start'), ('127.0.0.1', app.port)); s.close()
        import time as _t
        for _ in range(50):
            app.poll()
            if app.vel: break
            _t.sleep(.01)
        assert app.velocity() == (.2, 0., 0.) and app.take_mode() == 'start' and app.take_mode() is None
    finally:
        app.close()


def test_start_trace_two_seconds_from_first_command(rig):
    clock, sdk = rig
    run = LowLevelRunner(sdk, FakePolicy(), live=False, clock=clock)
    sdk.keys = ('up', 'start'); run.tick(); sdk.keys = ()
    for _ in range(10): clock.t += .02; run.tick()                 # 서 있음 · 기록 없음
    assert run.start_trace is None
    fwd = b'\x55\x51' + struct.pack('<H5f', 0, 0., 0., 0., 0., .4) + bytes(14)
    orig = sdk.low_state
    sdk.low_state = lambda: orig()[:5] + (fwd,)
    for _ in range(120): clock.t += .02; run.tick()
    tr = [e for e in run.events if e.code == 'START_TRACE']
    assert len(tr) == 1
    rows = tr[0].data['rows']
    assert rows[0][1][1] == .4 and np.isclose(rows[0][2][0], .6) and np.isclose(rows[0][3][0], .03)   # 막대 .4 → 목표 .6 → 한 틱 .03
    assert rows[-1][0] >= 2. and len(rows[0]) == 9 and rows[0][8] == [None, None]   # 정본 ONNX 는 추정 출력 없음


def test_start_trace_records_est_from_debug_onnx(rig):
    clock, sdk = rig
    class EstPolicy(FakePolicy):
        def run(self, feed):
            est = np.zeros((1, 51), np.float32); est[0, 16] = .25
            return {'action': np.zeros((1, 12), np.float32), 'est_raw': est + .01, 'est': est}
    run = LowLevelRunner(sdk, EstPolicy(), live=False, clock=clock)
    sdk.keys = ('up', 'start'); run.tick(); sdk.keys = ()
    fwd = b'\x55\x51' + struct.pack('<H5f', 0, 0., 0., 0., 0., .4) + bytes(14)
    orig = sdk.low_state
    sdk.low_state = lambda: orig()[:5] + (fwd,)
    for _ in range(3): clock.t += .02; run.tick()
    assert run.start_trace['rows'][0][8] == [.26, .25]
