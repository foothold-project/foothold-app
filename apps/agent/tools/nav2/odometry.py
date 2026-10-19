"""TF-derived planar base odom; no wall-stamped source odom is accepted."""
import math
from foothold_agent.executor.nav2.intent import number


def angle(v):
    return math.atan2(math.sin(v), math.cos(v))


class SimOdom:
    def __init__(self, max_dt_s, stamp_tolerance_s):
        self.max_dt, self.tolerance = max_dt_s, stamp_tolerance_s
        self.previous = None
        self.episode = None
        self.quarantined = False
        self.reason = 'WARMUP'

    def update(self, *, episode, clock, scan_stamp, stamp, x, y, yaw,
               parent='odom', child='base_footprint', map_identity=False):
        values = (clock, scan_stamp, stamp, x, y, yaw)
        if (type(episode) is not int or episode < 0 or not all(number(v) for v in values)
                or parent != 'odom' or child != 'base_footprint' or not map_identity
                or abs(clock-stamp) > self.tolerance or abs(scan_stamp-stamp) > self.tolerance):
            self.reason, self.previous = 'FRAME_OR_CLOCK_MISMATCH', None
            return None
        if self.episode is not None and episode != self.episode:
            self.quarantined = True  # new explicit adapter required after RESET
        self.episode = episode
        if self.quarantined:
            self.reason = 'EPISODE_OR_REWIND'
            return None
        old = self.previous
        if old is not None and stamp <= old[0]:
            if stamp < old[0]:
                self.quarantined = True
            self.reason = 'NONPROGRESS'
            return None
        self.previous = (stamp, x, y, yaw)
        if old is None or not 0 < stamp-old[0] <= self.max_dt:
            self.reason = 'WARMUP_OR_GAP'
            return None
        dt = stamp-old[0]
        wx, wy = (x-old[1])/dt, (y-old[2])/dt
        # Odometry twist is expressed in child frame, not world/COM coordinates.
        vx = math.cos(yaw)*wx + math.sin(yaw)*wy
        vy = -math.sin(yaw)*wx + math.cos(yaw)*wy
        self.reason = 'OK'
        return {'stamp': stamp, 'frame_id': parent, 'child_frame_id': child,
                'x': x, 'y': y, 'yaw': yaw, 'vx': vx, 'vy': vy,
                'wz': angle(yaw-old[3])/dt, 'episode': episode}
