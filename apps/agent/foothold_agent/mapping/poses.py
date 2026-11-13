"""Bounded read-only pose history shared by mapping and scan publication."""
from collections import deque
import math
import threading
import time


def timestamp(value):
    sec, ns = value.sec, value.nanosec
    if (type(sec) is not int or type(ns) is not int or not 0 <= sec <= 0x7fffffff
            or not 0 <= ns < 1_000_000_000 or sec == ns == 0):
        raise ValueError('invalid observation stamp')
    return sec * 1_000_000_000 + ns


class Poses:
    def __init__(self, now=time.monotonic):
        self.now = now
        self.lock = threading.Lock()
        self.odometry = deque(maxlen=64)
        self.sports = deque(maxlen=64)

    def append(self, history, stamp, position, quaternion):
        p, q = tuple(position), tuple(quaternion)
        if (len(p) != 3 or len(q) != 4
                or not all(type(v) in (int, float) and math.isfinite(v) for v in (*p, *q))
                or any(abs(v) > 10000 for v in p)):
            return
        norm = math.sqrt(sum(v*v for v in q))
        if not .9 <= norm <= 1.1:
            return
        with self.lock:
            if not history or stamp > history[-1][1]:
                history.append((self.now(), stamp, p, tuple(v/norm for v in q)))

    def sport(self, message):
        try:
            self.append(self.sports, timestamp(message.stamp), message.position, message.imu_state.quaternion)
        except (AttributeError, ValueError, TypeError, OverflowError):
            pass

    def odom(self, message):
        try:
            if message.header.frame_id != 'odom':
                return
            p, q = message.pose.pose.position, message.pose.pose.orientation
            self.append(self.odometry, timestamp(message.header.stamp), (p.x, p.y, p.z), (q.w, q.x, q.y, q.z))
        except (AttributeError, ValueError, TypeError, OverflowError):
            pass

    def nearest(self, received, stamp):
        with self.lock:
            # Odometry/cloud share the robot's clock; sport may have a different
            # epoch, so its existing local receipt-time pairing is preserved.
            for history, robot_clock in ((self.odometry, True), (self.sports, False)):
                matches = [p for p in history if 0 <= self.now()-p[0] <= .5
                           and abs(p[0]-received) <= .25
                           and (not robot_clock or abs(p[1]-stamp) <= 250_000_000)]
                if matches:
                    return min(matches, key=lambda p: abs(p[1]-stamp) if robot_clock else abs(p[0]-received))
        return None


def media_pose(pose):
    _, _, p, (w, x, y, z) = pose
    return dict(x=float(p[0]), y=float(p[1]), z=float(p[2]),
                yaw=math.atan2(2*(w*z+x*y), 1-2*(y*y+z*z)))
