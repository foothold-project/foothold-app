"""Offline-tested, nonblocking single-source SI output with independent watchdog.

Not a deployed motion service. SDK return=0 means request submission/response,
never physical stopping. No fabricated Core feedback is emitted by this module.
"""

import math
import threading
import time
from dataclasses import dataclass

ZERO = (0., 0., 0.)
DEADLINE_S = .30
FEEDBACK_MAX_AGE_S = .20
# Preserve current real-robot alphabet. Do not widen it from a config file.
ALLOWED = frozenset((ZERO, (.6, 0., 0.), (.6, 0., -.5), (.6, 0., .5)))


class OutputError(RuntimeError):
    pass


@dataclass(frozen=True)
class Limits:
    vx: tuple = (0., .6)
    vy: tuple = (0., 0.)
    wz: tuple = (-.5, .5)

    def __post_init__(self):
        for bounds, maximum in zip((self.vx, self.vy, self.wz), ((0., .6), (0., 0.), (-.5, .5))):
            if (not isinstance(bounds, tuple) or len(bounds) != 2 or
                    not all(type(x) in (int, float) and math.isfinite(x) for x in bounds) or
                    not maximum[0] <= bounds[0] <= 0 <= bounds[1] <= maximum[1]):
                raise ValueError('limits may only narrow current real-robot range')

    def project(self, velocity):
        if (not isinstance(velocity, (list, tuple)) or len(velocity) != 3 or
                not all(type(x) in (int, float) and math.isfinite(x) for x in velocity)):
            raise ValueError('finite body-frame vx, vy, wz required')
        value = tuple(float(min(hi, max(lo, x))) for x, (lo, hi)
                      in zip(velocity, (self.vx, self.vy, self.wz)))
        if value not in ALLOWED:
            raise ValueError('command is outside reviewed real-robot alphabet')
        return value


