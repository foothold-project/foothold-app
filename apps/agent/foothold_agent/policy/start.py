"""START (m15500 정본 3) 저수준 정책의 관측 조립 · ONNX 실행 (Jetson · 로봇 I/O 없음).

브라우저 시뮬 `mobile/sim/start-demo-adapter.js` 와 같은 계약을 파이썬으로 옮겼다.
- 입력 9 개: obs45 · hist [10,45] (지금 것이 맨 앞) · depth2 [2,60,60] (새 것이 맨 앞, 5 스텝마다 · 한 장 늦게) ·
  h_prop · h_terr (GRU, 출력을 다음 입력으로) · depth_tick · first_after_reset · use_gt · gt_map [32,16].
- 지도 모드: reconstruction (깊이로 지형 복원 · map_on) · off (고유수용감각만 · map_off). gt (정답 지도) 는 시뮬 전용이라 실기에 없다.
  off 에서는 깊이가 행동에 안 들어가므로 깊이 캡처를 하지 않고 0 을 넣는다 (시험 벡터로 확인 · app 427177d8).
- 행동: 목표 관절각 = 기본 자세 + 0.25 × clip(a, -17, 17), PD kp 25 · kd 0.5 (정책 순서).
속도 보정 (b 0.010) 은 ONNX 안에 있어 여기서 다시 하지 않는다 (lead 11/21 22:58).
이 모듈은 저수준 명령을 보내지 않는다. 송신 · 모드 전환은 별도 경계 (팀장 동의 뒤).
"""
from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

# 정책 (Isaac) 순서: [hip, thigh, calf] × [FL, FR, RL, RR]
POLICY_JOINTS = [f'{leg}_{part}_joint' for part in ('hip', 'thigh', 'calf') for leg in ('FL', 'FR', 'RL', 'RR')]
# Unitree SDK LowState/LowCmd motor_state 순서: [FR, FL, RR, RL] × [hip, thigh, calf]
SDK_JOINTS = [f'{leg}_{part}_joint' for leg in ('FR', 'FL', 'RR', 'RL') for part in ('hip', 'thigh', 'calf')]
POLICY_FROM_SDK = np.array([SDK_JOINTS.index(n) for n in POLICY_JOINTS])   # policy[i] = sdk[POLICY_FROM_SDK[i]]
SDK_FROM_POLICY = np.array([POLICY_JOINTS.index(n) for n in SDK_JOINTS])   # sdk[j] = policy[SDK_FROM_POLICY[j]]
DEFAULT_POSE = np.array([.1, -.1, .1, -.1, .8, .8, 1, 1, -1.5, -1.5, -1.5, -1.5], dtype=np.float32)
ACTION_SCALE, ACTION_CLIP, KP, KD = .25, 17., 25., .5
DEPTH_EVERY = 5
MODEL_FILES = {'reconstruction': 'start-m15500_map_on.onnx', 'off': 'start-m15500_map_off.onnx', 'gt': 'start-m15500_map_on.onnx'}
MODEL_SHA256 = {
    'start-m15500_map_on.onnx': 'df91c2d772c7d054e33c74fca479e79550cfd228d7682402f7eef4a0865e279f',
    'start-m15500_map_off.onnx': 'be6c8b103d3b39503447ee71076ec199e5ed0688c3540ccfe449a96d6e2a9a41',
}
# 기록용 (opus-code-lx 11/22 16:50 · planner 검증): 정본 그래프 그대로 + 출력 est_raw · est ([1,51] · 16 번 = 전진 속도 추정, 보정 전 / 후).
# 행동은 정본과 비트 같음 (시험 벡터 세 벌). 정본 대체가 아니라 START_TRACE 기록용. est 로 다시 보정하지 않는다.
DEBUG_EST_FILES = {'reconstruction': 'start-m15500_map_on_debug_est.onnx', 'off': 'start-m15500_map_off_debug_est.onnx',
                   'gt': 'start-m15500_map_on_debug_est.onnx'}
