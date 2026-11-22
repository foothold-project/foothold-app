"""Go2 저수준 정책 실행기: 모드 전환 · 일어서기 · 정책 루프 · 안전 정지 · 넘어짐 일어서기 (팀장 11/22).

순서 (팀장 11/22 04:03 · lead 설계 확인):
  1 고수준 (SportMode) 에서 StandDown 으로 앉힘 → MotionSwitcher ReleaseMode → CheckMode 가 빈 이름이 될 때까지 (저수준으로 넘김)
  2 저수준에서 앉은 자세 → 기본 자세로 일어서기 (보간 · PD 60/5 → 정책 PD 25/0.5 로 넘김)
  3 정책 루프 50 Hz (START: off 또는 reconstruction) · LowCmd 는 200 Hz 로 마지막 목표를 다시 보냄
  4 넘어짐 (몸 기울기 60° 초과 또는 몸 높이 낮음 0.5 초) → 정책 멈춤 · 감쇠 → SelectMode 로 고수준 복귀 → SportClient.RecoveryStand()
  5 끝 · 비상: 감쇠 (kp 0 · kd 3) → 고수준 복귀 (SelectMode)

명령 송신 조건: `--live` 와 go2_direct 승인 표식 (사람 · 30 분 · 0600) 이 둘 다 있을 때만. 기본은 dry-run (LowState 를 읽고 계산만, 송신 0).
리모컨 (LowState.wireless_remote · 팀장 11/22 12:34): 위 + start = START 정책, 아래 + start = AME-2 (student ONNX 를 받으면 · 지금은 알림만),
← + start = 순정 free walk 로 복귀, → + start = 순정 classic 으로 복귀, L2 + B = 비상 감쇠 (언제나). 고수준 (순정) 일 때 ← · → + start 는 펌웨어가 처리.
리모컨 바이트 배치와 모드 이름 ('normal' · 'mcf') 은 Unitree SDK 예제 기준이며 이 Go2 X 에서 아직 재지 않았다 (실기 미확인).
"""
from __future__ import annotations

import enum
import struct
import time
from dataclasses import dataclass

import numpy as np

from .start import DEFAULT_POSE, KD, KP, POLICY_FROM_SDK, SDK_FROM_POLICY, joint_targets, observation, projected_gravity

STAND_KP, STAND_KD = 60., 5.
DAMP_KD = 3.
STAND_SEC, BLEND_SEC = 2.5, 1.0
CMD_HZ, POLICY_HZ = 200, 50
STALE_S = .05
FALL_GRAV_Z, FALL_HOLD_S = -.5, .5
CAPS = {'vx': (-1.3, 1.5), 'vy': (-.5, .5), 'wz': (-1.2, 1.2)}
# 사람 확인 전 안전 상한: 관절 목표는 기본 자세에서 이만큼만 (rad). 정책 action clip 17 × 0.25 = 4.25 보다 좁다.
TARGET_SPAN = 1.6

KEYS = ['R1', 'L1', 'start', 'select', 'R2', 'L2', 'F1', 'F2', 'A', 'B', 'X', 'Y', 'up', 'right', 'down', 'left']


@dataclass
class Remote:
    keys: frozenset
    lx: float = 0.
    ly: float = 0.
    rx: float = 0.
    ry: float = 0.


def parse_remote(raw: bytes) -> Remote:
    """LowState.wireless_remote 40 바이트: head 2 · 단추 uint16 (R1..left 순 비트) · lx · rx · ry · L2 · ly (float32). SDK 예제 기준."""
    raw = bytes(raw)
    if len(raw) < 24:
        return Remote(frozenset())
    bits = struct.unpack_from('<H', raw, 2)[0]
    lx, rx, ry, _l2, ly = struct.unpack_from('<5f', raw, 4)
    return Remote(frozenset(k for i, k in enumerate(KEYS) if bits >> i & 1), lx, ly, rx, ry)


