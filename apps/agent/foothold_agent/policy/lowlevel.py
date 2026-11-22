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
import threading
import time
from dataclasses import dataclass

import numpy as np

from .start import EST_VX, DEFAULT_POSE, KD, KP, POLICY_FROM_SDK, SDK_FROM_POLICY, joint_targets, observation, projected_gravity

STAND_KP, STAND_KD = 60., 5.
DAMP_KD = 3.
STAND_SEC, BLEND_SEC = 2.5, 1.0
CMD_HZ, POLICY_HZ = 200, 50
STALE_S = .05
FALL_GRAV_Z, FALL_HOLD_S = -.5, .5
CAPS = {'vx': (-1.3, 1.5), 'vy': (-.5, .5), 'wz': (-1.2, 1.2)}
# 명령 변화 상한 (단위/초, vx · vy · wz): 시뮬 mobile/sim/keyboard-ramp.js START_COMMAND_SLEW 와 같음. 막대를 갑자기 밀어도 이만큼씩만.
SLEW_UP, SLEW_DOWN = (1.5, .5, 2.4), (3.75, 1.25, 3.)
SIT_WAIT_S = 3.0
RECOVER_WAIT_S = 3.0
# 저수준에서 천천히 앉히기: 엎드린 관절 각 (정책 순서, 시뮬 recovery-stand.js fold 와 같음) · 2 초 보간
SIT_POSE = np.array([0, 0, 0, 0, 1.2, 1.2, 1.2, 1.2, -2.7, -2.7, -2.7, -2.7], np.float32)
SIT_SEC = 2.0
STICK_DEADBAND = .05   # RecoveryStand 가 다 서는 시간 (보행 전환은 그 뒤)   # StandDown 이 앉기를 마칠 때까지 (11/22: 기다리지 않으면 선 채로 넘겨 받음)
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
        if abs(v) < STICK_DEADBAND:   # 막대 중립 떨림은 0 (11/22 실기: 멈춤 기록이 88 번 새로 시작됨)
            return 0.
        return v * hi if v >= 0 else -v * lo
    return np.array([axis(r.ly, *CAPS['vx']), axis(-r.lx, *CAPS['vy']), axis(-r.rx, *CAPS['wz'])], np.float32)


def remote_active(r: Remote) -> bool:
    """리모컨을 만지는 중인가 (단추 하나라도 · 막대가 중립 밖). 만지는 동안 앱 명령은 무시 (리모컨 우선)."""
    return bool(r.keys) or max(abs(r.lx), abs(r.ly), abs(r.rx)) >= STICK_DEADBAND


