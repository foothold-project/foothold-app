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
import math
import struct
import threading
import time
from dataclasses import dataclass

import numpy as np

from .trace import r4
from .start import EST_V, EST_VX, DEFAULT_POSE, body_height, KD, KP, POLICY_FROM_SDK, SDK_FROM_POLICY, joint_targets, observation, projected_gravity

STAND_KP, STAND_KD = 60., 5.
DAMP_KD = 3.
STAND_SEC, BLEND_SEC = 2.5, 1.0
CMD_HZ, POLICY_HZ = 200, 50
STALE_S = .05
FALL_GRAV_Z, FALL_HOLD_S = -.5, .5
CAPS = {'vx': (-1.3, 1.5), 'vy': (-.8, .8), 'wz': (-1.5, 1.5)}   # 축 하나만 쓸 때의 끝. 섞을 때는 shape_command
FWD_TOP = CAPS['vx'][1]   # 실기 전진 상한 (run.py --fwd-max · 팀장 11/23 13:54 (가): 1.34~1.43 에서 FL 다리 포화로 두 번 넘어질 뻔 → 1.2). 막대 끝 = 이 값
SETTLE_MAX_S, SETTLE_TILT, SETTLE_DQ, SETTLE_FOOT = 1.5, math.sin(math.radians(3.)), .2, .6   # (나) 멈춘 뒤 정렬 대기 조건
STOP_MODES = ('sit', 'settle', 'stand')   # sit = 지금 (바로 엎드림) · settle = (나) · stand = (가) 서 있는 채 순정 넘김
# 학습 명령 띠의 아래 끝 (E2 plan: forward [0.1, 1.5] · reverse [-1.3, -0.2] · side [0.1, 0.8] · walk wz [0.1, 1.0])
FLOOR_POS, FLOOR_NEG = (.1, .1, .15), (.2, .1, .15)   # 회전 0.15 (제자리 회전 표집 |wz| 0.15~1.5 · lead 11/23 12:39)
LIVENESS_S = 1.0   # LowState 가 이만큼 끊기면 엎드린 뒤 순정 (팀장 11/22 결정 11). 그 전까지는 마지막 목표를 잡고 기다림
# 명령 변화 상한 (단위/초, vx · vy · wz): 시뮬 mobile/sim/keyboard-ramp.js START_COMMAND_SLEW 와 같음. 막대를 갑자기 밀어도 이만큼씩만.
SLEW_UP, SLEW_DOWN = (.5, .5, 2.4), (1.2, 1.25, 3.)   # 가속 낮춤 (팀장 11/23 11:39: 붙자마자 전진이 미친 듯 튀어나감 · 1.5 → 0.5 m/s², 0 → 1.0 m/s 에 2 초)   # 전진 감속 1.2 /s 를 늘 (planner 11/23 09:55 · 시뮬 3.3~3.8 cm). 시뮬 keyboard-ramp.js 는 아직 3.75 (맞춰야 함)
SIT_WAIT_S = 3.0
RECOVER_WAIT_S = 3.0
# 저수준에서 천천히 앉히기 · 서기: Classic L2 + A 실측 (팀장 11/24 11:24~11:42 · 앉기 11 · 서기 11 회 · trace-1124/PHASES-1124.json).
# 엎드린 끝 자세 = Classic 평균 (뒷다리 엉덩이를 0.34 벌려 앉음 · 회차 편차 최대 0.023). 이전 값은 시뮬 fold (0 · 1.2 · -2.7).
SIT_POSE = np.array([.06, -.06, .34, -.34, 1.24, 1.24, 1.29, 1.29, -2.78, -2.78, -2.82, -2.82], np.float32)
SIT_SEC = 2.0   # Classic 엎드리기 1.9 초
# 관절마다 움직이는 창 (전체 시간에 대한 비율 [시작, 끝]) · 정책 순서 hip FL FR RL RR · thigh × 4 · calf × 4.
# 앉기: 허벅지 · 종아리가 바로 접히기 시작 · 뒷다리 엉덩이는 1/4 뒤부터 벌림 · 앞다리 엉덩이는 절반 뒤.
SIT_WIN = np.array([[.5, 1.]] * 2 + [[.25, 1.]] * 2 + [[0., .97]] * 4 + [[0., .95]] * 4)
# 서기: 앞다리 엉덩이 먼저 → 뒷다리 엉덩이 (0.28) → 허벅지 (0.42) · 종아리 (0.46) 가 함께 펴서 끝 (Classic 1.16 초 · 우리는 STAND_SEC 에 늘림)
STAND_WIN = np.array([[0., .95]] * 2 + [[.28, .92]] * 2 + [[.42, .98]] * 4 + [[.46, 1.]] * 4)


