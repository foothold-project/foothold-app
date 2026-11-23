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
    def free_walk(self): self.calls.append('free_walk'); return 0
    def classic_walk(self, flag=True): self.calls.append(f'classic_walk:{flag}'); return 0


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
    assert np.allclose(command_from_remote(r), [1.5, 0., 0.])      # 전진 1.5 위 옆 · 회전은 학습에 없음 → 0


@pytest.mark.parametrize('want,got,mark', [
    ((0., .8, 0.), (0., .8, 0.), 'none'),          # 옆만 0.8
    ((0., 0., 1.5), (0., 0., 1.5), 'none'),        # 제자리 회전 1.5
    ((-1.3, 0., 0.), (-1.3, 0., 0.), 'none'),      # 뒤 1.3
    ((.29, .6, 0.), (.3, .5, 0.), 'gap'),          # 틈 대각선: 전진 0.3 으로 올림 · 옆 0.5
    ((.2, 0., .9), (0., 0., .9), 'gap'),           # 틈: 제자리 회전
    ((.29, 0., 0.), (.29, 0., 0.), 'none'),        # 전진만은 틈 아님
    ((.31, .8, 0.), (.31, .5, 0.), 'clip'),        # 0.3 위 옆 0.5
    ((.45, .1, 0.), (.45, .1, 0.), 'interp'),      # 안쪽 보간 구간 표시만
    ((.59, .8, 0.), (.59, .5, 0.), 'clip'),
    ((.61, .8, 0.), (.61, 0., 0.), 'clip'),        # 0.6 위 옆 0
    ((.31, 0., 1.5), (.31, 0., 1.), 'clip'),       # 걸으며 회전 1.0
    ((1.19, 0., 1.5), (1.19, 0., 1.), 'clip'),
    ((1.21, 0., 1.), (1.21, 0., 0.), 'clip'),      # 1.2 위 회전 0
    ((-.5, 0., 1.), (-.5, 0., .6), 'clip'),        # 뒤 + 회전 0.6
    ((0., .5, 1.), (0., .5, .6), 'clip'),          # 옆 + 회전 0.6
    ((.04, .03, 0.), (0., 0., 0.), 'none'),        # 죽은 띠
    ((3., 0., 0.), (1.5, 0., 0.), 'clip'),
])
def test_shape_command_training_table(want, got, mark):
    from foothold_agent.policy.lowlevel import shape_command, command_from_app
    out, m = shape_command(*want)
    assert np.allclose(out, got) and m == mark
    assert np.allclose(command_from_app(want), got)


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
    assert run2.phase is Phase.POLICY                                     # 짧은 끊김: 마지막 목표를 잡고 기다림
    clock.t += lowlevel.LIVENESS_S + .1
    run2.tick()                                                            # 1 초 넘게 끊김: 엎드린 뒤 순정
    codes = [e.code for e in run2.events]
    assert codes[:3] == ['LIVENESS_LOST', 'SIT_DOWN', 'DAMPING'] and run2.phase is Phase.HIGH and 'MODE_HIGH' in codes
    sit = [q for q, kp, kd in sdk.sent if kp == lowlevel.KP]
    assert np.allclose(sit[-1], lowlevel.SIT_POSE[SDK_FROM_POLICY], atol=1e-3)   # 끊긴 채로도 끝까지 엎드림


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
    assert np.isclose(run.cmd[0], lowlevel.SLEW_UP[0] / 50)          # 한 틱 (20 ms) 에 가속 상한만큼만 (0.5 m/s² → 0.01)
    assert lowlevel.SLEW_UP[0] == .5
    assert lowlevel.SLEW_DOWN[0] == 1.2                             # 감속은 늘 1.2 /s


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
    assert np.isclose(run.cmd[0], lowlevel.SLEW_UP[0] / 50)
    sdk.keys = ('X',)                                      # 리모컨을 만지면 앱 속도 무시 → 감속
    app.feed(_pkt(2, vx=9.)); run.tick()
    assert run.cmd[0] == 0.                                # 0.01 은 감속 한 틱 (0.024) 안에서 0
    sdk.keys = ()
    base = float(run.cmd[0])
    for i in range(5):
        app.feed(_pkt(3 + i, vx=.5)); run.tick()
    assert np.isclose(run.cmd[0], base + 5 * lowlevel.SLEW_UP[0] / 50)    # 리모컨을 놓으면 다시 앱 속도로 가속
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


