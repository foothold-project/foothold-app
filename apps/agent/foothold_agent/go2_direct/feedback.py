"""Bounded DDS receipt cache; only owning-loop consume() can touch Hub/Core.

DDS has no cryptographic identity. SportModeState has no serial at all. This
requires an operator-confirmed exclusive robot NIC and fresh matching LowState.
Another LowState identity permanently faults this process, including at startup.
"""
from copy import deepcopy
import math
import threading
import time

from foothold_agent.go2_readonly.state import State, attitude, integer, number
from foothold_agent.safety.core import SCHEMA
from .sink import FEEDBACK_MAX_AGE_S


def vector(value, length):
    if not isinstance(value, (list, tuple)) or len(value) != length or not all(number(x) for x in value):
        return None
    return tuple(float(x) for x in value)


class Feedback:
    def __init__(self, serial, *, now=time.monotonic, wall=time.time):
        self.serial, self.now = serial, now
        self.state = State(now=now, wall=wall)
        self._lock = threading.Lock()
        self._low = self._sport = None
        self._sequence = 0
        self._consumed = -1
        self._last_ready = False
        self._fault = False
        self.sink = None

    @property
    def fault(self):
        with self._lock:
            return self._fault

    def lowstate(self, message):
        sn, tick = getattr(message, 'sn', None), getattr(message, 'tick', None)
        if not isinstance(sn, (tuple, list)) or len(sn) != 2 or not all(integer(x, 0xFFFFFFFF) for x in sn):
            return
        serial = f'{sn[0]}-{sn[1]}'
        with self._lock:
            if serial != self.serial:
                self._fault = True
                return
            if not integer(tick, 0xFFFFFFFF):
                return
            if self._low is not None:
                previous = self._low['tick']
                if tick <= previous and not (previous > 0xF0000000 and tick < 0x0FFFFFFF):
                    return
            gyro = vector(getattr(getattr(message, 'imu_state', None), 'gyroscope', None), 3)
            motors = getattr(message, 'motor_state', None)
            dq = (vector([getattr(m, 'dq', None) for m in motors[:12]], 12)
                  if isinstance(motors, (tuple, list)) and len(motors) >= 12 else None)
            self._low = dict(tick=tick, received=self.now(), attitude=attitude(message),
                             still=gyro is not None and dq is not None and
                             all(abs(x) <= .05 for x in gyro) and all(abs(x) <= .10 for x in dq))
            self.state.lowstate(message)

    def sportmodestate(self, message):
        stamp = getattr(message, 'stamp', None)
        sec, nsec = getattr(stamp, 'sec', None), getattr(stamp, 'nanosec', None)
        if not integer(sec, 0x7FFFFFFF) or not integer(nsec, 999999999):
            return
        marker = sec*1000000000+nsec
        velocity = vector(getattr(message, 'velocity', None), 3)
        yaw = getattr(message, 'yaw_speed', None)
        mode, error = getattr(message, 'mode', None), getattr(message, 'error_code', None)
        progress, height = getattr(message, 'progress', None), getattr(message, 'body_height', None)
        with self._lock:
            now = self.now()
            if (self._fault or self._low is None or
                    not 0 <= now-self._low['received'] <= FEEDBACK_MAX_AGE_S or marker <= 0 or
                    (self._sport is not None and marker <= self._sport['marker'])):
                return
            if velocity is None or not number(yaw) or not integer(mode, 255) or not integer(error, 0xFFFFFFFF):
                return
            context = self.sink.feedback_context() if self.sink is not None else (None, True)
            self._sequence += 1
            self._sport = dict(marker=marker, received=now, sequence=self._sequence,
                               generation=context[0], velocity=velocity, yaw=float(yaw),
                               mode=mode, error=error, progress=progress, height=height)
            self.state.sportmodestate(message)

    def sample(self):
        with self._lock:
            now = self.now()
            if (self._fault or self._low is None or self._sport is None or
                    any(not 0 <= now-s['received'] <= FEEDBACK_MAX_AGE_S for s in (self._low, self._sport))):
                return None
            return deepcopy((self._low, self._sport))

    def consume(self, hub):
        sample = self.sample()
        if sample is None:
            return False
        low, sport = sample
        if sport['sequence'] == self._consumed:
            return self._last_ready  # never refresh Core time or confirm a new generation from cache
        self._consumed = sport['sequence']
        angles = low['attitude']
        tilt = None if any(x is None for x in angles.values()) else max(abs(x) for x in angles.values())
        # Unitree's documented ordinary stand/balance/locomotion modes only.
        # No mode switch or stand-up is issued. Unknown modes/errors stay closed.
        ready = (sport['mode'] in (0, 1, 3) and sport['error'] == 0 and
                 number(sport['progress']) and sport['progress'] == 0 and
                 number(sport['height'], .20, .50) and tilt is not None and tilt < math.pi/3)
        still = (low['still'] and all(abs(x) <= .02 for x in sport['velocity']) and abs(sport['yaw']) <= .03)
        generation, latched = self.sink.feedback_context()
        confirmed = (ready and still and self.sink.confirm_stopped(
            generation=sport['generation'], sequence=sport['sequence'],
            received_at=sport['received'], stationary=True))
        self._last_ready = ready
        hub.on_robot_state(dict(schema=SCHEMA, episode=0, sim_t=None,
            stop_requested=bool(latched and confirmed), reset_in_progress=False, policy_running=ready,
            body_still=still, fallen=None if tilt is None else tilt >= math.pi/3,
            tilt_deg=None if tilt is None else math.degrees(tilt), z=sport['height'],
            vx=sport['velocity'][0], vy=sport['velocity'][1], wz=sport['yaw']))
        return ready
