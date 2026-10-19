"""Connection-bound lease state machine. No database, network, or wall clock I/O.

Callers apply returned effects in order. All deadlines use the injected monotonic
clock; UTC timestamps are presentation concerns in the transport adapter.
"""
from dataclasses import dataclass, field
from typing import Callable
from uuid import uuid4


class LeaseError(Exception):
    def __init__(self, code, message, status=409):
        self.code, self.message, self.status = code, message, status
        super().__init__(message)


@dataclass(frozen=True)
class Actor:
    user: str
    session: str
    connection: str
    display_name: str = field(default='', compare=False)
    role: str = field(default='OPERATOR', compare=False)


@dataclass
class Holder:
    actor: Actor | None
    lease_id: str
    since: float
    heartbeat: float
    holder_type: str = 'USER'
    seq: int = -1
    last_cmd: float = float('-inf')


@dataclass
class Request:
    id: str
    actor: Actor
    holder: Actor
    deadline: float


@dataclass
class Transfer:
    actor: Actor | None
    deadline: float
    stop_gen: int
    request: Request | None = None


@dataclass(frozen=True)
class Effect:
    target: str  # agent | screens | connection ID | audit
    robot: str
    body: dict


@dataclass
class RobotLease:
    holder: Holder | None = None
    request: Request | None = None
    transfer: Transfer | None = None
    cooldown: dict[str, float] = field(default_factory=dict)
    stop_gen: int = 0
    latched: bool = True