def test_trace_writes_every_policy_tick_with_est(rig, tmp_path):
    import json as js
    from foothold_agent.policy.trace import TraceWriter
    clock, sdk = rig
    sdk.motor_tau = lambda: list(range(12))
    sdk.motor_temp = lambda: [40 + i for i in range(12)]
    class EstPolicy(FakePolicy):
        def run(self, feed):
            est = np.zeros((1, 51), np.float32); est[0, 16] = .25
            return {'action': np.zeros((1, 12), np.float32), 'est_raw': est + .01, 'est': est}
    tw = TraceWriter(tmp_path, 'start')
    run = LowLevelRunner(sdk, EstPolicy(), live=False, clock=clock, trace=tw)
    sdk.keys = ('up', 'start'); run.tick(); sdk.keys = ()
    fwd = b'\x55\x51' + struct.pack('<H5f', 0, -1., 0., 0., 0., .6) + bytes(14)   # 앞 0.6 (곡선 → 0.54) + 옆 끝 (비례 0.8)
    orig = sdk.low_state
    sdk.low_state = lambda: orig()[:5] + (fwd,)
    for _ in range(5): clock.t += .02; run.tick()
    tw.close()
    rows = [r for r in map(js.loads, tw.path.read_text().splitlines()) if 'event' not in r]   # 사건 줄은 따로
    r = rows[0]
    assert len(rows) == 5 and r['phase'] == 'policy' and np.isclose(r['stick'][1], .6)
    assert np.allclose(r['want'], [.54, .8, 0.], atol=1e-3) and np.allclose(r['goal'], [.54, .5, 0.], atol=1e-3) and r['shape'] == 'clip'
    assert np.isclose(r['cmd'][0], lowlevel.SLEW_UP[0] / 50) and len(r['target']) == 12
    assert abs(r['wall'] - __import__('time').time()) < 60                       # 폰 측정 표시와 맞출 벽시계
    assert r['tau'][0] == 3 and r['temp'][0] == 43 and r['est_vx'] == [.26, .25] and r['foot'] == [10, 20, 30, 40]


def test_trace_stops_at_disk_cap_without_deleting(tmp_path):
    from foothold_agent.policy.trace import TraceWriter
    (tmp_path / 'old.jsonl').write_bytes(b'x' * 900)
    full = []
    tw = TraceWriter(tmp_path, 'start', max_total_bytes=1000, max_file_bytes=40, on_full=lambda: full.append(1))
    for i in range(30):
        tw.write({'i': i})
    assert full == [1] and (tmp_path / 'old.jsonl').exists() and tw.total <= 1000
    assert len(list(tmp_path.glob('start-*.jsonl'))) >= 2                # 파일 나눔


def test_shutdown_sits_down_before_factory(rig):
    clock, sdk = rig
    run = LowLevelRunner(sdk, FakePolicy(), live=True, clock=clock)
    sdk.keys = ('up', 'start'); run.tick(); sdk.keys = ()
    run.tick()
    run.shutdown()
    codes = [e.code for e in run.events]
    i = codes.index('EXIT_SIT_DOWN')
    assert codes[i:i + 3] == ['EXIT_SIT_DOWN', 'SIT_DOWN', 'DAMPING'] and run.phase is Phase.HIGH and codes[-1] == 'MODE_HIGH'
    assert run.events[i + 2].data == {'reason': 'sat down'}                 # 감쇠는 엎드린 뒤에만
    high = LowLevelRunner(sdk, FakePolicy(), live=True, clock=clock); n = len(sdk.sent)
    high.shutdown()
    assert len(sdk.sent) == n and high.events == []                         # 순정이면 아무것도 안 보냄


