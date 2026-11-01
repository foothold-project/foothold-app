"""One serialized authority adapter -> ONE existing Session -> ONE MotionSink."""
from collections import deque
from copy import deepcopy
from dataclasses import dataclass, field
from datetime import datetime, timezone
import time
from uuid import uuid4

from foothold_agent.link.session import Session, MotionCommand, Effects, MAX_BUFFER
from foothold_agent.safety.core import Z, STATE_STALE, quantize
from foothold_agent.policy_ranges import velocity_input
from .protocol import (PROTO, LIMITS, SIMULATION_LIMITS, MAX_SEQ, frame,
                       project_velocity, simulation_velocity)
from .tickets import TicketError


class PhoneError(ValueError):
    def __init__(self, code, close_code=1007):
        self.code, self.close_code = code, close_code
        super().__init__(code)


@dataclass
class Peer:
    user: str | None = None
    device: str | None = None
    purpose: str | None = None
    surface: str = 'phone'
    run_cancel: bool = False
    run_start_reply: dict | None = field(default=None, repr=False)
    jti: str | None = None
    issued: int = 0
    deadline: float = 0
    last_ping: float = 0
    echo: dict | None = None
    notifications: deque = field(default_factory=deque)
    request_window: float = float('-inf')
    request_count: int = 0
    release_window: float = float('-inf')
    release_count: int = 0