class Arbiter:
    def __init__(self, clock: Callable[[], float], ids=lambda: str(uuid4())):
        self.clock, self.ids = clock, ids
        self.robots: dict[str, RobotLease] = {}

    def robot(self, robot):
        return self.robots.setdefault(robot, RobotLease())

    def effect(self, target, robot, **body):
        return Effect(target, robot, body)

    def audit(self, robot, op, actor=None, other=None):
        return self.effect('audit', robot, op=op, user_id=actor.user if actor else None,
                           session_id=actor.session if actor else None,
                           other_user_id=other.user if other else None)

    def owned(self, r, actor, lease_id=None):
        h = r.holder
        if not h or h.actor != actor or (lease_id is not None and h.lease_id != lease_id):
            raise LeaseError('LEASE_MISMATCH', '현재 연결의 조종권이 아닙니다.', 403)
        return h

    def announce(self, robot):
        h = self.robot(robot).holder
        return self.effect('screens', robot, t='lease', holder=None if not h else {
            'holder_type': h.holder_type, 'user': None if not h.actor else {
                'id': h.actor.user, 'display_name': h.actor.display_name}},
            lease_id=h.lease_id if h else None, connection=h.actor.connection if h and h.actor else None,
            since=h.since if h else None)

    def result(self, robot, req, result, error=None):
        body = dict(t='lease.result', request_id=req.id, result=result)
        if error:
            body['error'] = error
        return [self.effect(c, robot, **body) for c in {req.actor.connection, req.holder.connection}]

    def cancel_request(self, robot):
        r = self.robot(robot)
        req, r.request = r.request, None
        return self.result(robot, req, 'CANCELED') if req else []

    def revoke(self, robot, actor=None, op='RELEASE'):
        r = self.robot(robot)
        h, tr = r.holder, r.transfer
        r.holder = r.transfer = None
        # Safety ordering is contractual: lease null reaches the agent before stop.
        effects = [self.effect('agent', robot, t='lease', lease_id=None, holder_type=None),
                   self.effect('agent', robot, t='stop', by_user_id=actor.user if actor else None),
                   self.announce(robot), *self.cancel_request(robot)]
        if h and h.actor:
            effects += [self.effect(h.actor.connection, robot, **self.announce(robot).body)]
        if tr and tr.request:
            effects += self.result(robot, tr.request, 'CANCELED')
        if h or tr:
            effects += [self.audit(robot, op, h.actor if h else tr.actor)]
        return effects

    def begin(self, robot, actor, req=None):
        r = self.robot(robot)
        effects = self.revoke(robot, actor)
        r.transfer = Transfer(actor, self.clock() + 2, r.stop_gen, req)
        return effects

    def take(self, robot, actor):
        r = self.robot(robot)
        if r.holder and r.holder.holder_type == 'RUN' and not r.transfer:
            return self.begin(robot, actor)
        if r.holder or r.transfer:
            raise LeaseError('LEASE_HELD', '다른 연결이 조종 중입니다.')
        return self.begin(robot, actor)

    def request(self, robot, actor, timeout=10):
        r = self.robot(robot)
        if self.clock() < r.cooldown.get(actor.user, float('-inf')):
            raise LeaseError('LEASE_REQUEST_COOLDOWN', '30초 뒤 다시 요청하세요.', 429)
        if not r.holder or not r.holder.actor or r.transfer:
            raise LeaseError('LEASE_FREE', '조종권 상태가 바뀌었습니다.')
        if r.holder.actor == actor or r.holder.actor.user == actor.user or r.request:
            raise LeaseError('LEASE_REQUEST_PENDING', '이미 조종 중이거나 요청이 있습니다.')
        req = Request(self.ids(), actor, r.holder.actor, self.clock() + timeout)
        r.request = req
        return [self.effect(req.holder.connection, robot, t='lease.requested', request_id=req.id,
                            requester={'display_name': actor.display_name, 'role': actor.role},
                            expires_in=timeout), self.audit(robot, 'REQUEST', actor, req.holder)]

    def respond(self, robot, actor, request_id, accept):
        r = self.robot(robot)
        self.owned(r, actor)
        req = r.request
        if not req or req.id != request_id or self.clock() >= req.deadline:
            raise LeaseError('LEASE_REQUEST_STALE', '요청이 끝났습니다.')
        r.request = None
        if not accept:
            r.cooldown[req.actor.user] = self.clock() + 30
            return [*self.result(robot, req, 'DECLINED'), self.audit(robot, 'DECLINE', actor, req.actor)]
        return self.begin(robot, req.actor, req)

    def release(self, robot, actor):
        self.owned(self.robot(robot), actor)
        return self.revoke(robot, actor)

    def hidden(self, robot, actor):
        r = self.robot(robot)
        if r.transfer and r.transfer.actor == actor:
            return self.revoke(robot, actor)
        return self.release(robot, actor)

    def heartbeat(self, robot, actor, lease_id, seq):
        h = self.owned(self.robot(robot), actor, lease_id)
        if seq <= h.seq:
            raise LeaseError('CMD_SEQ', '명령 순서가 올바르지 않습니다.', 400)
        at = self.clock()
        if at - h.last_cmd < 0.05 - 1e-9:
            raise LeaseError('CMD_RATE_LIMIT', '명령 간격은 50밀리초입니다.', 429)
        h.seq, h.last_cmd, h.heartbeat = seq, at, at

    def cmd(self, robot, actor, lease_id, seq, axes):
        self.heartbeat(robot, actor, lease_id, seq)
        return [self.effect('agent', robot, t='cmd', lease_id=lease_id, seq=seq, axes=axes)]

    def unlock(self, robot, actor, lease_id, stop_gen):
        r = self.robot(robot)
        self.owned(r, actor, lease_id)
        if stop_gen != r.stop_gen:
            raise LeaseError('STOP_GEN_MISMATCH', '정지 상태가 바뀌었습니다.')
        return [self.effect('agent', robot, t='unlock', lease_id=lease_id, stop_gen=stop_gen)]

    def stop(self, robot, actor):
        # Cancel an in-flight handoff so an old stop acknowledgement cannot grant it.
        r = self.robot(robot)
        tr, r.transfer = r.transfer, None
        effects = [self.effect('agent', robot, t='stop', by_user_id=actor.user)]
        if tr and tr.request:
            effects += self.result(robot, tr.request, 'CANCELED')
        return effects + [self.audit(robot, 'STOP', actor)]

    def state(self, robot, latched, applied, stop_gen):
        r = self.robot(robot)
        r.stop_gen, r.latched = max(r.stop_gen, stop_gen), latched
        tr = r.transfer
        if not tr or self.clock() >= tr.deadline or not latched or applied != [0, 0, 0] or stop_gen <= tr.stop_gen:
            return []
        at = self.clock()
        r.transfer = None
        r.holder = Holder(tr.actor, self.ids(), at, at, 'USER' if tr.actor else 'RUN')
        effects = [self.effect('agent', robot, t='lease', lease_id=r.holder.lease_id, holder_type=r.holder.holder_type),
                   self.announce(robot), self.audit(robot, 'TAKE', tr.actor)]
        if tr.request:
            effects += [*self.result(robot, tr.request, 'ACCEPTED'),
                        self.audit(robot, 'ACCEPT', tr.request.holder, tr.actor)]
        return effects

    def tick(self):
        effects, at = [], self.clock()
        for robot, r in self.robots.items():
            if r.transfer and at >= r.transfer.deadline:
                tr, r.transfer = r.transfer, None
                effects += [self.announce(robot), self.audit(robot, 'STOP_CONFIRM_FAILED', tr.actor)]
                if tr.request:
                    effects += self.result(robot, tr.request, 'CANCELED', 'STOP_CONFIRM_FAILED')
                elif tr.actor:
                    effects += [self.effect(tr.actor.connection, robot, t='lease.result', request_id=None,
                                            result='CANCELED', error='STOP_CONFIRM_FAILED')]
            if r.request and at >= r.request.deadline:
                req, r.request = r.request, None
                r.cooldown[req.actor.user] = at + 30
                effects += [*self.result(robot, req, 'TIMEOUT'), self.audit(robot, 'TIMEOUT', req.actor, req.holder)]
            if r.holder and r.holder.actor and at - r.holder.heartbeat >= 15:
                effects += self.revoke(robot, op='EXPIRE')
        return effects
