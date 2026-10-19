"""Preregistered R0' verdicts. Pure functions/state: no ROS or server calls."""
from dataclasses import asdict, dataclass
import math
from foothold_agent.executor.nav2.intent import number
from odometry import angle


@dataclass(frozen=True)
class Observation:
    wall: float
    sim: float
    received: float
    episode: int
    map_sha: str
    x: float
    y: float
    yaw: float
    vx: float
    vy: float
    wz: float
    tilt: float
    fallen: bool
    policy_running: bool
    lockstep: bool
    cmd: tuple
    gt_clear: bool
    frames_ready: bool
    single_writer: bool
    resources_ok: bool
    lifecycle_ready: bool
    body_still: bool

    def valid(self):
        return (all(number(getattr(self, k)) for k in ('wall', 'sim', 'received', 'x', 'y', 'yaw',
                    'vx', 'vy', 'wz', 'tilt')) and type(self.episode) is int
                and all(type(getattr(self, k)) is bool for k in ('fallen', 'policy_running', 'lockstep',
                    'gt_clear', 'frames_ready', 'single_writer', 'resources_ok', 'lifecycle_ready', 'body_still'))
                and isinstance(self.cmd, (list, tuple)) and len(self.cmd) == 3 and all(number(v) for v in self.cmd))


