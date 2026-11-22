"""START 정책 실행부: 관절 순서 · 중력 · 깊이 다시 뽑기 (onnxruntime 없이), 시험 벡터는 묶음이 있을 때만."""
import os
from pathlib import Path

import numpy as np
import pytest

from foothold_agent.policy import depth, start


def test_joint_order_round_trip_and_known_slots():
    sdk = np.arange(12, dtype=np.float32)   # FR hip 0 · FR thigh 1 · ... RL calf 11
    pol = start.to_policy_order(sdk)
    assert pol[0] == 3 and pol[1] == 0 and pol[2] == 9 and pol[3] == 6    # hips FL FR RL RR
    assert pol[8] == 5 and pol[11] == 8                                     # calves FL · RR
    assert np.array_equal(start.to_sdk_order(pol), sdk)


def test_projected_gravity_and_targets():
    assert np.allclose(start.projected_gravity([1, 0, 0, 0]), [0, 0, -1])
    assert np.allclose(start.projected_gravity([0, 1, 0, 0]), [0, 0, 1])          # 뒤집힘
    t = start.joint_targets(np.full(12, 100.))
    assert np.allclose(t, start.DEFAULT_POSE + .25 * 17)


def test_depth_resample_covers_raw_and_normalizes():
    # 11/19 녹화 camera_info: 원본 깊이 640×480 · fx 387.12 (lab 05-depth-input.md)
    raw = depth.DepthResampler(387.12, 387.12, 319.64, 242.06, 640, 480)
    aligned = depth.DepthResampler(604.28, 603.53, 326.51, 249.52, 640, 480)
    assert raw.coverage == 1.0 and 0.65 < aligned.coverage < 0.75
    frame = np.full((480, 640), 1600, np.uint16)
    frame[:, :120] = 0   # 시뮬 시야 왼쪽 끝은 원본 x ≈ 115 px (05 문서 「약 112 px」)
    out = raw(frame)
    assert out.shape == (60, 60) and np.isclose(out[30, 30], (1.6 - .2) / 2.8)
    assert out[30, 0] == 1.0          # 왼쪽 미검출 띠 → 1.0
    assert out.max() <= 1 and out.min() >= 0


BUNDLE = os.environ.get('FH_START_SRC')


@pytest.mark.skipif(not BUNDLE, reason='FH_START_SRC (start-m15500-app 묶음) 없음 · 정책 파일은 저장소에 없음')
@pytest.mark.parametrize('mode', ['reconstruction', 'gt', 'off'])
def test_vectors_through_python_runner(mode):
    pytest.importorskip('onnxruntime')
    from foothold_agent.policy.bench import vector_check
    result = vector_check(Path(BUNDLE), mode)
    assert result['pass'], result


DEBUG_EST = os.environ.get('FH_START_DEBUG_EST')


@pytest.mark.skipif(not (BUNDLE and DEBUG_EST), reason='FH_START_SRC · FH_START_DEBUG_EST 둘 다 있어야 함')
@pytest.mark.parametrize('mode', ['reconstruction', 'gt', 'off'])
def test_debug_est_onnx_actions_equal_canon(mode):
    pytest.importorskip('onnxruntime')
    vec = np.load(Path(DEBUG_EST) / f'test_vectors_flat20_{mode}.npz')
    canon, debug = start.StartPolicy(Path(BUNDLE), mode), start.StartPolicy(Path(BUNDLE), mode, debug_est=Path(DEBUG_EST))
    names = [i.name for i in canon.session.get_inputs()]
    assert [i.name for i in debug.session.get_inputs()] == names
    for k in range(20):
        feed = {n: vec[f'step{k:02d}_{n}'] for n in names}
        a = canon.session.run(None, feed)
        b = debug.session.run(None, feed)
        assert all(np.array_equal(x, y) for x, y in zip(a, b[:4]))      # 정본 출력 넷 비트 같음
        assert b[4].shape == (1, 51) and b[5].shape == (1, 51)          # est_raw · est
