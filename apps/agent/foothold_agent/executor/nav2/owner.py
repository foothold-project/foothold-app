"""Serialized owner: public Session inputs -> one sink -> action cancellation."""
from copy import deepcopy
import time

from foothold_agent.link.session import MotionCommand
from foothold_agent.safety.core import Z, clean_state
from .intent import number


class Owner:
    def __init__(self, session, sink, executor, *, now=time.monotonic, state_age_s=.2, guard=None):
        self.session, self.sink, self.executor = session, sink, executor
        self.now, self.state_age_s = now, state_age_s
        self.guard = guard
        self._stopping = False
        self._stamp = None
        self._progress = self._receipt = float('-inf')
        self.state = None
        self.journal = []  # drained by runner each tick, no media payloads

    def _apply(self, effects):
        # Every output path (including bridge feedback) obeys the ONE original
        # receive deadline. Session/Core poll-time clocks cannot extend it.
        if not self._stopping and self.executor.source_expired():
            return self.stop('INTENT_SOURCE_EXPIRED')
        try:
            for command in effects.motion:
                self.sink.apply(command)
                self.journal.append({'event': 'sink_apply', 'monotonic_s': self.now(),
                                     'kind': command.kind, 'velocity': command.velocity})
        except BaseException as exc:
            for fallback in (MotionCommand('stop'), MotionCommand(velocity=Z)):
                try:
                    self.sink.apply(fallback)
                except BaseException as output_error:
                    if hasattr(exc, 'add_note'):
                        exc.add_note('fallback output error: '+repr(output_error))
            self.executor.revoke('OUTPUT_FAILURE')
            raise
        for message in effects.messages:
            self.journal.append({'event': 'session_effect', 'monotonic_s': self.now(), 'message': message})
        self._cancel_if_invalid()
        return effects

    def _cancel_if_invalid(self):
        b, s = self.executor.binding, self.session
        if b is not None and (s.core.latch or s.core.stop_gen != b.stop_gen
                or s.holder_run_id != b.run_id or not s.lease_confirmed
                or not s.run or s.run['run_id'] != b.run_id or s.run['status'] != 'RUNNING'):
            self.sink.apply(MotionCommand(velocity=Z))
            self.executor.revoke('AUTHORITY_OR_STOP_CHANGED')

    def receive(self, frame):
        return self._apply(self.session.receive(frame))

    def on_state(self, raw, *, received_at=None, progress_at=None):
        received_at = self.now() if received_at is None else received_at
        progress_at = received_at if progress_at is None else progress_at
        if (not number(received_at) or not number(progress_at)
                or not 0 <= self.now()-received_at <= self.state_age_s
                or not 0 <= self.now()-progress_at <= self.state_age_s):
            if self.executor.binding is not None:
                self.stop('POLICY_MAILBOX_STALE')
            return self._apply(self.session.tick())
        try:
            clean = clean_state(raw)
        except (OverflowError, ValueError, TypeError):
            clean = None
        if clean is not None and number(clean.get('sim_t')):
            stamp = (clean['episode'], clean['sim_t'])
            if self._stamp is None or (stamp[0] == self._stamp[0] and stamp[1] > self._stamp[1]):
                self._stamp, self._progress = stamp, progress_at
            elif stamp[0] != self._stamp[0] or stamp[1] < self._stamp[1]:
                if self.executor.binding is not None:
                    self.stop('EPISODE_OR_CLOCK_REWIND')
            self.state, self._receipt = clean, received_at
        elif self.executor.binding is not None:
            self.stop('INVALID_POLICY_STATE')
        return self._apply(self.session.on_robot_state(raw))

    def ready(self):
        s, b = self.state, self.executor.binding
        return (s is not None and 0 <= self.now()-self._receipt <= self.state_age_s
                and 0 <= self.now()-self._progress <= self.state_age_s
                and s['policy_running'] and not s['reset_in_progress']
                and not s['stop_requested'] and s.get('fallen') is False
                and s.get('plugin_mode') == 'LOCKSTEP'
                and (b is None or s['episode'] == b.episode))

    def tick(self):
        self._apply(self.session.tick())  # expiry BEFORE accepting a late intent
        if self.executor.binding is not None and not self.ready():
            self.stop('POLICY_OR_CLOCK_STALE')
            return
        axes = self.executor.poll(deepcopy(self.session.run))
        if axes is not None:
            self.journal.append({'event': 'executor_intent', 'monotonic_s': self.now(),
                                 'received_monotonic_s': self.executor._last_receipt,
                                 'input_si': self.executor.last_velocity, 'axes': axes, 'reason': self.executor.reason})
        if self.executor.rejected:
            self.stop('UNSUPPORTED_COMMAND')
            return
        if axes is not None and self.session.run is not None:
            if self.guard is not None:
                allowed, reason = self.guard()
                if allowed is False:
                    self.stop(reason)
                    return
                if allowed is None:
                    axes = Z  # fresh producer, bounded proof pending; never replay intent
            self._apply(self.session.executor_command(self.session.run['run_id'], axes))

    def stop(self, reason='STOP'):
        self.journal.append({'event': 'stop_trigger', 'reason': reason, 'monotonic_s': self.now()})
        self._stopping = True
        try:
            # Public local shutdown is a fail-closed local stop. It changes no
            # server liveness and deliberately requires a new explicit session
            # handshake; a future reusable local-stop API belongs to link/**.
            effects = self._apply(self.session.shutdown())
            self.sink.apply(MotionCommand('stop'))
            self.sink.apply(MotionCommand(velocity=Z))
            self.executor.revoke(reason)
            return effects
        finally:
            self._stopping = False

    def close(self):
        try:
            self._apply(self.session.shutdown())
        finally:
            self.executor.revoke('FIXTURE_CLOSED')
