"""WebSocket transport and effect adapter; safe outputs never wait for audit writes.

A single ASGI process owns the arbiter. SQL reads run off the event loop, use no
row/advisory locks and never update session.last_seen_at. Audit writes have their
own connection pool/worker; a blocked insert cannot delay STOP or lease null.
"""
import asyncio
from contextlib import suppress
from dataclasses import dataclass, field, replace
from datetime import timedelta
import json
import hmac
import logging
import time
from concurrent.futures import ThreadPoolExecutor
from uuid import UUID, uuid4

from fastapi import Request, WebSocket, WebSocketDisconnect
from pydantic import TypeAdapter, ValidationError
from sqlalchemy import create_engine, select, text
from sqlalchemy.orm import sessionmaker
from sqlalchemy.exc import DBAPIError, DataError, IntegrityError, StatementError, TimeoutError as PoolTimeout

from apps.contracts import models as C
from .leases import Actor, Arbiter, Effect, LeaseError, Transfer
from .models import Event, LeaseLog, Organization, Robot, Session, User, now
from .security import digest

log = logging.getLogger(__name__)
SCREEN = TypeAdapter(C.ScreenMessage)
AGENT = TypeAdapter(C.AgentMessage)
MAX_FRAME = 4096
DB_RETRY_GRACE = 5.0
HELLO_TIMEOUT = 3.0
DB_READ_TIMEOUT = 2.0
TRANSIENT_DB = (DBAPIError, OSError, asyncio.TimeoutError, PoolTimeout)
SAFETY_CODES = {'SERVER_LINK_LOST', 'LINK_LOSS_TIMEOUT', 'EXECUTOR_STALLED',
                'PROTOCOL_MISMATCH', 'TRANSPORT_BACKPRESSURE', 'STOP_GEN_EXHAUSTED'}


class AuditQueue(asyncio.Queue):
    """Safety records bypass ordinary event history, FIFO within each class."""
    @staticmethod
    def urgent(effect):
        body = effect.body
        return (body.get('op') in ('STOP', 'STOP_CONFIRM_FAILED')
                or body.get('code') in SAFETY_CODES
                or body.get('severity', '').upper() in ('ERROR', 'CRITICAL', 'BAD'))

    def _put(self, effect):
        if self.urgent(effect):
            index = next((i for i, item in enumerate(self._queue) if not self.urgent(item)), len(self._queue))
            self._queue.insert(index, effect)
        else:
            self._queue.append(effect)


class BoundAgentHeaders(dict):
    """Server-created binding; no HTTP header can set this attribute."""
    def __init__(self, headers, robot):
        super().__init__(headers)
        self.bound_robot = robot


class ReadAhead:
    """Bounded overlapping read-only snapshots; freshness is always start-based.

    A slow read occupies its slot until its thread actually exits, including
    after a consumer timeout. Never build an unbounded executor backlog.
    """
    def __init__(self, read, clock, executor):
        self.read, self.clock = read, clock
        self.executor = executor
        self.pending = {}
        self.latest = None
        self.stamp = float('-inf')
        self.changed = asyncio.Event()
        self.next_start = float('-inf')
        self.task = asyncio.create_task(self.run())

    async def run(self):
        try:
            while True:
                for task, started in list(self.pending.items()):
                    if task.done():
                        self.pending.pop(task)
                        try:
                            result = task.result()
                        except Exception as exc:
                            result = exc
                        if started >= self.stamp:
                            self.latest, self.stamp = result, started
                            self.changed.set()
                if len(self.pending) < 21 and self.clock() >= self.next_start:
                    started = self.clock()
                    self.pending[asyncio.get_running_loop().run_in_executor(self.executor, self.read)] = started
                    self.next_start = started + 0.025
                await asyncio.sleep(0.005)
        finally:
            # Observe late thread results without creating replacement work.
            for task in self.pending:
                task.add_done_callback(lambda t: t.exception() if not t.cancelled() else None)

    async def next(self):
        async with asyncio.timeout(DB_READ_TIMEOUT):
            await self.changed.wait()
        self.changed.clear()
        if isinstance(self.latest, Exception):
            raise self.latest
        return self.latest, self.stamp

    async def close(self):
        self.task.cancel()
        await asyncio.gather(self.task, return_exceptions=True)


@dataclass
class Peer:
    socket: WebSocket
    queue: asyncio.Queue = field(default_factory=lambda: asyncio.Queue(128))
    actor: Actor | None = None
    subscriptions: dict[str, set[str]] = field(default_factory=dict)
    last_rx: float = 0
    last_ping: float = 0
    state: dict = field(default_factory=dict)
    run: dict | None = None
    closing: bool = False
    policy: object = None
    budget: float = 100
    budget_at: float = 0
    revoke_on_close: bool = False
    archive_budget: float = 100
    archive_budget_at: float = 0
    auth_checked: float = 0
    stale_revoked: bool = False
    auth_task: object = None
    audit_waiting: bool = False
    urgent: asyncio.Queue = field(default_factory=lambda: asyncio.Queue(128))
    send_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    archive: asyncio.Queue = field(default_factory=lambda: AuditQueue(1024))
    state_sent: float = float('-inf')


@dataclass(frozen=True)
class Policy:
    rights: dict[str, frozenset[str]]
    settings: C.OrgSettings
    expires_at: object
    checked: float