DEBUG_EST_SHA256 = {
    'start-m15500_map_on_debug_est.onnx': '1b9718d3558a5c2d8f2383546e3ac82e56a55164b2b5aa50b1e816e64438b31a',
    'start-m15500_map_off_debug_est.onnx': 'd216f35cf56a90da9521c5d56f986be0b56dd439311b8917621a88002216c611',
}
EST_VX = 16   # est 51 칸 중 전진 속도 추정
EST_V = slice(16, 19)   # est 의 v3 = 몸 속도 추정 (전진 · 옆 · 위아래 · 몸 기준)

# 운동학 몸 높이 (팀장 11/24 13:49: 우리 모드에서도 몸 높이). 허벅지 · 종아리 0.213 m · 엉덩이 자리 (Go2 URDF) · 발 반지름.
# 순정 body_height 와 대조 (11/24 11:45~12:09 순정 378 표본): 차 평균 +0.013 · 표준편차 0.009 m → 0.013 을 빼서 맞춤.
_LEG, _HIP_X, _HIP_Y, _THIGH_Y, _FOOT_R, _H_BIAS = .213, (.1934, .1934, -.1934, -.1934), (.0465, -.0465, .0465, -.0465), (.0955, -.0955, .0955, -.0955), .022, .013


def body_height(q, grav):
    """바닥에서 몸 (엉덩이 높이 평면) 까지 높이 (m). 정책 순서 관절 · 몸 기준 중력. 가장 낮은 발 셋 (디딘 발) 평균."""
    q = np.asarray(q, np.float64)
    up = -np.asarray(grav, np.float64)
    n = np.linalg.norm(up)
    if n < .5:
        return None
    up /= n
    hs = []
    for l in range(4):
        h, t, c = q[l], q[4 + l], q[8 + l]
        x = -_LEG * np.sin(t) - _LEG * np.sin(t + c)
        z = -_LEG * np.cos(t) - _LEG * np.cos(t + c)
        y = _THIGH_Y[l] * np.cos(h) - z * np.sin(h)
        zz = _THIGH_Y[l] * np.sin(h) + z * np.cos(h)
        hs.append(-np.dot((_HIP_X[l] + x, _HIP_Y[l] + y, zz), up) + _FOOT_R)
    return round(float(np.mean(sorted(hs, reverse=True)[:3])) - _H_BIAS, 4)


def projected_gravity(quat_wxyz) -> np.ndarray:
    """몸 좌표에서 본 중력 방향 (서 있으면 [0, 0, -1]). IMU 쿼터니언 (w, x, y, z)."""
    w, x, y, z = (float(v) for v in quat_wxyz)
    return np.array([2 * (w * y - x * z), -2 * (w * x + y * z), -(1 - 2 * (x * x + y * y))], dtype=np.float32)


def to_policy_order(sdk_values) -> np.ndarray:
    return np.asarray(sdk_values, dtype=np.float32)[POLICY_FROM_SDK]


def to_sdk_order(policy_values) -> np.ndarray:
    return np.asarray(policy_values, dtype=np.float32)[SDK_FROM_POLICY]


def observation(ang_vel_body, gravity_body, command, q_policy, dq_policy, last_action) -> np.ndarray:
    obs = np.empty(45, dtype=np.float32)
    obs[0:3], obs[3:6], obs[6:9] = ang_vel_body, gravity_body, command
    obs[9:21] = np.asarray(q_policy, dtype=np.float32) - DEFAULT_POSE
    obs[21:33], obs[33:45] = dq_policy, last_action
    return obs


def joint_targets(action) -> np.ndarray:
    """정책 순서 목표 관절각."""
    return DEFAULT_POSE + ACTION_SCALE * np.clip(np.asarray(action, dtype=np.float32), -ACTION_CLIP, ACTION_CLIP)


def file_sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for block in iter(lambda: f.read(1 << 20), b''):
            h.update(block)
    return h.hexdigest()


@dataclass
class StartMemory:
    """한 에피소드의 이력 · 깊이 두 장 · GRU 상태. reset() 뒤 첫 스텝은 first_after_reset."""
    step: int = 0
    hist: np.ndarray | None = None
    depth2: np.ndarray | None = None
    captured: np.ndarray | None = None
    h_prop: np.ndarray = field(default_factory=lambda: np.zeros((1, 128), np.float32))
    h_terr: np.ndarray = field(default_factory=lambda: np.zeros((1, 128), np.float32))


