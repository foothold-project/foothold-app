"""Latest-only SI output with a watchdog independent of asyncio and the ROS executor."""

import threading
import time

from foothold_agent.link.session import MotionCommand
from foothold_agent.safety.core import DEAD, Z, finite


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
                 now=time.monotonic, watchdog=True):
        self._velocity, self._stop, self._resume = publish_velocity, publish_stop, publish_resume
        self.now = now
        self._lock = threading.RLock()  # memory only; NEVER held across ROS calls
        self._output_lock = threading.RLock()
        self._closed = threading.Event()
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
            elif command.kind == "unlock":
                if not self._held:
                    self._pending = Z
                    self._stopped = True
                    self._resume_pending = True
                    self._urgent = True
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

    def feedback_generation(self):
        with self._lock:
            return self._generation

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

    def check_watchdog(self):
        trip = False
        with self._lock:
            if not self._expired and self.now() - self._last_apply >= DEAD:
                self._expired = True
                trip = True
            elif not self._expired and self.now() - self._last_flush >= DEAD:
                self.error = RuntimeError("ROS publisher loop stalled")
                self._expired = True
                trip = True
            if trip:
                self._hold_locked()
        if trip:
            self._emergency()

    def flush(self):
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
                        with self._lock:
                            if generation == self._generation:
                                self._stopped = False
                                self._stop_confirmed = False
                with self._lock:
                    velocity = Z if self._stopped or self._held or self._closed.is_set() else self._pending
                self._velocity(velocity)
                with self._lock:
                    superseded = generation != self._generation
                    stop_due = self._stopped and (self._stop_first or (
                        not self._stop_confirmed and self.now() - self._last_stop >= 0.5))
                    if stop_due:
                        self._stop_first = False
                        self._last_stop = self.now()
                if superseded:
                    self._emergency()
                elif stop_due:
                    self._stop()
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
                self.check_watchdog()
        except BaseException as exc:
            self.fail(exc)

    def close(self):
        with self._lock:
            if self._closed.is_set():
                return
            self._closed.set()
        self._emergency()
        if self._watchdog is not None and self._watchdog is not threading.current_thread():
            self._watchdog.join(timeout=0.5)
