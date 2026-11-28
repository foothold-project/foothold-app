"""#640: MuJoCo child state must keep flowing while the same process plans a route.

8830 11/28 18:43: five sim robots halted about 2 s after run.start. The state reader
starved while LocalNav built the 1800x1120 factory grid and ran A* in Python threads
(sim_stale -> STOP -> STOPPED_BY_USER, and a stale pose -> context False). A real pipe,
a fake 50 Hz child and the real Grid work in this process; no Node, server or robot.
"""
import asyncio
import random
import sys
import threading
import time

from foothold_agent.mujoco_bridge.__main__ import Pose
from foothold_agent.mujoco_bridge.node import MujocoNode
from foothold_agent.mujoco_bridge.route import Grid
from foothold_agent.safety.core import STATE_STALE

CHILD = r'''
import json, sys, threading
sim_t, stop = 0.0, True
def read():
    for line in sys.stdin:
        pass
threading.Thread(target=read, daemon=True).start()
import time
while True:
    sim_t += .02
    print(json.dumps({'schema': 'v2_live/state/1', 'episode': 0, 'sim_t': round(sim_t, 3), 'stop_requested': stop,
        'reset_in_progress': False, 'policy_running': True, 'x': 1.0, 'y': 2.0, 'z': 0.3, 'yaw': 0.0, 'vx': 0.0,
        'vy': 0.0, 'wz': 0.0, 'tilt_deg': 0.5, 'upright': 1.0, 'base_height': 0.3, 'fallen': False,
        'body_still': True, 'cmd_applied': [0, 0, 0], 'cmd_age_s': None, 'ttl_s': 0.3, 'ttl_expired': True,
        'battery_soc': 88.5, 'battery_minutes_left': 287,
        'joint_temp_c': [25.4, 31.6, 40.2, 25.0, 30.9, 39.5, 25.1, 33.2, 41.0, 24.6, 32.8, 40.4],
        'roll': 0.01, 'pitch': -0.02, 'source': 'mujoco', 'plugin_mode': 'REALTIME'}), flush=True)
    time.sleep(.02)
'''
POSE_MAX_AGE = .2  # LocalNav.fresh_pose: an older pose makes actions.ready() False
# This test's own asyncio sampling loop also stalls on a loaded host (review G2, load ~50), so the pose
# bound gets slack. The fix itself is judged by no 'stale' reject and the reader gap below STATE_STALE.
LOOP_SLACK = .3


def factory_grid_work():
    """The run-start work of route.GridSource + LocalNav on the 8830 factory map size."""
    rng = random.Random(1)
    rows = [[254 if rng.random() > .05 else 0 for _ in range(1800)] for _ in range(1120)]
    grid = Grid.from_image(rows, .5, (0., -560., 0.), inflate_m=.3)
    return grid.plan((10., -100.), (800., -500.))


def test_state_and_pose_stay_fresh_while_grid_and_plan_run_in_process(tmp_path):
    async def run():
        pose = Pose(time.monotonic)
        bridge = MujocoNode([sys.executable, '-c', CHILD], env=None)
        rejected = []
        try:
            await asyncio.wait_for(bridge.start(pose.update), 10)
            original = bridge.inputs.reject
            bridge.inputs.reject = lambda reason: (rejected.append(reason), original(reason))[1]
            await asyncio.sleep(.5)
            assert pose() is not None, 'baseline: child state reaches the pose'
            loop = asyncio.get_running_loop()
            done = threading.Event()
            work = loop.run_in_executor(None, lambda: (factory_grid_work(), done.set()))
            worst_pose = worst_state = 0.
            t0 = time.monotonic()
            while not done.is_set() and time.monotonic() - t0 < 30:
                await asyncio.sleep(.02)  # the Hub loop tick (hub_loop)
                now = time.monotonic()
                worst_pose = max(worst_pose, now - pose()[4])
                if bridge.inputs.last_state is not None:
                    worst_state = max(worst_state, now - bridge.inputs.last_state)
            await work
            assert done.is_set(), 'grid + plan did not finish'
            assert 'stale' not in rejected, f'state went stale under load: {rejected}'
            assert worst_state < STATE_STALE, f'reader state gap {worst_state:.3f} s'
            assert worst_pose <= POSE_MAX_AGE + LOOP_SLACK, f'loop-side pose age {worst_pose:.3f} s'
        finally:
            bridge.close()
    asyncio.run(run())
