"""Synthetic CPU timing only, no DDS initialization or network access.

PYTHONPATH=apps/agent python3 apps/agent/tools/benchmark_uslam.py
"""
import json
import platform
import time

import numpy as np

from foothold_agent.mapping.world import WorldAccumulator


def main():
    rng=np.random.default_rng(251125)
    points=rng.uniform([-8,-8,-.1],[8,8,1.5],(100000,3)).astype('float32')
    results={}
    for mode in ('projection','scan'):
        core=WorldAccumulator(mode=mode,frame='synthetic_world')
        durations=[]
        for stamp in range(1,51):
            start=time.perf_counter()
            core.add_world(points,[0,0,.3],[1,0,0,0],stamp=stamp,frame='synthetic_world')
            durations.append((time.perf_counter()-start)*1000)
        results[mode]=dict(input_points=len(points),point_cap=core.cap,budget_ms=core.budget_ms,
            p50_ms=round(float(np.percentile(durations,50)),3),p95_ms=round(float(np.percentile(durations,95)),3),
            max_ms=round(max(durations),3),voxels=len(core.cells),truncated=core.truncated)
    print(json.dumps(dict(python=platform.python_version(),machine=platform.machine(),results=results),indent=2))


if __name__=='__main__':
    main()
