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
    """Never amplify: only exact tested SI commands map to normalized axes.

    Values come from the reviewed config. Cross-check against the unchanged
    Core quantizer prevents a config change silently creating a different speed.
    Curves remain disabled until swept/STOP experiments authorize them.
    """
    def __init__(self, config):
        self.commands = config['commands']
        self.allow_curves = config['allow_curves']
        for item in self.commands:
            si, axes = item['si'], item['axes']
            if (len(si) != 3 or len(axes) != 3 or not all(number(x) for x in si + axes)
                    or any(abs(x) > 1 for x in axes) or quantize(*axes)[0] != tuple(si)):
                raise ValueError('config disagrees with tested Core alphabet')

    def adapt(self, velocity):
        if (not isinstance(velocity, (tuple, list)) or len(velocity) != 3
                or not all(number(x) for x in velocity)):
            return Z, 'INVALID_VELOCITY'
        for item in self.commands:
            if tuple(velocity) == tuple(item['si']):
                if velocity[2] and not self.allow_curves:
                    return Z, 'CURVE_UNVERIFIED'
                return tuple(item['axes']), 'TESTED' if any(velocity) else 'ZERO'
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

    def begin(self, binding, point):
        if self.binding is not None:
            raise ValueError('cancel previous goal before begin')
        with self._lock:
            self.binding = binding
            self._latest = None
            self._revoked = False
            self.result = None
        self.actions.submit(binding, point)

    def intent(self, binding, velocity):
        with self._lock:
            if binding != self.binding or self._revoked:
                return False
            self._sequence += 1
            self._latest = (self._sequence, self.now(), tuple(velocity) if isinstance(velocity, (list, tuple)) else velocity)
            return True

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
        if run.get('status') != 'RUNNING':
            return Z
        return axes