def staged(start, end, a, win):
    """관절마다 자기 창 [시작, 끝] 안에서만 부드럽게 (smoothstep) 옮김. a = 0..1 (전체 진행). a = 1 이면 정확히 end."""
    lo, hi = win[:, 0], win[:, 1]
    x = np.clip((a - lo) / (hi - lo), 0., 1.)
    return start + (end - start) * (x * x * (3 - 2 * x))
# 엎드린 채 다시 설 때: 먼저 다리를 몸 밑으로 모은 뒤 (FOLD_SEC) 선다. 몸이 이만큼 넘게 기울었으면 서지 않는다
# (팀장 11/23 17:30: 네 발을 고르게 모으지 못한 채 앉은 뒤 L2 + A 로 바로 세우자 뒤집힘 · Unitree go2_stand_example 도 접은 자세를 거쳐 선다)
FOLD_SEC, RESTAND_MAX_TILT_DEG = 1.0, 25.
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


GAP = .05   # 이 안의 축은 0 으로 본다 (막대 죽은 띠와 같음)


def shape_command(vx, vy, wz):
    """학습에 있던 명령 꼴만 남긴다 (팀장 11/22 결정 10 · lead 11/23 09:41 정본 표 · planner plan 811~840 · mixed_core.py 286~327).
    전진 (0, 1.5] · 뒤 [-1.3, 0) · 제자리 회전 |wz| 1.5 · 옆: vx 0 이면 0.8, 0.3 ≤ |vx| ≤ 0.6 이면 0.5, 0.6 위 0 ·
    회전: vx 0 · vy 0 이면 1.5, vx < 0 또는 vy ≠ 0 이면 0.6, 0.3 ≤ vx ≤ 1.2 이면 1.0, 1.2 위 0 ·
    학습에 없는 틈 (0.05 < |vx| < 0.3 에 다른 축 섞임) 은 가장 큰 축 하나만 남김. 돌려줌: (명령 3, 표지 none · clip · gap)."""
    want = [float(vx), float(vy), float(wz)]
    v = [0. if abs(x) <= GAP else x for x in want]
    mark = 'none'
    if GAP < abs(v[0]) < .3 - 1e-4 and v[1]:
        # 대각선: 전진을 지우지 않고 학습 diag (vx 0.3~0.6) 끝으로 올린다 (팀장 11/23 11:51: 대각선이 옆 걸음으로 잠김)
        v[0] = math.copysign(.3, v[0])
        mark = 'gap'
    elif GAP < abs(v[0]) < .3 - 1e-4 and v[2]:
        # 걸으며 회전 틈: 큰 축 하나 (막대가 살짝 앞으로 밀린 제자리 회전이 걷기로 바뀌지 않게)
        k = max(range(3), key=lambda i: abs(v[i]))
        v = [x if i == k else 0. for i, x in enumerate(v)]
        mark = 'gap'
    x = min(max(v[0], CAPS['vx'][0]), CAPS['vx'][1], FWD_TOP)
    if abs(x) > .6 and abs(v[1]) >= .2:
        # 빠른 대각선: 옆을 지우지 않고 전진을 학습 diag 끝 (0.6) 으로 줄여 방향을 지킨다 (팀장 11/23 12:00: 대각선이 아예 안 됨 ·
        # 막대를 끝까지 비스듬히 밀면 전진 1.4 에 옆 0 이 되던 것)
        x = math.copysign(.6, x)
        mark = 'clip'
    ax = abs(x)
    e = 1e-4   # 막대 float32 반올림 (0.4 × 1.5 = 0.6000000238) 이 경계를 넘지 않게
    ycap = .8 if x == 0 else .5 if .3 - e <= ax <= .6 + e else 0. if ax > .6 + e else .8
    y = min(max(v[1], -ycap), ycap)
    if x == 0 and y == 0:
        zcap = 1.5
    elif x < 0 or y != 0:
        zcap = .6
    elif .3 - e <= x <= 1.2 + e:
        zcap = 1.
    elif x > 1.2 + e:
        zcap = 0.
    else:
        zcap = 1.5   # 틈에서 vx 하나만 남은 경우 (wz 는 이미 0)
    z = min(max(v[2], -zcap), zcap)
    out = [x, y, z]
    if mark == 'none' and any(abs(a - b) > 1e-6 for a, b in zip(out, v)):
        mark = 'clip'
    if mark == 'none' and .3 - e <= ax <= .6 + e and 0 < abs(y) < .2:
        mark = 'interp'   # 학습 diag vy [0.2, 0.5] 안쪽 보간 구간 (값은 그대로 · 표시만 · planner 09:55)
    return np.array(out, np.float32), mark