class Realtime:
    def __init__(self, settings, factory, authorize, api_error, clock=time.monotonic):
        self.settings = settings
        # Enough lazy connection slots for bounded overlapping auth reads. A
        # ten-connection pool would serialize 450ms snapshots back into staleness.
        self.read_engine = create_engine(settings.database_url, pool_size=16, max_overflow=48, pool_timeout=2,
            connect_args={'options': '-c default_transaction_read_only=on -c statement_timeout=2000',
                          'connect_timeout': 2, 'keepalives': 1, 'keepalives_idle': 2,
                          'keepalives_interval': 1, 'keepalives_count': 2, 'tcp_user_timeout': 5000})
        self.factory = sessionmaker(self.read_engine, expire_on_commit=False)
        self.authorize, self.api_error, self.clock = authorize, api_error, clock
        self.arbiter = Arbiter(clock)
        self.screens: dict[str, Peer] = {}
        self.agents: dict[str, Peer] = {}
        self.runs: dict[str, dict] = {}  # executor persistence is a later task
        self.audit = AuditQueue(4096)
        self.audit_engine = create_engine(settings.database_url, pool_size=1, max_overflow=0,
                                         connect_args={'options': '-c lock_timeout=1000 -c statement_timeout=2000'})
        self.audit_factory = sessionmaker(self.audit_engine, expire_on_commit=False)
        self.tasks = []
        self.failed = False
        self.owner_connection = None
        self.starts = 0
        self.policy_cache = {}
        self.policy_loads = {}
        self.auth_executor = ThreadPoolExecutor(max_workers=64, thread_name_prefix='fh-auth')
        self.archive_tasks = set()
        self.audit_groups = {}
        self.audit_dropped = 0
        self.audit_overloaded = False
        self.audit_budget = 20.0
        self.audit_budget_at = self.clock()
        self.effect_depth = 0
        self.free_pending = False
        self.owner_uncertain = False
        self.owner_error_since = None
        self.owner_task = None
        self.owner_cleanup = set()

    def dispose_owner(self, pending, connection):
        async def finish():
            result = None
            with suppress(BaseException):
                result = await asyncio.shield(pending)
            connections = [connection] if connection is not None else []
            if hasattr(result, 'close') and result not in connections:
                connections.append(result)
            for conn in connections:
                with suppress(Exception):
                    await self.read(conn.close)
        task = asyncio.create_task(finish())
        self.owner_cleanup.add(task)
        task.add_done_callback(self.owner_cleanup.discard)
        return task

    async def read(self, function, *args):
        async with asyncio.timeout(DB_READ_TIMEOUT):
            return await asyncio.to_thread(function, *args)

    async def pending_read(self, task):
        async with asyncio.timeout(DB_READ_TIMEOUT):
            return await asyncio.shield(task)

    async def start(self):
        self.starts += 1
        if self.starts > 1:
            return
        # Memory leases require exactly one live authority per organization.
        # This session lock is only a startup guard, never an input-path lock.
        self.owner_connection = self.read_engine.connect()
        key = 'fh-realtime:' + str(self.settings.org_id)
        acquired = self.owner_connection.scalar(text(
            'SELECT pg_try_advisory_lock(hashtextextended(:key, 0))'), {'key': key})
        self.owner_connection.commit()
        if not acquired:
            self.owner_connection.close()
            self.owner_connection = None
            # REST replicas may serve authentication/accounts, but cannot open
            # another realtime authority or accept a STOP they cannot deliver.
            self.failed = True
        self.tasks = [asyncio.create_task(self.ticker()), asyncio.create_task(self.auditor()),
                      asyncio.create_task(self.ownership_watch())]

    def ownership_alive(self):
        alive = self.owner_connection.scalar(text("SELECT EXISTS (SELECT 1 FROM pg_locks "
            "WHERE pid=pg_backend_pid() AND locktype='advisory' AND granted)"))
        self.owner_connection.commit()
        return alive

    def acquire_owner(self):
        conn = self.read_engine.connect()
        acquired = conn.scalar(text('SELECT pg_try_advisory_lock(hashtextextended(:key, 0))'),
                               {'key': 'fh-realtime:' + str(self.settings.org_id)})
        conn.commit()
        if not acquired:
            conn.close()
            return None
        return conn

    async def ownership_watch(self):
        while True:
            await asyncio.sleep(0.5)
            if self.failed:
                try:
                    if self.owner_task is None:
                        self.owner_task = asyncio.create_task(asyncio.to_thread(self.acquire_owner))
                    try:
                        conn = await self.pending_read(self.owner_task)
                    finally:
                        if self.owner_task.done():
                            self.owner_task = None
                except Exception:
                    continue
                if conn is not None:
                    self.owner_connection = conn
                    self.failed = False  # recovery never restores any old lease
                    self.owner_uncertain = False
                    self.owner_error_since = None
                continue
            try:
                if self.owner_task is None:
                    self.owner_task = asyncio.create_task(asyncio.to_thread(self.ownership_alive))
                try:
                    alive = await self.pending_read(self.owner_task)
                finally:
                    if self.owner_task.done():
                        self.owner_task = None
            except TRANSIENT_DB:
                if not self.owner_uncertain:
                    self.owner_uncertain = True
                    self.owner_error_since = self.clock()
                    self.emergency_free()
                with suppress(Exception):
                    await self.read(self.owner_connection.rollback) if self.owner_task is None else None
                if self.clock() - self.owner_error_since < DB_RETRY_GRACE:
                    continue
                alive = False
            except Exception:
                alive = False
            if alive:
                self.owner_uncertain = False
                self.owner_error_since = None
            if not alive:
                self.failed = True
                self.emergency_free()
                for peer in [*self.agents.values(), *self.screens.values()]:
                    asyncio.create_task(peer.socket.close(code=1013))
                connection, self.owner_connection = self.owner_connection, None
                if self.owner_task is not None:
                    task, self.owner_task = self.owner_task, None
                    self.dispose_owner(task, connection)
                else:
                    with suppress(Exception):
                        await self.read(connection.close)

    async def close(self):
        if self.starts <= 0:
            return
        self.starts -= 1
        if self.starts:
            return
        for task in self.archive_tasks:
            task.cancel()
        await asyncio.gather(*self.archive_tasks, return_exceptions=True)
        for task in self.tasks:
            task.cancel()
        await asyncio.gather(*self.tasks, return_exceptions=True)
        await asyncio.gather(*(p.close() for p in self.policy_loads.values()))
        self.policy_loads.clear()
        self.auth_executor.shutdown(wait=False, cancel_futures=True)
        connection, self.owner_connection = self.owner_connection, None
        if self.owner_task is not None:
            pending, self.owner_task = self.owner_task, None
            self.dispose_owner(pending, connection)
        elif connection is not None:
            def release():
                try:
                    connection.execute(text('SELECT pg_advisory_unlock(hashtextextended(:key, 0))'),
                        {'key': 'fh-realtime:' + str(self.settings.org_id)})
                finally:
                    connection.close()
            with suppress(Exception):
                await self.read(release)
        self.audit_engine.dispose()
        self.read_engine.dispose()

    def identity(self, headers, cookies, connection):
        """Read-only identity: deliberately does not call REST's writing identity."""
        auth = headers.get('authorization')
        if auth:
            raw, client = (auth[7:], 'app') if auth.startswith('Bearer ') else ('', 'app')
        else:
            raw, client = cookies.get('fh_s'), 'web'
        if not raw:
            raise self.api_error(401, 'AUTH_REQUIRED', '로그인이 필요합니다.')
        with self.factory() as db:
            session = db.scalar(select(Session).where(Session.org_id == self.settings.org_id,
                Session.client == client, Session.token_hash == digest(raw),
                Session.revoked_at.is_(None), Session.expires_at > now()))
            user = db.get(User, session.user_id) if session else None
            if not user or user.locked or user.archived_at or user.org_id != self.settings.org_id:
                raise self.api_error(401, 'AUTH_REQUIRED', '로그인이 필요합니다.')
            self.authorize(user, 'LOGIN')
            return Actor(str(user.id), str(session.id), connection, user.display_name, user.role)

    def access(self, actor, robots, permission, with_settings=False):
        with self.factory() as db:
            # Recheck identity and ownership for *each* operation and delivery.
            user, session = db.get(User, UUID(actor.user)), db.get(Session, UUID(actor.session))
            if (not user or user.org_id != self.settings.org_id or user.locked or user.archived_at
                    or not session or session.org_id != self.settings.org_id or session.user_id != user.id
                    or session.revoked_at or session.expires_at <= now()):
                raise self.api_error(401, 'AUTH_REQUIRED', '로그인이 필요합니다.')
            self.authorize(user, 'LOGIN')
            for rid in robots:
                robot = db.get(Robot, UUID(rid))
                if not robot:
                    raise self.api_error(404, 'NOT_FOUND', '로봇을 찾을 수 없습니다.')
                self.authorize(user, permission, robot)
            return C.OrgSettings.model_validate(db.get(Organization, user.org_id).settings) if with_settings else None

    def load_policy(self, actor):
        checked = self.clock()
        # Two SELECTs, independent of the number of subscribed robots. No writes.
        with self.factory() as db:
            row = db.execute(select(User, Session, Organization).join(Session,
                Session.user_id == User.id).join(Organization, Organization.id == User.org_id).where(
                User.id == UUID(actor.user), Session.id == UUID(actor.session),
                User.org_id == self.settings.org_id, Session.org_id == self.settings.org_id)).first()
            if not row:
                raise self.api_error(401, 'AUTH_REQUIRED', '로그인이 필요합니다.')
            user, session, org = row
            if user.locked or user.archived_at or session.revoked_at or session.expires_at <= now():
                raise self.api_error(401, 'AUTH_REQUIRED', '로그인이 필요합니다.')
            self.authorize(user, 'LOGIN')
            rights = {}
            for robot in db.scalars(select(Robot).where(Robot.org_id == self.settings.org_id,
                                                        Robot.archived_at.is_(None))):
                allowed = set()
                for permission in ('ROBOT_SUMMARY', 'ROBOT_READ', 'O_OWN'):
                    try:
                        self.authorize(user, permission, robot)
                        allowed.add(permission)
                    except self.api_error:
                        pass
                rights[str(robot.id)] = frozenset(allowed)
            return Policy(rights, C.OrgSettings.model_validate(org.settings), session.expires_at, checked)

    async def refresh_policy(self, peer):
        sid = peer.actor.session
        cached = self.policy_cache.get(sid)
        if cached is None or self.clock() - cached.checked >= 0.025:
            pending = self.policy_loads.get(sid)
            if pending is None:
                pending = ReadAhead(lambda: self.load_policy(peer.actor), self.clock, self.auth_executor)
                self.policy_loads[sid] = pending
            cached, started = await pending.next()
            # Include executor scheduling/pool waits in the authorization age.
            cached = replace(cached, checked=min(started, cached.checked))
            self.policy_cache[sid] = cached
        peer.policy = cached

    def cached_access(self, peer, robots, permission, *, safety=False):
        policy = peer.policy
        if policy is None or policy.expires_at <= now() or peer.closing:
            raise self.api_error(401, 'AUTH_REQUIRED', '로그인이 필요합니다.')
        # Previously verified STOP scope stays usable during a slow refresh.
        # Motion is disabled once its authorization snapshot is 500 ms old.
        if not safety and self.clock() - policy.checked > 0.5:
            raise LeaseError('POLICY_STALE', '권한 확인을 기다리고 있습니다.', 503)
        for rid in robots:
            if permission not in policy.rights.get(rid, ()):
                raise self.api_error(404 if permission != 'O_OWN' else 403,
                                     'NOT_FOUND' if permission != 'O_OWN' else 'NOT_ROBOT_OWNER',
                                     '로봇 접근 권한이 없습니다.')
        return policy.settings

    def revoke_actor(self, actor):
        for rid, r in self.arbiter.robots.items():
            if (r.holder and r.holder.actor == actor) or (r.transfer and r.transfer.actor == actor):
                self.apply(self.arbiter.revoke(rid, actor))
            elif r.request and r.request.actor == actor:
                self.apply(self.arbiter.cancel_request(rid))

    def disconnect_pending(self, actor):
        for rid, r in self.arbiter.robots.items():
            if r.request and r.request.actor == actor:
                self.apply(self.arbiter.cancel_request(rid))
            if r.transfer and r.transfer.actor == actor:
                self.apply(self.arbiter.revoke(rid, actor))

    async def deny_screen(self, peer, code):
        peer.revoke_on_close = True
        self.revoke_actor(peer.actor)
        await peer.socket.close(code=code)

    def ingress_allowed(self, peer, *, archive=False):
        at = self.clock()
        budget, stamp = ('archive_budget', 'archive_budget_at') if archive else ('budget', 'budget_at')
        balance = min(100.0, getattr(peer, budget) + max(0, at - getattr(peer, stamp)) * 100)
        setattr(peer, stamp, at)
        setattr(peer, budget, balance - 1 if balance >= 1 else balance)
        return balance >= 1

    async def retry_later(self, ws):
        # A pre-accept ASGI close becomes HTTP 403 in uvicorn. Negotiate first
        # so transient unavailability stays a retryable 1013 on the wire.
        await ws.accept()
        await ws.close(code=1013)

    def finish_effects(self):
        if self.effect_depth == 0 and self.free_pending:
            self.free_pending = False
            self.emergency_free()

    def queue_audit(self, effect):
        try:
            self.audit.put_nowait(effect)
            return True
        except asyncio.QueueFull:
            self.audit_dropped += effect.body.get('_count', 1)
            if not self.audit_overloaded:
                self.audit_overloaded = True
                self.free_pending = True
                self.finish_effects()
            return False

    def note_audit(self, rid, body):
        # Preserve transitions individually; repeatable external input is bounded
        # by (robot, user, code), 256 groups and a global 20/s first-event budget.
        op = body['op']
        stamped = Effect('audit', rid, {**body, 'at': now()})
        critical = op in ('TAKE', 'RELEASE', 'REQUEST', 'ACCEPT', 'DECLINE', 'TIMEOUT',
                          'EXPIRE', 'RUN_PAUSE_TAKEOVER', 'STOP_CONFIRM_FAILED')
        if critical:
            self.queue_audit(stamped)
            return
        key = (rid, body.get('user_id'), body.get('code', op))
        at = self.clock()
        group = self.audit_groups.get(key)
        if group is not None:
            group['count'] += 1
            return
        self.audit_budget = min(20.0, self.audit_budget + max(0, at - self.audit_budget_at) * 20)
        self.audit_budget_at = at
        if len(self.audit_groups) >= 256 or self.audit_budget < 1:
            self.audit_dropped += 1
            return
        self.audit_budget -= 1
        self.audit_groups[key] = {'effect': stamped, 'since': at, 'count': 0}
        self.queue_audit(stamped)

    def flush_audits(self):
        at = self.clock()
        for key, group in list(self.audit_groups.items()):
            if at - group['since'] < 1:
                continue
            count = group['count']
            if count:
                effect = group['effect']
                body = {**effect.body, 'at': now(), '_count': count, 'data': {**effect.body.get('data', {}), 'count': count}}
                self.queue_audit(Effect('audit', effect.robot, body))
                group['count'] = 0
                group['since'] = at
            else:
                self.audit_groups.pop(key, None)
        if self.audit_overloaded and self.audit.qsize() < max(1, self.audit.maxsize // 4):
            self.audit_overloaded = False
        if self.audit_dropped and self.audit.qsize() < max(1, self.audit.maxsize // 4) and self.arbiter.robots:
            rid = next(iter(self.arbiter.robots))
            count, self.audit_dropped = self.audit_dropped, 0
            self.queue_audit(Effect('audit', rid, {'op': 'AUDIT_DROPPED', 'at': now(), 'data': {'count': count}}))

    def agent_identity(self, headers):
        raw = headers.get('authorization', '')
        if not raw.startswith('Bearer ') or not raw[7:]:
            raise self.api_error(401, 'AUTH_REQUIRED', '에이전트 인증이 필요합니다.')
        with self.factory() as db:
            candidate = digest(raw[7:])
            # Established sockets already have a robot binding. Recheck exactly
            # that row (including archive/token rotation), never the whole fleet.
            bound = getattr(headers, 'bound_robot', None)
            query = select(Robot).where(Robot.org_id == self.settings.org_id,
                                         Robot.archived_at.is_(None))
            if bound is not None:
                query = query.where(Robot.id == UUID(bound))
            robots = db.scalars(query).all()
            matches = [robot for robot in robots
                       if hmac.compare_digest(robot.agent_token_hash or b'\x00' * 32, candidate)]
            if len(matches) != 1:
                raise self.api_error(403, 'FORBIDDEN', '에이전트 인증을 확인하세요.')
            return str(matches[0].id)

    def put(self, peer, body):
        if peer.closing:
            return
        try:
            (peer.urgent if body.get('t') == 'reply' else peer.queue).put_nowait(body)
        except asyncio.QueueFull:
            peer.closing = True
            asyncio.create_task(peer.socket.close(code=1013))

    def apply(self, effects):
        """Synchronous effect enqueue. First two revoke effects cannot interleave."""
        self.effect_depth += 1
        try:
            for effect in effects:
                body, rid = dict(effect.body), effect.robot
                target = effect.target
                if target == 'agent':
                    peer = self.agents.get(rid)
                    if peer:
                        if body['t'] == 'lease' and body['holder_type'] == 'RUN':
                            self.runs[rid]['lease_id'] = body['lease_id']
                            body['holder_type'] = 'RUN:' + self.runs[rid]['run_id']
                        if body['t'] in ('cmd', 'unlock') or (body['t'] == 'lease' and body['lease_id'] is not None):
                            if self.owner_uncertain or self.clock() - peer.auth_checked > 0.5:
                                continue
                        if body['t'] == 'cmd':
                            body['t_server'] = now().isoformat().replace('+00:00', 'Z')
                        # Safety transitions discard any unsent movement inputs. They
                        # keep lease-null/stop order and bypass queued telemetry/ping.
                        if body['t'] in ('stop', 'lease', 'cmd'):
                            retained = []
                            while not peer.queue.empty():
                                item = peer.queue.get_nowait()
                                if item.get('t') not in ('cmd', 'ping', 'streams'):
                                    retained.append(item)
                            for item in retained:
                                peer.queue.put_nowait(item)
                        self.put(peer, body)
                elif target == 'audit':
                    self.note_audit(rid, body)
                else:
                    body['robot'] = rid
                    if body['t'] == 'lease':
                        owner = body.pop('connection')
                        since = body.get('since')
                        body['since'] = (now() - timedelta(seconds=max(0, self.clock() - since))).isoformat().replace('+00:00', 'Z') if since is not None else None
                    else:
                        owner = None
                    if 'expires_in' in body:
                        body['expires_at'] = (now() + timedelta(seconds=body.pop('expires_in'))).isoformat().replace('+00:00', 'Z')
                    recipients = list(self.screens.items()) if target == 'screens' else [(target, self.screens.get(target))]
                    for cid, peer in recipients:
                        if not peer or (target == 'screens' and rid not in peer.subscriptions and cid != owner):
                            continue
                        outgoing = dict(body)
                        if body['t'] == 'lease' and cid != owner:
                            outgoing.pop('lease_id', None)
                        # Delivery checks the latest authorization snapshot; no
                        # per-message SQL can block the safety path.
                        self.put(peer, {'_delivery': outgoing})
        finally:
            self.effect_depth -= 1
            self.finish_effects()

    def emergency_free(self):
        # Use the same purge and notifications as ordinary revocation, without
        # adding more audit work while recovering from audit backpressure.
        for rid in self.arbiter.robots:
            effects = self.arbiter.revoke(rid)
            self.apply([effect for effect in effects if effect.target != 'audit'])

    async def send_body(self, peer, body):
        async with peer.send_lock:
            await asyncio.wait_for(peer.socket.send_json(body), timeout=0.25)

    async def replies(self, peer):
        try:
            while True:
                await self.send_body(peer, await peer.urgent.get())
        except (WebSocketDisconnect, RuntimeError, asyncio.TimeoutError):
            peer.closing = True
            with suppress(Exception):
                await peer.socket.close(code=1013)

    async def writer(self, peer, screen=False):
        try:
            while True:
                body = await peer.queue.get()
                if '_delivery' in body:
                    body = body['_delivery']
                    try:
                        async with asyncio.timeout(DB_RETRY_GRACE):
                            while True:
                                try:
                                    self.cached_access(peer, [body['robot']], 'ROBOT_READ')
                                    break
                                except LeaseError:
                                    try:
                                        await self.refresh_policy(peer)
                                        await asyncio.sleep(0)
                                    except TRANSIENT_DB:
                                        await asyncio.sleep(0.1)
                    except self.api_error as exc:
                        await self.deny_screen(peer, 4401 if exc.status == 401 else 4403)
                        return
                await self.send_body(peer, body)
        except (WebSocketDisconnect, RuntimeError, asyncio.TimeoutError):
            peer.closing = True
            with suppress(Exception):
                await peer.socket.close(code=1013)

    async def receive(self, ws, *, agent=False):
        packet = await ws.receive()
        if packet['type'] == 'websocket.disconnect':
            raise WebSocketDisconnect(packet.get('code', 1000))
        raw = packet.get('text')
        if agent and raw is None:
            return None  # binary relay is not implemented
        if raw is None or len(raw.encode('utf-8')) > MAX_FRAME:
            await ws.close(code=1009 if raw is not None else 1003)
            raise WebSocketDisconnect(1009)
        try:
            data = json.loads(raw)
            if not isinstance(data, dict):
                raise ValueError()
            return data
        except (ValueError, RecursionError):
            if agent:
                return None
            await ws.close(code=1007)
            raise WebSocketDisconnect(1007)

    def streams(self):
        for rid, agent in self.agents.items():
            self.put(agent, {'t': 'streams', **{k: False for k in ('rgb', 'depth', 'lidar', 'map')}})

    async def screen_ws(self, ws: WebSocket):
        if self.owner_connection is None or self.failed:
            await self.retry_later(ws)
            return
        cid = str(uuid4())
        try:
            actor = await self.read(self.identity, ws.headers, ws.cookies, cid)
            if not ws.headers.get('authorization'):
                # Compare the full configured origin; never trust a forwarded
                # Origin or allow wildcards. Same-origin is the default.
                origin = ws.headers.get('origin')
                expected = self.settings.ws_origin or str(ws.base_url).rstrip('/').replace('wss:', 'https:').replace('ws:', 'http:')
                if not origin or origin != expected:
                    raise self.api_error(403, 'FORBIDDEN', '접속 출처를 확인하세요.')
        except self.api_error as exc:
            await ws.close(code=4401 if exc.status == 401 else 4403)
            return
        except TRANSIENT_DB:
            await self.retry_later(ws)
            return
        peer = Peer(ws, actor=actor, last_rx=self.clock(), budget_at=self.clock())
        try:
            await self.refresh_policy(peer)
        except self.api_error as exc:
            await ws.close(code=4401 if exc.status == 401 else 4403)
            return
        except TRANSIENT_DB:
            await self.retry_later(ws)
            return
        await ws.accept()
        self.screens[cid] = peer
        sender = asyncio.create_task(self.writer(peer, True))
        urgent_sender = asyncio.create_task(self.replies(peer))
        watcher = asyncio.create_task(self.screen_watch(peer))
        try:
            first = True
            while True:
                raw = await self.receive(ws)
                if not self.ingress_allowed(peer):
                    # Even the frame that closes a flooder may deliver a valid,
                    # previously authorized STOP. No other action is performed.
                    if raw.get('t') == 'stop':
                        try:
                            urgent = SCREEN.validate_python(raw)
                            self.cached_access(peer, [str(urgent.robot)], 'ROBOT_SUMMARY', safety=True)
                            self.apply(self.arbiter.stop(str(urgent.robot), actor))
                        except (ValidationError, self.api_error, LeaseError):
                            pass
                    await self.deny_screen(peer, 1013)
                    return
                if (first and raw.get('proto') != 'fh-rt/1') or ('proto' in raw and raw['proto'] != 'fh-rt/1'):
                    await self.deny_screen(peer, 4403)
                    return
                first = False
                try:
                    msg = SCREEN.validate_python(raw)
                    rid = str(msg.robot) if hasattr(msg, 'robot') else None
                    robots = [str(x) for x in msg.robots] if msg.t == 'sub' else ([rid] if rid else [])
                    policy = 'ROBOT_READ' if msg.t == 'sub' else ('ROBOT_SUMMARY' if msg.t == 'stop' else 'O_OWN' if rid else 'LOGIN')
                    safe = msg.t in ('stop', 'lease.release', 'hidden')
                    settings = self.cached_access(peer, robots, policy, safety=safe)
                    self.apply(self.arbiter.tick())  # expiry before new input
                    if (self.failed or self.audit_overloaded or self.owner_uncertain) and not safe:
                        raise LeaseError('SERVER_BUSY', '서버 기록을 확인하고 있습니다.', 503)
                    if msg.t == 'stop':
                        self.apply(self.arbiter.stop(rid, actor))
                    if msg.t == 'sub':
                        peer.subscriptions = {r: set(msg.streams) for r in robots}
                        self.streams()
                        for robot in robots:
                            self.apply([self.arbiter.announce(robot)])
                    elif msg.t == 'ping':
                        pass  # ping never extends a lease heartbeat
                    elif msg.t == 'stop':
                        pass
                    elif msg.t == 'lease.release':
                        self.apply(self.arbiter.release(rid, actor))
                    elif msg.t == 'hidden':
                        self.apply(self.arbiter.hidden(rid, actor))
                    else:
                        if rid not in self.agents or self.agents[rid].closing:
                            raise LeaseError('ROBOT_OFFLINE', '로봇 연결이 끊겼습니다.', 503)
                        if self.clock() - self.agents[rid].auth_checked > 0.5:
                            raise LeaseError('ROBOT_AUTH_PENDING', '로봇 인증 확인을 기다리고 있습니다.', 503)
                        if msg.t == 'lease.take':
                            r = self.arbiter.robot(rid)
                            if r.holder and r.holder.holder_type == 'RUN' and rid in self.runs:
                                self.runs[rid]['status'] = 'PAUSED'
                                self.put(self.agents[rid], {'t': 'run.control', 'run_id': self.runs[rid]['run_id'], 'op': 'pause'})
                            self.apply(self.arbiter.take(rid, actor))
                        elif msg.t == 'lease.request':
                            self.apply(self.arbiter.request(rid, actor, settings.lease_request_timeout_s))
                        elif msg.t == 'lease.respond':
                            pending = self.arbiter.robot(rid).request
                            if msg.accept and pending:
                                if pending.actor.connection not in self.screens:
                                    raise LeaseError('LEASE_REQUEST_STALE', '요청자 연결이 끊겼습니다.')
                                try:
                                    self.cached_access(self.screens[pending.actor.connection], [rid], 'O_OWN')
                                except (self.api_error, LeaseError):
                                    self.apply(self.arbiter.cancel_request(rid))
                                    raise LeaseError('LEASE_REQUEST_STALE', '요청자의 조종 권한이 바뀌었습니다.')
                                self.apply(self.arbiter.tick())
                            self.apply(self.arbiter.respond(rid, actor, str(msg.request_id), msg.accept))
                        elif msg.t == 'cmd':
                            self.apply(self.arbiter.cmd(rid, actor, str(msg.lease_id), msg.seq, msg.axes))
                        elif msg.t == 'unlock':
                            self.apply(self.arbiter.unlock(rid, actor, str(msg.lease_id), msg.stop_gen))
                    self.put(peer, C.ScreenReply(id=msg.id, ok=True).model_dump(mode='json'))
                except ValidationError:
                    self.put(peer, {'t': 'reply', 'id': str(raw.get('id', ''))[:128], 'ok': False,
                                    'error': {'code': 'VALIDATION', 'message': '입력 형식을 확인하세요.', 'detail': {}}})
                except (self.api_error, LeaseError) as exc:
                    if isinstance(exc, self.api_error) and (exc.status == 401 or msg.t == 'sub'):
                        await self.deny_screen(peer, 4401 if exc.status == 401 else 4403)
                        return
                    if isinstance(exc, LeaseError) and msg.t in ('cmd', 'unlock'):
                        self.apply([Effect('audit', rid, {'op': exc.code, 'user_id': actor.user})])
                    self.put(peer, {'t': 'reply', 'id': msg.id, 'ok': False,
                        'error': {'code': exc.code, 'message': exc.message, 'detail': {'status': exc.status}}})
        except (WebSocketDisconnect, asyncio.CancelledError):
            pass
        except Exception:
            log.warning('Screen connection failed; closing safely')
            with suppress(Exception):
                await ws.close(code=1013)
        finally:
            self.screens.pop(cid, None)
            if peer.revoke_on_close:
                self.revoke_actor(actor)
            # Ordinary socket loss retains the existing holder for 15 s, but
            # pending requests/transfers cannot survive a vanished connection.
            self.disconnect_pending(actor)
            sender.cancel()
            urgent_sender.cancel()
            watcher.cancel()
            with suppress(asyncio.CancelledError):
                await asyncio.gather(sender, urgent_sender, watcher, return_exceptions=True)
            if not any(p.actor.session == actor.session for p in self.screens.values()):
                pending = self.policy_loads.pop(actor.session, None)
                if pending:
                    pending.task.cancel()
                self.policy_cache.pop(actor.session, None)
            self.streams()

    async def screen_watch(self, peer):
        try:
            while True:
                await asyncio.sleep(0.01)
                try:
                    await self.refresh_policy(peer)
                    self.cached_access(peer, list(peer.subscriptions), 'ROBOT_READ')
                    for rid, r in self.arbiter.robots.items():
                        if (r.holder and r.holder.actor == peer.actor) or (r.transfer and r.transfer.actor == peer.actor):
                            self.cached_access(peer, [rid], 'O_OWN')
                    peer.stale_revoked = False
                except TRANSIENT_DB:
                    age = self.clock() - peer.policy.checked
                    if age > 0.5 and not peer.stale_revoked:
                        self.revoke_actor(peer.actor)
                        peer.stale_revoked = True
                    if age >= DB_RETRY_GRACE:
                        await self.deny_screen(peer, 1013)
                        return
                    continue
                except LeaseError:
                    # A stale snapshot is uncertainty, not an authorization denial.
                    self.revoke_actor(peer.actor)
                    if self.clock() - peer.policy.checked >= DB_RETRY_GRACE:
                        await self.deny_screen(peer, 1013)
                        return
                    continue
                except self.api_error as exc:
                    await self.deny_screen(peer, 4401 if exc.status == 401 else 4403)
                    return
                if self.clock() - peer.state_sent < .1:
                    continue
                peer.state_sent = self.clock()
                for rid, streams in peer.subscriptions.items():
                    if 'state' in streams:
                        agent = self.agents.get(rid)
                        state = dict(agent.state) if agent else {}
                        self.put(peer, C.ScreenState(robot=rid,
                            connection='ONLINE' if agent and not agent.closing else 'OFFLINE',
                            status=state.get('status'), battery=state.get('battery'),
                            location=state.get('location'), devices=state.get('devices', []),
                            speed=state.get('speed'), latency_ms=None, latched=state.get('latched'),
                            stop_gen=state.get('stop_gen'), applied=state.get('applied')).model_dump(mode='json'))
        except (WebSocketDisconnect, RuntimeError):
            return
        except Exception:
            with suppress(Exception):
                await self.deny_screen(peer, 1013)

    async def agent_watch(self, rid, peer):
        headers = BoundAgentHeaders(peer.socket.headers, rid)
        pending = ReadAhead(lambda: self.agent_identity(headers), self.clock, self.auth_executor)
        try:
            await self._agent_watch(rid, peer, pending)
        finally:
            await pending.close()

    async def _agent_watch(self, rid, peer, pending):
        while True:
            await asyncio.sleep(0.01)
            try:
                identity, started = await pending.next()
                if self.agents.get(rid) is not peer or peer.closing:
                    return
                if identity != rid:
                    raise self.api_error(403, 'FORBIDDEN', '에이전트 인증을 확인하세요.')
                peer.auth_checked = started
                peer.stale_revoked = False
            except TRANSIENT_DB:
                if self.agents.get(rid) is not peer:
                    return
                age = self.clock() - peer.auth_checked
                if age > 0.5 and not peer.stale_revoked:
                    self.apply(self.arbiter.revoke(rid, op='EXPIRE'))
                    peer.stale_revoked = True
                if age < DB_RETRY_GRACE:
                    continue
                await peer.socket.close(code=1013)
                return
            except self.api_error:
                if self.agents.get(rid) is peer:
                    self.apply(self.arbiter.revoke(rid, op='EXPIRE'))
                    await peer.socket.close(code=4403)
                return
            except Exception:
                if self.agents.get(rid) is peer:
                    self.apply(self.arbiter.revoke(rid, op='EXPIRE'))
                    with suppress(Exception):
                        await peer.socket.close(code=1013)
                return

    async def agent_ws(self, ws: WebSocket):
        if self.owner_connection is None or self.failed:
            await self.retry_later(ws)
            return
        try:
            auth_started = self.clock()
            rid = await self.read(self.agent_identity, ws.headers)
        except self.api_error as exc:
            await ws.close(code=4401 if exc.status == 401 else 4403)
            return
        except TRANSIENT_DB:
            await self.retry_later(ws)
            return
        await ws.accept()
        peer = Peer(ws, last_rx=self.clock(), last_ping=self.clock(), auth_checked=auth_started,
                    budget_at=self.clock(), archive_budget_at=self.clock())
        sender = watcher = archiver = None
        try:
            async with asyncio.timeout(HELLO_TIMEOUT):
                while True:
                    raw = await self.receive(ws, agent=True)
                    if not self.ingress_allowed(peer):
                        await ws.close(code=1013)
                        return
                    if isinstance(raw, dict) and raw.get('proto') not in (None, 'fh-agent/2'):
                        self.note_audit(rid, {'op': 'AGENT_PROTOCOL_MISMATCH', 'data': {'expected': 'fh-agent/2'}})
                        await ws.close(code=4406, reason='PROTOCOL_MISMATCH: expected fh-agent/2')
                        return
                    try:
                        hello = C.AgentHello.model_validate(raw)
                        break
                    except ValidationError:
                        self.note_audit(rid, {'op': 'AGENT_INVALID_FRAME'})
            old = self.agents.get(rid)
            if old:
                old.closing = True
                await old.socket.close(code=1012)
            self.agents[rid] = peer
            r = self.arbiter.robot(rid)
            fresh_reference = r.stop_ref < C.MAX_SAFE_INTEGER
            r.stop_gen = hello.stop_gen
            r.latched = hello.latched
            self.apply(self.arbiter.revoke(rid, op='EXPIRE'))
            peer.state = {'devices': [d.model_dump(mode='json') for d in hello.devices],
                          'latched': hello.latched, 'stop_gen': hello.stop_gen}
            run = hello.run.model_dump(mode='json') if hello.run else None
            if run and run['status'] not in ('COMPLETED', 'FAILED', 'ABORTED'):
                run['status'] = 'PAUSED'
                run['wait_reason'] = 'RECONNECTED'
                self.runs[rid] = run
                self.put(peer, {'t': 'run.control', 'run_id': run['run_id'], 'op': 'pause'})
                # RUN remains reserved after the same stop verification barrier.
                if fresh_reference:
                    r.transfer = Transfer(None, self.clock() + 2, r.stop_ref)
            else:
                self.runs.pop(rid, None)
            self.apply([Effect('audit', rid, {'op': 'AGENT_CONNECTED'})])
            sender = asyncio.create_task(self.writer(peer))
            watcher = asyncio.create_task(self.agent_watch(rid, peer))
            archiver = asyncio.create_task(self.agent_archive(peer))
            self.archive_tasks.add(archiver)
            archiver.add_done_callback(self.archive_tasks.discard)
            self.streams()
            while True:
                raw = await self.receive(ws, agent=True)
                if self.agents.get(rid) is not peer or peer.closing:
                    return
                archive = isinstance(raw, dict) and raw.get('t') == 'event'
                admitted = self.ingress_allowed(peer, archive=archive)
                if not admitted and not archive:
                    await ws.close(code=1013)
                    return
                if not isinstance(raw, dict) or not isinstance(raw.get('t'), str):
                    self.note_audit(rid, {'op': 'AGENT_INVALID_FRAME'})
                    continue
                # A parseable envelope proves transport liveness, even if its
                # body is invalid. No malformed body can grant new authority.
                peer.last_rx = self.clock()
                if raw.get('proto', 'fh-agent/2') != 'fh-agent/2':
                    self.note_audit(rid, {'op': 'AGENT_PROTOCOL_MISMATCH', 'data': {'expected': 'fh-agent/2'}})
                    await ws.close(code=4406, reason='PROTOCOL_MISMATCH: expected fh-agent/2')
                    return
                try:
                    msg = AGENT.validate_python(raw)
                except ValidationError:
                    self.note_audit(rid, {'op': 'AGENT_INVALID_FRAME'})
                    if not admitted:
                        await ws.close(code=1013)
                        return
                    continue
                if msg.t == 'hello':
                    # Same-socket recovery must get a fresh connection/identity.
                    await ws.close(code=1012, reason='RECONNECT_REQUIRED')
                    return
                self.apply(self.arbiter.tick())
                if msg.t == 'state':
                    self.accept_state(rid, peer, msg)
                elif msg.t == 'event':
                    effect = Effect('audit', rid, {'op': 'AGENT_EVENT', 'at': now(), **msg.model_dump(mode='json')})
                    # Parsing never waits behind archival pacing. Exhaustion is
                    # explicit and fail-safe rather than silently losing events.
                    try:
                        peer.archive.put_nowait(effect)
                    except asyncio.QueueFull:
                        self.note_audit(rid, {'op': 'AGENT_BACKLOG_OVERFLOW'})
                        self.apply(self.arbiter.revoke(rid, op='EXPIRE'))
                        await ws.close(code=1013, reason='AGENT_BACKLOG_OVERFLOW')
                        return
                    await asyncio.sleep(0)
                elif msg.t == 'run.update':
                    # Placeholder: accept matching paused/terminal reports only;
                    # no mission execution or persistence is claimed here.
                    run = self.runs.get(rid)
                    if run and run['run_id'] == str(msg.run_id) and msg.status in ('PAUSED', 'COMPLETED', 'FAILED', 'ABORTED'):
                        run.update(status=msg.status, step=msg.step)
                        holder = self.arbiter.robot(rid).holder
                        if (msg.status != 'PAUSED' and holder and holder.holder_type == 'RUN'
                                and run.get('lease_id') == holder.lease_id):
                            self.apply(self.arbiter.revoke(rid))
                # ping, cmd.ack, media are validated no-op extension points.
        except self.api_error:
            await ws.close(code=4403)
        except asyncio.TimeoutError:
            await ws.close(code=1013, reason='HELLO_TIMEOUT')
        except ValidationError:
            await ws.close(code=4406, reason='PROTOCOL_MISMATCH: expected fh-agent/2')
        except (WebSocketDisconnect, asyncio.CancelledError):
            pass
        except Exception:
            log.warning('Agent connection failed; closing safely')
            with suppress(Exception):
                await ws.close(code=1013)
        finally:
            if self.agents.get(rid) is peer:
                self.agents.pop(rid, None)
                self.apply(self.arbiter.revoke(rid, op='EXPIRE'))
                self.apply([Effect('audit', rid, {'op': 'AGENT_DISCONNECTED'})])
            peer.closing = True
            # Accepted history drains independently of the socket's cancellation
            # scope. The runtime owns this bounded worker until it empties.
            if archiver and peer.archive.empty():
                archiver.cancel()
            for task in (sender, watcher):
                if task:
                    task.cancel()
            with suppress(asyncio.CancelledError):
                await asyncio.gather(*(t for t in (sender, watcher) if t), return_exceptions=True)

    async def agent_archive(self, peer):
        """FIFO archival worker; state/STOP acknowledgements use the reader."""
        while True:
            effect = await peer.archive.get()
            while not self.ingress_allowed(peer, archive=True):
                await asyncio.sleep(0.01)
            if self.audit.full():
                self.audit_overloaded = True
                self.emergency_free()
            await self.audit.put(effect)
            peer.archive.task_done()
            if peer.closing and peer.archive.empty():
                return

    def accept_state(self, rid, peer, msg):
        if self.agents.get(rid) is not peer or peer.closing:
            return False
        if self.owner_uncertain or self.clock() - peer.auth_checked > 0.5:
            return False
        data = msg.model_dump(mode='json')
        peer.state.update({k: data[k] for k in ('speed', 'latched', 'stop_gen', 'applied')})
        peer.state['battery'] = C.Battery(soc=msg.battery.soc, updated_at=now()).model_dump(mode='json') if msg.battery.soc is not None else None
        # §10 pose does not carry a map_version_id; never invent the
        # map revision that §3 Location requires.
        peer.state['location'] = None
        run = self.runs.get(rid)
        peer.state['status'] = 'STOP_LATCHED' if msg.latched else 'PAUSED' if run and run['status'] == 'PAUSED' else 'RUNNING' if msg.mode == 'RUN' else 'TELEOP' if msg.mode == 'USER' else 'IDLE'
        if msg.devices_changed is not None:
            peer.state['devices'] = data['devices_changed']
        pending = self.arbiter.robot(rid).transfer
        if pending and pending.actor:
            try:
                target = self.screens.get(pending.actor.connection)
                if target is None:
                    raise LeaseError('LEASE_REQUEST_STALE', '요청자 연결이 끊겼습니다.')
                self.cached_access(target, [rid], 'O_OWN')
            except (self.api_error, LeaseError):
                self.apply(self.arbiter.revoke(rid, pending.actor))
        self.apply(self.arbiter.state(rid, msg.latched, msg.applied, msg.stop_gen, msg.stop_ref))
        return True

    async def ticker(self):
        while True:
            await asyncio.sleep(0.025)
            self.apply(self.arbiter.tick())
            self.flush_audits()
            at = self.clock()
            for rid, peer in list(self.agents.items()):
                if at - peer.last_rx >= 3 and not peer.closing and not peer.audit_waiting:
                    peer.closing = True
                    self.apply(self.arbiter.revoke(rid, op='EXPIRE'))
                    asyncio.create_task(peer.socket.close(code=1013))
                elif at - peer.last_ping >= 1 and not peer.closing:
                    peer.last_ping = at
                    self.put(peer, C.AgentServerPing(t_server=now()).model_dump(mode='json'))

    def record(self, effect):
        body, rid = effect.body, UUID(effect.robot)
        op = body['op']
        if op == 'TAKE' and not body.get('user_id'):
            op = 'RUN_TAKE'
        user = UUID(body['user_id']) if body.get('user_id') else None
        messages = {'TAKE': '조종권을 받았습니다.', 'RELEASE': '조종권을 반납했습니다.',
            'REQUEST': '조종권을 요청했습니다.', 'ACCEPT': '조종권을 넘겼습니다.',
            'DECLINE': '조종권 요청을 거절했습니다.', 'TIMEOUT': '응답이 없어 조종권 요청이 끝났습니다.',
            'EXPIRE': '조종권이 만료되었습니다.', 'STOP': '정지를 요청했습니다.',
            'RUN_PAUSE_TAKEOVER': '실행을 일시정지하고 사람이 조종권을 받았습니다.',
            'AUDIT_DROPPED': '감사 기록 일부를 묶거나 생략했습니다.',
            'STOP_CONFIRM_FAILED': '로봇 정지 확인에 실패했습니다.',
            'AGENT_CONNECTED': '로봇이 연결되었습니다.', 'AGENT_DISCONNECTED': '로봇 연결이 끊겼습니다.'}
        with self.audit_factory.begin() as db:
            if op in ('TAKE', 'RELEASE', 'REQUEST', 'ACCEPT', 'DECLINE', 'TIMEOUT', 'EXPIRE', 'RUN_TAKE', 'RUN_PAUSE_TAKEOVER'):
                db.add(LeaseLog(org_id=self.settings.org_id, robot_id=rid, op=op, user_id=user,
                    other_user_id=UUID(body['other_user_id']) if body.get('other_user_id') else None,
                    session_id=UUID(body['session_id']) if body.get('session_id') else None, at=body['at']))
            ev = Event(org_id=self.settings.org_id, robot_id=rid, user_id=user, at=body['at'],
                category='SAFETY' if op in ('STOP', 'STOP_CONFIRM_FAILED') else 'LINK' if op.startswith('AGENT_') else 'LEASE',
                code=body.get('code', op), severity=body.get('severity', 'INFO').upper(),
                message=messages.get(op, '로봇 상태 변화가 기록되었습니다.'),
                robot_at=body.get('robot_at'), data=body.get('data', {}))
            if isinstance(ev.robot_at, str):
                from datetime import datetime
                ev.robot_at = datetime.fromisoformat(ev.robot_at)
            db.add(ev)
            db.flush()
            return C.Event(
                id=str(ev.id), at=ev.at, robot_at=ev.robot_at, category=ev.category, code=ev.code,
                severity=ev.severity, message=ev.message, robot_id=rid, user_id=user,
                run_id=None, data=ev.data).model_dump(mode='json')

    @staticmethod
    def permanent_audit_error(exc):
        sqlstate = getattr(getattr(exc, 'orig', None), 'sqlstate', '') or ''
        if sqlstate[:2] in ('22', '23'):  # data exception / integrity constraint
            return True
        if isinstance(exc, (DataError, IntegrityError, UnicodeError, ValueError, TypeError)):
            return True
        if isinstance(exc, StatementError) and isinstance(exc.orig, (UnicodeError, ValueError, TypeError)):
            return True
        return not isinstance(exc, TRANSIENT_DB)

    async def auditor(self):
        while True:
            effect = await self.audit.get()
            while True:
                try:
                    ev = await asyncio.to_thread(self.record, effect)
                    self.apply([Effect('screens', effect.robot, {'t': 'event', **ev})])
                    break
                except Exception as exc:
                    if self.permanent_audit_error(exc):
                        log.warning('Realtime audit item quarantined (%s)', type(exc).__name__)
                        if effect.body.get('op') == 'AUDIT_QUARANTINED':
                            self.audit_dropped += 1
                            break
                        effect = Effect('audit', effect.robot, {'op': 'AUDIT_QUARANTINED',
                            'at': now(), 'data': {'count': 1, 'error_type': type(exc).__name__}})
                        continue
                    log.warning('Realtime audit unavailable; retrying')
                    await asyncio.sleep(0.5)
            self.audit.task_done()
            self.flush_audits()


def install(app, settings, factory, authorize, api_error):
    realtime = Realtime(settings, factory, authorize, api_error)
    app.state.realtime = realtime
    app.add_api_websocket_route('/api/v1/ws', realtime.screen_ws)
    app.add_api_websocket_route('/api/v1/agent/ws', realtime.agent_ws)

    def check_csrf(actor, headers):
        with realtime.factory() as db:
            session = db.get(Session, UUID(actor.session))
            csrf = headers.get('x-fh-csrf')
            if not csrf or not session or digest(csrf) != session.csrf_hash:
                raise api_error(403, 'FORBIDDEN', '요청 확인 값을 확인하세요.')

    @app.post('/api/v1/robots/{robot_id}/stop', status_code=202)
    async def stop(robot_id: UUID, request: Request):
        if realtime.owner_connection is None:
            raise api_error(503, 'SERVER_BUSY', '실시간 중재기 연결을 확인하세요.')
        actor = await asyncio.to_thread(realtime.identity, request.headers, request.cookies, str(uuid4()))
        # HTTP fallback retains CSRF (WS uses Origin). Read it without writing.
        if not request.headers.get('authorization'):
            await asyncio.to_thread(check_csrf, actor, request.headers)
        await asyncio.to_thread(realtime.access, actor, [str(robot_id)], 'ROBOT_SUMMARY')
        realtime.apply(realtime.arbiter.stop(str(robot_id), actor))
        return {'requested': True}