class Go2Sink:
    """Constructor and apply are I/O-free; start_threads is explicit.

    start_threads() must run before live input: it runs independent output and
    emergency/watchdog workers, waking the latter on STOP without waiting for a
    deadline. Manual drain/check_watchdog calls are for offline tests.
    STOP/expiry discard pending
    nonzero commands. Fresh telemetry evidence plus authorized unlock plus NEW
    neutral are required before nonzero; periodic apply alone cannot unlock.
    """
    def __init__(self, client, emergency_client, *, limits=None, now=time.monotonic):
        if client is emergency_client:
            raise ValueError('separate normal/emergency SDK objects required')
        self.client, self.emergency_client = client, emergency_client
        self.limits, self.now = limits or Limits(), now
        self._lock = threading.RLock()
        self._output = threading.RLock()
        self._emergency = threading.Lock()
        self._closed = threading.Event()
        self._stop_requested = threading.Event()
        self._threads = []
        self.pending = ZERO
        self.latched = True
        self.generation = 0
        self.source = None
        self.error = None
        self._last_apply = now()
        self._last_drain = now()
        self._confirmed_generation = None
        self._neutral_required = True
        self._urgent = True
        self._tripped = False
        self._feedback_seq = -1
        self._feedback_received = float("-inf")

    def select_source(self, source):
        if source not in ('phone', 'nav2'):
            raise ValueError('known source required')
        with self._lock:
            if self.source != source:
                self._hold()
                self.source = source

    def _hold(self):
        self.pending = ZERO
        self.latched = True
        self.generation += 1
        self._confirmed_generation = None
        self._neutral_required = True
        self._urgent = True

    def apply(self, command, *, source):
        with self._lock:
            if self._closed.is_set() or self.error is not None:
                raise OutputError('adapter closed or failed')
            # STOP dominates every source; source arbitration is not an auth gate.
            if command.kind == 'stop':
                self._hold()
                self._stop_requested.set()
                return
            # Check OLD clocks before any input can refresh them. Otherwise a
            # delayed apply -> drain -> watchdog sequence erases the outage.
            stamp = self.now()
            if not self.latched and (stamp-self._last_apply >= DEADLINE_S or
                                     stamp-self._last_drain >= DEADLINE_S):
                self._hold()
                self._stop_requested.set()
            if source != self.source or self.source is None:
                self._hold()
                raise ValueError('not the selected command source')
            if command.kind == 'unlock':
                if (self._confirmed_generation == self.generation and
                        0 <= self.now()-self._feedback_received <= FEEDBACK_MAX_AGE_S):
                    self.latched = False
                    self._neutral_required = True
                return
            if command.kind != 'apply':
                self._hold()
                raise ValueError('unsupported motion kind')
            try:
                velocity = self.limits.project(command.velocity)
            except ValueError:
                self._hold()
                raise
            self._last_apply = stamp
            # Expiry cannot be undone by continuing input; only explicit unlock.
            self.pending = ZERO if self.latched or self._neutral_required else velocity
            if not self.latched and self._neutral_required and velocity == ZERO:
                self._neutral_required = False

    def confirm_stopped(self, *, generation, sequence, received_at, stationary):
        """Integration-only observed telemetry, NEVER an SDK return-code shortcut.

        Caller must validate sensor source, robot identity and stationary evidence.
        Deliberately cannot manufacture Core stop_requested/stop_ref feedback.
        """
        with self._lock:
            if (type(generation) is not int or generation != self.generation or
                    type(sequence) is not int or sequence <= self._feedback_seq or
                    type(received_at) not in (int, float) or not math.isfinite(received_at) or
                    not 0 <= self.now()-received_at <= FEEDBACK_MAX_AGE_S or stationary is not True):
                return False
            self._feedback_seq = sequence
            self._confirmed_generation = generation
            self._feedback_received = received_at
            return True

    def _call(self, client, method, *args):
        code = getattr(client, method)(*args)
        if type(code) is not int or code != 0:
            raise OutputError('SDK command submission failed')

    def _stop_output(self, client):
        first = None
        for method, args in [('Move', ZERO), ('StopMove', ())]:
            try:
                self._call(client, method, *args)
            except BaseException as error:
                first = first or error
        if first is not None:
            raise first

    def _fail(self, error):
        with self._lock:
            self.error = self.error or error
            self._hold()

    def drain(self):
        """Normal output worker only. Never hold the memory lock across SDK I/O."""
        with self._output:
            with self._lock:
                if self._closed.is_set():
                    return
                if not self.latched and self.now()-self._last_apply >= DEADLINE_S:
                    self._hold()
                generation, urgent = self.generation, self._urgent
                velocity = ZERO if self.latched else self.pending
                self._urgent = False
            try:
                if urgent:
                    self._stop_output(self.client)
                else:
                    self._call(self.client, 'Move', *velocity)
                # An in-flight SDK call cannot be cancelled. Compensate on its
                # own lane immediately after return if STOP/close raced it.
                with self._lock:
                    self._last_drain = self.now()
                    changed = generation != self.generation or self._closed.is_set()
                    if changed:
                        self._urgent = True
                if changed:
                    self._stop_output(self.client)
            except BaseException as error:
                self._fail(error)
                self.emergency_stop()
                raise OutputError('normal SDK output failed') from error

    def emergency_stop(self):
        # Independent lane: a blocked normal RPC must not own this lock.
        if not self._emergency.acquire(blocking=False):
            return
        try:
            with self._lock:
                self._hold()
            try:
                self._stop_output(self.emergency_client)
            except BaseException as error:
                self._fail(error)
                raise OutputError('emergency SDK output failed') from error
        finally:
            self._emergency.release()

    def check_watchdog(self):
        with self._lock:
            requested = self._stop_requested.is_set()
            self._stop_requested.clear()
            expired = (self.now()-self._last_apply >= DEADLINE_S or
                       self.now()-self._last_drain >= DEADLINE_S)
            if not requested and not expired:
                self._tripped = False
                return False
            if not requested and self._tripped:
                return False
            self._tripped = expired
            self._hold()
        self.emergency_stop()
        return True

    def start_threads(self):
        with self._lock:
            if self._threads or self._closed.is_set():
                raise RuntimeError('output workers cannot be restarted')
            def worker(action, wake):
                while not self._closed.is_set():
                    try:
                        action()
                    except BaseException as error:
                        self._fail(error)
                        return
                    wake.wait(.02)
            self._threads = [threading.Thread(target=worker, args=(fn, wake), daemon=True)
                             for fn, wake in ((self.drain, self._closed),
                                              (self.check_watchdog, self._stop_requested))]
            for thread in self._threads:
                thread.start()

    def close(self):
        self._closed.set()
        self._stop_requested.set()
        self.emergency_stop()
        for thread in self._threads:
            thread.join(timeout=.25)
        if any(t.is_alive() for t in self._threads):
            self._fail(OutputError('SDK worker did not stop; process isolation required'))
            raise OutputError('SDK worker did not stop')
