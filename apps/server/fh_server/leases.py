"""Connection-bound lease state machine. No database, network, or wall clock I/O.

Callers apply returned effects in order. All deadlines use the injected monotonic
clock; UTC timestamps are presentation concerns in the transport adapter.
"""
from dataclasses import dataclass, field
from typing import Callable
from uuid import uuid4

MAX_SAFE_INTEGER = 2**53 - 1


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
    tokens: float = 3.0


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
    stop_ref: int
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
    stop_ref: int = 0  # causal server STOP reference; never wrap or reuse for grants
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

    def cancel(self, robot, actor):
        r = self.robot(robot)
        if r.request and r.request.actor == actor:
            return self.cancel_request(robot)
        # Accept may have won the race, but STOP confirmation has not granted
        # the lease yet. Cancel that transfer too, preserving lease-null/STOP.
        if r.transfer and r.transfer.request and r.transfer.actor == actor:
            return self.revoke(robot, actor)
        raise LeaseError('LEASE_REQUEST_STALE', '현재 연결의 요청이 끝났습니다.')

    def revoke(self, robot, actor=None, op='RELEASE'):
        r = self.robot(robot)
        h, tr = r.holder, r.transfer
        r.holder = r.transfer = None
        r.stop_ref = min(MAX_SAFE_INTEGER, r.stop_ref + 1)
        # Safety ordering is contractual: lease null reaches the agent before stop.
        effects = [self.effect('agent', robot, t='lease', lease_id=None, holder_type=None),
                   self.effect('agent', robot, t='stop', by_user_id=actor.user if actor else None, stop_ref=r.stop_ref),
                   self.announce(robot), *self.cancel_request(robot)]
        if h and h.actor:
            effects += [self.effect(h.actor.connection, robot, **self.announce(robot).body)]
        if tr and tr.request:
            effects += self.result(robot, tr.request, 'CANCELED')
        if op is not None and (h or tr):
            effects += [self.audit(robot, op, h.actor if h else tr.actor)]
        return effects

    def begin(self, robot, actor, req=None, op='RELEASE'):
        r = self.robot(robot)
        exhausted = r.stop_ref >= MAX_SAFE_INTEGER
        effects = self.revoke(robot, actor, op=op)
        if exhausted:
            # Safety STOP still goes out, but an exhausted reference may never
            # confirm another grant. Restart/reconciliation requires a new link.
            if req:
                effects += self.result(robot, req, 'CANCELED', 'STOP_REF_EXHAUSTED')
            elif actor:
                effects += [self.effect(actor.connection, robot, t='lease.result', request_id=None,
                                        result='CANCELED', error='STOP_REF_EXHAUSTED')]
            return effects
        r.transfer = Transfer(actor, self.clock() + 2, r.stop_ref, req)
        return effects

    def take(self, robot, actor):
        r = self.robot(robot)
        if r.holder and r.holder.holder_type == 'RUN' and not r.transfer:
            effects = self.begin(robot, actor, op=None)
            return effects + [self.audit(robot, 'RUN_PAUSE_TAKEOVER', actor)]
        if r.holder or r.transfer:
            raise LeaseError('LEASE_HELD', '다른 연결이 조종 중입니다.')
        return self.begin(robot, actor)

    def request(self, robot, actor, timeout=10):
        r = self.robot(robot)
        if self.clock() < r.cooldown.get(actor.user, float('-inf')):
            raise LeaseError('LEASE_REQUEST_COOLDOWN', '30초 뒤 다시 요청하세요.', 429)
        if r.transfer:
            raise LeaseError('LEASE_FREE', '조종권을 넘기고 있습니다.')
        if not r.holder or not r.holder.actor:
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

    def heartbeat(self, robot, actor, lease_id, seq, neutral=False):
        h = self.owned(self.robot(robot), actor, lease_id)
        if type(seq) is not int or not 0 <= seq <= MAX_SAFE_INTEGER or seq <= h.seq:
            raise LeaseError('CMD_SEQ', '명령 순서가 올바르지 않습니다.', 400)
        at = self.clock()
        # 20 Hz intent tolerates scheduler jitter and a burst of three. A zero
        # input is always safe to forward, even when the movement budget is gone.
        h.tokens = min(3.0, h.tokens + max(0, at - h.last_cmd) * 25)
        h.last_cmd = at
        if h.tokens < 1 and not neutral:
            raise LeaseError('CMD_RATE_LIMIT', '조종 입력이 너무 빠릅니다.', 429)
        h.tokens = max(0, h.tokens - 1)
        h.seq, h.last_cmd, h.heartbeat = seq, at, at

    def cmd(self, robot, actor, lease_id, seq, axes):
        self.heartbeat(robot, actor, lease_id, seq, axes == [0, 0, 0])
        return [self.effect('agent', robot, t='cmd', lease_id=lease_id, seq=seq, axes=axes)]

    def unlock(self, robot, actor, lease_id, stop_gen):
        r = self.robot(robot)
        self.owned(r, actor, lease_id)
        if type(stop_gen) is not int or not 0 <= stop_gen <= MAX_SAFE_INTEGER or stop_gen != r.stop_gen:
            raise LeaseError('STOP_GEN_MISMATCH', '정지 상태가 바뀌었습니다.')
        return [self.effect('agent', robot, t='unlock', lease_id=lease_id, stop_gen=stop_gen)]

    def stop(self, robot, actor):
        # Cancel an in-flight handoff so an old stop acknowledgement cannot grant it.
        r = self.robot(robot)
        tr, r.transfer = r.transfer, None
        r.stop_ref = min(MAX_SAFE_INTEGER, r.stop_ref + 1)
        effects = [self.effect('agent', robot, t='stop', by_user_id=actor.user, stop_ref=r.stop_ref)]
        if tr and tr.request:
            effects += self.result(robot, tr.request, 'CANCELED')
        elif tr and tr.actor:
            effects += [self.effect(tr.actor.connection, robot, t='lease.result', request_id=None, result='CANCELED')]
        return effects + [self.audit(robot, 'STOP', actor)]

    def state(self, robot, latched, applied, stop_gen, stop_ref=0):
        r = self.robot(robot)
        if (type(stop_gen) is not int or not 0 <= stop_gen <= MAX_SAFE_INTEGER
                or type(stop_ref) is not int or not 0 <= stop_ref <= MAX_SAFE_INTEGER):
            return []
        r.stop_gen, r.latched = max(r.stop_gen, stop_gen), latched
        tr = r.transfer
        if not tr or self.clock() >= tr.deadline or not latched or applied != [0, 0, 0] or stop_ref != tr.stop_ref:
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
