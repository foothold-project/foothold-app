"""One serialized authority adapter -> ONE existing Session -> ONE MotionSink."""
from collections import deque
from copy import deepcopy
from dataclasses import dataclass, field
from datetime import datetime, timezone
import time
from uuid import uuid4

from foothold_agent.link.session import Session, MotionCommand
from foothold_agent.safety.core import Z, STATE_STALE
from .protocol import PROTO, LIMITS, MAX_SEQ, frame, project_velocity
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
                 now=time.monotonic, wall=time.time, record=None):
        self.verifier, self.sink = verifier, sink
        self.now, self.wall, self.record = now, wall, record
        self.robot = verifier.robot
        self.policy = {'name': policy_name, 'version': policy_version}
        self.simulation = simulation
        self.session = Session(now=now, server_link=False)
        self.peers = {}
        self.closing = {}
        self.owner = self.reservation = self.pending = None
        self.cooldowns = {}
        self.stop_ref = 0
        self.clock_origin = None
        self._emit(self.session.connect())

    def _emit(self, effects):
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
                self.record([m for m in effects.messages if m['t'] in ('event', 'run.update')])
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
        self._emit(self.session.tick())

    def stop(self):
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
                if old['t'] == message['t']:
                    queue.remove(old)
            queue.append(deepcopy(message))

    def drain(self, peer):
        queue = self.peers[peer].notifications
        result = list(queue)
        queue.clear()
        return result

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
        self._drop(peer)
        if self.pending is not None and self.pending['peer'] == peer:
            self._request_result('CANCELED', self_cancel=True)

    def disconnect(self, peer, *, reserve=True, requester_withdrawal=True):
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
            if self.owner == peer:
                self.fail(peer, 'TICKET_EXPIRED', 4401)
            self.disconnect(peer, reserve=False, requester_withdrawal=True)
            self.closing[peer] = PhoneError('TICKET_EXPIRED', 4401)
            raise self.closing[peer]
        if self.now() - p.last_ping >= 3:
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
        return list(self.closing.items())

    def tick(self):
        expired = self._expire()  # expiry precedes any output from a cached input
        self._emit(self.session.tick())  # Hub is the ONLY phone link timer
        return expired

    @staticmethod
    def error(code):
        status = (429 if code in ('LEASE_REQUEST_COOLDOWN', 'REQUEST_FLOOD') else 503 if code == 'STOP_CONFIRM_FAILED'
                  else 403 if code in ('FORBIDDEN', 'NOT_CONTROLLER') else 409)
        return {'code': code, 'message': code, 'detail': {'status': status}}

    def _grant(self, peer):
        self.stop()
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
            if ticket['device'] != f['device']:
                self.fail(peer, 'DEVICE_MISMATCH', 4403)
            if any(other.user is not None and other.device == ticket['device'] for other in self.peers.values()):
                self.fail(peer, 'DEVICE_CONNECTED', 4403)
            if sum(other.user is not None for other in self.peers.values()) >= 16:
                self.fail(peer, 'SERVER_BUSY', 1013)
            p.user, p.device, p.purpose, p.deadline = ticket['user'], ticket['device'], ticket['purpose'], ticket['deadline']
            return {'t': 'hello', 'id': f['id'], 'robot': self.robot, 'proto': PROTO,
                    'limits': deepcopy(LIMITS), 'policy': dict(self.policy), 'simulation': self.simulation,
                    'ping_interval_ms': 1000, 'link_timeout_ms': 3000, 'lease_timeout_ms': 15000}
        if p.user is None:
            self.fail(peer, 'HELLO_REQUIRED', 4401)
        reply = {'t': 'reply', 'id': f['id'], 'ok': True, 'error': None, 'lease_id': None, 'request_id': None}
        if kind in ('lease.request', 'lease.cancel'):
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
            axes, clipped = project_velocity(f['vx'], f['vy'], f['wz'])
            core_axes = list(axes)
            self._emit(self.session.receive({'t': 'cmd', 'lease_id': f['lease_id'], 'seq': f['seq'], 'axes': core_axes}))
            return {'t': 'cmd.ack', 'id': f['id'], 'seq': f['seq'], 'applied': list(self.session.core.out),
                    'clipped': clipped, 'reason': self.session.core.reason or None}
        return reply

    def on_robot_state(self, raw):
        self._expire()  # a bridge callback must not apply intent past ticket expiry
        self._emit(self.session.on_robot_state(raw))
        st = self.session.core.st
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
        return {**s, 'robot': self.robot, 'controller': identity[0], 'controller_device': identity[1],
                'controller_connected': self.owner is not None,
                'lease_id': self.session.lease_id if self.owner == peer else None,
                'stop_requested': st.get('stop_requested'),
                'posture': {k: st.get(k) for k in ('z', 'tilt_deg', 'fallen', 'body_still')},
                'velocity': [st.get(k) for k in ('vx', 'vy', 'wz')], 'echo': deepcopy(p.echo),
                'wall_time_ms': int(self.wall()*1000), 'sim_time_s': sim_t if self.simulation else None,
                'sim_wall_delta_s': delta, 'simulation': self.simulation}

    def close(self):
        try:
            self._emit(self.session.shutdown())
        finally:
            self.owner = self.reservation = self.pending = None
            self.peers.clear()
            self.closing.clear()
