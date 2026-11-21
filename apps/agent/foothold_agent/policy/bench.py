"""정책 묶음 확인 · 추론 지연 측정 (Jetson 에서 로봇 없이). 로봇 명령 0.

  python3 -m foothold_agent.policy.bench --folder ~/foothold-policy/start-m15500-app [--runs 2000] [--threads 0]

1) ONNX SHA-256 이 정본 계약과 같은지 2) 시험 벡터 세 모드를 이 모듈의 관측 조립 (이력 · 깊이 두 장 · 플래그 · GRU 되먹임) 으로
돌려 행동이 정답과 허용치 (1e-4) 안인지 3) 복원 · 끔 모드 추론 1 회 지연 (p50 · p95 · 최대, ms) 을 JSON 한 줄로 낸다.
"""
import argparse
import json
import platform
import time
from pathlib import Path

import numpy as np

from .start import MODEL_FILES, StartPolicy


def vector_check(folder: Path, mode: str) -> dict:
    tv = json.loads((folder / f'test_vectors_flat20_{mode}.json').read_text())
    policy = StartPolicy(folder, mode)
    worst, worst_input = 0.0, 0.0
    for k in range(tv['steps']):
        rec = tv['inputs'][k]
        frame = None
        if policy.uses_depth and k % 5 == 0:
            # 캡처 f(k) 는 k+5 에서 맨 앞 프레임으로 보인다 (시뮬 start-demo-vector-check.js 와 같음)
            src = tv['inputs'][0 if k == 0 else min(k + 5, tv['steps'] - 1)]['depth2']
            frame = np.asarray(src, np.float32).reshape(2, 60, 60)[0]
        feed = policy.inputs(rec['obs45'], frame, rec['gt_map'])
        for name in ('hist', 'depth2'):
            if name == 'depth2' and not policy.uses_depth:
                worst_input = max(worst_input, float(np.abs(feed[name]).max()))
                continue
            worst_input = max(worst_input, float(np.abs(feed[name].ravel() - np.asarray(rec[name], np.float32).ravel()).max()))
        for name in ('depth_tick', 'first_after_reset', 'use_gt'):
            assert bool(feed[name][0]) == bool(rec[name][0]), (mode, k, name)
        out = policy.run(feed)
        worst = max(worst, float(np.abs(out['action'].ravel() - np.asarray(tv['expected'][k]['action'], np.float32).ravel()).max()))
    return {'action_max_err': worst, 'input_max_err': worst_input, 'tolerance': tv['tolerance'], 'pass': worst <= tv['tolerance'] and worst_input <= 1e-6}


def latency(folder: Path, mode: str, runs: int) -> dict:
    policy = StartPolicy(folder, mode)
    rng = np.random.default_rng(0)
    frame = rng.random((60, 60), dtype=np.float32)
    times = []
    for k in range(runs + 50):
        feed = policy.inputs(rng.standard_normal(45).astype(np.float32) * .1, frame if policy.depth_needed() or k % 5 == 0 else None)
        t0 = time.perf_counter()
        policy.run(feed)
        if k >= 50:
            times.append((time.perf_counter() - t0) * 1000)
    a = np.array(times)
    return {'p50_ms': round(float(np.percentile(a, 50)), 3), 'p95_ms': round(float(np.percentile(a, 95)), 3), 'max_ms': round(float(a.max()), 3), 'runs': runs}


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument('--folder', required=True, type=Path)
    ap.add_argument('--runs', type=int, default=2000)
    a = ap.parse_args(argv)
    import onnxruntime as ort
    report = {'machine': platform.machine(), 'python': platform.python_version(),
              'onnxruntime': ort.__version__, 'providers': ort.get_available_providers(),
              'vectors': {m: vector_check(a.folder, m) for m in ('reconstruction', 'gt', 'off')},
              'latency': {m: latency(a.folder, m, a.runs) for m in ('reconstruction', 'off')}}
    print(json.dumps(report, ensure_ascii=False))
    return 0 if all(v['pass'] for v in report['vectors'].values()) else 1


if __name__ == '__main__':
    raise SystemExit(main())
