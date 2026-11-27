"""Offline-tested, nonblocking single-source SI output with independent watchdog.

Not a deployed motion service. SDK return=0 means request submission/response,
never physical stopping. No fabricated Core feedback is emitted by this module.
"""

import math
import logging
import sys
import threading
import time
from foothold_agent.safety.core import MAX_TURN_RATE
from foothold_agent.safety.lock_log import LockLog
from dataclasses import dataclass
from collections import deque
from datetime import datetime, timezone
from statistics import median

ZERO = (0., 0., 0.)
DEADLINE_S = .30
FEEDBACK_MAX_AGE_S = .20
STOP_RETRY_S = .20
QUIET_STOP_MAX_S = 1.0  # receipt-to-dispatch bound; an already running SDK RPC cannot be cancelled
SERVER_RAMP_S = 2.0
SERVER_BRAKE_S = .30
SERVER_AXIS_MAX = (1.5, 1., MAX_TURN_RATE)
SERVER_SLEW = tuple(speed / SERVER_RAMP_S for speed in SERVER_AXIS_MAX)
SERVER_BRAKE = tuple(speed / SERVER_BRAKE_S for speed in SERVER_AXIS_MAX)
PHONE_FORWARD_STEPS = frozenset(step / 10 for step in range(3, 16))
SERVER_ALLOWED = frozenset({ZERO, (1.5, 0., 0.), (-1.5, 0., 0.), (0., 1., 0.), (0., -1., 0.)}
                    | {(vx, 0., wz) for vx in (0., 1.5)
                       for wz in (-MAX_TURN_RATE, -.5, .5, MAX_TURN_RATE)})


def _slew_axis(current, target, elapsed, acceleration, braking):
    if current * target < 0:
        # Brake to zero first. Only the time left in this tick can accelerate.
        stop_time = abs(current) / braking
        if elapsed < stop_time:
            return current - math.copysign(braking * elapsed, current)
        elapsed -= stop_time
        current = 0.
    rate = braking if abs(target) < abs(current) else acceleration
    step = rate * elapsed
    if abs(target - current) <= step:
        return target
    return current + math.copysign(step, target - current)


def server_velocity(value):
    if (not isinstance(value, (list, tuple)) or len(value) != 3 or
            not all(type(x) in (int, float) and math.isfinite(x) for x in value) or
            tuple(value) not in SERVER_ALLOWED):
        raise ValueError('outside exact server-drive SI alphabet')
    return tuple(value)


def start_active():
    """START 실행기가 저수준으로 로봇을 쥐고 있으면 참 (실행기가 /tmp/foothold-start-active 를 만든다).
    그동안 이 프로그램은 순정 걷기 · 동작을 보내지 않는다: 조종 권한은 한 번에 하나 (팀장 11/25 20:50)."""
    from ..policy.trace import START_FLAG
    return START_FLAG.exists()


class OutputError(RuntimeError):
    pass


@dataclass(frozen=True)
class Limits:
    vx: tuple = (0., 1.5)
    vy: tuple = (0., 0.)
    wz: tuple = (-MAX_TURN_RATE, MAX_TURN_RATE)

    def __post_init__(self):
        for bounds, maximum in zip((self.vx, self.vy, self.wz), (Limits.vx, Limits.vy, Limits.wz)):
            if (not isinstance(bounds, tuple) or len(bounds) != 2 or
                    not all(type(x) in (int, float) and math.isfinite(x) for x in bounds) or
                    not maximum[0] <= bounds[0] <= 0 <= bounds[1] <= maximum[1]):
                raise ValueError('limits may only narrow current real-robot range')

    def project(self, velocity):
        if (not isinstance(velocity, (list, tuple)) or len(velocity) != 3 or
                not all(type(x) in (int, float) and math.isfinite(x) for x in velocity)):
            raise ValueError('finite body-frame vx, vy, wz required')
        if abs(velocity[2]) > MAX_TURN_RATE:
            raise ValueError('phone turn exceeds physical limit')
        value = tuple(float(min(hi, max(lo, x))) for x, (lo, hi)
                      in zip(velocity, (self.vx, self.vy, self.wz)))
        if value != ZERO and value[0] not in PHONE_FORWARD_STEPS:
            raise ValueError('command is outside reviewed real-robot alphabet')
        return value