class Hub:
    def __init__(self, verifier, sink, *, policy_name, policy_version, simulation,
                 now=time.monotonic, wall=time.time, record=None,
                 nav=None, scenario_source=None, run_journal=None, run_context=None,
                 arrival_evidence=None, run_pause_timeout_s=600, simulation_binding=None):
        self.verifier, self.sink = verifier, sink
        self.now, self.wall, self.record = now, wall, record
        self.robot = verifier.robot
        self.policy = {'name': policy_name, 'version': policy_version}
        self.simulation = simulation
        self.session = Session(now=now, server_link=False,
                               velocity_projection=simulation_velocity if simulation is True else quantize,
                               **({"axes_validator": velocity_input} if simulation is True else {}))
        self.session.output_safety = getattr(sink, 'output_safety', None)
        self.peers = {}
        self.closing = {}
        self.owner = self.reservation = self.pending = None
        self.cooldowns = {}
        self.acquisitions = {}  # identity -> at most30 admitted attempts in rolling60s
        self.acquisition_denials = 0
        self.acquisition_report_at = self.now()
        self.stop_ref = 0
        self.stop_requests = {}
        self.clock_origin = None
        from foothold_agent.executor.scenario_run import ScenarioRun
        self.runs = ScenarioRun(self, nav=nav, source=scenario_source, journal=run_journal,
            context=run_context, arrival=arrival_evidence, run_pause_timeout_s=run_pause_timeout_s)
        self.session.executor_zero_only = self.runs.zero_only_waiting
        # Only the proven simulation Nav2 adapter shares the manual SI envelope.
        from foothold_agent.executor.nav2.simulation import SimulationBinding, SimulationPolicyAdapter
        if (simulation is True and nav is not None
                and isinstance(simulation_binding, SimulationBinding)
                and simulation_binding.robot_id == self.robot):
            enabled = lambda: (self.simulation is True
                               and simulation_binding.matches(self.runs.binding))
            nav.adapter = SimulationPolicyAdapter(nav.adapter, enabled)
        phone_projection = self.session.core.velocity_projection
        def projection(vx, vy, wz):
            if self.session.holder_type == 'RUN' and self.runs.nav is not None:
                adapter = self.runs.nav.adapter
                if isinstance(adapter, SimulationPolicyAdapter):
                    return adapter.project(vx, vy, wz)
                # Legacy Nav2 .6 SI -> axis 1 must stay .6 SI even in a sim Hub.
                return quantize(vx, vy, wz)
            return phone_projection(vx, vy, wz)
        if simulation is True:
            self.session.core.velocity_projection = projection
        self._emit(self.session.connect())

    def _emit(self, effects):
        if self.runs.binding is not None and self.runs.nav.rejected:
            self.runs._halt('FAILED', 'NAV_GOAL_REJECTED')
            return  # discard even effects computed just before the callback
        # Core intent time is the consumption time. Every output, including
        # robot feedback and audit ticks, must obey Nav2's original receipt.
        if self.runs.binding is not None and not self.runs.zero_only_waiting() and self.runs.nav.source_expired():
            self.runs._halt('FAILED', 'NAV_TIMEOUT')
            return  # discard effects computed from the expired intent
        try:
            for command in effects.motion:
                self.sink.apply(command)
        except BaseException as error:
            for command in (MotionCommand('stop'), MotionCommand(velocity=Z)):
                try:
                    self.sink.apply(command)
                except BaseException as extra:
                    error.output_errors = [*getattr(error, 'output_errors', []), extra]
                    if hasattr(error, 'add_note'):
                        error.add_note('additional fallback output error: ' + type(extra).__name__)
            raise
        if self.record is not None:
            try:
                self.record([m for m in effects.messages if m['t'] == 'event' or (m['t'] == 'run.update' and self.runs.current is None)])
            except BaseException as error:
                self.record = None  # output a STOP without recursing into failed storage
                try:
                    self.stop()
                except BaseException as extra:
                    error.output_errors = [*getattr(error, 'output_errors', []), extra]
                raise

    def _audit(self, code, **data):
        self.session.retain([{'t': 'event', 'code': code, 'severity': 'info', 'robot_at': None,
                              'data': data}])
        effects = (self.session.tick() if self.session.connected else
                   Effects((), tuple(self.session.pop_history(MAX_BUFFER - 1))))
        self._emit(effects)

    def stop(self):
        try:
            self.runs.stopped()
        finally:
            # Action cancellation/storage errors must never suppress Session's
            # STOP emission. Preserve the failure after the safety output.
            if self.stop_ref >= MAX_SEQ:
                self._emit(self.session.shutdown())
                raise RuntimeError('phone STOP reference exhausted')
            self.stop_ref += 1
            self._emit(self.session.receive({'t': 'stop', 'stop_ref': self.stop_ref, 'by_user_id': None}))

    def _notify(self, peer, message):
        if peer in self.peers:
            queue = self.peers[peer].notifications
            # These are replaceable UI snapshots. Audit events remain FIFO in
            # the separate journal; a slow viewer cannot kill the robot service.
            for old in list(queue):
                if old['t'] == message['t'] and message['t'] != 'event':
                    queue.remove(old)
            if len(queue) >= 256:
                queue.popleft()  # UI only; durable run journal owns all events
            queue.append(deepcopy(message))

    def drain(self, peer):
        queue = self.peers[peer].notifications
        result = list(queue)
        queue.clear()
        return result

    def _flush_acquisition_denials(self, *, final=False):
        if self.acquisition_denials and (final or self.now() - self.acquisition_report_at >= 1):
            count, self.acquisition_denials = self.acquisition_denials, 0
            self.acquisition_report_at = self.now()
            self._audit('PHONE_LEASE_ACQUIRE_LIMIT', rejected=count)

    def _acquisition_allowed(self, peer):
        identity = (peer.user, peer.device)
        history = self.acquisitions.setdefault(identity, deque())
        if len(history) >= 30 or sum(at > self.now()-1 for at in history) >= 8:
            self.acquisition_denials += 1
            self._flush_acquisition_denials()
            return False
        history.append(self.now())
        return True

    def _request_result(self, result, error=None, *, self_cancel=False):
        request, self.pending = self.pending, None
        if request is None:
            return
        message = {'t': 'lease.result', 'robot': self.robot, 'request_id': request['id'],
                   'result': result, 'error': error}
        for peer in (request['holder'], request['peer']):
            self._notify(peer, message)
        if result in ('DECLINED', 'TIMEOUT') or self_cancel:
            self.cooldowns[request['identity']] = self.now() + 30
        self._audit('PHONE_LEASE_' + result, request_id=request['id'],
                    user_id=request['identity'][0], device_id=request['identity'][1])

    def _drop(self, peer, *, reserve=False, reason='RELEASED', cancel_request=True):
        if self.owner != peer:
            return
        p = self.peers[peer]
        try:
            self._emit(self.session.receive({'t': 'lease', 'lease_id': None, 'holder_type': None}))
            self.stop()  # STOP/zero/latch before authority is cleared or handed over
        finally:
            self.owner = None
            self.reservation = None
        self.reservation = ({'identity': (p.user, p.device), 'until': min(p.last_ping + 15, p.deadline)}
                            if reserve else None)
        if cancel_request:
            self._request_result('CANCELED')
        self._audit('PHONE_LEASE_RELEASED', user_id=p.user, device_id=p.device, reason=reason)

    def release(self, peer):
        self.runs.lost(peer)
        self._drop(peer)
        if self.pending is not None and self.pending['peer'] == peer:
            self._request_result('CANCELED', self_cancel=True)

    def disconnect(self, peer, *, reserve=True, requester_withdrawal=True):
        self.runs.lost(peer)
        try:
            self._drop(peer, reserve=reserve, reason='DISCONNECTED')
            if self.pending is not None and self.pending['peer'] == peer:
                self._request_result('CANCELED', self_cancel=requester_withdrawal)
        finally:
            self.peers.pop(peer, None)

    def fail(self, peer, code='VALIDATION', close_code=1007, *, reserve=False, safety=True):
        if safety and peer in self.peers and self.peers[peer].user is not None:
            self.stop()  # only hello-approved phones may affect robot safety
        # Rejecting a peer's own input is withdrawal, not unrelated server cleanup.
        requester_withdrawal = code != 'CLOCK_UNTRUSTED'
        self.disconnect(peer, reserve=reserve, requester_withdrawal=requester_withdrawal)
        error = PhoneError(code, close_code)
        self.closing[peer] = error
        raise error

    def _check_peer(self, peer):
        p = self.peers[peer]
        if p.user is not None and self.now() >= p.deadline:
            self.runs.lost(peer)
            if self.owner == peer:
                self.fail(peer, 'TICKET_EXPIRED', 4401)
            self.disconnect(peer, reserve=False, requester_withdrawal=True)
            self.closing[peer] = PhoneError('TICKET_EXPIRED', 4401)
            raise self.closing[peer]
        if self.now() - p.last_ping >= 3:
            self.runs.lost(peer)
            if self.owner == peer:
                self.fail(peer, 'PHONE_LINK_LOST', 1013, reserve=True)
            self.disconnect(peer, reserve=False)
            self.closing[peer] = PhoneError('PHONE_LINK_LOST', 1013)
            raise self.closing[peer]

    def _expire(self):
        expired = []
        try:
            self.verifier.check_clock()
        except TicketError:
            for peer in list(self.peers):
                try:
                    self.fail(peer, 'CLOCK_UNTRUSTED', 4401)
                except PhoneError as exc:
                    expired.append((peer, exc))
            self.reservation = None
            return expired
        for peer in list(self.peers):
            try:
                self._check_peer(peer)
            except PhoneError as exc:
                expired.append((peer, exc))
        if self.reservation is not None and self.now() >= self.reservation['until']:
            self.reservation = None
        if self.pending is not None and self.now() >= self.pending['until']:
            self._request_result('TIMEOUT')
        self.cooldowns = {key: until for key, until in self.cooldowns.items() if self.now() < until}
        for identity, history in list(self.acquisitions.items()):
            while history and history[0] <= self.now()-60:
                history.popleft()
            if not history:
                del self.acquisitions[identity]
        self._flush_acquisition_denials()
        return list(self.closing.items())

    def tick(self):
        expired = self._expire()  # expiry precedes any output from a cached input
        self.runs.tick()
        self._emit(self.session.tick())  # Hub is the ONLY phone link timer
        return expired

    @staticmethod
    def error(code):
        status = (429 if code in ('LEASE_REQUEST_COOLDOWN', 'REQUEST_FLOOD', 'LEASE_ACQUIRE_LIMIT') else 503 if code == 'STOP_CONFIRM_FAILED'
                  else 403 if code in ('FORBIDDEN', 'NOT_CONTROLLER', 'WEB_SIM_ONLY') else 409)
        return {'code': code, 'message': code, 'detail': {'status': status}}

    def _grant(self, peer):
        self.stop()
        if not self.runs.cancel_confirmed():
            return False
        state = self.session._state()
        if not (state['latched'] and state['applied'] == list(Z) and state['stop_ref'] == self.stop_ref):
            return False
        lease = str(uuid4())
        self._emit(self.session.receive({'t': 'lease', 'lease_id': lease, 'holder_type': 'USER'}))
        if self.session.core.controller != lease:
            self._emit(self.session.receive({'t': 'lease', 'lease_id': None, 'holder_type': None}))
            return False
        self.owner, self.reservation = peer, None
        p = self.peers[peer]
        # Connection UI/cancel windows reset; identity acquisition budgets stay intact.
        p.request_window = p.release_window = float('-inf')
        p.request_count = p.release_count = 0
        self._audit('PHONE_LEASE_TAKEN', user_id=p.user, device_id=p.device, lease_id=lease)
        return True

    def receive(self, peer, raw):
        self._expire()  # expire ALL authority before any frame can emit motion
        if peer in self.closing:
            raise self.closing[peer]
        if peer not in self.peers:
            # Direct Hub users only: Server._admit has already registered its peers.
            if sum(p.user is None for p in self.peers.values()) >= 16:
                raise PhoneError('SERVER_BUSY', 1013)
            self.peers[peer] = Peer(last_ping=self.now())
        try:
            self.verifier.check_clock()
        except TicketError:
            self.fail(peer, 'CLOCK_UNTRUSTED', 4401)
        self._check_peer(peer)  # reject queued input at/after the monotonic deadline
        p = self.peers[peer]
        try:
            f = frame(raw, self.robot)
        except (ValueError, TypeError, UnicodeError, RecursionError, OverflowError) as exc:
            code = str(exc) if str(exc) in ('PROTOCOL_MISMATCH', 'BINARY_UNSUPPORTED', 'FRAME_TOO_LARGE', 'ROBOT_MISMATCH') else 'VALIDATION'
            self.fail(peer, code, {'PROTOCOL_MISMATCH': 4406, 'BINARY_UNSUPPORTED': 1003,
                                  'FRAME_TOO_LARGE': 1009, 'ROBOT_MISMATCH': 4403}.get(code, 1007))
        kind = f['t']
        if kind == 'hello':
            if p.user is not None:
                self.fail(peer, 'SECOND_HELLO', 1012)
            try:
                ticket = self.verifier.verify(f['ticket'])
            except TicketError:
                self.fail(peer, 'TICKET_INVALID', 4403)
            if ticket['surface'] == 'pc' and self.simulation is not True:
                self.fail(peer, 'WEB_SIM_ONLY', 4403)
            if ticket['device'] != f['device']:
                self.fail(peer, 'DEVICE_MISMATCH', 4403)
            if any(other.user is not None and other.device == ticket['device'] for other in self.peers.values()):
                self.fail(peer, 'DEVICE_CONNECTED', 4403)
            if sum(other.user is not None for other in self.peers.values()) >= 16:
                self.fail(peer, 'SERVER_BUSY', 1013)
            p.user, p.device, p.purpose, p.deadline = ticket['user'], ticket['device'], ticket['purpose'], ticket['deadline']
            p.jti, p.issued = ticket['jti'], ticket['issued']
            p.surface = ticket['surface']
            p.run_cancel = ticket.get('run_cancel', False)
            return {'t': 'hello', 'id': f['id'], 'robot': self.robot, 'proto': PROTO,
                    'limits': deepcopy(SIMULATION_LIMITS if self.simulation is True else LIMITS),
                    'policy': dict(self.policy), 'simulation': self.simulation,
                    'capabilities': {'run_contract': 'scenario/1'},
                    'ping_interval_ms': 1000, 'link_timeout_ms': 3000, 'lease_timeout_ms': 15000}
        if p.user is None:
            self.fail(peer, 'HELLO_REQUIRED', 4401)
        reply = {'t': 'reply', 'id': f['id'], 'ok': True, 'error': None, 'lease_id': None, 'request_id': None}
        # A rejected local mode must not leave the previous intent running.
        # Reuse release's STOP/zero/latch cleanup, even for harmless requests.
        pc_mode_denied = p.surface == 'pc' and self.simulation is not True
        zero_cmd = kind == 'cmd' and (f['vx'], f['vy'], f['wz']) == Z
        if pc_mode_denied:
            if not zero_cmd:
                self.release(peer)
            # A valid neutral command still follows normal lease/sequence checks;
            # release it immediately after applying zero, before acknowledging.
            if not zero_cmd and kind not in ('stop', 'ping', 'lease.release', 'lease.cancel', 'view'):
                reply.update(ok=False, error=self.error('WEB_SIM_ONLY'))
                return reply
        self.runs.expire()  # deadlines win; incoming STOP/pause never poll a goal
        if kind.startswith('run.'):
            code, detail = self.runs.handle(peer, f)
            if code is not None:
                reply.update(ok=False, error=self.error(code))
            elif detail is not None:
                reply['detail'] = detail
            return reply
        if kind in ('lease.take', 'lease.request', 'lease.respond') and self.runs.active:
            c = self.runs.current
            if c['status'] != 'PAUSED':
                reply.update(ok=False, error=self.error('RUN_ACTIVE'))
                return reply
            if self.runs.identity(p) != c['identity']:
                reply.update(ok=False, error=self.error('RUN_OWNER_MISMATCH'))
                return reply
            if (kind == 'lease.respond' and f['accept'] and self.pending is not None
                    and self.runs.identity(self.peers[self.pending['peer']]) != c['identity']):
                reply.update(ok=False, error=self.error('RUN_OWNER_MISMATCH'))
                return reply
            if not self.runs.cancel_confirmed():
                reply.update(ok=False, error=self.error('RESUME_REJECTED'))
                return reply
        if kind == 'cmd' and self.runs.active and self.runs.current['status'] != 'PAUSED':
            if not zero_cmd:
                reply.update(ok=False, error=self.error('RUN_ACTIVE'))
                return reply
            # Safety-reducing ZERO is never blocked by RUN ownership.
            self.session.core.cmd(self.session.lease_id, Z)
            self._emit(self.session.tick())
            return {'t': 'cmd.ack', 'id': f['id'], 'seq': f['seq'], 'applied': list(Z), 'clipped': False, 'reason': None}
        if kind in ('lease.take', 'lease.request') and not self._acquisition_allowed(p):
            reply.update(ok=False, error=self.error('LEASE_ACQUIRE_LIMIT'))
            return reply  # Identity budget persists across grant, disconnect and hello.
        if kind == 'lease.cancel':
            if self.now() - p.request_window >= 1:
                p.request_window, p.request_count = self.now(), 0
            p.request_count += 1
            if p.request_count > 8:
                self.fail(peer, 'REQUEST_FLOOD', 1013, safety=False)
        elif kind in ('lease.release', 'view') and self.owner != peer:
            if self.now() - p.release_window >= 1:
                p.release_window, p.release_count = self.now(), 0
            p.release_count += 1
            if p.release_count > 8:
                reply.update(ok=False, error=self.error('REQUEST_FLOOD'))
                return reply  # Keep this phone connected and able to STOP.
        if kind in ('lease.take', 'lease.request'):
            identity = (p.user, p.device)
            if p.purpose != 'control':
                reply.update(ok=False, error=self.error('FORBIDDEN'))
            elif self.owner == peer:
                reply['lease_id'] = self.session.lease_id
            elif self.owner is None:
                if self.reservation is not None and self.now() < self.reservation['until'] and self.reservation['identity'] != identity:
                    reply.update(ok=False, error=self.error('LEASE_HELD'))
                elif self._grant(peer):
                    reply['lease_id'] = self.session.lease_id
                else:
                    reply.update(ok=False, error=self.error('STOP_CONFIRM_FAILED'))
            elif kind == 'lease.take':
                reply.update(ok=False, error=self.error('LEASE_HELD'))
            elif identity in self.cooldowns and self.now() < self.cooldowns[identity]:
                reply.update(ok=False, error=self.error('LEASE_REQUEST_COOLDOWN'))
            elif self.pending is not None:
                reply.update(ok=False, error=self.error('LEASE_REQUEST_PENDING'))
            else:
                request_id = str(uuid4())
                self.pending = {'id': request_id, 'peer': peer, 'holder': self.owner,
                                'identity': identity, 'until': self.now() + 10}
                self._notify(self.owner, {'t': 'lease.requested', 'robot': self.robot, 'request_id': request_id,
                    'requester': {'user_id': p.user, 'device_id': p.device},
                    'expires_at': datetime.fromtimestamp(self.wall()+10, timezone.utc).isoformat()})
                self._audit('PHONE_LEASE_REQUESTED', request_id=request_id, user_id=p.user, device_id=p.device)
                reply['request_id'] = request_id
        elif kind == 'lease.respond':
            if self.owner != peer or self.pending is None or self.pending['id'] != f['request_id']:
                reply.update(ok=False, error=self.error('NOT_CONTROLLER'))
            elif self.now() >= self.pending['until']:
                self._request_result('TIMEOUT')
                reply.update(ok=False, error=self.error('LEASE_REQUEST_EXPIRED'))
            elif not f['accept']:
                self._request_result('DECLINED')
            else:
                target = self.pending['peer']
                try:
                    self._check_peer(target)
                except PhoneError:
                    reply.update(ok=False, error=self.error('LEASE_REQUEST_EXPIRED'))
                    return reply
                self._drop(peer, cancel_request=False, reason='TRANSFERRED')
                if self._grant(target):
                    self._request_result('ACCEPTED')
                else:
                    self._request_result('CANCELED', 'STOP_CONFIRM_FAILED')
                    reply.update(ok=False, error=self.error('STOP_CONFIRM_FAILED'))
        elif kind in ('lease.release', 'view'):
            self.release(peer)
        elif kind == 'lease.cancel':
            if self.pending is not None and self.pending['peer'] == peer:
                self._request_result('CANCELED', self_cancel=True)
        elif kind == 'stop':
            self.stop()  # authenticated view-only phones may STOP
            if 'request_id' in f:
                # Bounded confirmation metadata never suppresses the STOP itself.
                if len(self.stop_requests) >= 16:
                    self.stop_requests.pop(next(iter(self.stop_requests)))
                self.stop_requests[f['request_id']] = self.now()
        elif kind == 'ping':
            p.last_ping = self.now()
            p.echo = {'id': f['id'], 'client_time_ms': f['client_time_ms'], 'agent_time_ms': int(self.wall()*1000)}
        elif self.owner != peer or f['lease_id'] != self.session.lease_id:
            reply.update(ok=False, error=self.error('NOT_CONTROLLER'))
        elif kind == 'unlock':
            self._emit(self.session.receive({'t': 'unlock', 'lease_id': f['lease_id'], 'stop_gen': f['stop_gen']}))
            if self.session.core.resume_pending is None:
                reply.update(ok=False, error=self.error('UNLOCK_REJECTED'))
        elif kind == 'cmd':
            if f['seq'] <= self.session.last_seq:
                self.fail(peer, 'SEQUENCE_INVALID')
            axes, clipped = project_velocity(f['vx'], f['vy'], f['wz'], simulation=self.simulation)
            core_axes = list(axes)
            self._emit(self.session.receive({'t': 'cmd', 'lease_id': f['lease_id'], 'seq': f['seq'], 'axes': core_axes}))
            if pc_mode_denied:
                self.release(peer)
            return {'t': 'cmd.ack', 'id': f['id'], 'seq': f['seq'], 'applied': list(self.session.core.out),
                    'clipped': clipped, 'reason': self.session.core.reason or None}
        return reply

    def on_robot_state(self, raw):
        self._expire()  # a bridge callback must not apply intent past ticket expiry
        self._emit(self.session.on_robot_state(raw))
        st = self.session.core.st
        if (self.stop_requests and st is not None and self.session.core.latch
                and not any(self.session.core.out) and st.get('stop_requested') is True
                and st.get('body_still') is True
                and self.now() - self.session.core.state_t <= STATE_STALE):
            for request_id, requested_at in list(self.stop_requests.items()):
                if self.session.core.state_t > requested_at:
                    del self.stop_requests[request_id]
                    self._audit('STOP_REQUEST_APPLIED', request_id=request_id,
                        stop_gen=self.session.core.stop_gen, latched=True,
                        applied=list(self.session.core.out), bridge_confirmed=True)
        if st and st.get('sim_t') is not None:
            if self.clock_origin is None or self.clock_origin[0] != st['episode']:
                self.clock_origin = (st['episode'], st['sim_t'], self.now())

    def state(self, peer):
        s = self.session._state()
        st = self.session.core.st
        fresh = st is not None and self.now() - self.session.core.state_t <= STATE_STALE
        st = st if fresh else {}
        sim_t = st.get('sim_t')
        delta = None
        if self.simulation and sim_t is not None and self.clock_origin is not None:
            delta = (sim_t - self.clock_origin[1]) - (self.now() - self.clock_origin[2])
        p = self.peers[peer]
        identity = ((self.peers[self.owner].user, self.peers[self.owner].device) if self.owner is not None
                    else self.reservation['identity'] if self.reservation is not None else (None, None))
        return {**s, 'run': self.runs.snapshot(), 'robot': self.robot, 'controller': identity[0], 'controller_device': identity[1],
                'controller_connected': self.owner is not None,
                'lease_id': self.session.lease_id if self.owner == peer else None,
                'stop_requested': st.get('stop_requested'),
                'posture': {k: st.get(k) for k in ('z', 'tilt_deg', 'fallen', 'body_still')},
                'velocity': [st.get(k) for k in ('vx', 'vy', 'wz')], 'echo': deepcopy(p.echo),
                'wall_time_ms': int(self.wall()*1000), 'sim_time_s': sim_t if self.simulation else None,
                'sim_wall_delta_s': delta, 'simulation': self.simulation}

    def revoke(self, frame):
        self._expire()  # open authority follows its fixed monotonic deadline
        primary = None
        try:
            self.verifier.revoke(frame)
        except TicketError as error:
            primary = error
            # A failed local persistence operation cannot leave motion running.
            try:
                self.stop()
            except BaseException as extra:
                if hasattr(primary, 'add_note'):
                    primary.add_note('revocation STOP error: ' + type(extra).__name__)
        for peer, p in list(self.peers.items()):
            if primary is not None or (p.user is not None and self.verifier.matches(
                    {'user': p.user, 'device': p.device, 'jti': p.jti, 'issued': p.issued}, frame['items'], None)):
                try:
                    self.disconnect(peer, reserve=False, requester_withdrawal=False)
                except BaseException as error:
                    if primary is None:
                        primary = error
                    elif hasattr(primary, 'add_note'):
                        primary.add_note('revocation disconnect error: ' + type(error).__name__)
                finally:
                    self.closing[peer] = PhoneError('TICKET_REVOKED', 4403)
        if primary is not None:
            raise primary

    def close(self):
        self.runs.stopped()
        primary = None
        try:
            self._emit(self.session.shutdown())
        except BaseException as error:
            primary = error
        finally:
            self.owner = self.reservation = self.pending = None
            self.peers.clear()
            self.closing.clear()
        try:
            # The final synchronous audit must never precede STOP/zero.
            self._flush_acquisition_denials(final=True)
        except BaseException as error:
            if primary is None:
                primary = error
            elif hasattr(primary, 'add_note'):
                primary.add_note('final phone audit error: ' + type(error).__name__)
        if primary is not None:
            raise primary