def test_factory_record_row_is_read_only_and_same_shape():
    from types import SimpleNamespace as NS
    from foothold_agent.policy import factory_record
    import ast
    names = {a.name for n in ast.walk(ast.parse(open(factory_record.__file__).read())) if isinstance(n, ast.ImportFrom) for a in n.names}
    assert not names & {'ChannelPublisher', 'SportClient', 'MotionSwitcherClient', 'UnitreeSdk'}   # 명령을 보낼 길이 없음
    m = [NS(q=i * .1, dq=0., tau_est=float(i), temperature=30 + i) for i in range(12)]
    low = NS(motor_state=m, wireless_remote=remote(ly=.5), foot_force=[1, 2, 3, 4],
             imu_state=NS(gyroscope=[0, 0, .1], quaternion=[1, 0, 0, 0]))
    sport = NS(mode=3, gait_type=1, error_code=2010, body_height=.32, velocity=[.5, 0, 0], yaw_speed=0.)
    r = factory_record.row(low, 99.98, sport, 'classic', 100.)
    assert r['phase'] == 'factory' and r['label'] == 'classic' and r['stick'][1] == .5 and r['tau'][0] == 3.   # 정책 순서 (FL hip = SDK 3)
    assert r['sport'] == {'mode': 3, 'gait': 1, 'err': 2010, 'height': .32, 'vel': [.5, 0., 0.], 'yaw_speed': 0.} and r['stale'] is False
    assert r['temp'][0] == 33 and len(r['temp']) == 12                                          # 정책 순서 (FL hip = SDK 3)
    assert set(r) >= {'q', 'dq', 'tau', 'foot', 'gyro', 'grav', 'want', 'shape', 'goal', 'cmd', 'target', 'est_vx'}



def _policy_rig(rig, mode, feet):
    clock, sdk = rig
    sdk.foot_force = lambda: feet
    run = LowLevelRunner(sdk, FakePolicy(), live=True, clock=clock, stop_mode=mode)
    sdk.keys = ('up', 'start'); run.tick(); sdk.keys = ()
    run.tick()
    return clock, sdk, run


def test_settle_mode_waits_then_sits_when_balanced(rig):
    clock, sdk, run = _policy_rig(rig, 'settle', [20, 21, 19, 20])
    assert run.slew_down[0] == 1.2
    sdk.keys = ('L2', 'A'); run.tick(); sdk.keys = ()
    codes = [e.code for e in run.events]
    i = codes.index('SETTLE_WAIT')
    assert codes[i:i + 4] == ['SETTLE_WAIT', 'SETTLE_OK', 'SIT_DOWN', 'DAMPING'] and run.phase is Phase.DAMPING
    assert 'STAND_HANDOVER' not in codes


def test_settle_mode_times_out_then_sits_never_stand(rig):
    clock, sdk, run = _policy_rig(rig, 'settle', [5, 40, 40, 40])     # 한 발에 무게가 안 실림
    sdk.keys = ('L2', 'A'); run.tick(); sdk.keys = ()
    codes = [e.code for e in run.events]
    to = run.events[codes.index('SETTLE_TIMEOUT')]
    assert to.data['seconds'] >= lowlevel.SETTLE_MAX_S
    assert codes[codes.index('SETTLE_TIMEOUT') + 1] == 'SIT_DOWN'                       # 못 맞춰도 엎드림 (15:18 확인 길)
    assert 'STAND_HANDOVER' not in codes and 'select_mode:mcf' not in sdk.calls[-3:] and 'balance_stand' not in sdk.calls
    assert run.phase is Phase.DAMPING


def test_stand_handover_reports_gap(rig):
    clock, sdk, run = _policy_rig(rig, 'stand', [20, 20, 20, 20])
    sdk.keys = ('L2', 'A'); run.tick(); sdk.keys = ()
    codes = [e.code for e in run.events]
    gap = run.events[codes.index('HANDOVER_GAP')].data
    assert gap['attached'] is True and gap['ms'] is not None and gap['ms'] >= 0
    assert sdk.calls[-2:] == ['balance_stand', 'stand_down'] and run.phase is Phase.HIGH


def test_stand_mode_holds_last_target_until_factory_attaches(rig):
    clock, sdk, run = _policy_rig(rig, 'stand', [20, 20, 20, 20])
    target = run.target.copy()
    n = len(sdk.sent)
    run.back_to_factory('classic')
    held = [q for q, kp, kd in sdk.sent[n:]]
    assert held and all(np.allclose(q, target[SDK_FROM_POLICY]) for q in held)      # 놓기 전까지 마지막 목표 그대로
    assert 'recovery_stand' not in sdk.calls and sdk.calls[-1] == 'classic_walk:True'  # 서 있는 채 → 보행만
    assert 'balance_stand' in sdk.calls and 'stand_down' not in sdk.calls


