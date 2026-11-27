"""D435i 원본 깊이 → 정책 깊이 60×60 (시뮬 카메라 내부 행렬로 다시 뽑기). 로봇 I/O 없음.

lab `05-depth-input.md` (초안 · 계산) 의 「다시 뽑는 법」: 시뮬 칸 (u, v) 마다 광선 ((u + 0.5 - 30) / 55.9, (v + 0.5 - 30) / 54.1, 1) 을
실기 영상 내부 행렬로 투영해 가장 가까운 화소를 읽는다. 원본 깊이 (`/camera/camera/depth/image_rect_raw`) 는 시뮬 시야를
100 % 덮고, 정렬 깊이 (색 카메라 기준) 는 약 70 % 만 덮는다 (계산). 값은 광축 거리 (mm, 0 = 미검출) → m →
(d - 0.2) / 2.8 를 [0, 1] 로 자르고, 0.3 m 미만 · 미검출 · 영상 밖은 1.0 (학습 amp3-1126 depth_aug.py: min_valid_m 0.3 · NEAR 0.2 · FAR 3.0). 장착 위치 · 각 차이는 여기서 고치지 않는다 (팀장 결정 대기).
"""
from __future__ import annotations

import numpy as np

SIM = {'width': 60, 'height': 60, 'fx': 55.9, 'fy': 54.1, 'cx': 30.0, 'cy': 30.0}
NEAR, SPAN, MISS = 0.2, 2.8, 1.0
MIN_VALID = 0.3  # 학습 증강은 0.3 m 미만을 무효(1.0)로 넣는다


def sample_grid(fx, fy, cx, cy, width, height):
    """시뮬 60×60 칸이 실기 영상에서 읽을 화소 (row, col) 와 영상 안 여부."""
    u = (np.arange(SIM['width']) + .5 - SIM['cx']) / SIM['fx']
    v = (np.arange(SIM['height']) + .5 - SIM['cy']) / SIM['fy']
    col = np.rint(fx * u + cx - .5).astype(int)
    row = np.rint(fy * v + cy - .5).astype(int)
    rr, cc = np.meshgrid(row, col, indexing='ij')
    inside = (rr >= 0) & (rr < height) & (cc >= 0) & (cc < width)
    return np.clip(rr, 0, height - 1), np.clip(cc, 0, width - 1), inside


class DepthResampler:
    """camera_info K (fx, fy, cx, cy) 와 영상 크기로 한 번 만들고, 프레임마다 __call__."""

    def __init__(self, fx, fy, cx, cy, width, height):
        self.rows, self.cols, self.inside = sample_grid(fx, fy, cx, cy, width, height)
        self.coverage = float(self.inside.mean())
        self.invalid = 1.

    def __call__(self, depth_mm: np.ndarray) -> np.ndarray:
        d = depth_mm[self.rows, self.cols].astype(np.float32) / 1000.
        out = np.clip((d - NEAR) / SPAN, 0., 1.)
        missing = (d < MIN_VALID) | ~self.inside  # d <= 0 (미검출) 포함
        out[missing] = MISS
        # 1.0 also covers far values (beyond 3 m). Only missing and too-near cells count as invalid.
        self.invalid = float(missing.mean())
        return out.astype(np.float32)
