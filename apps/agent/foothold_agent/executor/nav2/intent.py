"""Finite policy alphabet and a size-one, receive-once intent mailbox."""
from dataclasses import asdict, dataclass
import json
import logging
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
    policy_version = 'nav2-physical-alphabet-yaw04/1'

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
        self.result_at = None
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
        self.first_rejection = None
        self._pending_rejection = None

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
            self.result_at = None
            self.rejected = False
            self.first_rejection = None
            self._pending_rejection = None
        self.actions.submit(binding, point)

    def intent(self, binding, velocity):
        received_at = self.now()
        with self._lock:
            if binding != self.binding or self._revoked or self.result is not None:
                return False
            # Check the PREVIOUS receipt under this same lock before replacing it.
            # Only a new explicit goal can clear expiration; callbacks never can.
            if self._expire_locked():
                return False
            self._source_at = received_at
            self._sequence += 1
            self._latest = (self._sequence, received_at, tuple(velocity) if isinstance(velocity, (list, tuple)) else velocity)
            # Latest-one movement remains bounded, but a rejected input must
            # not disappear when a second callback arrives before the poll.
            _, reason = self.adapter.adapt(self._latest[2])
            if reason not in ('TESTED', 'TESTED_YAW_REDUCED', 'ZERO') and self._pending_rejection is None and self.first_rejection is None:
                self._pending_rejection = (self._latest, reason,
                    getattr(self.adapter, 'policy_version', type(self.adapter).__name__))
                self._reject_locked(binding, self._latest, reason, self._pending_rejection[2])
            return True

    def _reject_locked(self, binding, item, reason, policy_version):
        if self.first_rejection is None:
            def raw(value):
                if isinstance(value, (tuple, list)):
                    return [raw(v) for v in value[:16]]
                if type(value) in (int, float):
                    if type(value) is int and value.bit_length() > 4096:
                        return {'invalid_type': 'int', 'bits': value.bit_length()}
                    return value if number(value) else str(value)[:128]
                if value is None or type(value) in (str, bool):
                    return value[:128] if type(value) is str else value
                return {'invalid_type': type(value).__name__}
            # Preserve evidence before latching, including nonfinite/malformed
            # values. No contract changes or synchronous journal writes.
            self.first_rejection = dict(kind='COMMAND_REJECTION', binding=asdict(binding),
                received_at=item[1], input_si=raw(item[2]), reason=reason,
                policy_version=policy_version, output_axes=list(Z))
            self.rejected = True
            logging.getLogger(__name__).warning('NAV_FAILURE %s', json.dumps(self.first_rejection, allow_nan=False, sort_keys=True))
        self.rejected = True

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
            if binding != self.binding or self._revoked or self.result is not None or self.rejected:
                return False
            if result == 'SUCCEEDED' and self._expire_locked():
                return False
            self.result = result
            self.result_at = self.now()
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
            pending = self._pending_rejection
            if pending is not None:
                item = pending[0]
                self._pending_rejection = None
            if item is None or item[0] == self._consumed:
                return None
            seq, receipt, velocity = item
            self._consumed = seq
            self._last_receipt = receipt
        if pending is None and not 0 <= self.now() - receipt <= self.dead_s:
            self.reason = 'INTENT_STALE'
            return None
        self.last_velocity = velocity
        axes, self.reason = (Z, pending[1]) if pending is not None else self.adapter.adapt(velocity)
        self.counts[self.reason] = self.counts.get(self.reason, 0)+1
        if self.reason not in ('TESTED', 'TESTED_YAW_REDUCED', 'ZERO'):
            with self._lock:
                self._reject_locked(b, item, self.reason,
                    pending[2] if pending is not None else getattr(self.adapter, 'policy_version', type(self.adapter).__name__))
        if self.rejected:
            self.reason = 'COMMAND_REJECTION_LATCHED'
            return Z  # no unverified .6<->0 flicker after a rejected sample
        if run.get('status') != 'RUNNING':
            return Z
        return axes