def command_from_app(vel) -> np.ndarray:
    """앱 속도를 리모컨과 같은 학습 상한으로 자른다."""
    return np.array([np.clip(v, -CAPS[k][0], CAPS[k][1]) for v, k in zip(vel, ('vx', 'vy', 'wz'))], np.float32)


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

    def __init__(self, sdk, policy, *, live: bool, clock=time.monotonic, on_event=lambda e: None, sport_mode='mcf', stand_only=False, sit_first=False, app=None):
        self.sdk, self.policy, self.live, self.clock, self.on_event = sdk, policy, live, clock, on_event
        self.app = app   # applink.AppLink 또는 None (앱 명령 끔)
        self.sport_mode, self.stand_only, self.sit_first = sport_mode, stand_only, sit_first   # stand_only: 일어선 뒤 정책 없이 기본 자세만 (첫 실기 · 관절 순서 확인)
        self.phase = Phase.HIGH
        self.target = DEFAULT_POSE.copy()
        self.kp, self.kd = KP, KD
        self.last_action = np.zeros(12, np.float32)
        self.cmd = np.zeros(3, np.float32)
        self._ame2_held = False
        self.stop_trace = None   # 명령이 0 이 된 순간부터 2 초: 발 힘 · 기울기 · 관절 (lead 11/22 14:16 · 멈출 때 마지막 발 비교용)
        self.last_out = {}
        self.start_trace = None  # 서 있다가 명령이 처음 들어간 순간부터 2 초 · 50 Hz (lead 11/22 16:47 · 「팍 튀어나감」 견주기)
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
            # 해제 전에 지금 순정 모드 이름을 읽어 두고, 돌아갈 때 그 이름을 쓴다 (11/22: 이 Go2 X 는 'mcf' · 'normal' 은 7004 거절)
            name = self.sdk.check_mode()
            if name == '':
                self.emit('MODE_LOW', already=True)   # 이미 저수준 (감쇠 뒤 다시 시작): 앉히기 · 해제 없이 바로 일어서기
                return
            if name and name != 'unknown':
                self.sport_mode = name
            # 팀장 11/22 14:19: 순정 모드끼리 바꾸듯 어떤 자세 (선 채 · 감쇠 · 엎드림) 에서든 위 + start 로 바로 붙는다.
            # 해제 직후 지금 관절 각을 잡고 기본 자세로 보간하므로 선 채로 넘겨받아도 주저앉지 않는다 (4b 실측).
            if self.sit_first:
                self.sdk.stand_down()
                time.sleep(SIT_WAIT_S)
            deadline = self.clock() + timeout_s
            while True:
                self.sdk.release_mode()
                if not self.sdk.check_mode():
                    break
                if self.clock() > deadline:
                    raise TimeoutError('MotionSwitcher ReleaseMode did not clear the sport mode')
                time.sleep(.5)
        self.emit('MODE_LOW')

    def to_high(self, tries=5, on_selected=lambda: None):
        """순정 복귀. 요청 결과와 CheckMode 로 확인하고, 실패하면 다시 시도 · 끝내 실패면 MODE_HIGH_FAILED (사람 확인)."""
        ok = not self.live
        for _ in range(tries if self.live else 0):
            code = self.sdk.select_mode(self.sport_mode)
            # 11/22 14:32 실기: 첫 요청이 시간 초과 (3104) 로 돌아와도 순정은 이미 붙어 있을 수 있다 → 그 사이 우리 LowCmd 와
            # 순정이 함께 모터를 쥐어 긁히는 소리. 결과 코드와 상관없이 바로 CheckMode 로 붙었는지 보고 붙었으면 즉시 놓는다.
            if (code[0] if isinstance(code, tuple) else code) == 0 or self.sdk.check_mode() == self.sport_mode:
                on_selected()
            time.sleep(1.)
            if self.sdk.check_mode() == self.sport_mode:
                ok = True
                break
            self.emit('MODE_HIGH_RETRY', mode=self.sport_mode, result=code)
        self.phase = Phase.HIGH
        self.emit('MODE_HIGH' if ok else 'MODE_HIGH_FAILED', mode=self.sport_mode)
        return ok

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
            # 저수준으로 우리가 쥐고 있을 때만 감쇠를 보낸다. 순정 (HIGH) 일 때는 펌웨어가 L2 + B 를 처리한다.
            if self.phase in (Phase.STANDING_UP, Phase.POLICY):
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
        if self.phase in (Phase.POLICY, Phase.STANDING_UP) and {'L2', 'A'} <= keys:
            self.sit_down()   # 저수준일 때 L2 + A = 천천히 앉아 감쇠 (순정의 L2 + A 엎드리기와 같은 뜻 · 팀장 11/22 14:46)
            return s
        if self.phase in (Phase.HIGH, Phase.DAMPING) and {'up', 'start'} <= keys:
            self.start_policy(s)
            return s
        if {'down', 'start'} <= keys:
            if not self._ame2_held:   # 누르는 동안 한 번만 (11/22 실기: 누르고 있는 동안 매 틱 16 번 기록됨)
                self.emit('AME2_UNAVAILABLE', note='AME-2 student ONNX 없음 (석헌 student 대기)')
            self._ame2_held = True
            return s
        self._ame2_held = False
        if self.phase in (Phase.POLICY, Phase.DAMPING) and ({'left', 'start'} <= keys or {'right', 'start'} <= keys):
            self.back_to_factory('free_walk' if 'left' in keys else 'classic')
            return s
        if self.app is not None:
            self.app.poll()
            mode = self.app.take_mode()
            if mode and self.app_mode(mode, s):
                return s
        if self.phase is Phase.POLICY:
            self.policy_step(s, depth_frame)
        return s

    def app_mode(self, mode, s) -> bool:
        """앱 모드 요청. 리모컨을 만지는 중이면 버린다. 할 수 없는 상태면 알리고 버린다 (다시 시도하지 않음)."""
        if remote_active(s['remote']):
            self.emit('APP_MODE_IGNORED', mode=mode, reason='remote active', phase=self.phase.value)
            return False
        low = self.phase in (Phase.STANDING_UP, Phase.POLICY)
        if mode == 'damp' and low:
            self.damp('app')
        elif mode == 'sit' and low:
            self.sit_down()
        elif mode == 'start' and self.phase in (Phase.HIGH, Phase.DAMPING):
            self.emit('APP_MODE', mode=mode)
            self.start_policy(s)
        elif mode in ('classic', 'free_walk') and self.phase in (Phase.POLICY, Phase.DAMPING):
            self.emit('APP_MODE', mode=mode)
            self.back_to_factory(mode)
        else:
            self.emit('APP_MODE_IGNORED', mode=mode, reason='phase', phase=self.phase.value)
            return False
        return True

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
        self.cmd[:] = 0
        self.phase = Phase.POLICY
        self.emit('POLICY_START', mode=self.policy.mode)

    def policy_step(self, s, depth_frame):
        if self.stand_only:
            self._send(DEFAULT_POSE, KP, KD)
            return
        goal, dt = command_from_remote(s['remote']), 1. / POLICY_HZ
        app_vel = self.app.velocity() if self.app is not None else None
        if app_vel is not None and not remote_active(s['remote']):
            goal = command_from_app(app_vel)   # 리모컨이 중립일 때만 앱 속도. 0.3 초 끊기면 None → 0 으로 감속
        still = not np.abs(self.cmd).max() > .05
        for i in range(3):   # 시뮬과 같은 명령 변화 상한
            slowing = abs(goal[i]) < abs(self.cmd[i]) or self.cmd[i] * goal[i] < 0
            lim = (SLEW_DOWN if slowing else SLEW_UP)[i] * dt
            self.cmd[i] += np.clip(goal[i] - self.cmd[i], -lim, lim)
        cmd = self.cmd.copy()
        self._trace_stop(goal, s)
        obs = observation(s['gyro'], s['grav'], cmd, s['q'], s['dq'], self.last_action)
        feed = self.policy.inputs(obs, depth_frame if self.policy.depth_needed() else None)
        out = self.policy.run(feed)
        self.last_out = out
        action = out['action'].reshape(12).astype(np.float32)
        self.last_action = action
        target = np.clip(joint_targets(action), DEFAULT_POSE - TARGET_SPAN, DEFAULT_POSE + TARGET_SPAN)
        self.target = target
        self._send(target, KP, KD)
        self._trace_start(still, goal, s)

    def _trace_start(self, still, goal, s):
        if self.start_trace is None and still and np.abs(goal).max() > .05:
            self.start_trace = {'t0': self.clock(), 'rows': []}
        if self.start_trace is not None:
            r, ff = s['remote'], getattr(self.sdk, 'foot_force', lambda: [])()
            r3 = lambda v: [round(float(x), 3) for x in v]
            # t · 막대 원값 (lx ly rx) · 한도 전 목표 · 한도 뒤 명령 (정책 입력) · 몸 각속도 · 중력 · 관절 목표 · 발 힘 · 전진 속도 추정 (보정 전 · 후, 기록용 ONNX 일 때만, 아니면 null)
            est = [round(float(np.asarray(self.last_out[k]).reshape(-1)[EST_VX]), 4) if k in self.last_out else None for k in ('est_raw', 'est')]
            self.start_trace['rows'].append([round(self.clock() - self.start_trace['t0'], 3), r3((r.lx, r.ly, r.rx)), r3(goal), r3(self.cmd),
                                             r3(s['gyro']), r3(s['grav']), r3(self.target), list(ff), est])
            if self.clock() - self.start_trace['t0'] >= 2.:
                self.emit('START_TRACE', **self.start_trace)
                self.start_trace = None

    def _trace_stop(self, goal, s):
        moving = bool(np.abs(self.cmd).max() > .05)
        if self.stop_trace is None and moving and not np.abs(goal).max() > 1e-3:
            self.stop_trace = {'t0': self.clock(), 'cmd0': [round(float(x), 3) for x in self.cmd], 'rows': []}
        if self.stop_trace is not None:
            ff = getattr(self.sdk, 'foot_force', lambda: [])()
            self.stop_trace['rows'].append([round(self.clock() - self.stop_trace['t0'], 3), [round(float(x), 3) for x in s['grav']], list(ff),
                                            [round(float(x), 3) for x in s['q']]])
            if self.clock() - self.stop_trace['t0'] >= 2. or np.abs(goal).max() > .05:
                self.emit('STOP_TRACE', **self.stop_trace)
                self.stop_trace = None

    def hold(self):
        """정책 사이 (200 Hz) 마지막 목표 다시 보내기."""
        if self.phase is Phase.POLICY:
            self._send(self.target, KP, KD)

    def recover(self):
        self.phase = Phase.RECOVERING
        if self.to_high() and self.live:
            self.sdk.recovery_stand()
        self.emit('ROBOT_FALL_RECOVERY_STAND')
        self.phase = Phase.HIGH

    def sit_down(self):
        """지금 자세에서 엎드린 자세로 2 초 보간 → 감쇠. 서 있는 채로 감쇠하면 다리가 이상하게 접힌다 (11/22 실기)."""
        s0, t0 = self.read(), self.clock()
        start = s0['q'].copy()
        self.phase = Phase.STANDING_UP   # 보간 중 (L2 + B · 끊김이면 감쇠)
        self.emit('SIT_DOWN')
        while True:
            a = min(1., (self.clock() - t0) / SIT_SEC)
            st = self.read()
            if {'L2', 'B'} <= st['remote'].keys or st['stale']:
                break
            self._send(start + (SIT_POSE - start) * (a * a * (3 - 2 * a)), KP, KD)
            if a >= 1.:
                break
            time.sleep(1. / CMD_HZ)
        self.damp('sat down')

    def back_to_factory(self, gait):
        """서 있는 채로 순정 복귀 → 순정 보행 (free walk · classic).
        11/22 14:25 실기: 감쇠부터 하면 SelectMode 가 1~3 초 걸리는 동안 선 채로 힘이 빠져 몸이 뒤집혔다.
        그래서 순정이 붙을 때까지 기본 자세를 200 Hz 로 계속 잡고 (뒤 스레드), 붙은 것을 확인하면 바로 놓는다.
        끝내 안 붙으면 그때 감쇠."""
        # 11/22 14:46 실기: 선 채로 자세를 잡은 채 넘기면 SelectMode 가 2~3 초 막혀 있는 동안 순정과 겹쳐 긁히는 소리.
        # 그래서 먼저 우리가 천천히 앉히고 감쇠한 뒤 넘긴다 (순정은 엎드린 상태에서 붙고 RecoveryStand 로 일어섬).
        if self.phase in (Phase.POLICY, Phase.STANDING_UP):
            self.sit_down()
        hold = False
        stop = threading.Event()
        def holder():
            while not stop.is_set():
                self._send(DEFAULT_POSE, KP, KD)
                time.sleep(1. / CMD_HZ)
        th = threading.Thread(target=holder, daemon=True) if hold and self.live else None
        if th:
            th.start()
        self.emit('FACTORY_HANDOVER', gait=gait, holding=bool(th))
        try:
            ok = self.to_high(on_selected=stop.set)
        finally:
            stop.set()
            if th:
                th.join(1.)
        if not ok:
            self.damp('factory mode did not attach')
            return
        codes = {}
        if self.live:
            codes['recovery_stand'] = self.sdk.recovery_stand()
            # 11/22 14:26 실기: RecoveryStand 직후 바로 보행 전환을 보내면 무시되고 기본 sport 로 남음 → 다 선 뒤 (3 초) 보낸다
            time.sleep(RECOVER_WAIT_S)
            codes[gait] = self.sdk.free_walk() if gait == 'free_walk' else self.sdk.classic_walk(True)
        self.emit('FACTORY_GAIT', gait=gait, result=str(codes))
