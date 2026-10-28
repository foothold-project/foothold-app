"""Measured state cache, isolated from Core, authority, and command adapters."""

from copy import deepcopy
from datetime import datetime, timezone
import math
import threading
import time

STALE_S = 2.0
OFFLINE_S = 10.0
TILT_RAD = math.pi / 3


def number(value, low=-math.inf, high=math.inf):
    return (type(value) in (int, float) and math.isfinite(value)
            and low <= value <= high)


def integer(value, high):
    return type(value) is int and 0 <= value <= high


def attitude(message):
    rpy = getattr(getattr(message, 'imu_state', None), 'rpy', None)
    if not isinstance(rpy, (list, tuple)) or len(rpy) != 3:
        return {'roll': None, 'pitch': None}
    return {name: float(value) if number(value, -math.pi, math.pi) else None
            for name, value in zip(('roll', 'pitch'), rpy)}


class State:
    def __init__(self, *, now=time.monotonic, wall=time.time):
        self.now, self.wall = now, wall
        self._lock = threading.Lock()
        self._topics = {}

    def _accept(self, topic, marker, values):
        with self._lock:
            previous = self._topics.get(topic)
            # DDS receipt alone doesn't make replayed/frozen measurements fresh.
            if previous is not None:
                delta = marker - previous['marker']
                # The lowstate tick is uint32 milliseconds and can wrap.
                wrapped = (topic == 'lowstate' and previous['marker'] > 0xF0000000
                           and marker < 0x0FFFFFFF)
                if delta <= 0 and not wrapped:
                    return
            self._topics[topic] = dict(marker=marker, values=values,
                                       received=self.now(), wall=self.wall())

    def lowstate(self, message):
        tick = getattr(message, 'tick', None)
        if not integer(tick, 0xFFFFFFFF):
            return
        soc = getattr(getattr(message, 'bms_state', None), 'soc', None)
        voltage = getattr(message, 'power_v', None)
        self._accept('lowstate', tick, {
            'battery': {'soc': soc if number(soc, 0, 100) else None,
                        'voltage': float(voltage) if number(voltage, .01, 100) else None},
            'attitude': attitude(message)})

    def sportmodestate(self, message):
        stamp = getattr(message, 'stamp', None)
        sec, nsec = getattr(stamp, 'sec', None), getattr(stamp, 'nanosec', None)
        if not integer(sec, 0x7FFFFFFF) or not integer(nsec, 999999999):
            return
        mode, error = getattr(message, 'mode', None), getattr(message, 'error_code', None)
        self._accept('sportmodestate', sec * 1000000000 + nsec, {
            'mode': mode if integer(mode, 255) else None,
            'error_code': error if integer(error, 0xFFFFFFFF) else None})

    def snapshot(self):
        with self._lock:
            topics = deepcopy(self._topics)
        now = self.now()
        sources = {}
        fresh = {}
        for name in ('lowstate', 'sportmodestate'):
            sample = topics.get(name)
            age = None if sample is None else now - sample['received']
            valid = age is not None and 0 <= age <= STALE_S
            fresh[name] = valid
            sources[name] = {
                'fresh': valid, 'age_s': None if age is None else max(0, age),
                'received_at': None if sample is None else datetime.fromtimestamp(
                    sample['wall'], timezone.utc).isoformat()}
        ages = [now - sample['received'] for sample in topics.values()]
        connection = ('ONLINE' if all(fresh.values()) else
                      'OFFLINE' if not ages or all(age > OFFLINE_S for age in ages)
                      else 'STALE')
        low = topics['lowstate']['values'] if fresh['lowstate'] else {}
        sport = topics['sportmodestate']['values'] if fresh['sportmodestate'] else {}
        pose = low.get('attitude', {'roll': None, 'pitch': None})
        fallen = (None if any(v is None for v in pose.values()) else
                  any(abs(v) >= TILT_RAD for v in pose.values()))
        latest_topic = max(topics, key=lambda name: topics[name]['received'], default=None)
        return {
            'v': 1, 'kind': 'go2-readonly', 'connection': connection,
            'read_only': True, 'motion_enabled': False, 'gate': 'READ_ONLY',
            'battery': low.get('battery', {'soc': None, 'voltage': None}),
            'attitude': pose, 'fallen': fallen, 'fallen_source': 'imu_tilt_estimate',
            'fallen_threshold_rad': TILT_RAD,
            'mode': sport.get('mode'), 'error_code': sport.get('error_code'),
            'last_received_at': (sources[latest_topic]['received_at']
                                 if latest_topic is not None else None),
            'sources': sources, 'stale_after_s': STALE_S, 'offline_after_s': OFFLINE_S}
