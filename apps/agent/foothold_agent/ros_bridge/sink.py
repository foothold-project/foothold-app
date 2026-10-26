"""Latest-only SI output with a watchdog independent of asyncio and the ROS executor."""

import threading
import time
from collections import deque

from foothold_agent.link.session import MotionCommand
from foothold_agent.safety.core import DEAD, Z, finite, _SafetyLog, _log_source

# Isolated scheduling delays can recover; three incidents in one minute cannot.
# Keep the policy together so field diagnostics can inform later tuning.
STALL_LIMIT = (3, 60.0)  # count, rolling monotonic seconds
# Allow a brief scheduling interruption, never an indefinitely live failed bridge.
STALL_RECOVERY_TIMEOUT = 2.0  # seconds since detection / emergency dispatch


def twist_message(velocity, factory):
    """Core output is already m/s and rad/s. Never scale or quantize it again."""
    message = factory()
    message.linear.x, message.linear.y, message.angular.z = velocity
    return message


class RosSink:
    """MotionSink with bounded memory updates; apply never waits for ROS publishing.

    Normal publication belongs to flush() on the ROS thread; the independent
    watchdog may publish emergency ZERO/STOP. Publishers must be local, bounded,
    thread-safe calls. No state lock is held across a publisher call. The output
    lock serializes dispatch with emergency output; no nonzero backlog exists.
    A publisher failure is terminal and visible through check_health().
    """

    def __init__(self, publish_velocity, publish_stop, publish_resume, *,
                 now=time.monotonic, watchdog=True, diagnostics=None, on_error=None):
        self._velocity, self._stop, self._resume = publish_velocity, publish_stop, publish_resume
        self.now = now
        self._safety_log = _SafetyLog(now)
        self.diagnostics = diagnostics
        self._on_error = on_error
        self._failure_reported = False
        self._lock = threading.RLock()  # memory only; NEVER held across ROS calls
        self._output_lock = threading.RLock()
        self._closed = threading.Event()
        self._close_complete = threading.Event()
        self._close_error = None
        self._pending = Z
        self._stopped = True
        self._held = False
        self._generation = 0
        self._resume_pending = False
        self._urgent = True
        self._last_apply = now()
        self._stop_first = True
        self._stop_confirmed = False
        self._last_stop = float("-inf")
        self._last_flush = now()
        self._expired = False
        self._publisher_expired = False
        self._stall_started = None
        self._emergency_started = None
        self._emergency_thread = None
        self._stall_sequence = 0
        self._stalls = deque(maxlen=STALL_LIMIT[0])
        self.error = None
        self._watchdog = None
        if watchdog:
            self._watchdog = threading.Thread(target=self._watch, name="ros-output-watchdog", daemon=True)
            self._watchdog.start()

    def apply(self, command: MotionCommand):
        with self._lock:
            self.check_health()
            if self._closed.is_set():
                raise RuntimeError("ROS sink is closed")
            if command.kind == "apply":
                v = command.velocity
                try:
                    valid = isinstance(v, tuple) and len(v) == 3 and all(finite(x) for x in v)
                except (TypeError, OverflowError):
                    valid = False
                if not valid:
                    self._hold_locked()
                    raise ValueError("invalid SI velocity")
                self._last_apply = self.now()  # ONLY apply refreshes the deadline.
                self._expired = False
                self._pending = tuple(float(x) for x in v) if not (self._stopped or self._held) else Z
            elif command.kind == "stop":
                self._hold_locked(held=False)
                self._safety_log.emit('stop_received', 'motion_stop', _log_source(), sink_generation=self._generation)
            elif command.kind == "unlock":
                if not self._held:
                    self._pending = Z
                    self._stopped = True
                    self._resume_pending = True
                    self._urgent = True
                else:
                    self._safety_log.emit('resume_rejected', 'sink_feedback_held', _log_source(), sink_generation=self._generation)
            else:
                self._hold_locked()
                raise ValueError("unsupported motion action")

    def _hold_locked(self, *, held=True):
        self._stop_first |= not self._stopped or self._resume_pending or self._stop_confirmed
        self._stop_confirmed = False
        self._pending = Z
        self._resume_pending = False
        self._stopped = True
        self._held |= held
        self._generation += 1
        self._urgent = True

    def hold(self):
        """Bad/stale feedback: discard motion until genuine STOP feedback + new unlock."""
        with self._lock:
            self._hold_locked()
            self._safety_log.emit('hold', 'bridge_feedback_hold', _log_source(2), sink_generation=self._generation)

    def feedback_generation(self):
        with self._lock:
            return self._generation

    def output_safety(self):
        """Memory-only signal for the owning Session; never touch Core here."""
        with self._lock:
            return self._stall_sequence, self._held

    def observe_stop(self, generation=None):
        """Only fresh, validated stop_requested=true feedback may release a feedback hold."""
        with self._lock:
            if generation is not None and generation != self._generation:
                return False
            self._held = False  # local dispatch state is not physical feedback
            self._stop_confirmed = True
            return True

    def check_health(self):
        if self.error is not None:
            raise RuntimeError("ROS output failed") from self.error

    def _emergency(self):
        with self._lock:
            self._hold_locked()
        with self._output_lock:
            # Attempt both even when one publisher fails. Preserve the first error.
            for output in (lambda: self._velocity(Z), self._stop):
                try:
                    output()
                except BaseException as exc:
                    with self._lock:
                        if self.error is None:
                            self.error = exc
            with self._lock:
                self._last_stop = self.now()
                self._stop_first = False
        self._safety_log.emit('stop_publish', 'emergency', _log_source(2), sink_generation=self._generation)

    def check_watchdog(self, *, defer_emergency=False):
        trip = False
        with self._lock:
            now = self.now()
            if ((self._stall_started is not None and now >= self._stall_started + STALL_RECOVERY_TIMEOUT)
                    or (self._emergency_started is not None and now >= self._emergency_started + STALL_RECOVERY_TIMEOUT)):
                self.error = self.error or RuntimeError("ROS output stall recovery timed out")
            if not self._expired and self.now() - self._last_apply >= DEAD:
                self._expired = True
                trip = True
            elif not self._expired and not self._publisher_expired and self.now() - self._last_flush >= DEAD:
                self._publisher_expired = True
                detected = self.now()
                self._stall_started = detected
                self._stall_sequence += 1
                self._stalls.append(detected)
                count, window = STALL_LIMIT
                if len(self._stalls) == count and detected - self._stalls[0] <= window:
                    self.error = self.error or RuntimeError("ROS publisher loop repeatedly stalled")
                trip = True
                if self.diagnostics is not None:
                    self.diagnostics.stall(detected_at=self.now(), last_apply=self._last_apply,
                                           last_flush=self._last_flush)
            if trip:
                self._hold_locked()
                self._safety_log.emit('watchdog', 'apply_deadline' if self._expired else 'publisher_deadline',
                                      _log_source(), sink_generation=self._generation)
        if trip:
            if defer_emergency:
                self._start_emergency()
            else:
                self._emergency()

    def _start_emergency(self):
        """One in-flight attempt; a stuck publisher must not occupy the watchdog."""
        with self._lock:
            if self._emergency_started is not None:
                return
            self._emergency_started = self.now()
            self._emergency_thread = threading.Thread(target=self._watch_emergency,
                                                      name="ros-output-emergency", daemon=True)
            try:
                self._emergency_thread.start()
            except BaseException:
                self._emergency_started = None
                self._emergency_thread = None
                raise

    def _watch_emergency(self):
        try:
            self._emergency()
        except BaseException as exc:
            with self._lock:
                self.error = self.error or exc
        finally:
            with self._lock:
                self._emergency_started = None

    def _report_failure(self):
        with self._lock:
            if self.error is None or self._failure_reported or self._on_error is None:
                return
            error = self.error
            self._failure_reported = True
        self._on_error(error)

    def flush(self):
        if self.diagnostics is None:
            return self._flush()
        return self.diagnostics.call("flush", self._flush)

    def _flush(self):
        """20 Hz latest velocity, prompt STOP/unlock; no I/O on apply's state lock.

        A command committed to a publisher is in flight, never queued. If STOP
        races with that call, dispatch zero/STOP before this flush returns.
        """
        with self._output_lock:
            self.check_watchdog()
            with self._lock:
                if self._closed.is_set():
                    return
                self.check_health()
                now = self.now()
                if not self._urgent and now - self._last_flush < 0.05:
                    return
                self._urgent = False
                self._last_flush = now
                # Remove BEFORE publishing: never retry unlock, including failure.
                resume, self._resume_pending = self._resume_pending, False
                generation = self._generation
            try:
                if resume:
                    self._velocity(Z)
                    with self._lock:
                        approved = (not self._held and not self._closed.is_set()
                                    and generation == self._generation
                                    and self.now() - self._last_apply < DEAD)
                    if approved:
                        self._resume()
                        self._safety_log.emit('resume_publish', 'approved', _log_source(), sink_generation=generation)
                        with self._lock:
                            if generation == self._generation:
                                self._stopped = False
                                self._stop_confirmed = False
                    else:
                        self._safety_log.emit('resume', 'sink_not_approved', _log_source(), sink_generation=generation)
                with self._lock:
                    velocity = Z if self._stopped or self._held or self._closed.is_set() else self._pending
                self._velocity(velocity)
                with self._lock:
                    superseded = generation != self._generation
                    stop_due = self._stopped and (self._stop_first or (
                        not self._stop_confirmed and self.now() - self._last_stop >= 0.5))
                    if stop_due:
                        diagnostic_stop_reason = 'initial_or_new_stop' if self._stop_first else 'unconfirmed_retry'
                        self._stop_first = False
                        self._last_stop = self.now()
                if superseded:
                    self._emergency()
                elif stop_due:
                    self._stop()
                    self._safety_log.emit('stop_publish', diagnostic_stop_reason, _log_source(), sink_generation=generation)
                with self._lock:
                    # Completion (not apply or flush entry) rearms the publisher
                    # deadline. Recovery never releases the STOP feedback hold.
                    self._last_flush = self.now()
                    self._publisher_expired = False
                    self._stall_started = None
            except BaseException as exc:
                self.fail(exc)
                raise

    def fail(self, error):
        """Executor/callback failure is terminal; attempt zero and STOP immediately."""
        with self._lock:
            if self.error is None:
                self.error = error
        self._emergency()

    def _watch(self):
        try:
            while not self._closed.wait(0.005):
                self.check_watchdog(defer_emergency=True)
                self._report_failure()
        except BaseException as exc:
            with self._lock:
                self.error = self.error or exc
            # Notify before any emergency attempt, including thread-start failure.
            self._report_failure()
            self._start_emergency()

    def close(self):
        with self._lock:
            first = not self._closed.is_set()
            if first:
                self._closed.set()
        if first:
            # Keep publishers alive on timeout: incomplete close cannot ACK/destroy.
            try:
                threading.Thread(target=self._finish_close, name="ros-sink-close", daemon=True).start()
            except Exception:
                # Resource exhaustion cannot suppress the final ZERO/STOP.
                # Without a new thread this best-effort fallback is synchronous.
                self._finish_close()
        if not self._close_complete.wait(timeout=1.0):
            with self._lock:
                self._close_error = RuntimeError("ROS sink close timed out; publishers retained")
                self.error = self.error or self._close_error
            raise self._close_error
        if self._close_error is not None:
            raise self._close_error

    def _finish_close(self):
        try:
            self._emergency()
            if self._watchdog is not None and self._watchdog is not threading.current_thread():
                self._watchdog.join(timeout=0.5)
                if self._watchdog.is_alive():
                    self._close_error = RuntimeError("ROS watchdog did not stop")
                    self.error = self.error or self._close_error
            if self._emergency_thread is not None:
                self._emergency_thread.join(timeout=0.5)
                if self._emergency_thread.is_alive():
                    self._close_error = RuntimeError("ROS emergency output did not stop")
                    self.error = self.error or self._close_error
        finally:
            self._close_complete.set()