def test_stop_events_land_in_trace(rig, tmp_path):
    import json as js
    from foothold_agent.policy.trace import TraceWriter
    clock, sdk = rig
    tw = TraceWriter(tmp_path, 'start')
    run = LowLevelRunner(sdk, FakePolicy(), live=True, clock=clock, trace=tw, stop_mode='stand')
    sdk.keys = ('up', 'start'); run.tick(); sdk.keys = ()
    run.tick(); run.shutdown(); tw.close()
    ev = [js.loads(l).get('event') for l in tw.path.read_text().splitlines()]
    assert {'POLICY_START', 'EXIT_SIT_DOWN', 'STAND_HANDOVER', 'HANDOVER_GAP', 'MODE_HIGH'} <= set(ev)


def test_unknown_stop_mode_rejected(rig):
    clock, sdk = rig
    with pytest.raises(ValueError):
        LowLevelRunner(sdk, FakePolicy(), live=False, clock=clock, stop_mode='jump')



def test_armed_by_remote_needs_enabled_env_and_matching_nic(monkeypatch):
    from foothold_agent.policy import run as runmod
    monkeypatch.delenv('FH_GO2_DIRECT_ENABLED', raising=False)
    args = ['--folder', '/nonexistent', '--nic', 'enP8p1s0', '--live', '--armed-by-remote']
    with pytest.raises(PermissionError):
        runmod.main(args)
    monkeypatch.setenv('FH_GO2_DIRECT_ENABLED', '1'); monkeypatch.setenv('FH_GO2_DIRECT_NIC', 'eth9')
    with pytest.raises(PermissionError):
        runmod.main(args)                                                  # NIC 가 다르면 거부


def test_autostart_unit_and_env_files():
    from pathlib import Path
    root = Path(__file__).resolve().parents[1] / 'installer' / 'policy-runner'
    unit = (root / 'foothold-policy.service').read_text()
    env = (root / 'runner.env.example').read_text()
    assert 'WantedBy=default.target' in unit and 'KillSignal=SIGTERM' in unit and 'Restart=on-failure' in unit
    assert '--armed-by-remote' in env and '--stop-mode sit' in env and '--trace-dir' in env and '--seconds' not in env



def test_stick_curve_is_quadratic_and_reaches_training_edge():
    vx = lambda ly: float(command_from_remote(parse_remote(remote(ly=ly)))[0])
    assert np.isclose(vx(1 / 3), 1.5 / 9, atol=1e-3) and np.isclose(vx(2 / 3), 1.5 * 4 / 9, atol=1e-3)
    assert np.isclose(vx(1.), 1.5) and np.isclose(vx(-1.), -1.3) and vx(.04) == 0.
    wz = float(command_from_remote(parse_remote(remote(rx=-.5)))[2])
    assert np.isclose(wz, .5 * 1.5)                                      # 회전 · 옆은 비례


def test_depth_health_summary():
    from foothold_agent.policy.depth_health import summarize
    r = summarize([0., .033, .066, .2], [[640, 480]] * 3, [.01, .03], 1000., carried=1)
    assert r['frames'] == 3 and r['max_gap_ms'] == 134.0 and r['size'] == [640, 480] and r['zero_frac'] == .02



def test_l2a_lie_then_l2a_again_stands_back_into_start(rig):
    clock, sdk = rig
    run = LowLevelRunner(sdk, FakePolicy(), live=True, clock=clock)
    sdk.keys = ('up', 'start'); run.tick(); sdk.keys = ()
    run.tick()
    sdk.keys = ('L2', 'A'); run.tick()                                    # 앉힘
    assert run.phase is Phase.DAMPING
    run.tick()                                                             # 아직 누르고 있음 → 다시 서지 않음
    assert run.phase is Phase.DAMPING
    sdk.keys = (); run.tick()                                              # 놓음
    sdk.keys = ('L2', 'A'); run.tick()                                     # 다시 누름 → 일어나 START
    assert run.phase is Phase.POLICY and [e.code for e in run.events].count('POLICY_START') == 2


def test_classic_walk_retried_until_accepted(rig):
    clock, sdk, run = _policy_rig(rig, 'sit', [20, 20, 20, 20])
    answers = iter([-1, -1, 0])
    def classic(flag=True):
        sdk.calls.append('classic_walk'); return next(answers)
    sdk.classic_walk = classic
    run.back_to_factory('classic')
    gait = [e for e in run.events if e.code == 'FACTORY_GAIT'][-1]
    assert sdk.calls.count('classic_walk') == 3 and "'classic': [-1, -1, 0]" in gait.data['result']
