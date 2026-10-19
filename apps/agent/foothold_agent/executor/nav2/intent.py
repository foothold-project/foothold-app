"""Finite policy alphabet and a size-one, receive-once intent mailbox."""
from dataclasses import dataclass
import math
import threading
import time

from foothold_agent.safety.core import Z, quantize


def number(v):
    return type(v) in (int, float) and -1e100 < v < 1e100 and math.isfinite(v)


@dataclass(frozen=True)
class Binding:
    run_id: str
    goal_id: str
    episode: int
    stop_gen: int
    world: str
    floor: str
    map_sha: str


class PolicyAdapter:
    """Never amplify: tested SI commands, with downward-only tiny-yaw projection.

    Values come from the reviewed config. Cross-check against the unchanged
    Core quantizer prevents a config change silently creating a different speed.
    Curves remain disabled until swept/STOP experiments authorize them.
    """
    def __init__(self, config):
        self.commands = config['commands']
        self.allow_curves = config['allow_curves']
        # D22 downward projection: .04 rad/s is below 2*.6*.05/1.2**2
        # (one 5 cm map cell at 1.2 m lookahead); full GT sweep still required.
        self.yaw_zero_threshold = config['yaw_zero_threshold_rps']
        if not number(self.yaw_zero_threshold) or self.yaw_zero_threshold < 0:
            raise ValueError('invalid downward yaw threshold')
        for item in self.commands:
            si, axes = item['si'], item['axes']
            if (len(si) != 3 or len(axes) != 3 or not all(number(x) for x in si + axes)
                    or any(abs(x) > 1 for x in axes) or quantize(*axes)[0] != tuple(si)):
                raise ValueError('config disagrees with tested Core alphabet')

    def adapt(self, velocity):
        if (not isinstance(velocity, (tuple, list)) or len(velocity) != 3
                or not all(number(x) for x in velocity)):
            return Z, 'INVALID_VELOCITY'
        reduced = 0 < abs(velocity[2]) <= self.yaw_zero_threshold
        if reduced:
            velocity = (velocity[0], velocity[1], 0)  # reduce only; never round up vx or wz
        for item in self.commands:
            if tuple(velocity) == tuple(item['si']):
                if velocity[2] and not self.allow_curves:
                    return Z, 'CURVE_UNVERIFIED'
                reason = 'TESTED_YAW_REDUCED' if reduced and any(velocity) else 'TESTED'
                return tuple(item['axes']), reason if any(velocity) else 'ZERO'
        return Z, 'UNSUPPORTED_VELOCITY'


class NavExecutor:
    """The ROS callback records its original monotonic receipt, never poll time.

    A sample is consumed once. Repeated poll() with no new callback returns None,
    so Session's >0.3s EXECUTOR_STALLED path cannot be refreshed by a cached cmd.
    submit/cancel on the injected action port MUST only enqueue (no ACK wait).
    """
    def __init__(self, adapter, actions, *, now=time.monotonic, dead_s=.3):
        self.adapter, self.actions, self.now, self.dead_s = adapter, actions, now, dead_s
        self.binding = None
        self.reason = 'IDLE'
        self.result = None
        self.counts = {}
        self.last_velocity = None
        self._lock = threading.Lock()
        self._latest = None
        self._sequence = 0
        self._consumed = 0
        self._last_receipt = float('-inf')
        self._revoked = False
        self._source_at = None
        self._deadline_expired = False
        self.rejected = False

    def begin(self, binding, point):
        if self.binding is not None:
            raise ValueError('cancel previous goal before begin')
        with self._lock:
            self.binding = binding
            self._source_at = self.now()  # bounded first-command wait
            self._deadline_expired = False
            self._latest = None
            self._revoked = False
            self.result = None
            self.rejected = False
        self.actions.submit(binding, point)

    def intent(self, binding, velocity):
        received_at = self.now()
        with self._lock:
            if binding != self.binding or self._revoked:
                return False
            # Check the PREVIOUS receipt under this same lock before replacing it.
            # Only a new explicit goal can clear expiration; callbacks never can.
            if self._expire_locked():
                return False
            self._source_at = received_at
            self._sequence += 1
            self._latest = (self._sequence, received_at, tuple(velocity) if isinstance(velocity, (list, tuple)) else velocity)
            return True

    def source_received(self):
        with self._lock:
            return self._source_at

    def _expire_locked(self):
        if (self.binding is not None and self._source_at is not None
                and not 0 <= self.now()-self._source_at <= self.dead_s):
            self._deadline_expired = True
        return self._deadline_expired

    def source_expired(self):
        with self._lock:
            return self.binding is not None and self._expire_locked()

    def feedback(self, binding, result):
        with self._lock:
            if binding != self.binding or self._revoked:
                return False
            self.result = result
            return True

    def revoke(self, reason):
        # Owner calls this only AFTER applying zero/STOP to the one motion sink.
        with self._lock:
            binding = self.binding
            self._revoked = True
            self.binding = None
            self._latest = None
            self.reason = reason
        if binding is not None:
            self.actions.cancel(binding)

    def poll(self, run):
        with self._lock:
            b, item = self.binding, self._latest
            if b is None or run is None or run.get('run_id') != b.run_id:
                return None
            if item is None or item[0] == self._consumed:
                return None
            seq, receipt, velocity = item
            self._consumed = seq
            self._last_receipt = receipt
        if not 0 <= self.now() - receipt <= self.dead_s:
            self.reason = 'INTENT_STALE'
            return None
        self.last_velocity = velocity
        axes, self.reason = self.adapter.adapt(velocity)
        self.counts[self.reason] = self.counts.get(self.reason, 0)+1
        if self.reason not in ('TESTED', 'TESTED_YAW_REDUCED', 'ZERO'):
            self.rejected = True
        if self.rejected:
            self.reason = 'COMMAND_REJECTION_LATCHED'
            return Z  # no unverified .6<->0 flicker after a rejected sample
        if run.get('status') != 'RUNNING':
            return Z
        return axes