class Go2Sink:
    """Constructor and apply are I/O-free; start_threads is explicit.

    start_threads() must run before live input: it runs independent output and
    emergency/watchdog workers, waking the latter on STOP without waiting for a
    deadline. Manual execution requires explicit offline_test_mode=True and fake
    clients; that mode cannot start live workers.
    STOP/expiry discard pending
    nonzero commands. Fresh telemetry evidence plus authorized unlock plus NEW
    neutral are required before nonzero; periodic apply alone cannot unlock.
    """
    def __init__(self, client, emergency_client, *, limits=None, now=time.monotonic,
                 offline_test_mode=False, phone_watchdog=False):
        if type(offline_test_mode) is not bool:
            raise ValueError('offline_test_mode must be an explicit boolean')
        if client is emergency_client:
            raise ValueError('separate normal/emergency SDK objects required')
        self.client, self.emergency_client = client, emergency_client
        self._offline_test_mode = offline_test_mode
        if type(phone_watchdog) is not bool:
            raise ValueError('phone_watchdog must be a boolean')
        self._phone_watchdog = phone_watchdog
        self._source_received = None
        self.lock_evidence = {}
        self.limits, self.now = limits or Limits(), now
        self.lock_log = LockLog(now)
        self._lock = threading.RLock()
        self._output = threading.RLock()
        self._emergency = threading.Lock()
        self._closed = threading.Event()
        self._stop_requested = threading.Event()
        self._emergency_force_pending = False
        self._threads = []
        self.pending = ZERO
        self._ramp_velocity = ZERO
        self._ramp_at = (self.now(),) * 3
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
        self._stall_sequence = 0
        self.posture_feedback = None
        # Without a sequence provider, no posture can prove it postdates motion.
        self.latest_sport_sequence = lambda: math.inf
        self.posture_authorized = lambda lease: False
        self._posture = None
        self._posture_stop_only = False
        self.posture_result = None
        self.stop_feedback = None
        self.stop_feedback_reason = lambda: '만료'
        self._hold_reason = None
        self.remote = None
        self._last_remote_activity = float('-inf')
        self._wait_operator_neutral = False
        self._operator_stop = False
        self._ordinary_hold = True
        self._app_control = None  # None preserves standalone adapter behavior
        self._release_until = None
        self._release_sent = set()
        self._release_inflight = set()
        self._release_last = {}
        # Each independent lane owns its own RPC history, never the other lock.
        self._stop_attempts = {}
        self._resting_lanes = set()
        self._resting_stop_state = None
        self._held_stop_generation = None
        self._motion_inflight = False
        self._last_motion_sequence = -1
        self._stop_diagnostics = {}
        self._rpc_samples = deque(maxlen=20)
        self._stop_timeouts = deque(maxlen=256)
        self._last_timeout_at = None
        from .actions import Actions
        from .runner_link import RunnerLink
        # START 실행기 앱 입력 길 (FH_START_MOVE_PORT 없으면 None · APP-MOVES.md)
        self.runner = RunnerLink.configured(now=now)
        self.actions = Actions(self)
        from .gait import Gait
        self.gait = Gait(self)   # 걷기 모드 (gait.py) · 결과는 gait_result

    def automatic_stop_allowed(self, session):
        """Owning-loop lease observation; workers only read the memory snapshot."""
        active = bool(session.connected and session.lease_confirmed and session.lease_id
                      and not session.link_lost and not session.reconnect_required)
        with self._lock:
            previous = self._app_control
            self._app_control = active
            if active != previous:
                self._release_until = None
                if not active and previous is True:
                    self._hold()
                    self._release_until = self.now()+QUIET_STOP_MAX_S
                    self._release_sent.clear()
                    self._release_last.clear()
                    self._stop_requested.set()
                logging.getLogger(__name__).warning('GO2_QUIET %s', '조용히 끝' if active else '조용히 시작')
            return session.operator_stop or (active and not self._remote_active())

    def _remote_active(self):
        # Caller owns the memory lock. A takeover invalidates even commands
        # queued before the worker observed the handset or finished an RPC.
        if self.remote is None:
            return False
        active, last_activity = self.remote.snapshot()
        if last_activity > self._last_remote_activity:
            self._last_remote_activity = last_activity
            self.pending = self._ramp_velocity = ZERO
            self._ramp_at = (self.now(),) * 3
            self._source_received = None
            self.lock_evidence['watchdog_input'] = None
            self._wait_operator_neutral = self._neutral_required = True
        return active is True

    def movement_reason(self, *, neutral=False):
        with self._lock:
            active = self._remote_active()
            if self._operator_stop:
                return '비상정지가 걸려 있습니다'
            if start_active():
                if self.runner is None:
                    return 'START 저수준 제어 중이라 화면 조종 · 순정 동작은 멈춰 있습니다 (리모컨 L2+A 앉기 · start+좌/우 로 순정 넘김)'
                if self.runner.status() is None:
                    return 'START 실행기 응답이 없어 화면 조종은 멈춰 있습니다 (리모컨으로 조종하세요)'
            if active:
                if self.remote.state_active():
                    return '리모컨 동작 중이라 화면 조종은 멈춰 있습니다'
                return '리모컨으로 조종 중이라 화면 조종은 멈춰 있습니다'
            if self._wait_operator_neutral:
                if not neutral or self.latched:
                    return '조종 막대에서 손을 한 번 뗀 뒤 다시 조종해 주세요'
                self._wait_operator_neutral = False
            return None

    def movement_trial_blocked(self, action):
        from .actions import EXECUTION_MAX_S
        if action == 'RiseSit':
            with self._lock:
                sample = self._posture_sample()
                # A settled remote state is not a live handset command. Keep
                # actual handset activity and explicit emergency STOP priority.
                if (sample.get('sitting_settled', False) and sample['still']
                        and not self._operator_stop and not start_active()
                        and (self.remote is None or self.remote.snapshot(include_state=False)[0] is not True)):
                    return False
        moves = isinstance(action, str) and (action in EXECUTION_MAX_S or
                                              action in ('StopMove', 'StandDown', 'StandUp'))
        return moves and bool(self.movement_reason())

    def _posture_sample(self):
        return (self.posture_feedback() if self.posture_feedback is not None
                else dict(state='UNKNOWN', mode=None, still=False))

    def _walkable(self, sample=None):
        # Legacy sinks without measured posture keep their existing fail-closed
        # SDK return handling; server sinks always install the measured provider.
        return self.posture_feedback is None or (sample or self._posture_sample()).get('walkable', False)

    @staticmethod
    def _standing(sample):
        return sample['state'] == 'STANDING' or sample.get('standing_locked', False)

    @classmethod
    def _posture_start_allowed(cls, sample, action):
        if action == 'stand_up':
            return sample['state'] == 'LYING' or sample.get('standing_locked', False)
        return action == 'stand_down' and cls._standing(sample)

    @property
    def gait_result(self):
        with self._lock:
            return self.gait.refresh()

    @property
    def posture_busy(self):
        with self._lock:
            return self._posture is not None or self.actions.busy

    def request_posture(self, request_id, action, lease):
        """Queue one reviewed action; SDK I/O stays on the normal output worker."""
        with self._lock:
            if start_active():
                # START 중 엎드리기는 실행기 L2+A 로 (동작표 「저수준」 켬). 일어서기는 실행기에 없어 회색.
                status, code = (self.actions.runner(request_id, 'StandDown', lease, False) if action == 'stand_down'
                                else ('REJECTED', 'LOWLEVEL_UNSUPPORTED'))
                self.posture_result = dict(request_id=request_id, action=action, status=status, code=code, sdk_code=None)
                return False
            sample = self._posture_sample()
            reason = ('BUSY' if self._posture is not None or self.actions.busy else
                'NOT_AUTHORIZED' if not self.posture_authorized(lease) else
                'MOVING' if self.pending != ZERO or self._ramp_velocity != ZERO or not sample['still'] else
                'WRONG_POSTURE' if not self._posture_start_allowed(sample, action) else None)
            if reason is not None:
                self.posture_result = dict(request_id=request_id, action=action,
                    status='REJECTED', code=reason, sdk_code=None)
                return False
            self._hold()
            self._posture_stop_only = True
            self._posture = dict(request_id=request_id, action=action, lease=lease,
                stage='start', deadline=self.now()+15.)
            self.posture_result = dict(request_id=request_id, action=action,
                status='RUNNING', code='STARTED', sdk_code=None)
            return True

    def cancel_posture(self, reason='STOPPED'):
        with self._lock:
            self.actions.cancel(reason)
            if self._posture is not None:
                self._posture_finish('FAILED', reason, None)

    def _posture_finish(self, status, code, sdk_code):
        job, self._posture = self._posture, None
        self.posture_result = dict(request_id=job['request_id'], action=job['action'],
            status=status, code=code, sdk_code=sdk_code)
        if status == 'FAILED':
            self._urgent = True
            self._stop_requested.set()

    def _posture_step(self):
        # Only the normal worker calls this; STOP uses the independent lane.
        notice = None
        with self._lock:
            job = self._posture
            if job is None:
                return
            if not self.posture_authorized(job['lease']) or self._closed.is_set():
                self._posture_finish('FAILED', 'AUTHORITY_LOST', None)
                return
            sample = self._posture_sample()
            if self.now() >= job['deadline']:
                self._posture_finish('FAILED', 'TIMEOUT', None)
                return
            if sample['state'] == 'UNKNOWN' and not sample.get('standing_locked', False):
                return  # a brief DDS gap/unknown mode cannot strand a joint lock
            method = None
            if job['stage'] == 'start':
                expected = self._posture_start_allowed(sample, job['action'])
                if not expected or not sample['still']:
                    self._posture_finish('FAILED', 'POSTURE_CHANGED', None)
                    return
                if job['action'] == 'stand_up':
                    method = 'BalanceStand' if sample.get('standing_locked', False) else 'StandUp'
                else:
                    method = 'StandDown'
            elif (job['stage'] == 'stand' and self._standing(sample) and sample['still']
                    and sample['sequence'] > job['sequence']):
                method = 'BalanceStand'
            elif job['stage'] == 'confirm':
                target = 'STANDING' if job['action'] == 'stand_up' else 'LYING'
                if sample['sequence'] > job['sequence'] and sample['state'] == target and sample['still']:
                    if target == 'LYING' or (sample['mode'] in (1, 3) and self._walkable(sample)):
                        self._posture_finish('SUCCEEDED', 'CONFIRMED', 0)
                    elif sample['mode'] in (1, 3):
                        notice = (sample['mode'], sample['motion_state'], sample['height'])
                        self._posture_finish('FAILED', 'STOOD_NOT_WALKABLE', 0)
                if notice is None:
                    return
            if method is None and notice is None:
                return
        if notice is not None:
            # No journal I/O while holding the memory lock used by STOP.
            logging.getLogger(__name__).warning(
                'GO2_POSTURE_STOOD_NOT_WALKABLE mode=%d motion_state=%d height_m=%.2f', *notice)
            return
        # Recheck after every RPC. A concurrent STOP prevents later stages.
        if method == 'StandDown':
            try:
                code = self._call(self.client, 'StopMove')
                if code == 3104:
                    with self._lock:
                        if self._posture is job:
                            self._posture_finish('REJECTED', 'ROBOT_SLOW', 3104)
                    return
            except Exception as error:
                with self._lock:
                    if self._posture is job:
                        self._posture_finish('FAILED', 'SDK_REJECTED', getattr(error, 'sdk_code', None))
                raise  # standing stop rejection remains a fatal output fault
        try:
            rpc = getattr(self.client, method)
            with self._lock:
                if self._posture is not job or not self.posture_authorized(job['lease']):
                    return
                if method == 'StandDown':
                    current = self._posture_sample()
                    if current['state'] == 'UNKNOWN' and not current.get('standing_locked', False):
                        return  # wait, then recheck StopMove before any StandDown
                    if not self._standing(current) or not current['still']:
                        self._posture_finish('FAILED', 'POSTURE_CHANGED', None)
                        return
                self._motion_inflight = True
            started = time.monotonic()
            code = None
            try:
                code = rpc()
            finally:
                self._motion_returned()
                self._rpc_diagnostic(method, time.monotonic()-started, code)
        except Exception:
            code = None
        with self._lock:
            if self._posture is not job:
                return
            if type(code) is not int or code != 0:
                self._posture_finish('FAILED', 'SDK_REJECTED', code if type(code) is int else None)
                return
            job['stage'] = 'stand' if method == 'StandUp' else 'confirm'
            job['sequence'] = self._posture_sample().get('sequence', -1)

    def output_safety(self):
        """Atomic observation for the ONE phone Session; never mutate its Core."""
        with self._lock:
            held = (self.latched and not (
                self._confirmed_generation == self.generation and
                0 <= self.now()-self._feedback_received <= FEEDBACK_MAX_AGE_S))
            return self._stall_sequence, held

    def feedback_context(self):
        with self._lock:
            return self.generation, self.latched

    def _stall(self, emit):
        if not self.latched:
            stamp = self.now()
            cause = ('output_apply_stalled' if stamp-self._last_apply >= DEADLINE_S else
                     'output_drain_stalled' if stamp-self._last_drain >= DEADLINE_S else 'output_input_stale')
            emit('stop', cause)
            emit('lock', cause)
            self._stall_sequence += 1
        self._hold(preserve=True)

    def select_source(self, source):
        if source not in ('phone', 'nav2', 'server'):
            raise ValueError('known source required')
        with self.lock_log.after_unlock() as emit, self._lock:
            if self.source != source:
                emit("stop", "output_source_changed")
                emit("lock", "output_source_changed")
                self._hold()
                self.source = source
                self.lock_evidence['server_source'] = source == 'server'

    def _hold(self, *, reason=None, preserve=False):
        repeated = self.latched and (preserve or (reason is not None and reason == self._hold_reason))
        self.pending = ZERO
        self._ramp_velocity = ZERO
        self._ramp_at = (self.now(),) * 3
        self.latched = True
        if repeated:
            return
        self._hold_reason = reason
        self.generation += 1
        self._confirmed_generation = None
        self._neutral_required = True
        self._urgent = True
        self._source_received = None
        self.lock_evidence['watchdog_input'] = None

    def _expired(self, stamp):
        if self._app_control is False and not self._operator_stop:
            return False
        if ((self._remote_active() or self._wait_operator_neutral) and not self._operator_stop
                and not self.actions.busy and self._posture is None):
            # No lower-priority stream owns movement or needs a deadman STOP.
            return False
        return (stamp-self._last_apply >= DEADLINE_S or
                stamp-self._last_drain >= DEADLINE_S or
                (self._phone_watchdog and self._source_received is not None and
                 stamp-self._source_received >= DEADLINE_S))

    def _require_workers(self, emit):
        # Call under the memory lock. start_threads starts BOTH workers while
        # holding that lock, so neither may output before the pair is ready.
        if not self._offline_test_mode and (len(self._threads) != 2 or
                                           not all(t.is_alive() for t in self._threads)):
            emit('stop', 'output_workers_unready')
            emit('lock', 'output_workers_unready')
            self._hold()
            self._stop_requested.set()
            raise OutputError('both live workers must be ready before input/output')

    def apply(self, command, *, source, input_received_at=None, operator_stop=None):
        with self.lock_log.after_unlock() as emit, self._lock:
            if self._closed.is_set() or self.error is not None:
                raise OutputError('adapter closed or failed')
            # STOP dominates every source; source arbitration is not an auth gate.
            if command.kind == 'stop':
                if operator_stop:
                    self._operator_stop = True
                    self._wait_operator_neutral = True
                if self._app_control is False and not self._operator_stop:
                    return  # a release window is created only by a lease falling edge
                # Unclassified adapter calls retain their conservative STOP output.
                self._ordinary_hold = operator_stop is False
                action_hold = self.actions.stop(getattr(command, 'stop_generation', None), source=source)
                # Core can publish the same held STOP on every tick/sample.
                # Only a new hold invalidates sensor evidence; Core's own STOP
                # generation/CAS and authority checks remain untouched.
                stop_generation = getattr(command, 'stop_generation', None)
                reason = (('stop', source, stop_generation)
                          if type(stop_generation) is int else None)
                self._hold(reason=reason, preserve=action_hold)
                if action_hold:
                    self._hold_reason = reason
                self._stop_requested.set()
                return
            self._require_workers(emit)
            # Check OLD clocks before any input can refresh them. Otherwise a
            # delayed apply -> drain -> watchdog sequence erases the outage.
            stamp = self.now()
            if (not self.latched or self.actions.executing is not None) and self._expired(stamp):
                self.actions.cancel('WATCHDOG')
                self._stall(emit)
                self._stop_requested.set()
            if source != self.source or self.source is None:
                emit('stop', 'output_source_invalid')
                emit('lock', 'output_source_invalid')
                self._hold()
                raise ValueError('not the selected command source')
            if command.kind == 'unlock':
                if self._posture is not None or self.actions.busy:
                    return
                if (self._confirmed_generation == self.generation and
                        0 <= self.now()-self._feedback_received <= FEEDBACK_MAX_AGE_S):
                    self._operator_stop = False
                    self.latched = False
                    self._posture_stop_only = False
                    self._neutral_required = True
                return
            if command.kind != 'apply':
                emit('stop', 'output_command_invalid')
                emit('lock', 'output_command_invalid')
                self._hold()
                raise ValueError('unsupported motion kind')
            try:
                if source == 'server':
                    velocity = server_velocity(command.velocity)
                    if not self.limits.wz[0] <= velocity[2] <= self.limits.wz[1]:
                        raise ValueError('server turn exceeds local limit')
                else:
                    velocity = self.limits.project(command.velocity)
            except ValueError:
                emit("stop", "output_velocity_invalid")
                emit("lock", "output_velocity_invalid")
                self._hold()
                self._stop_requested.set()
                raise
            self._last_apply = stamp
            self.lock_log.healthy(stamp)
            if self._remote_active() or self._wait_operator_neutral:
                return  # discard, including zero: a periodic apply cannot re-arm
            if self._phone_watchdog and not self.latched:
                fresh_input = (type(input_received_at) in (int, float) and math.isfinite(input_received_at)
                               and 0 <= stamp-input_received_at < DEADLINE_S)
                # Keep the original packet time even if this very packet is
                # rejected or _hold clears the watchdog clock.
                self.lock_evidence['output_input'] = (input_received_at
                    if type(input_received_at) in (int, float) and math.isfinite(input_received_at) else None)
                if velocity != ZERO and not fresh_input:
                    self._stall(emit)
                    self._stop_requested.set()
                    if (type(input_received_at) in (int, float) and math.isfinite(input_received_at)
                            and input_received_at <= stamp):
                        return  # ordinary input deadline: hold/STOP, keep the service alive
                    raise ValueError('nonzero requires original fresh phone input time')
                if (fresh_input
                        and (self._source_received is None or input_received_at > self._source_received)):
                    self._source_received = input_received_at
                    self.lock_evidence['watchdog_input'] = input_received_at
            # Expiry cannot be undone by continuing input; only explicit unlock.
            posture_held = not self._walkable()
            if posture_held and velocity != ZERO:
                emit("stop", "output_posture_hold")
            target = ZERO if self.latched or self._neutral_required or self._posture is not None or self.actions.busy or posture_held else velocity
            if source == 'server' and target != self.pending:
                # Do not spend preceding idle time on a newly received target.
                self._ramp_at = tuple(stamp if new != old else previous
                                      for new, old, previous in zip(target, self.pending, self._ramp_at))
            elif source == 'phone' and target[2] and self.pending[2] == self._ramp_velocity[2] == 0:
                # Start at first deflection. Later analog samples can change
                # the target on every tick without restarting the slew clock.
                self._ramp_at = (*self._ramp_at[:2], stamp)
            self.pending = target
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

    def _measured_stop(self, generation):
        # Read the current cache, not a sticky past confirmation: movement or
        # stale LowState must also reject a timeout after a previous still sample.
        provider = self.stop_feedback
        sample = provider() if provider is not None else None
        with self._lock:
            return (self.latched and generation == self.generation and sample is not None
                    and sample['generation'] == generation and sample['stationary'] is True
                    and 0 <= self.now()-sample['received_at'] <= FEEDBACK_MAX_AGE_S)

    def _rpc_diagnostic(self, method, elapsed, code):
        with self._lock:
            stamp = self.now()
            timed_out = type(code) is int and code == 3104
            self._rpc_samples.append((stamp, elapsed*1000, timed_out))
            if method == 'StopMove' and timed_out:
                self._stop_timeouts.append(stamp)
                self._last_timeout_at = datetime.now(timezone.utc).isoformat()

    def response_health(self):
        """Display only; both workers share this bounded, lock-protected cache."""
        with self._lock:
            stamp = self.now()
            while self._stop_timeouts and stamp-self._stop_timeouts[0] >= 3.:
                self._stop_timeouts.popleft()
            recent = [row for row in self._rpc_samples if 0 <= stamp-row[0] < 3.]
            last = recent[-1] if recent else None
            return dict(slow=bool(self._stop_timeouts), timeout_count=len(self._stop_timeouts),
                last_timeout_at=self._last_timeout_at,
                last_ms=None if last is None else round(last[1], 3),
                last_timed_out=False if last is None else last[2],
                median_ms=None if not recent else round(median(max(100., row[1]) if row[2]
                    else row[1] for row in recent), 3),
                median_timed_out=bool(recent) and sum(row[2] for row in recent)*2 >= len(recent),
                sample_count=len(recent))

    def _stop_diagnostic(self, client, started, elapsed, code):
        lane = 'normal' if client is self.client else 'emergency'
        previous, failures = self._stop_diagnostics.get(lane, (None, 0))
        failures = failures + 1 if code != 0 else 0
        self._stop_diagnostics[lane] = (started, failures)
        logging.getLogger('foothold_agent.go2_direct.stop_rpc').warning(
            'GO2_STOP_RESULT lane=%s elapsed_ms=%.3f code=%s consecutive_failures=%d interval_ms=%.3f',
            lane, elapsed*1000, code, failures,
            -1. if previous is None else (started-previous)*1000)

    def _call(self, client, method, *args):
        started = time.monotonic()
        try:
            code = getattr(client, method)(*args)
        except BaseException as error:
            # SDK exception text (and arbitrary class names) can contain private
            # values. Keep the diagnostic vocabulary fixed and never print args.
            name = type(error).__name__
            name = name if name in {'TimeoutError', 'OSError', 'ConnectionError',
                'RuntimeError', 'ValueError', 'TypeError', 'AttributeError',
                'PermissionError', 'DDSException', 'KeyboardInterrupt', 'SystemExit'} else 'Exception'
            if method == 'StopMove':
                self._stop_diagnostic(client, started, time.monotonic()-started, name)
            print(f'SDK_OUTPUT_FAILED method={method} code={name}', file=sys.stderr)
            raise
        if method == 'StopMove':
            elapsed = time.monotonic()-started
            self._stop_diagnostic(client, started, elapsed,
                                  code if type(code) is int else 'InvalidReturnType')
            self._rpc_diagnostic(method, elapsed, code)
        if type(code) is not int or code != 0:
            timeout = method == 'StopMove' and type(code) is int and code == 3104
            # Non-walkable/unknown posture may reject stopping as an unsupported
            # operation. Client/transport error codes (3000+) stay fatal.
            # Keep transport/observations alive, never enable motion.
            sample = self._posture_sample()
            unsupported_stop = (type(code) is int and code < 3000 and not self._walkable(sample)
                                and (method == 'StopMove' or (method == 'Move' and args == ZERO)))
            if timeout or unsupported_stop:
                if self._operator_stop:
                    logging.getLogger(__name__).critical('GO2_EMERGENCY_OUTPUT_FAILED method=%s code=%d', method, code)
                return code  # no unlock or synthetic Core feedback
            value = str(code) if type(code) is int else 'InvalidReturnType'
            print(f'SDK_OUTPUT_FAILED method={method} code={value}', file=sys.stderr)
            error = OutputError('SDK command submission failed')
            error.sdk_code = code if type(code) is int else None
            raise error
        return code

    def _motion_returned(self):
        # Normal output is serialized. STOP on either lane needs newer posture
        # evidence than a sample captured before or during this motion RPC.
        with self._lock:
            self._last_motion_sequence = self.latest_sport_sequence()
            self._motion_inflight = False

    @staticmethod
    def _lying_or_sitting(sample):
        # Unitree Go2 SportModeState mode 10 is sit; mode 0 can be lying on Go2 X.
        return sample['state'] == 'LYING' or sample['mode'] == 10

    def _resting_for_stop(self, sample):
        return (sample['still'] and (sample['state'] == 'LYING' or sample.get('sitting_settled', False))
                and not self._motion_inflight
                and sample.get('sequence', -1) > self._last_motion_sequence)

    def _resting_stop_notice(self, sample):
        # Caller owns the memory lock. Share transitions across both lanes and
        # STOP generations; emit the returned notice only after releasing it.
        state = ('LYING' if sample['state'] == 'LYING' else 'SITTING') if self._resting_for_stop(sample) else None
        previous, self._resting_stop_state = self._resting_stop_state, state
        if state is not None and state != previous:
            return '엎드림이라 정지 명령 생략' if state == 'LYING' else '앉음이라 정지 명령 생략'
        return None

    def _standing_stop_ready(self, sample, measured):
        # The measured provider binds BOTH DDS topics to this robot and STOP
        # generation. Posture alone (or a successful RPC) cannot prove a hold.
        return (measured and self._standing(sample) and sample['still']
                and not self._motion_inflight
                and sample.get('sequence', -1) > self._last_motion_sequence)

    def _held_stop_notice(self, sample, generation, ready, force, held):
        # Caller owns the memory lock; both lanes share one transition record.
        previous = self._held_stop_generation
        reason = None
        if previous is not None:
            if previous != generation or force:
                reason = '새 STOP'
            elif not ready:
                if self._motion_inflight or (sample.get('sequence', -1) >= 0 and
                        sample['sequence'] <= self._last_motion_sequence):
                    reason = 'RPC 이후 표본 없음'
                elif sample.get('sequence', -1) >= 0 and not sample['still']:
                    reason = '움직임'
                else:
                    reason = self.stop_feedback_reason()
        if reason is not None:
            self._held_stop_generation = None
            return ('GO2_STOP_RESUMED', f'{reason} — 정지 명령 다시 보냄')
        if held and previous is None:
            self._held_stop_generation = generation
            return ('GO2_STOP_HELD', '정지 확인 — 정지 명령 반복 멈춤')
        return None

    def _movement_rpc(self, client, method, args, *, movement_epoch=None, release=False):
        motion = method == 'Move' and args != ZERO
        with self._lock:
            active = self._remote_active()
            activity_before = self._last_remote_activity
            emergency = self._operator_stop
            if release and not emergency and (self._app_control is not False or
                    self._release_until is None or self.now() >= self._release_until):
                return
            if not emergency and active and not release:
                return
            if not emergency and not release and self._app_control is False:
                return
            if movement_epoch is not None and (self.latched or self._closed.is_set()
                    or self._wait_operator_neutral or movement_epoch != (self.generation, activity_before)):
                return
            if motion:
                self._motion_inflight = True
        try:
            self._call(client, method, *args)
        except (OSError, RuntimeError) as error:
            # A dispatched RPC cannot be withdrawn. A rejection overlapping
            # observed handset activity must not tear down the DDS/WS session.
            with self._lock:
                overlap = self._remote_active() or self._last_remote_activity > activity_before
            if not (active or overlap) or isinstance(error, PermissionError):
                raise
            code = getattr(error, 'sdk_code', None)
            if isinstance(error, OutputError) and code is None:
                raise
            logger = logging.getLogger(__name__)
            if emergency:
                logger.critical('GO2_EMERGENCY_OUTPUT_FAILED method=%s code=%s', method, code)
            else:
                logger.warning('GO2_REMOTE_OUTPUT_REJECTED method=%s code=%s', method, code)
        finally:
            if motion:
                self._motion_returned()

    def _release_output(self, client):
        """One release STOP on each existing lane; retries share one deadline."""
        lane = 'normal' if client is self.client else 'emergency'
        with self._lock:
            if self._release_until is None or lane in self._release_inflight:
                return
            generation = self.generation
            sample = self._posture_sample()
            confirmed = (len(self._release_sent) == 2 and self._measured_stop(generation)
                         and not self._motion_inflight
                         and sample.get('sequence', -1) > self._last_motion_sequence)
            if confirmed or self.now() >= self._release_until:
                self._release_until = None  # sticky completion: #479 cannot restart it
                return
            if self.now()-self._release_last.get(lane, float('-inf')) < STOP_RETRY_S:
                return
            self._release_inflight.add(lane)
            self._release_last[lane] = self.now()
            self._release_sent.add(lane)
        try:
            stop_only = (self._lying_or_sitting(sample) or sample['state'] == 'TRANSITIONING'
                         or sample.get('standing_locked', False) or
                         (sample['state'] == 'STANDING' and not self._walkable(sample)))
            methods = [('StopMove', ())] if stop_only else [('Move', ZERO), ('StopMove', ())]
            for method, args in methods:
                try:
                    self._movement_rpc(client, method, args, release=True)
                except (OSError, RuntimeError) as error:
                    with self._lock:
                        if isinstance(error, PermissionError) or self._operator_stop:
                            raise
                    # A failed automatic release must not promote itself to an
                    # unbounded explicit emergency STOP. Retain the same window.
                    logging.getLogger(__name__).warning('GO2_RELEASE_OUTPUT_FAILED method=%s code=%s',
                        method, getattr(error, 'sdk_code', None))
        finally:
            with self._lock:
                self._release_inflight.discard(lane)

    def _start_route(self):
        """START 이고 실행기 길이 있으면 참: 순정 SDK 이동 · 정지 RPC 를 보내지 않고 실행기로만 낸다."""
        return self.runner is not None and start_active()

    def _runner_output(self, velocity, movement_epoch=None):
        # Move RPC 와 같은 관문: 리모컨 · 잠금 · 새 STOP 세대 · 손 떼기 대기면 0.
        with self._lock:
            ok = (velocity != ZERO and not self._remote_active() and not self.latched
                  and not self._closed.is_set() and not self._wait_operator_neutral
                  and movement_epoch == (self.generation, self._last_remote_activity))
        self.runner.poll()
        self.runner.velocity(velocity if ok else ZERO)

    def _stop_output(self, client, *, force=False):
        with self._lock:
            releasing = self._app_control is False and not self._operator_stop
        if self._start_route():
            # START 중 정지 = 실행기 속도 0 (실행기가 감속해 제자리에 선다 · 엎드리지 않음).
            # 조종권 없는 자동 정지는 리모컨과 다투지 않게 실행기에도 보내지 않는다 (#511 조용히와 같은 뜻).
            if not releasing:
                self._runner_output(ZERO)
            return
        if releasing:
            return self._release_output(client)
        first = None
        with self._lock:
            if self._remote_active() and not self._operator_stop:
                return
            self.actions.poll()
            if not force and not self._operator_stop and self.actions.executing is not None:
                return  # only the accepted action's own held STOP generation
            generation = self.generation
            quiet = self._ordinary_hold and not self._operator_stop
        measured = self._measured_stop(generation)
        lane = 'normal' if client is self.client else 'emergency'
        with self._lock:
            sample = self._posture_sample()
            resting = self._resting_for_stop(sample)
            notice = self._resting_stop_notice(sample)
            previous = self._stop_attempts.get(lane)
            ready = self._standing_stop_ready(sample, measured)
            if self._standing(sample):
                # Still DDS captured during motion must not suppress retries
                # after a held lane has sent its first compensating STOP.
                measured = ready
            # Every new STOP generation and explicit emergency/force still
            # sends once on each lane before stationary standing can hold it.
            held = (ready and not force and previous is not None and previous[0] == generation)
            if resting:
                # A fresh low posture continues the existing skip policy; it
                # does not resume RPC output just because standing ended.
                self._held_stop_generation = None
                held_notice = None
            else:
                held_notice = self._held_stop_notice(sample, generation, ready, force, held)
            if resting or held:
                self._resting_lanes.add(lane)
            else:
                resume = lane in self._resting_lanes
                self._resting_lanes.discard(lane)
        if notice is not None:
            logging.getLogger('foothold_agent.go2_direct.stop_rpc').warning('GO2_STOP_SKIPPED %s', notice)
        if held_notice is not None:
            logging.getLogger('foothold_agent.go2_direct.stop_rpc').warning('%s %s', *held_notice)
        if resting or held:
            return
        previous = self._stop_attempts.get(lane)
        send_stop = (force or resume or previous is None or previous[0] != generation or
                     (not measured and self.now()-previous[1] >= STOP_RETRY_S))
        if quiet and measured and not send_stop:
            return
        # 서 있거나 걷는 로봇의 정지는 언제나 Move(0) 부터 (11/26 Sport 모드 실기: 동작 뒤 남은
        # _posture_stop_only 로 StopMove 만 나가 로봇이 계속 걸음). StopMove 만은 낮은 자세 · 자세 바꾸는 중 ·
        # 관절 잠금 · 서지 않은 상태에서 끝난 동작 뒤뿐. 걸을 수 없는 운동 상태의 Move(0) 거절은 _call 이 넘긴다.
        stop_only = (self._lying_or_sitting(sample) or sample['state'] == 'TRANSITIONING' or
            sample.get('standing_locked', False) or self._posture is not None or
            (self._posture_stop_only and sample['state'] != 'STANDING'))
        for method, args in ([('StopMove', ())] if stop_only else [('Move', ZERO), ('StopMove', ())]):
            if method == 'StopMove':
                if not send_stop and first is None:
                    continue
                # Move(0) can block while the robot finishes lying down.
                if not stop_only:
                    with self._lock:
                        current = self._posture_sample()
                        resting = self._resting_for_stop(current)
                        notice = self._resting_stop_notice(current)
                        if resting:
                            self._resting_lanes.add(lane)
                    if notice is not None:
                        logging.getLogger('foothold_agent.go2_direct.stop_rpc').warning('GO2_STOP_SKIPPED %s', notice)
                    if resting:
                        break
                self._stop_attempts[lane] = (generation, self.now())
            try:
                self._movement_rpc(client, method, args)
            except BaseException as error:
                first = first or error
        if first is not None:
            raise first

    def _fail(self, error):
        with self.lock_log.after_unlock() as emit, self._lock:
            if self.error is None:
                emit("stop", "output_fault")
                emit("lock", "output_fault")
                self._stall_sequence += 1
            self.error = self.error or error
            self._hold()

    def drain(self):
        """Normal output worker only. Never hold the memory lock across SDK I/O."""
        with self._output:
            with self.lock_log.after_unlock() as emit, self._lock:
                if self._closed.is_set():
                    return
                self._require_workers(emit)
                stamp = self.now()
                if self.actions.executing is not None and self._expired(stamp):
                    self.actions.cancel('WATCHDOG')
                if not self.latched and self._expired(stamp):
                    self._stall(emit)
                    self._stop_requested.set()
                generation, urgent = self.generation, self._urgent
                movement_epoch = (generation, self._last_remote_activity)
                velocity = ZERO if self.latched else self.pending
                if self.source == 'server' and not self.latched and not urgent:
                    velocity = tuple(
                        _slew_axis(current, target, max(0., stamp - previous), acceleration, braking)
                        for current, target, previous, acceleration, braking in
                        zip(self._ramp_velocity, velocity, self._ramp_at, SERVER_SLEW, SERVER_BRAKE))
                elif self.source == 'phone' and velocity[0] > 0 and not urgent:
                    # Translation stays immediate. Releasing forward also cuts yaw
                    # immediately so braking can never command a turn in place.
                    turn = _slew_axis(self._ramp_velocity[2], velocity[2],
                                      max(0., stamp - self._ramp_at[2]), SERVER_SLEW[2], SERVER_BRAKE[2])
                    velocity = (velocity[0], velocity[1], turn)
                # Safety holds reset this state; neither STOP lane uses the ramp.
                self._ramp_velocity = ZERO if urgent else velocity
                self._ramp_at = (stamp,) * 3
                self._urgent = False
            try:
                if self._start_route():
                    # START: 순정 SDK 이동 · 정지 대신 실행기에 속도 (0 포함). 같은 관문을 지난 값만 나간다.
                    moving = not urgent and self._posture is None and not self.actions.busy and self._walkable()
                    self._runner_output(velocity if moving else ZERO, movement_epoch)
                elif urgent or self.latched:
                    self._stop_output(self.client)
                elif self._posture is None and not self.actions.busy and self._walkable():
                    self._movement_rpc(self.client, 'Move', velocity, movement_epoch=movement_epoch)
                self._posture_step()
                self.actions.step()
                self.actions.runner_acks()
                # An in-flight SDK call cannot be cancelled. Compensate on its
                # own lane immediately after return if STOP/close raced it.
                with self.lock_log.after_unlock() as emit, self._lock:
                    stamp = self.now()
                    # A stalled SDK return can also beat the watcher. Do not
                    # erase the outage by stamping its late completion as fresh.
                    if (not self.latched or self.actions.executing is not None) and self._expired(stamp):
                        self.actions.cancel('WATCHDOG')
                        self._stall(emit)
                        self._stop_requested.set()
                    self._last_drain = stamp
                    changed = generation != self.generation or self._closed.is_set()
                    if changed:
                        self._urgent = True
                if changed:
                    self._stop_output(self.client, force=velocity != ZERO)
            except BaseException as error:
                self._fail(error)
                self.emergency_stop()
                raise OutputError('normal SDK output failed') from error

    def emergency_stop(self, *, force=False, retry=False):
        # Independent lane: a blocked normal RPC must not own this lock.
        if not retry:
            with self._lock:
                self._hold(preserve=self._operator_stop)
                self._operator_stop = True
                self._wait_operator_neutral = True
                self.actions.cancel()
        with self._lock:
            if force or not retry:
                # A busy emergency RPC cannot consume a NEW explicit request.
                # Carry its force through the event-driven retry after return.
                self._emergency_force_pending = True
        if not self._emergency.acquire(blocking=False):
            if force or not retry:
                self._stop_requested.set()
            return
        try:
            with self._lock:
                self._hold(preserve=True)
                force = force or self._emergency_force_pending
                self._emergency_force_pending = False
            try:
                self._stop_output(self.emergency_client, force=force)
            except BaseException as error:
                self._fail(error)
                raise OutputError('emergency SDK output failed') from error
        finally:
            self._emergency.release()

    def check_watchdog(self):
        self.actions.poll()
        with self.lock_log.after_unlock() as emit, self._lock:
            sample = self._posture_sample()
            measured = self._measured_stop(self.generation)
            standing_ready = self._standing_stop_ready(sample, measured)
            if self._standing(sample):
                measured = standing_ready
            previous = self._stop_attempts.get('emergency')
            retry = (previous is not None and self.latched and
                     self.now()-previous[1] >= STOP_RETRY_S and
                     not measured and self.actions.executing is None)
            # A suppressed lane has no RPC deadline. Re-evaluate it on the
            # next watchdog tick so newly observed motion stops immediately.
            retry = self.latched and (retry or "emergency" in self._resting_lanes or
                                     standing_ready)
            retry = retry or (self._app_control is False and self._release_until is not None
                             and self.now()-self._release_last.get('emergency', float('-inf')) >= STOP_RETRY_S)
            expired = self._expired(self.now())
            if expired and self.actions.executing is not None:
                self.actions.cancel('WATCHDOG')
            requested = self._stop_requested.is_set()
            self._stop_requested.clear()
            if not requested and not expired and not retry:
                self._tripped = False
                return False
            if not requested and self._tripped and not retry:
                return False
            self._tripped = expired
            if expired:
                self.cancel_posture('WATCHDOG')
            if expired and not requested:
                self._stall(emit)
            else:
                self._hold(preserve=True)
        self.emergency_stop(retry=True)
        return True

    def start_threads(self):
        with self._lock:
            if self._offline_test_mode:
                raise RuntimeError('offline test mode cannot start live workers')
            if self._threads or self._closed.is_set():
                raise RuntimeError('output workers cannot be restarted')
            if self.source is None and self._phone_watchdog and self._app_control is None:
                # Phone runtime starts workers before constructing its Hub.
                # No source/lease has been bound in that startup interval.
                self._app_control = False
                logging.getLogger(__name__).warning('GO2_QUIET 조용히 시작')
            def worker(action, wake, normal_output):
                while not self._closed.is_set():
                    try:
                        action()
                    except BaseException as error:
                        self._fail(error)
                        if normal_output:
                            # The emergency worker may already be dead. Even a
                            # readiness failure before drain's SDK try-block
                            # must attempt zero/stop on this independent lane.
                            # Only started workers do this; pre-start calls stay
                            # I/O-free. Preserve the first fault if stopping fails.
                            try:
                                with self._output:
                                    self._stop_output(self.client, force=True)
                            except BaseException as stop_error:
                                self._fail(stop_error)
                        return
                    wake.wait(.02)
            self._threads = [threading.Thread(target=worker, args=(fn, wake, normal), daemon=True)
                             for fn, wake, normal in ((self.drain, self._closed, True),
                                                      (self.check_watchdog, self._stop_requested, False))]
            for thread in self._threads:
                thread.start()

    def close(self):
        self.lock_log.emit("stop", "output_closed")
        self.lock_log.emit("lock", "output_closed")
        self._closed.set()
        self.cancel_posture('CLOSED')
        self._stop_requested.set()
        self.emergency_stop(force=True)
        for thread in self._threads:
            thread.join(timeout=.25)
        if self.runner is not None:
            self.runner.close()
        if any(t.is_alive() for t in self._threads):
            self._fail(OutputError('SDK worker did not stop; process isolation required'))
            raise OutputError('SDK worker did not stop')