def command_from_remote(r: Remote) -> np.ndarray:
    """왼 막대 앞뒤 · 좌우 = vx · vy, 오른 막대 좌우 = wz (시뮬 손 조종과 같은 뜻). 막대 끝 = 학습 상한."""
    def axis(v, lo, hi):
        v = float(np.clip(v, -1, 1))
        return v * hi if v >= 0 else -v * lo
    return np.array([axis(r.ly, *CAPS['vx']), axis(-r.lx, *CAPS['vy']), axis(-r.rx, *CAPS['wz'])], np.float32)


class Phase(enum.Enum):
    HIGH = 'high'            # 고수준 (순정 SportMode) · 우리는 명령 안 보냄
    STANDING_UP = 'standing_up'
    POLICY = 'policy'
    DAMPING = 'damping'
    RECOVERING = 'recovering'


@dataclass
class Event:
    t: float
    code: str
    data: dict


class LowLevelRunner:
    """sdk: 아래 메서드를 가진 경계 객체 (실기 = UnitreeSdk, 시험 = 가짜).
       low_state() -> (stamp_s, quat_wxyz, gyro, q_sdk[12], dq_sdk[12], remote_bytes) · send(q, dq, kp, kd, tau) (SDK 순서 12 개씩) ·
       stand_down() · release_mode() · check_mode() -> str · select_mode(name) · recovery_stand() · balance_stand()"""

    def __init__(self, sdk, policy, *, live: bool, clock=time.monotonic, on_event=lambda e: None, sport_mode='normal'):
        self.sdk, self.policy, self.live, self.clock, self.on_event = sdk, policy, live, clock, on_event
        self.sport_mode = sport_mode
        self.phase = Phase.HIGH
        self.target = DEFAULT_POSE.copy()
        self.kp, self.kd = KP, KD
        self.last_action = np.zeros(12, np.float32)
        self.fall_since = None
        self.events: list[Event] = []
        self.sent = 0

    # ── 기록 ──
    def emit(self, code, **data):
        e = Event(self.clock(), code, data)
        self.events.append(e)
        self.on_event(e)

    # ── 송신 (dry-run 이면 세기만) ──
    def _send(self, q_policy, kp, kd):
        q = np.asarray(q_policy, np.float32)[SDK_FROM_POLICY]
        if self.live:
            self.sdk.send(q, np.zeros(12, np.float32), np.full(12, kp, np.float32), np.full(12, kd, np.float32), np.zeros(12, np.float32))
        self.sent += 1

    def damp(self, reason):
        """비상 감쇠: 위치 이득 0 · 속도 이득만. 정책 멈춤."""
        self.phase = Phase.DAMPING
        if self.live:
            self.sdk.send(np.zeros(12, np.float32), np.zeros(12, np.float32), np.zeros(12, np.float32),
                          np.full(12, DAMP_KD, np.float32), np.zeros(12, np.float32))
        self.emit('DAMPING', reason=reason)

    # ── 모드 전환 ──
    def to_low(self, timeout_s=10.):
        if self.live:
            self.sdk.stand_down()
            deadline = self.clock() + timeout_s
            while True:
                self.sdk.release_mode()
                if not self.sdk.check_mode():
                    break
                if self.clock() > deadline:
                    raise TimeoutError('MotionSwitcher ReleaseMode did not clear the sport mode')
                time.sleep(.5)
        self.emit('MODE_LOW')

    def to_high(self):
        if self.live:
            self.sdk.select_mode(self.sport_mode)
        self.phase = Phase.HIGH
        self.emit('MODE_HIGH', mode=self.sport_mode)

    # ── 상태 읽기 ──
    def read(self):
        stamp, quat, gyro, q_sdk, dq_sdk, remote = self.sdk.low_state()
        stale = self.clock() - stamp > STALE_S
        return dict(stale=stale, grav=projected_gravity(quat), gyro=np.asarray(gyro, np.float32),
                    q=np.asarray(q_sdk, np.float32)[POLICY_FROM_SDK], dq=np.asarray(dq_sdk, np.float32)[POLICY_FROM_SDK],
                    remote=parse_remote(remote))

    def fallen(self, s) -> bool:
        bad = s['grav'][2] > FALL_GRAV_Z
        now = self.clock()
        self.fall_since = (self.fall_since or now) if bad else None
        return bad and now - self.fall_since >= FALL_HOLD_S

    # ── 한 틱 (정책 50 Hz 에서 부름) ──
    def tick(self, depth_frame=None):
        s = self.read()
        keys = s['remote'].keys
        if {'L2', 'B'} <= keys:
            if self.phase is not Phase.DAMPING:
                self.damp('remote L2+B')
            return s
        if s['stale'] and self.phase in (Phase.STANDING_UP, Phase.POLICY):
            self.damp('low_state stale')
            return s
        if self.phase is Phase.POLICY and self.fallen(s):
            self.damp('fall')
            self.emit('ROBOT_FALL', grav_z=float(s['grav'][2]))
            self.recover()
            return s
        if self.phase is Phase.HIGH and {'up', 'start'} <= keys:
            self.start_policy(s)
            return s
        if {'down', 'start'} <= keys:
            self.emit('AME2_UNAVAILABLE', note='AME-2 student ONNX 없음 (석헌 student 대기)')
            return s
        if self.phase in (Phase.POLICY, Phase.DAMPING) and ({'left', 'start'} <= keys or {'right', 'start'} <= keys):
            self.back_to_factory('free_walk' if 'left' in keys else 'classic')
            return s
        if self.phase is Phase.POLICY:
            self.policy_step(s, depth_frame)
        return s

    def start_policy(self, s):
        self.to_low()
        self.phase = Phase.STANDING_UP
        start, t0 = s['q'].copy(), self.clock()
        while self.phase is Phase.STANDING_UP:
            a = min(1., (self.clock() - t0) / STAND_SEC)
            st = self.read()
            if {'L2', 'B'} <= st['remote'].keys or st['stale']:
                self.damp('stand-up interrupted')
                return
            blend = min(1., max(0., (self.clock() - t0 - STAND_SEC) / BLEND_SEC))
            kp, kd = STAND_KP + (KP - STAND_KP) * blend, STAND_KD + (KD - STAND_KD) * blend
            self._send(start + (DEFAULT_POSE - start) * (a * a * (3 - 2 * a)), kp, kd)
            if blend >= 1.:
                break
            time.sleep(1. / CMD_HZ)
        self.policy.reset()
        self.last_action[:] = 0
        self.phase = Phase.POLICY
        self.emit('POLICY_START', mode=self.policy.mode)

    def policy_step(self, s, depth_frame):
        cmd = command_from_remote(s['remote'])
        obs = observation(s['gyro'], s['grav'], cmd, s['q'], s['dq'], self.last_action)
        feed = self.policy.inputs(obs, depth_frame if self.policy.depth_needed() else None)
        out = self.policy.run(feed)
        action = out['action'].reshape(12).astype(np.float32)
        self.last_action = action
        target = np.clip(joint_targets(action), DEFAULT_POSE - TARGET_SPAN, DEFAULT_POSE + TARGET_SPAN)
        self.target = target
        self._send(target, KP, KD)

    def hold(self):
        """정책 사이 (200 Hz) 마지막 목표 다시 보내기."""
        if self.phase is Phase.POLICY:
            self._send(self.target, KP, KD)

    def recover(self):
        self.phase = Phase.RECOVERING
        self.to_high()
        if self.live:
            self.sdk.recovery_stand()
        self.emit('ROBOT_FALL_RECOVERY_STAND')
        self.phase = Phase.HIGH

    def back_to_factory(self, gait):
        """감쇠 → 고수준 복귀 → 일어서기 → 순정 보행 (free walk · classic). 펌웨어 쪽 동작은 실기 미확인."""
        if self.phase is Phase.POLICY:
            self.damp('operator back to factory')
        self.to_high()
        if self.live:
            self.sdk.recovery_stand()
            self.sdk.free_walk() if gait == 'free_walk' else self.sdk.classic_walk(True)
        self.emit('FACTORY_GAIT', gait=gait)