class Trial:
    def __init__(self, config, goal, episode, *, kind='goal'):
        self.c, self.goal, self.episode, self.kind = config, goal, episode, kind
        self.status, self.reason = 'NOT_STARTED', None
        self.start_wall = self.start_sim = self.previous = None
        self.hold_since = self.burst_since = None
        self.nonzero_total = 0
        self.stop_at = self.stop_pose = self.last_intent = self.ros_zero_at = None
        self.previous_sim = self.progress_wall = None
        self.records = []
        self.metrics = {'max_xy_error_m': None, 'final_xy_error_m': None,
                        'max_yaw_error_rad': None, 'final_yaw_error_rad': None,
                        'max_path_deviation_m': 0, 'max_actual_speed_mps': 0,
                        'max_stop_displacement_m': 0}

    def record(self, event, **data):
        self.records.append({'schema': 'fh-nav2-trial/1', 'event': event, **data})

    def finish(self, status, reason):
        if self.status not in ('SUCCEEDED', 'FAILED', 'BLOCKED_NOT_STARTED'):
            self.status, self.reason = status, reason
            self.record('verdict', status=status, reason=reason, nonzero_total_wall_s=self.nonzero_total,
                        include_in_success_denominator=status != 'BLOCKED_NOT_STARTED',
                        metrics=dict(self.metrics), r0_complete=False)  # aggregate must independently require all ten trials
        return self.status

    def safe(self, o):
        return (o.valid() and o.episode == self.episode and o.map_sha == self.c['map_sha']
                and 0 <= o.wall-o.received <= self.c['fresh_state_s']
                and o.policy_running and o.lockstep and not o.fallen
                and abs(o.tilt) <= self.c['max_tilt_deg']
                and o.gt_clear and o.frames_ready and o.single_writer
                and o.resources_ok and o.lifecycle_ready)

    def start(self, o):
        if self.status != 'NOT_STARTED':
            return self.status  # terminal verdicts cannot be retried in place
        s = self.c['spawn']
        if (not self.safe(o) or math.hypot(o.x-s['x'], o.y-s['y']) > self.c['start_xy_m']
                or abs(angle(o.yaw-s['yaw'])) > self.c['start_yaw_rad']
                or math.hypot(o.vx, o.vy) > self.c['still_vxy_mps']
                or abs(o.wz) > self.c['still_wz_rps'] or any(o.cmd)):
            return self.finish('BLOCKED_NOT_STARTED', 'PRESTART_GATE')
        self.status = 'RUNNING'
        self.start_wall, self.start_sim = o.wall, o.sim
        self.previous_sim, self.progress_wall = o.sim, o.wall
        self.previous = o
        self.record('started', observation=asdict(o), kind=self.kind, goal=self.goal)
        return self.status

    def trigger_stop(self, o, *, last_intent_receive=None):
        if self.kind != 'safety':
            self.finish('FAILED', 'GOAL_SAFETY_INTERVENTION')
            return
        self.stop_at, self.stop_pose, self.last_intent = o.wall, (o.x, o.y), last_intent_receive
        self.hold_since = None
        self.record('stop_trigger', monotonic_s=o.wall, sim_t=o.sim, episode=o.episode,
                    t_executor_or_manual_receive=last_intent_receive)

    def ros_zero(self, wall):
        # A ROS receive observation, never inferred from sink apply/ACK.
        if self.stop_at is None or not number(wall) or wall < self.stop_at:
            return  # a prior zero is not evidence for this stop
        if self.ros_zero_at is None:
            self.ros_zero_at = wall
        self.record('ros_zero_receive', monotonic_s=wall)

    def update(self, o, nav_result=None):
        if self.status != 'RUNNING':
            return self.status
        self.record('observation', observation=asdict(o), nav_result=nav_result)
        if not self.safe(o):
            return self.finish('FAILED', 'SAFETY_GATE')
        xy = math.hypot(o.x-self.goal['x'], o.y-self.goal['y'])
        yaw = abs(angle(o.yaw-self.goal['yaw']))
        self.metrics['final_xy_error_m'], self.metrics['final_yaw_error_rad'] = xy, yaw
        self.metrics['max_xy_error_m'] = max(self.metrics['max_xy_error_m'] or 0, xy)
        self.metrics['max_yaw_error_rad'] = max(self.metrics['max_yaw_error_rad'] or 0, yaw)
        self.metrics['max_path_deviation_m'] = max(self.metrics['max_path_deviation_m'], abs(o.y-self.c['spawn']['y']))
        self.metrics['max_actual_speed_mps'] = max(self.metrics['max_actual_speed_mps'], math.hypot(o.vx, o.vy))
        if self.stop_pose is not None:
            self.metrics['max_stop_displacement_m'] = max(self.metrics['max_stop_displacement_m'],
                math.hypot(o.x-self.stop_pose[0], o.y-self.stop_pose[1]))
        if o.wall < self.previous.wall or o.sim < self.previous_sim:
            return self.finish('FAILED', 'CLOCK_REWIND')
        if o.sim > self.previous_sim:
            self.previous_sim, self.progress_wall = o.sim, o.wall
        if o.wall-self.progress_wall > self.c['fresh_state_s']:
            return self.finish('FAILED', 'CLOCK_STALLED')
        dt = o.wall-self.previous.wall
        if (dt > self.c['fresh_state_s']
                or o.received < self.previous.received
                or o.received-self.previous.received > self.c['fresh_state_s']
                or o.sim-self.previous.sim > self.c['observation_sim_gap_s']):
            return self.finish('FAILED', 'OBSERVATION_GAP')
        # Charge the entire preceding interval if either endpoint is nonzero.
        if any(self.previous.cmd) or any(o.cmd):
            self.nonzero_total += dt
            if self.burst_since is None:
                self.burst_since = self.previous.wall
        else:
            self.burst_since = None
        self.previous = o
        if (self.nonzero_total > self.c['nonzero_total_wall_s']
                or self.burst_since is not None and o.wall-self.burst_since > self.c['nonzero_burst_wall_s']):
            return self.finish('FAILED', 'MOTION_BUDGET')
        if o.wall-self.start_wall >= self.c['trial_wall_s']:
            return self.finish('FAILED', 'TRIAL_TIMEOUT')
        if self.stop_at is not None:
            if o.wall-self.stop_at > self.c['stop_wall_s']:
                return self.finish('FAILED', 'STOP_BODY_TIMEOUT')
            if math.hypot(o.x-self.stop_pose[0], o.y-self.stop_pose[1]) > self.c['stop_displacement_m']:
                return self.finish('FAILED', 'STOP_DISPLACEMENT')
            if self.last_intent is not None:
                if (self.ros_zero_at is not None and self.ros_zero_at-self.last_intent > self.c['silence_zero_wall_s']
                        or self.ros_zero_at is None and o.wall-self.last_intent > self.c['silence_zero_wall_s']):
                    return self.finish('FAILED', 'SILENCE_ZERO_LATE_OR_UNMEASURED')
            still = (not any(o.cmd) and math.hypot(o.vx, o.vy) <= self.c['still_vxy_mps']
                     and abs(o.wz) <= self.c['still_wz_rps'])
            if not still:
                self.hold_since = None
            elif self.hold_since is None:
                self.hold_since = o.sim
            # Safety-control deadline is native body_still (its 1sim-second
            # marker) within 5wall seconds. The separate GOAL verdict below
            # requires a measured continuous 2sim-second hold.
            if still and o.body_still and self.ros_zero_at is not None:
                if self.stop_at <= self.ros_zero_at <= o.wall:
                    return self.finish('SUCCEEDED', 'SAFETY_CONTROL_STOPPED')
            if o.wall-self.stop_at >= self.c['stop_wall_s']:
                return self.finish('FAILED', 'STOP_BODY_TIMEOUT')
            return self.status
        if self.kind == 'safety':
            return self.status  # safety can succeed ONLY after its stop trigger
        if nav_result in ('ABORTED', 'CANCELED', 'REJECTED', 'TIMEOUT'):
            return self.finish('FAILED', 'NAV2_'+nav_result)
        if (o.wall-self.start_wall >= self.c['goal_wall_s']
                or o.sim-self.start_sim >= self.c['goal_sim_s']):
            return self.finish('FAILED', 'GOAL_TIMEOUT_OR_UNSUPPORTED_COMMAND')
        at_goal = (nav_result == 'SUCCEEDED'
                   and math.hypot(o.x-self.goal['x'], o.y-self.goal['y']) <= self.c['goal_xy_m']
                   and abs(angle(o.yaw-self.goal['yaw'])) <= self.c['goal_yaw_rad']
                   and math.hypot(o.vx, o.vy) <= self.c['still_vxy_mps']
                   and abs(o.wz) <= self.c['still_wz_rps'] and not any(o.cmd))
        if not at_goal:
            if self.hold_since is not None:
                return self.finish('FAILED', 'GOAL_HOLD_LOST')
        elif self.hold_since is None:
            self.hold_since = o.sim
        elif o.sim-self.hold_since >= self.c['still_hold_sim_s']:
            return self.finish('SUCCEEDED', 'GT_GOAL_AND_ZERO_2_SIM_SECONDS')
        return self.status


def aggregate(config, experiment):
    from ledger import Ledger
    if not isinstance(experiment, Ledger):
        raise ValueError('aggregate requires the complete registered attempt ledger')
    return experiment.summary(config)