class StartPolicy:
    """관측 → 입력 9 개 → ONNX → 행동 · GRU 상태. 깊이 프레임은 호출자가 준다 (60×60, 0~1, 미검출 1.0)."""

    def __init__(self, folder: Path, mode: str = 'reconstruction', *, providers=('CPUExecutionProvider',), check_sha=True, threads=2, debug_est: Path | None = None):
        import onnxruntime as ort
        if mode not in MODEL_FILES:
            raise ValueError(f'unknown START map mode: {mode}')
        files, shas = (DEBUG_EST_FILES, DEBUG_EST_SHA256) if debug_est else (MODEL_FILES, MODEL_SHA256)
        path = Path(debug_est or folder) / files[mode]
        if check_sha and file_sha256(path) != shas[path.name]:
            raise ValueError(f'{path.name} SHA-256 differs from the canon contract')
        self.mode = mode
        # 스레드 수를 정해 둔다: 자동이면 Jetson (15 W · CPU 0-3 만 켜짐) 에서 꺼진 코어에 묶으려다 실패해 p95 42 ms.
        # 2 개로 p50 3.9 · p95 4.3 ms (11/22 Orin 실측).
        so = ort.SessionOptions()
        so.intra_op_num_threads, so.inter_op_num_threads = threads, 1
        so.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        self.session = ort.InferenceSession(str(path), so, providers=list(providers))
        self.outputs = [o.name for o in self.session.get_outputs()]
        self.memory = StartMemory()

    @property
    def uses_depth(self) -> bool:
        return self.mode == 'reconstruction'

    def reset(self):
        self.memory = StartMemory()

    def depth_needed(self) -> bool:
        """이번 스텝이 깊이를 새로 받아야 하는가 (복원 모드 · 첫 스텝, 또는 지난 tick 의 캡처)."""
        m = self.memory
        return self.uses_depth and (m.depth2 is None or (m.step % DEPTH_EVERY == 0 and m.step != 0))

    def inputs(self, obs45, depth_frame=None, gt_map=None) -> dict:
        m = self.memory
        obs45 = np.asarray(obs45, dtype=np.float32).reshape(45)
        if m.hist is None:
            m.hist = np.tile(obs45, (10, 1))
        else:
            m.hist = np.concatenate([obs45[None], m.hist[:9]])
        tick = m.step % DEPTH_EVERY == 0
        if not self.uses_depth:
            m.depth2 = np.zeros((2, 60, 60), np.float32) if m.depth2 is None else m.depth2
        elif m.depth2 is None:
            if depth_frame is None:
                raise ValueError('reconstruction mode needs the first depth frame')
            frame = np.asarray(depth_frame, np.float32).reshape(60, 60)
            m.depth2, m.captured = np.stack([frame, frame]), frame
        elif tick:
            # 새 것이 맨 앞: tick k 는 [지난 tick 뒤 캡처, 지난 맨 앞] (시뮬과 같이 한 장 늦게)
            m.depth2 = np.stack([m.captured, m.depth2[0]])
        if self.uses_depth and depth_frame is not None and tick and m.step != 0:
            m.captured = np.asarray(depth_frame, np.float32).reshape(60, 60)
        use_gt = self.mode == 'gt'
        gmap = np.asarray(gt_map, np.float32).reshape(32, 16) if use_gt and gt_map is not None else np.zeros((32, 16), np.float32)
        return {'obs45': obs45[None], 'hist': m.hist[None], 'depth2': m.depth2[None], 'h_prop': m.h_prop, 'h_terr': m.h_terr,
                'depth_tick': np.array([tick]), 'first_after_reset': np.array([m.step == 0]), 'use_gt': np.array([use_gt]),
                'gt_map': gmap[None]}

    def run(self, feed: dict) -> dict:
        result = dict(zip(self.outputs, self.session.run(self.outputs, feed)))
        self.memory.h_prop, self.memory.h_terr = result['h_prop_next'], result['h_terr_next']
        self.memory.step += 1
        return result
