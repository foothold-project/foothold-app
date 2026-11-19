"""Bounded DDS receipt cache; only owning-loop consume() can touch Hub/Core.

DDS has no cryptographic identity. SportModeState has no serial at all. This
requires an operator-confirmed exclusive robot NIC and fresh matching LowState.
Another LowState identity permanently faults this process, including at startup.
"""
from copy import deepcopy
import math
import logging
import threading
import time

from foothold_agent.go2_readonly.state import State, attitude, integer, number
from foothold_agent.safety.core import SCHEMA
from .sink import FEEDBACK_MAX_AGE_S

STILL_VZ_MAX_M_S = .06  # ponytail: 실측 정지 분포 보고 조정 (현장 승인).
LYING_HEIGHT_MAX_M = .15  # Go2 X idle (mode 0) can also mean lying down.


def vector(value, length):
    if not isinstance(value, (list, tuple)) or len(value) != length or not all(number(x) for x in value):
        return None
    return tuple(float(x) for x in value)


class Feedback:
    def __init__(self, serial, *, now=time.monotonic, wall=time.time, accept_error_codes=()):
        self.serial, self.now = serial, now
        self.accept_error_codes = frozenset(accept_error_codes)
        if any(type(x) is not int or not 0<=x<=0xFFFFFFFF for x in self.accept_error_codes):
            raise ValueError('explicit uint32 state list required')
        self.state = State(now=now, wall=wall)
        self._lock = threading.Lock()
        self._low = self._sport = None
        self._sequence = 0
        self._consumed = -1
        self._last_ready = False
        self._fault = False
        self.sink = None
        self._journal_posture_value = None

    @property
    def sink(self):
        return self._sink

    @sink.setter
    def sink(self, value):
        self._sink = value
        if value is not None:
            value.stop_feedback = lambda: self.stop_snapshot(value)

    def stop_snapshot(self, sink):
        """Identity-bound measurements for STOP RPC timeout handling only.

        Never acknowledges Core or unlocks it; both DDS receipts must belong to
        the same sink generation and remain within the existing freshness gate.
        """
        sample = self.sample()
        if sample is None or self.sink is not sink:
            return None
        low, sport = sample
        if low['generation'] != sport['generation']:
            return None
        return dict(generation=sport['generation'],
                    received_at=min(low['received'], sport['received']),
                    stationary=self._posture(sample)['still'])

    @property
    def fault(self):
        with self._lock:
            return self._fault

    def lowstate(self, message):
        received = self.now()  # callback entry, BEFORE parsing or any lock wait
        sink = self.sink
        generation = None if sink is None else sink.generation  # nonblocking epoch snapshot
        sn, tick = getattr(message, 'sn', None), getattr(message, 'tick', None)
        if not isinstance(sn, (tuple, list)) or len(sn) != 2 or not all(integer(x, 0xFFFFFFFF) for x in sn):
            return
        serial = f'{sn[0]}-{sn[1]}'
        with self._lock:
            # Identity conflict is permanent evidence, even if motion evidence
            # aged out or crossed STOP while this callback waited for the lock.
            if serial != self.serial:
                self._fault = True
                return
            if (not 0 <= self.now()-received <= FEEDBACK_MAX_AGE_S or self.sink is not sink
                    or (sink is not None and sink.generation != generation)):
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
            self._low = dict(tick=tick, received=received, generation=generation, attitude=attitude(message),
                             gyro=gyro, dq=dq,
                             still=gyro is not None and dq is not None and
                             all(abs(x) <= .05 for x in gyro) and all(abs(x) <= .10 for x in dq))
            self.state.lowstate(message)

    def sportmodestate(self, message):
        received = self.now()  # preserve receipt through cache-lock contention
        sink = self.sink
        generation = None if sink is None else sink.generation
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
            if (not 0 <= now-received <= FEEDBACK_MAX_AGE_S or self.sink is not sink
                    or (sink is not None and sink.generation != generation) or
                    self._fault or self._low is None or
                    not 0 <= now-self._low['received'] <= FEEDBACK_MAX_AGE_S or marker <= 0 or
                    (self._sport is not None and marker <= self._sport['marker'])):
                return
            if velocity is None or not number(yaw) or not integer(mode, 255) or not integer(error, 0xFFFFFFFF):
                return
            self._sequence += 1
            self._sport = dict(marker=marker, received=received, sequence=self._sequence,
                               generation=generation, velocity=velocity, yaw=float(yaw),
                               mode=mode, error=error, progress=progress, height=height)
            self.state.sportmodestate(message)

    def sample(self):
        with self._lock:
            now = self.now()
            if (self._fault or self._low is None or self._sport is None or
                    any(not 0 <= now-s['received'] <= FEEDBACK_MAX_AGE_S for s in (self._low, self._sport))):
                return None
            return deepcopy((self._low, self._sport))

    def telemetry(self):
        """Measured display cache; reporting freshness is separate from motion."""
        with self._lock:
            low = deepcopy(self._low)
            sport = deepcopy(self._sport)
            fault = self._fault
        self._journal_posture(sport)
        snapshot = self.state.snapshot()
        # The read-only display cache stamps when it is updated. Preserve the
        # actual DDS callback-entry receipts for phone/relay freshness instead.
        now = self.now()
        for topic, sample in (('lowstate', low), ('sportmodestate', sport)):
            source = snapshot['sources'][topic]
            age = None if sample is None else now-sample['received']
            source['age_s'] = None if age is None else max(0., age)
            source['fresh'] = source['fresh'] and age is not None and age >= 0
        snapshot['speed_sample'] = (None if sport is None or fault else dict(
            speed=math.hypot(*sport['velocity'][:2]), received=sport['received']))
        if fault:
            # Do not publish the previous robot's healthy battery on an ID conflict.
            for source in snapshot['sources'].values():
                source['fresh'] = False
        error = snapshot.get('error_code')
        if type(error) is int:
            accepted = error != 0 and self.error_allowed(error)
            snapshot['status_code'] = dict(raw=error,
                level='ACCEPTED' if accepted else 'ERROR' if error else 'OK',
                reason='EXPLICIT_SERVER_ALLOWLIST' if accepted else None)
        return snapshot

    def _journal_posture(self, sport):
        if sport is None:
            return
        height = float(sport['height']) if number(sport['height']) else -1.
        value = (sport['mode'], sport['error'])
        if value != self._journal_posture_value:
            self._journal_posture_value = value
            # Numeric diagnostics only: no identity, address, token or SDK text.
            # Called on the reporting loop, outside the DDS/cache lock.
            logging.getLogger(__name__).warning(
                'GO2_POSTURE mode=%d motion_state=%d height_m=%.2f', *value, height)

    def error_allowed(self, error):
        """Shared display/readiness policy; only an explicit server list applies."""
        return error == 0 or (error in self.accept_error_codes and getattr(self.sink, 'source', None) == 'server')

    def posture_snapshot(self):
        """Fresh identity-bound posture, never inferred from an RPC return code.

        Unitree unitree_ros2 README Sportmode state: 5 lieDown, 8
        recoveryStand, 0 idle/default stand, 1 balanceStand, 3 locomotion.
        Height/progress/attitude disambiguate incomplete stand transitions.
        """
        return self._posture(self.sample())

    def _posture(self, sample):
        result = dict(state='UNKNOWN', mode=None, still=False, sequence=-1,
                      standing_locked=False, walkable=False, motion_state=None, height=None)
        if sample is None:
            return result
        low, sport = sample
        result['mode'] = sport['mode']
        result['motion_state'] = sport['error']
        result['height'] = sport['height'] if number(sport['height']) else None
        result['sequence'] = sport['sequence']
        angles = low['attitude']
        tilt = None if any(x is None for x in angles.values()) else max(abs(x) for x in angles.values())
        safe = (tilt is not None and tilt < math.pi/3
                and number(sport['progress']) and sport['progress'] == 0)
        result['still'] = (low['still'] and all(abs(x) <= .02 for x in sport['velocity'][:2])
            and abs(sport['velocity'][2]) <= STILL_VZ_MAX_M_S and abs(sport['yaw']) <= .03)
        # Preserve the existing mode-5 range; Go2 X also lies down in mode 0.
        if safe and ((sport['mode'] == 5 and number(sport['height'], 0., .50)) or
                (sport['mode'] in (0, 5) and number(sport['height'], 0.)
                 and sport['height'] < LYING_HEIGHT_MAX_M)):
            result['state'] = 'LYING'
        elif safe and sport['mode'] in (0, 1, 3) and number(sport['height'], .20, .50):
            result['state'] = 'STANDING'
            result['walkable'] = self.error_allowed(sport['error'])
        elif (sport['mode'] == 8 or
                (sport['mode'] in (0, 1, 3, 5) and number(sport['progress']) and sport['progress'] != 0)):
            result['state'] = 'TRANSITIONING'
        # Keep UNKNOWN on the existing wire: TRANSITIONING disables the web's
        # recovery buttons. A measured joint lock is recoverable, never walkable.
        result['standing_locked'] = (safe and sport['mode'] == 6 and
            number(sport['height'], .20, .50) and result['still'])
        return result

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
        ready = (sport['mode'] in (0, 1, 3) and self.error_allowed(sport['error']) and
                 number(sport['progress']) and sport['progress'] == 0 and
                 number(sport['height'], .20, .50) and tilt is not None and tilt < math.pi/3)
        still = (low['still'] and all(abs(x) <= .02 for x in sport['velocity'][:2])
                 and abs(sport['velocity'][2]) <= STILL_VZ_MAX_M_S and abs(sport['yaw']) <= .03)
        generation, latched = self.sink.feedback_context()
        posture = self._posture(sample)
        posture_stopped = posture['state'] == 'LYING' or posture['standing_locked']
        confirmed = ((ready or posture_stopped) and still and low['generation'] == sport['generation'] and self.sink.confirm_stopped(
            generation=sport['generation'], sequence=sport['sequence'],
            received_at=sport['received'], stationary=True))
        self._last_ready = ready
        checks = [(axis, value, limit, 'm/s') for axis, value, limit in
                  zip(('vx', 'vy', 'vz'), sport['velocity'], (.02, .02, STILL_VZ_MAX_M_S))]
        checks += [('wz', sport['yaw'], .03, 'rad/s')]
        checks += [(axis, value, .05, 'rad/s') for axis, value in
                   zip(('gyro_x', 'gyro_y', 'gyro_z'), low['gyro'] or ())]
        checks += [(f'joint_{i}', value, .10, 'rad/s') for i, value in enumerate(low['dq'] or ())]
        violations = [dict(axis=axis, value=value, limit=limit, unit=unit)
                      for axis, value, limit, unit in checks if abs(value) > limit]
        hub.on_robot_state(dict(schema=SCHEMA, episode=0, sim_t=None,
            still_violations=violations,
            stop_requested=bool(latched and confirmed), reset_in_progress=False, policy_running=ready,
            body_still=still, fallen=None if tilt is None else tilt >= math.pi/3,
            tilt_deg=None if tilt is None else math.degrees(tilt), z=sport['height'],
            vx=sport['velocity'][0], vy=sport['velocity'][1], wz=sport['yaw']))
        return ready
