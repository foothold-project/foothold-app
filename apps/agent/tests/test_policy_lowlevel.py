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
        self.quat, self.keys, self.mode_left = (1, 0, 0, 0), (), 2
        self.q = np.zeros(12)
    def low_state(self):
        self.clock.t += .005
        return self.clock.t, self.quat, (0, 0, 0), self.q, np.zeros(12), remote(*self.keys)
    def send(self, q, dq, kp, kd, tau): self.sent.append((np.array(q), float(kp[0]), float(kd[0])))
    def stand_down(self): self.calls.append('stand_down')
    def release_mode(self): self.calls.append('release_mode'); self.mode_left -= 1
    def check_mode(self): self.calls.append('check_mode'); return 'normal' if self.mode_left > 0 else ''
    def select_mode(self, name): self.calls.append(f'select_mode:{name}')
    def recovery_stand(self): self.calls.append('recovery_stand')
    def balance_stand(self): self.calls.append('balance_stand')
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
    assert sdk.calls[:5] == ['stand_down', 'release_mode', 'check_mode', 'release_mode', 'check_mode']
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
    assert sdk.calls[-2:] == ['select_mode:normal', 'recovery_stand'] and run.phase is Phase.HIGH


@pytest.mark.parametrize('arrow,gait,call', [('left', 'free_walk', 'free_walk'), ('right', 'classic', 'classic_walk:True')])
def test_arrow_start_returns_to_factory_gait(rig, arrow, gait, call):
    clock, sdk = rig
    run = LowLevelRunner(sdk, FakePolicy(), live=True, clock=clock)
    sdk.keys = ('up', 'start'); run.tick(); sdk.keys = (arrow, 'start'); run.tick()
    assert run.phase is Phase.HIGH and sdk.calls[-3:] == ['select_mode:normal', 'recovery_stand', call]
    assert run.events[-1].code == 'FACTORY_GAIT' and run.events[-1].data['gait'] == gait


def test_down_start_is_ame2_placeholder(rig):
    clock, sdk = rig
    run = LowLevelRunner(sdk, FakePolicy(), live=True, clock=clock)
    sdk.keys = ('down', 'start'); run.tick()
    assert run.phase is Phase.HIGH and run.events[-1].code == 'AME2_UNAVAILABLE' and sdk.calls == []
