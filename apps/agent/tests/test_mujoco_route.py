"""MuJoCo agent waypoint follower behind the SAME ScenarioRun / NavExecutor port as Nav2.

Fake kinematic sim only (pose integrates the Hub's applied output). No ROS, MuJoCo,
server or robot. The run, STOP and lease rules are the phone Hub's own.
"""
import math

import pytest

from test_scenario_run import r, start, uid  # noqa: F401  (fixture reuse)
from foothold_agent.executor.nav2 import NavExecutor
from foothold_agent.executor.nav2.actions import GoalActions
from foothold_agent.executor.nav2.simulation import SimulationPolicyAdapter
from foothold_agent.mujoco_bridge.route import Grid, LocalNav, Follower
from foothold_agent.safety.core import Z

SHA = 'a' * 64
DT = .02


class Identity:
    def adapt(self, velocity):
        return tuple(velocity), 'TESTED' if tuple(velocity) != Z else 'ZERO'


def room_with_door():
    """10 m x 6 m at .1 m cells, wall at x=5 with a 1.2 m door at y in [2.4, 3.6]."""
    cells = [[0] * 100 for _ in range(60)]
    for row in range(60):
        for col in (0, 99):
            cells[row][col] = 1
        if not 24 <= row < 36:
            cells[row][50] = 1
    for col in range(100):
        cells[0][col] = cells[59][col] = 1
    return Grid(cells, .1, (0., 0.), inflate_m=.3)


class Kinematic:
    def __init__(self, r, x, y, yaw):
        self.r, self.x, self.y, self.yaw = r, x, y, yaw
        self.trace = []
        self.blind = False

    def pose(self):
        return None if self.blind else (0, self.x, self.y, self.yaw, self.r.clock())

    def step(self):
        vx, vy, wz = self.r.hub.session.core.out
        self.yaw += wz * DT
        self.x += (vx * math.cos(self.yaw) - vy * math.sin(self.yaw)) * DT
        self.y += (vx * math.sin(self.yaw) + vy * math.cos(self.yaw)) * DT
        self.trace.append((self.r.clock(), self.x, self.y, (vx, vy, wz)))


def rig(r, points, start_pose=(1., 1., 0.)):
    sim = Kinematic(r, *start_pose)
    nav = NavExecutor(SimulationPolicyAdapter(Identity(), lambda: True), GoalActions(), now=r.clock)
    r.runs.nav = nav
    local = LocalNav(nav, sim.pose, grids={SHA: room_with_door()}, now=r.clock)
    request = r.start
    r.data['waypoints'] = [dict(floor_id=request['floor_id'], map_version_id=request['map_version_id'],
        x=x, y=y, yaw=0., waypoint_ref=f'p{i}', mission_id=uid(), mission_version=1, mission_name=f'p{i}')
        for i, (x, y) in enumerate(points)]
    r.runs.arrival = lambda b, goal: dict(binding=b, received_at=r.clock(), pose=dict(
        floor_id=request['floor_id'], map_version_id=request['map_version_id'], x=sim.x, y=sim.y, yaw=sim.yaw, confidence=1.))
    local.spin()  # first fresh pose: the action port reports ready
    return sim, local


def advance(r, sim, local, seconds, until=None):
    for k in range(int(seconds / DT)):
        r.clock.t += DT
        if k % 25 == 0:
            r.send(r.peer, 'ping', client_time_ms=int(r.clock.t * 1000))
        r.state(False)
        if local.planning is not None:
            local.planning[0].result(timeout=5)  # fake clock: planning time is not simulated time
        local.spin()
        r.hub.tick()
        sim.step()
        if until is not None and until():
            return True
    return False


def test_follower_turns_in_place_then_drives_and_stops_at_goal():
    f = Follower()
    assert f.command((0, 0, 0), [(0, 2)])[0] == 0  # 90 degrees off: turn in place
    vx, vy, wz = f.command((0, 0, 0), [(2, 0)])
    assert vx == pytest.approx(.6) and vy == 0 and wz == 0
    assert f.command((1.9, 0, 0), [(2, 0)]) is None  # inside reach


def test_astar_goes_through_the_door():
    path = room_with_door().plan((1, 1), (9, 1))
    assert path is not None and path[-1] == (9, 1)
    crossing = [p for p in path if 4 <= p[0] <= 6]
    assert crossing and all(2.4 <= p[1] <= 3.6 for p in crossing)


def test_three_waypoints_through_a_door_complete(r):
    goals = [(3., 1.5), (8., 3.), (8.5, 1.)]
    sim, local = rig(r, goals)
    start(r)
    done = advance(r, sim, local, 60, until=lambda: r.runs.snapshot()['status'] == 'COMPLETED')
    assert done, (r.runs.snapshot(), local.log[-3:])
    assert r.runs.snapshot()['progress'] == {'done': 3, 'total': 3}
    results = [e for e in local.log if e[0] == 'result']
    assert [e[3]['result'] for e in results] == ['SUCCEEDED'] * 3
    for (gx, gy), e in zip(goals, results):
        x, y, _ = e[3]['detail']['pose']
        assert math.hypot(x - gx, y - gy) <= .25
    # Never inside the wall band except through the door.
    assert all(not (4.9 <= x <= 5.1) or 2.4 <= y <= 3.6 for _, x, y, _ in sim.trace)
    assert all(abs(v[0]) <= .6 and abs(v[2]) <= .5 for *_, v in sim.trace)
    assert r.hub.session.core.latch and r.hub.session.core.out == Z  # run end latches, as on Nav2


def test_stop_mid_route_latches_and_nothing_moves_after(r):
    sim, local = rig(r, [(8., 3.)])
    start(r)
    assert advance(r, sim, local, 10, until=lambda: sim.x > 2.5)
    r.send(r.peer, 'stop')
    stopped_at = (sim.x, sim.y)
    advance(r, sim, local, 3)
    assert r.hub.session.core.latch and r.hub.session.core.out == Z
    assert r.runs.snapshot()['status'] == 'PAUSED'
    assert math.hypot(sim.x - stopped_at[0], sim.y - stopped_at[1]) < 1e-9
    assert local.active is None  # the goal was cancelled; no intent source left
    assert all(v == Z for t, *_, v in sim.trace if t > r.clock() - 2.9)


def test_no_pose_means_no_intent_and_the_goal_times_out(r):
    sim, local = rig(r, [(8., 3.)])
    start(r)
    advance(r, sim, local, .5)
    assert sim.x > 1.05  # moving on fresh poses
    sim.blind = True
    advance(r, sim, local, 2)
    assert r.runs.snapshot()['status'] == 'FAILED' and r.runs.snapshot()['fail_code'] == 'NAV_TIMEOUT'
    assert r.hub.session.core.out == Z


def test_goal_taken_without_pose_is_aborted_not_driven(r):
    sim, local = rig(r, [(8., 3.)])
    start(r)
    sim.blind = True
    advance(r, sim, local, 1)
    assert r.runs.snapshot()['status'] == 'FAILED' and r.runs.snapshot()['fail_code'] == 'NAV_GOAL_REJECTED'
    assert all(v == Z for *_, v in sim.trace)