def command_from_remote(r: Remote) -> np.ndarray:
    """왼 막대 앞뒤 · 좌우 = vx · vy, 오른 막대 좌우 = wz (시뮬 손 조종과 같은 뜻). 막대 끝 = 축 하나만 쓸 때의 학습 끝, 섞으면 shape_command 가 자름."""
    return shape_command(*remote_want(r))[0]


def remote_want(r: Remote):
    """막대가 바라는 값 (자르기 전). 막대 → 속도는 제곱 곡선 (팀장 11/23 11:15 · 나 안): 1/3 → 0.17, 2/3 → 0.67, 끝 → 1.5 m/s.
    저속을 세밀하게 쓰고 끝에서만 학습 끝 값에 닿는다 (11/22 밖 「팍 튀어나감」 · 비례였을 때 1/3 = 0.5 m/s)."""
    def unit(v):
        v = float(np.clip(v, -1, 1))
        if abs(v) < STICK_DEADBAND:   # 막대 중립 떨림은 0 (11/22 실기: 멈춤 기록이 88 번 새로 시작됨)
            return 0.
        return v * abs(v)
    def lin(v):
        v = float(np.clip(v, -1, 1))
        return 0. if abs(v) < STICK_DEADBAND else v
    fx, fy, fz = unit(r.ly), lin(-r.lx), lin(-r.rx)   # 곡선은 전진만 (옆 · 회전은 어제처럼 비례 · 팀장 11/23 11:51)
    return fx * (FWD_TOP if fx >= 0 else -CAPS['vx'][0]), fy * CAPS['vy'][1], fz * CAPS['wz'][1]


def remote_active(r: Remote) -> bool:
    """리모컨을 만지는 중인가 (단추 하나라도 · 막대가 중립 밖). 만지는 동안 앱 명령은 무시 (리모컨 우선)."""
    return bool(r.keys) or max(abs(r.lx), abs(r.ly), abs(r.rx)) >= STICK_DEADBAND


