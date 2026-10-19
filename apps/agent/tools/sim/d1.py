#!/usr/bin/env python3
"""Opt-in isolated launch. Motion is separately gated by FH_SIM_D1_MOTION=1."""
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

from isolation import Simulation, stamp, write

ROOT = Path(__file__).resolve().parents[4]
HERE = Path(__file__).resolve().parent


def stop_child(child):
    if child is not None and child.poll() is None:
        child.send_signal(signal.SIGINT)
        child.wait(timeout=15)  # never kill an unrelated process, no escalation to KILL


def ros_env():
    env = {**os.environ, 'ROS_DOMAIN_ID': '93', 'ROS_AUTOMATIC_DISCOVERY_RANGE': 'LOCALHOST',
           'ROS_LOCALHOST_ONLY': '1', 'GZ_IP': '127.0.0.1', 'PYTHONDONTWRITEBYTECODE': '1',
           'PYTHONPATH': os.pathsep.join([str(ROOT / 'apps/agent'), str(ROOT), os.environ.get('PYTHONPATH', '')])}
    # Reject rather than silently clear conflicting DDS settings.
    sys.path.insert(0, str(ROOT / 'apps/agent'))
    from foothold_agent.ros_bridge.config import validate_isolation
    validate_isolation(env)
    return env


def latest(folder):
    try:
        row = json.loads((folder / 'state.json').read_text())
        if time.monotonic() - row['mono'] > 1:
            return None
        return row
    except FileNotFoundError:
        return None


def ready(state):
    return (state.get('episode', 0) >= 1 and state.get('stop_requested') is True
            and state.get('cmd_applied') == [0, 0, 0] and state.get('policy_running') is True
            and state.get('plugin_mode') == 'LOCKSTEP' and state.get('reset_in_progress') is False
            and state.get('fallen') is False and state.get('camera_frames', 0) > 0)


def main():
    if os.environ.get('FH_SIM_D1_RUN') != '1':
        raise RuntimeError('explicit FH_SIM_D1_RUN=1 required')
    requested_folder = Path(os.environ['SIM_RUN_DIR'])
    folder = requested_folder.resolve()
    if (not requested_folder.is_absolute() or requested_folder != folder
            or not folder.is_relative_to(ROOT / 'runs/sim-d1') or folder == ROOT / 'runs/sim-d1'):
        raise ValueError('SIM_RUN_DIR must be a new real path below this worktree runs/sim-d1')
    folder.mkdir(parents=True, exist_ok=False)
    folder.chmod(0o700)
    env = ros_env()
    sys.path.insert(0, str(ROOT))
    env['ROS_LOG_DIR'] = str(folder / 'observer-ros')
    sim = Simulation(folder, Path(os.environ['SIM_SOURCE']), Path(os.environ['SIM_ROS_SETUP']))
    observer = None
    launched = False
    result = {'stage0': 'pending', 'stage1': 'pending', 'stage2': 'pending', 'stage3': 'not_run',
              'stage4': 'not_run', 'stage5': 'skipped unless stage4 passes and straight-ahead GT clearance >=3m is proven; motion requires separate bounded operator procedure',
              'stage6': 'pending'}
    # Ensure SIGTERM from a terminal supervisor follows the same cleanup path.
    signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt()))
    try:
        sim.start()
        launched = True
        result.update(stage0='passed', stage1='active')
        with (folder / 'observer.log').open('w') as log:
            observer = subprocess.Popen([sys.executable, str(HERE / 'observe.py'), str(folder)], cwd=ROOT, env=env, stdout=log, stderr=log)
            deadline = time.monotonic() + 110
            first = None
            while time.monotonic() < deadline:
                if sim.reason:
                    raise RuntimeError('simulation supervisor: ' + sim.reason)
                if observer.poll() is not None:
                    raise RuntimeError('ROS observer exited')
                row = latest(folder)
                if row and row['data'].get('fallen'):
                    raise RuntimeError('fallen state; stop and end run')
                if row and ready(row['data']):
                    if first is None:
                        first = row
                    if row['data']['camera_frames'] > first['data']['camera_frames'] and row['data']['sim_t'] > first['data']['sim_t']:
                        identity = sim.live_identity()
                        write(folder / 'readiness.json', {'first': first, 'next': row, 'live_identity': identity,
                              'native_manifest_at_exit': str(sim.out / 'manifest.json')})
                        result['stage2'] = 'passed'
                        break
                time.sleep(.1)
            else:
                raise RuntimeError('readiness deadline; no retry')
            from app_probe import probe
            result.update(probe(folder, env, sim))
    except BaseException as exc:
        # Never serialize exception input/HTTP request bodies containing credentials.
        result['error'] = str(exc) if isinstance(exc, RuntimeError) else type(exc).__name__
        import traceback
        result['error_locations'] = [{'file': f.filename, 'line': f.lineno, 'function': f.name}
                                     for f in traceback.extract_tb(exc.__traceback__)]
    finally:
        try:
            stop_child(observer)
        finally:
            if sim.started:
                try:
                    sim.close()
                    result['stage6'] = 'passed'
                except Exception as exc:
                    result['cleanup_error'] = type(exc).__name__ + ': ' + str(exc)
                    result['stage6'] = 'failed'
        if sim.reason:
            result['stage1'] = sim.reason
        elif launched:
            result['stage1'] = 'passed'
        result.update(stamp())
        write(folder / 'result.json', result)
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result['stage4'] == 'passed' and result['stage6'] == 'passed' else 1


if __name__ == '__main__':
    raise SystemExit(main())
