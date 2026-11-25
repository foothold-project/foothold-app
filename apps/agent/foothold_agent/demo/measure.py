"""Measure battery drain and temperature ranges from real Go2 X trace files.

Reads the 50 Hz runner traces (start-*.jsonl, factory-auto-*.jsonl) read only.
Each row is classified as lie / stand / walk (see activity()); per file we keep
the seconds spent in each class and the SOC change, then fit
    soc_drop = r_lie * t_lie + r_stand * t_stand + r_walk * t_walk
by least squares (no intercept). The fitted numbers are written into
measured.py by hand together with the file list, so a run is reproducible:

    python3 -m foothold_agent.demo.measure TRACE_DIR/start-*.jsonl TRACE_DIR/factory-auto-*.jsonl
"""
import json
import math
import os
import sys

# Policy order (runner_cpp core.cpp to_policy) -> SDK order (FR FL RR RL x hip thigh calf).
TO_SDK = (1, 5, 9, 0, 4, 8, 3, 7, 11, 2, 6, 10)
WALK_MPS = 0.1
WALK_RADPS = 0.2
LIE_HEIGHT_M = 0.2


def to_sdk(values):
    return [values[i] for i in TO_SDK]


def activity(row):
    """lie | stand | walk | None (transitions and unknown rows are skipped)."""
    phase = row.get('phase')
    if phase == 'policy':
        cmd = row.get('cmd')
        if not (isinstance(cmd, list) and len(cmd) == 3):
            return None
        return 'walk' if math.hypot(cmd[0], cmd[1]) > WALK_MPS or abs(cmd[2]) > WALK_RADPS else 'stand'
    if phase == 'factory':
        sport = row.get('sport')
        if not isinstance(sport, dict) or not isinstance(sport.get('vel'), list):
            return None
        height = sport.get('height')
        if isinstance(height, (int, float)) and height < LIE_HEIGHT_M:
            return 'lie'
        vel = sport['vel']
        moving = math.hypot(vel[0], vel[1]) > WALK_MPS or abs(sport.get('yaw_speed') or 0) > WALK_RADPS
        return 'walk' if moving else 'stand'
    return None


def summarize(path, stride=25):
    """Per-file seconds by activity, SOC change and temperature extremes."""
    seconds = dict(lie=0.0, stand=0.0, walk=0.0)
    temps = dict(lie=[], stand=[], walk=[])
    first = last = prev = None
    count = 0
    with open(path, 'rb') as fh:
        for raw in fh:
            if b'"phase"' not in raw:
                continue
            count += 1
            if count % stride:
                continue
            try:
                row = json.loads(raw)
            except ValueError:
                continue
            wall = row.get('wall')
            if not isinstance(wall, (int, float)):
                continue
            kind = activity(row)
            if prev is not None and kind is not None and 0 < wall - prev[0] < 5:
                seconds[kind] += wall - prev[0]
            prev = (wall, kind)
            battery = row.get('bat')
            if isinstance(battery, dict) and isinstance(battery.get('soc'), (int, float)):
                first = first or (wall, battery['soc'], battery.get('v'))
                last = (wall, battery['soc'], battery.get('v'))
            temp = row.get('temp')
            if kind and isinstance(temp, list) and len(temp) == 12:
                temps[kind].append((min(temp), max(temp)))
    if first is None or last[0] - first[0] < 60:
        return None
    return dict(file=os.path.basename(path), hours=(last[0] - first[0]) / 3600,
                soc0=first[1], soc1=last[1], v0=first[2], v1=last[2], seconds=seconds,
                temp={k: [min(v[0] for v in t), max(v[1] for v in t)] for k, t in temps.items() if t})


def fit(rows, *, coverage=0.8):
    """Least squares SOC %/h per activity over files whose rows cover the SOC span."""
    use = [r for r in rows if r and sum(r['seconds'].values()) >= coverage * r['hours'] * 3600]
    keys = ('lie', 'stand', 'walk')
    a = [[r['seconds'][k] / 3600 for k in keys] for r in use]
    b = [r['soc0'] - r['soc1'] for r in use]
    # Normal equations, 3x3, solved by Gaussian elimination.
    m = [[sum(x[i] * x[j] for x in a) for j in range(3)] + [sum(x[i] * y for x, y in zip(a, b))]
         for i in range(3)]
    for i in range(3):
        pivot = max(range(i, 3), key=lambda r: abs(m[r][i]))
        m[i], m[pivot] = m[pivot], m[i]
        if abs(m[i][i]) < 1e-12:
            raise ValueError(f'not enough {keys[i]} time to fit')
        for r in range(3):
            if r != i:
                factor = m[r][i] / m[i][i]
                m[r] = [u - factor * v for u, v in zip(m[r], m[i])]
    rates = {k: m[i][3] / m[i][i] for i, k in enumerate(keys)}
    hours = {k: sum(x[i] for x in a) for i, k in enumerate(keys)}
    return dict(rates=rates, hours=hours, files=[r['file'] for r in use])


def main(argv):
    rows = [summarize(p) for p in argv]
    rows = [r for r in rows if r]
    for row in rows:
        print(json.dumps(row))
    result = fit(rows)
    print(json.dumps({'fit': result['rates'], 'hours': result['hours'], 'n_files': len(result['files'])}))
    temps = [t for r in rows for t in r['temp'].values()]
    print(json.dumps({'joint_temp_c': [min(t[0] for t in temps), max(t[1] for t in temps)]}))


if __name__ == '__main__':
    main(sys.argv[1:])