def command_from_app(vel) -> np.ndarray:
    """앱 속도를 리모컨과 같은 학습 꼴로 자른다."""
    return shape_command(*vel)[0]


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

    def __init__(self, sdk, policy, *, live: bool, clock=time.monotonic, on_event=lambda e: None, sport_mode='mcf', stand_only=False, sit_first=False, app=None, trace=None, stop_mode='sit'):
        self.sdk, self.policy, self.live, self.clock, self.on_event = sdk, policy, live, clock, on_event
        self.app = app   # applink.AppLink 또는 None (앱 명령 끔)
        self.trace = trace   # trace.TraceWriter 또는 None · START 가 켜진 동안 50 Hz 한 줄씩
        if stop_mode not in STOP_MODES:
            raise ValueError(f'stop_mode must be one of {STOP_MODES}')
        self.stop_mode = stop_mode   # 멈춰 엎드릴 때 · 순정 넘길 때 어떤 길로 (팀장 11/23 09:52 문제 · 선택 표지)
        self.slew_down = SLEW_DOWN
        self.stale_since = None
        self.sport_mode, self.stand_only, self.sit_first = sport_mode, stand_only, sit_first   # stand_only: 일어선 뒤 정책 없이 기본 자세만 (첫 실기 · 관절 순서 확인)
        self.phase = Phase.HIGH
        self.target = DEFAULT_POSE.copy()
        self.kp, self.kd = KP, KD
        self.last_action = np.zeros(12, np.float32)
        self.cmd = np.zeros(3, np.float32)
        self._ame2_held = False
        self._l2a_latched = False
        self.stop_trace = None   # 명령이 0 이 된 순간부터 2 초: 발 힘 · 기울기 · 관절 (lead 11/22 14:16 · 멈출 때 마지막 발 비교용)
        self.last_out = {}
        self.fall_since = None
        self.events: list[Event] = []
        self.sent = 0

    # ── 기록 ──
    def emit(self, code, **data):
        e = Event(self.clock(), code, data)
        self.events.append(e)
        self.on_event(e)
        if self.trace is not None:   # 넘김 순간 · 모드 전환도 같은 기록에 (한 줄 event 칸)
            self.trace.write({'t': round(e.t, 4), 'wall': round(time.time(), 3), 'event': code, **data})

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
            # 짧게 끊기면 마지막 목표를 잡고 기다린다 (hold 가 200 Hz 로 다시 보냄). LIVENESS_S 넘으면 엎드린 뒤 순정 (팀장 결정 11).
            self.stale_since = self.stale_since or self.clock()
            if self.clock() - self.stale_since >= LIVENESS_S:
                self.emit('LIVENESS_LOST', seconds=round(self.clock() - self.stale_since, 2))
                self.stale_since = None
                self.sit_down(blind=True)
                self.to_high()
            return s
        self.stale_since = None
        if self.phase is Phase.POLICY and self.fallen(s):
            self.damp('fall')
            self.emit('ROBOT_FALL', grav_z=float(s['grav'][2]))
            self.recover()
            return s
        l2a = {'L2', 'A'} <= keys
        if not l2a:
            self._l2a_latched = False   # 놓은 뒤에만 다음 L2 + A 를 받는다 (앉히자마자 다시 서지 않게)
        if self.phase is Phase.DAMPING and l2a and not self._l2a_latched:
            # 저수준으로 엎드린 상태에서 L2 + A = 다시 일어서 START (순정의 L2 + A 처럼 · 팀장 11/23 11:39)
            self._l2a_latched = True
            self.start_policy(s)
            return s
        if self.phase in (Phase.POLICY, Phase.STANDING_UP) and l2a and not self._l2a_latched:
            self._l2a_latched = True
            self.lower()   # 저수준일 때 L2 + A = 천천히 앉아 감쇠 (stop_mode 에 따라 정렬 대기 · 서서 넘김) (순정의 L2 + A 엎드리기와 같은 뜻 · 팀장 11/22 14:46)
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
            self.lower()
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
        from_lying = self.phase is Phase.DAMPING   # 저수준에서 엎드려 힘 빠진 상태 (앉힘 · 감쇠 뒤)
        if from_lying:
            tilt = math.degrees(math.acos(max(-1., min(1., -float(s['grav'][2])))))
            if tilt > RESTAND_MAX_TILT_DEG:
                self.emit('STAND_REFUSED', reason='tilted', tilt_deg=round(tilt, 1))   # 옆으로 누웠거나 뒤집힘: 사람이 바로 놓은 뒤 다시
                return
        self.to_low()
        self.phase = Phase.STANDING_UP
        start, t0 = s['q'].copy(), self.clock()
        if from_lying:
            # 1 단계: 엎드린 채 다리를 몸 밑 접은 자세 (SIT_POSE) 로 모음. 엉덩이 좌우 · 앞뒤 어긋남을 먼저 바로잡는다
            self.emit('STAND_FOLD', sec=FOLD_SEC)
            while True:
                a = min(1., (self.clock() - t0) / FOLD_SEC)
                st = self.read()
                if {'L2', 'B'} <= st['remote'].keys or st['stale']:
                    self.damp('fold interrupted')
                    return
                tgt = start + (SIT_POSE - start) * (a * a * (3 - 2 * a))
                self._send(tgt, STAND_KP, STAND_KD)
                self._trace_transition(st, tgt)
                if a >= 1.:
                    break
                time.sleep(1. / CMD_HZ)
            start, t0 = SIT_POSE.astype(np.float64).copy(), self.clock()
        while self.phase is Phase.STANDING_UP:
            a = min(1., (self.clock() - t0) / STAND_SEC)
            st = self.read()
            if {'L2', 'B'} <= st['remote'].keys or st['stale']:
                self.damp('stand-up interrupted')
                return
            blend = min(1., max(0., (self.clock() - t0 - STAND_SEC) / BLEND_SEC))
            kp, kd = STAND_KP + (KP - STAND_KP) * blend, STAND_KD + (KD - STAND_KD) * blend
            tgt = staged(start, DEFAULT_POSE, a, STAND_WIN)   # Classic 순서 (엉덩이 먼저 → 허벅지 · 종아리)
            self._send(tgt, kp, kd)
            self._trace_transition(st, tgt)
            if blend >= 1.:
                break
            time.sleep(1. / CMD_HZ)
        self.policy.reset()
        self.last_action[:] = 0
        self.cmd[:] = 0
        self.phase = Phase.POLICY
        self.emit('POLICY_START', mode=self.policy.mode)

    def policy_step(self, s, depth_frame, force_zero=False):
        if self.stand_only:
            self._send(DEFAULT_POSE, KP, KD)
            return
        want, dt = (0., 0., 0.) if force_zero else remote_want(s['remote']), 1. / POLICY_HZ
        app_vel = self.app.velocity() if self.app is not None else None
        if app_vel is not None and not remote_active(s['remote']) and not force_zero:
            want = app_vel   # 리모컨이 중립일 때만 앱 속도. 0.3 초 끊기면 None → 0 으로 감속
        goal, self.shape_mark = shape_command(*want)
        self.want = want
        for i in range(3):   # 시뮬과 같은 명령 변화 상한
            slowing = abs(goal[i]) < abs(self.cmd[i]) or self.cmd[i] * goal[i] < 0
            lim = (self.slew_down if slowing else SLEW_UP)[i] * dt
            self.cmd[i] += np.clip(goal[i] - self.cmd[i], -lim, lim)
            # 학습에 없는 아주 작은 명령 띠를 건너뛴다 (팀장 11/23 12:09: 옆 걸음이 「기를 모으다가」 들어감 ·
            # 기록: 옆 0.01 → 0.31 을 0.6 초 동안 올리는 사이 몸만 옆으로 4° 기울고 발이 늦게 나감).
            # 출발: 목표가 띠 위인데 명령이 띠 안이면 띠 끝으로 바로. 멈춤: 목표 0 인데 명령이 띠 안이면 바로 0.
            floor = (FLOOR_POS if goal[i] > 0 or (goal[i] == 0 and self.cmd[i] > 0) else FLOOR_NEG)[i]
            c = float(self.cmd[i])
            if abs(goal[i]) >= floor and abs(c) < floor and c * goal[i] >= 0:
                self.cmd[i] = math.copysign(floor, goal[i])
            elif goal[i] == 0 and 0 < abs(c) < floor:
                self.cmd[i] = 0.
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
        if self.trace is not None:
            self.trace.write(self.trace_row(s, goal))

    def trace_row(self, s, goal=None):
        """기록 한 줄 (정책 순서 관절). 순정 읽기 전용 기록도 같은 꼴 (goal · cmd · target · est 는 null)."""
        r = s['remote']
        tau = getattr(self.sdk, 'motor_tau', lambda: None)()
        temp = getattr(self.sdk, 'motor_temp', lambda: None)()
        est = [round(float(np.asarray(self.last_out[k]).reshape(-1)[EST_VX]), 4) if k in self.last_out else None for k in ('est_raw', 'est')]
        low = self.phase is Phase.POLICY
        return {'t': round(self.clock(), 4), 'wall': round(time.time(), 3), 'phase': self.phase.value, 'stick': r4((r.lx, r.ly, r.rx)), 'keys': sorted(r.keys),
                'want': r4(getattr(self, 'want', None)) if low else None, 'shape': getattr(self, 'shape_mark', None) if low else None,
                'goal': r4(goal) if low else None, 'cmd': r4(self.cmd) if low else None, 'target': r4(self.target) if low else None,
                'q': r4(s['q']), 'dq': r4(s['dq']), 'tau': r4(np.asarray(tau)[POLICY_FROM_SDK]) if tau is not None else None,
                'temp': [int(x) for x in np.asarray(temp)[POLICY_FROM_SDK]] if temp is not None else None,
                'foot': list(getattr(self.sdk, 'foot_force', lambda: [])()), 'gyro': r4(s['gyro']), 'grav': r4(s['grav']),
                'est_vx': est if low else None,
                'est_v': r4(np.asarray(self.last_out['est']).reshape(-1)[EST_V]) if low and 'est' in self.last_out else None,
                'h_kin': body_height(s['q'], s['grav']), 'bat': getattr(self.sdk, 'battery', lambda: None)()}

    def _trace_transition(self, st, target):
        """앉기 · 다리 모으기 · 일어서기 동안에도 50 Hz 기록. 동작은 바꾸지 않는다 (팀장 11/23 18:00: 라이다가 닿는 순간 몸 기울기를 먼저 숫자로)."""
        if self.trace is None:
            return
        self._tt = getattr(self, '_tt', 0) + 1
        if self._tt % (CMD_HZ // POLICY_HZ) == 0:
            row = self.trace_row(st)
            row['target'] = r4(target)
            self.trace.write(row)

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

    def lower(self, *, lie=True) -> bool:
        """멈춘 뒤 내려놓기. 돌려줌: True = 이미 순정에 넘김 (가 · stand) · False = 우리가 엎드려 감쇠함 (부르는 쪽이 to_high).
        sit: 바로 엎드림. settle (나): 명령 0 으로 정책을 계속 돌리며 정렬을 기다렸다가 엎드림, 못 맞춰도 엎드림 (sit · 15:18 확인 길).
        settle 은 stand 로 가지 않는다 (팀장 11/23 10:04: 모터 소리 다시 나면 안 됨 · stand 는 팀장이 고를 때만).
        stand (가): 서 있는 채 순정 넘김 → BalanceStand (순정이 발을 굴러 중심을 맞춤) → lie 면 StandDown."""
        if self.phase is not Phase.POLICY or self.stop_mode == 'sit':
            self.sit_down()
            return False
        if self.stop_mode == 'settle':
            self.settle()   # 맞추든 못 맞추든 엎드림
            self.sit_down()
            return False
        return self.stand_handover(lie=lie)

    def settled(self, s) -> bool:
        ff = [float(x) for x in getattr(self.sdk, 'foot_force', lambda: [])()]
        feet = len(ff) == 4 and min(ff) > 0 and min(ff) / (sum(ff) / 4) >= SETTLE_FOOT
        tilt = max(abs(float(s['grav'][0])), abs(float(s['grav'][1]))) <= SETTLE_TILT
        return feet and tilt and float(np.abs(s['dq']).max()) <= SETTLE_DQ and not np.abs(self.cmd).max() > 1e-3

    def settle(self) -> bool:
        """(나) 명령 0 · 감속 1.2 /s 로 정책을 계속 돌리며 발 힘 넷 고름 · 기울기 3° 안 · 관절 속도 작음을 기다림 (최대 1.5 초, 명령이 0 이 된 뒤부터)."""
        self.emit('SETTLE_WAIT')
        t_zero = None
        while True:
            s = self.read()
            if {'L2', 'B'} <= s['remote'].keys or s['stale']:
                self.emit('SETTLE_ABORT', reason='L2+B' if not s['stale'] else 'stale')
                return True   # 엎드림 길로 (sit_down 이 다시 확인해 감쇠)
            self.policy_step(s, None, force_zero=True)
            if not np.abs(self.cmd).max() > 1e-3:
                t_zero = t_zero or self.clock()
                if self.settled(s):
                    self.emit('SETTLE_OK', seconds=round(self.clock() - t_zero, 3))
                    return True
                if self.clock() - t_zero >= SETTLE_MAX_S:
                    self.emit('SETTLE_TIMEOUT', seconds=round(self.clock() - t_zero, 3))
                    return False
            for _ in range(CMD_HZ // POLICY_HZ - 1):
                time.sleep(1. / CMD_HZ)
                self.hold()
            time.sleep(1. / CMD_HZ)

    def stand_handover(self, *, lie=True) -> bool:
        """(가) 서 있는 채 순정 넘김. 순정이 붙을 때까지 마지막 정책 목표를 200 Hz 로 잡고 (뒤 스레드), 붙은 것을 보면 바로 놓는다.
        HANDOVER_GAP: 우리 마지막 LowCmd 부터 순정이 붙은 것을 본 때까지 (ms, 이 PC 의 시계). 순정 첫 제어까지의 실제 틈은 펌웨어 안이라 미확인.
        11/22 14:27~14:46 의 잡은 채 넘긴 판은 붙은 뒤 RecoveryStand 를 보냈고 그때 갈리는 소리가 났다 (원인 미확인). 이 길은 BalanceStand 를 쓴다 · 실기 0 회 · 기본은 sit."""
        hold_q = self.target.copy()
        stop, last = threading.Event(), [time.monotonic()]
        def holder():
            while not stop.is_set():
                self._send(hold_q, KP, KD)
                last[0] = time.monotonic()
                time.sleep(1. / CMD_HZ)
        th = threading.Thread(target=holder, daemon=True) if self.live else None
        if th:
            th.start()
        self.emit('STAND_HANDOVER', lie=lie)
        seen = []
        def selected():
            seen.append(time.monotonic())
            stop.set()
        try:
            ok = self.to_high(on_selected=selected)
        finally:
            stop.set()
            if th:
                th.join(1.)
        self.emit('HANDOVER_GAP', ms=round((seen[0] - last[0]) * 1e3, 1) if seen else None, attached=ok)
        if not ok:
            self.damp('factory mode did not attach (stand)')
            return True
        codes = {}
        if self.live:
            codes['balance_stand'] = self.sdk.balance_stand()
            if lie:
                time.sleep(RECOVER_WAIT_S)
                codes['stand_down'] = self.sdk.stand_down()
        self.emit('FACTORY_STAND', result=str(codes))
        return True

    def shutdown(self):
        """끝날 때도 선 채 감쇠하지 않는다 (11/22 20:27 실기: 선 채 감쇠 → 주저앉음). 천천히 엎드린 뒤 순정 (팀장 결정 11)."""
        if self.phase in (Phase.POLICY, Phase.STANDING_UP):
            self.emit('EXIT_SIT_DOWN')
            if not self.lower():
                self.to_high()

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

    def sit_down(self, blind=False):
        """지금 자세에서 엎드린 자세로 2 초 보간 (관절마다 Classic 순서) → 감쇠. 서 있는 채로 감쇠하면 다리가 이상하게 접힌다 (11/22 실기).
        blind: LowState 가 끊긴 채로 (마지막으로 받은 관절 각에서) 끝까지 보간한다 (생존 신호 끊김 · 팀장 결정 11)."""
        s0, t0 = self.read(), self.clock()
        start = s0['q'].copy()
        self.phase = Phase.STANDING_UP   # 보간 중 (L2 + B · 끊김이면 감쇠)
        self.emit('SIT_DOWN')
        while True:
            a = min(1., (self.clock() - t0) / SIT_SEC)
            st = self.read()
            if {'L2', 'B'} <= st['remote'].keys or (st['stale'] and not blind):
                break
            tgt = staged(start, SIT_POSE, a, SIT_WIN)   # Classic 순서 (허벅지 · 종아리 먼저 → 뒷다리 엉덩이 벌림)
            self._send(tgt, STAND_KP, STAND_KD)   # 서기와 같은 버팀 (11/24 13:14 실기: kp 25 로는 걸은 뒤 안쪽으로 들어간 FR 이 무게를 못 버텨 꺾이며 오른쪽으로 넘어짐)
            self._trace_transition(st, tgt)
            if a >= 1.:
                break
            time.sleep(1. / CMD_HZ)
        self.damp('sat down')

    def back_to_factory(self, gait):
        """서 있는 채로 순정 복귀 → 순정 보행 (free walk · classic).
        11/22 14:25 실기: 감쇠부터 하면 SelectMode 가 1~3 초 걸리는 동안 선 채로 힘이 빠져 몸이 뒤집혔다.
        그래서 순정이 붙을 때까지 기본 자세를 200 Hz 로 계속 잡고 (뒤 스레드), 붙은 것을 확인하면 바로 놓는다.
        끝내 안 붙으면 그때 감쇠."""
        # 11/22 14:27~14:46 실기: 잡은 채 넘긴 판에서 순정이 붙은 뒤 RecoveryStand 로 앉았다 일어설 때 갈리는 소리 (원인 미확인: 겹침인지 순정 동작인지).
        # 그래서 먼저 우리가 천천히 앉히고 감쇠한 뒤 넘긴다 (순정은 엎드린 상태에서 붙고 RecoveryStand 로 일어섬).
        if self.phase in (Phase.POLICY, Phase.STANDING_UP) and self.lower(lie=False):
            # (가) 이미 서 있는 채 순정에 붙음 (BalanceStand) → RecoveryStand 없이 보행만
            if self.phase is Phase.HIGH and self.live:
                time.sleep(1.)
                code = self.sdk.free_walk() if gait == 'free_walk' else self.sdk.classic_walk(True)
                self.emit('FACTORY_GAIT', gait=gait, result=str({gait: code}))
            return
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
            # 11/23 11:35 실기: ClassicWalk 가 -1 로 돌아와 sport 로 남음 → 0 이 올 때까지 1 초 간격 3 번 (결과는 모두 남김)
            tries = []
            for _ in range(3):
                code = self.sdk.free_walk() if gait == 'free_walk' else self.sdk.classic_walk(True)
                tries.append(code[0] if isinstance(code, tuple) else code)
                if tries[-1] == 0:
                    break
                time.sleep(1.)
            codes[gait] = tries
        self.emit('FACTORY_GAIT', gait=gait, result=str(codes))
