"""WebSocket transport and effect adapter; safe outputs never wait for audit writes.

A single ASGI process owns the arbiter. SQL reads run off the event loop, use no
row/advisory locks and never update session.last_seen_at. Audit writes have their
own connection pool/worker; a blocked insert cannot delay STOP or lease null.
"""
import asyncio
import threading
from contextlib import suppress
from dataclasses import dataclass, field, replace
from datetime import timedelta
import json
import hmac
import logging
import time
import weakref
from concurrent.futures import ThreadPoolExecutor
from uuid import UUID, uuid4
from types import SimpleNamespace, MappingProxyType
from functools import lru_cache
from collections.abc import Mapping
from collections import OrderedDict, deque

from fastapi import Request, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse
from pydantic import TypeAdapter, ValidationError
from sqlalchemy import create_engine, select, text, event, inspect, and_
from sqlalchemy.orm import sessionmaker, Session as ORMSession
from sqlalchemy.exc import DBAPIError, DataError, IntegrityError, StatementError, TimeoutError as PoolTimeout

from apps.contracts import models as C
from .leases import Actor, Arbiter, Effect, LeaseError, Transfer
from .inventory import InventoryWriter
from .robots import live_state
from .event_messages import render, CATEGORIES, AGENT_CODES
from .notifications import append_for_event
from .models import Event, LeaseLog, Organization, Robot, Session, User, now
from .floor_maps import approved_bindings, matches_context
from .security import digest
from .history import History, HistoryPending

log = logging.getLogger(__name__)
SCREEN = TypeAdapter(C.ScreenMessage)
AGENT = TypeAdapter(C.AgentMessage)
MAX_FRAME = 4096
DB_RETRY_GRACE = 5.0
HELLO_TIMEOUT = 3.0
DB_READ_TIMEOUT = 2.0
PHONE_ACK_STORAGE_TIMEOUT = 5.0
TRANSIENT_DB = (DBAPIError, OSError, asyncio.TimeoutError, PoolTimeout)
SAFETY_CODES = {'SERVER_LINK_LOST', 'LINK_LOSS_TIMEOUT', 'EXECUTOR_STALLED',
                'PROTOCOL_MISMATCH', 'TRANSPORT_BACKPRESSURE', 'STOP_GEN_EXHAUSTED',
                'LEASE_INVALID', 'BRIDGE_STATE_INVALID', 'HISTORY_STORAGE_BLOCKED'}


from .audit import AuditQueue, FairAuditQueue, SourceArchiveFull


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
    slots = weakref.WeakKeyDictionary()

    def __init__(self, read, clock, executor, *, offset=0, min_interval=.02):
        self.read, self.clock = read, clock
        self.executor = executor
        self.capacity = self.slots.setdefault(executor, asyncio.Semaphore(executor._max_workers))
        self.min_interval = min_interval
        self.cadence = min_interval
        self.limit = executor._max_workers
        self.pending = {}
        self.latest = None
        self.stamp = float('-inf')
        self.changed = asyncio.Event()
        self.last_latency = 0.0
        self.max_latency = 0.0
        self.submitted = self.completed = 0
        self.next_start = self.clock() + offset
        self.task = asyncio.create_task(self.run())
        self.task.add_done_callback(lambda _: self.changed.set())

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
                        duration = max(0, self.clock() - started)
                        self.last_latency = duration
                        self.max_latency = max(self.max_latency, duration)
                        self.completed += 1
                        self.cadence = max(self.min_interval, min(.1, (.5 - duration) / 4))
                        if started >= self.stamp:
                            self.latest, self.stamp = result, started
                            self.changed.set()
                if len(self.pending) < self.limit and self.clock() >= self.next_start and not self.capacity.locked():
                    await self.capacity.acquire()
                    started = self.clock()
                    try:
                        future = asyncio.get_running_loop().run_in_executor(self.executor, self.read)
                    except BaseException:
                        self.capacity.release()
                        raise
                    future.add_done_callback(lambda _: self.capacity.release())
                    self.submitted += 1
                    self.pending[future] = started
                    self.next_start = started + self.cadence
                await asyncio.sleep(0.002)
        finally:
            # Observe late thread results without creating replacement work.
            for task in self.pending:
                task.add_done_callback(lambda t: t.exception() if not t.cancelled() else None)

    async def next(self, after=None):
        async with asyncio.timeout(DB_READ_TIMEOUT):
            while self.stamp == float('-inf') or (after is not None and self.stamp <= after):
                if self.task.done():
                    self.task.result()
                self.changed.clear()
                await self.changed.wait()
        if self.task.done():
            self.task.result()
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
    simulation: bool = False
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
    archive: asyncio.Queue | None = None
    state_sent: float = float('-inf')
    state_received_at: float = float('-inf')
    delivery_epochs: dict = field(default_factory=dict)
    revoked_robots: set = field(default_factory=set)
    subscription_task: object = None
    phone_ack_queue: asyncio.Queue = field(default_factory=lambda: asyncio.Queue(128))
    phone_ack_pending: set = field(default_factory=set)
    phone_revoke_retry: int | None = None
    floor_token: tuple | None = None


@dataclass(frozen=True)
class Policy:
    rights: Mapping[str, frozenset[str]]
    settings: C.OrgSettings
    expires_at: object
    checked: float



@lru_cache(maxsize=256)
def policy_rights(authorize, api_error, user_values, robot_values):
    """Memoize pure ACL calculation, never DB reads or authorization age.

    Every value used by authorize comes from these hashable current SQL rows.
    Role/owner/archive/token/simulation changes select a new key; session validity and LOGIN
    are still checked on every batch. Cached maps cannot be mutated by a peer.
    """
    user = SimpleNamespace(**dict(zip(('id', 'org_id', 'role', 'locked', 'archived_at'), user_values)))
    rights = {}
    for values in robot_values:
        robot = SimpleNamespace(**dict(zip(
            ('id', 'org_id', 'archived_at', 'owner_user_id', 'agent_token_hash', 'simulation'), values)))
        allowed = set()
        for permission in ('ROBOT_SUMMARY', 'ROBOT_READ', 'O_OWN', 'ROBOT_STOP'):
            try:
                authorize(user, permission, robot)
                allowed.add(permission)
            except api_error as exc:
                if exc.code in ('ADMIN_NO_REAL_CONTROL', 'PHONE_DIRECT_REQUIRED'):
                    allowed.add(exc.code)
        rights[str(robot.id)] = frozenset(allowed)
    return MappingProxyType(rights)


class AgentBatch(dict):
    floor_authority = None


class PolicyBatch(dict):
    """Internal snapshots; robot rows already read for ACLs also verify tokens."""
    agents = None


class Realtime:
    def __init__(self, settings, factory, authorize, api_error, clock=time.monotonic):
        self.settings = settings
        # ACK commits have their own bounded write pool. A dead DB must not
        # retain a robot's single in-flight slot indefinitely after WS timeout.
        self.phone_ack_engine = create_engine(settings.database_url,pool_size=2,max_overflow=0,pool_timeout=.5,
            connect_args={'options':'-c statement_timeout=2000 -c lock_timeout=1000',
                          'connect_timeout':1,'keepalives':1,'keepalives_idle':1,
                          'keepalives_interval':1,'keepalives_count':2,'tcp_user_timeout':2000})
        self.phone_pass_factory = sessionmaker(self.phone_ack_engine,expire_on_commit=False)
        self.run_engine = create_engine(settings.database_url, pool_size=2, max_overflow=0, pool_timeout=.5,
            connect_args={'options': '-c statement_timeout=2000 -c lock_timeout=1000', 'connect_timeout': 1})
        self.run_factory = sessionmaker(self.run_engine, expire_on_commit=False)
        self.phone_pass_clock = time.time
        self.phone_ack_stores = {}
        self.phone_ack_contention = {}
        # Admission/HTTP reads cannot occupy any control or agent-auth slot.
        self.read_engine = create_engine(settings.database_url, pool_size=4, max_overflow=0, pool_timeout=2,
            connect_args={'options': '-c default_transaction_read_only=on -c statement_timeout=2000',
                          'connect_timeout': 2, 'keepalives': 1, 'keepalives_idle': 2,
                          'keepalives_interval': 1, 'keepalives_count': 2, 'tcp_user_timeout': 5000})
        self.factory = sessionmaker(self.read_engine, expire_on_commit=False)
        def relay_authorize(user, permission, robot=None):
            authorize(user, permission, robot)
            if (robot is not None and permission in ('O_OWN', 'ROBOT_STOP')
                    and robot.simulation is not True):
                raise api_error(403, 'PHONE_DIRECT_REQUIRED', '실기 조종·STOP은 현장 폰에서 직접 하세요.')
        self.authorize, self.api_error, self.clock = relay_authorize, api_error, clock
        self.last_state_received = {}
        self.arbiter = Arbiter(clock)
        self.screens: dict[str, Peer] = {}
        self.agents: dict[str, Peer] = {}
        self.robot_changes = set()
        self.robot_changed_at = {}
        self.deleted_robots = set()
        self.deleted_at = {}
        self.runs: dict[str, dict] = {}  # executor persistence is a later task
        self.audit = FairAuditQueue(self)
        self.audit_engine = create_engine(settings.database_url, pool_size=1, max_overflow=0,
                                         connect_args={'options': '-c lock_timeout=1000 -c statement_timeout=2000'})
        self.audit_factory = sessionmaker(self.audit_engine, expire_on_commit=False)
        self.inventory = InventoryWriter(settings, self.clock, lambda rid, error: self.note_audit(rid,
            {'op': 'AGENT_INVENTORY_FAILED', 'severity': 'WARN', 'data': {'error_type': error}}))
        self.tasks = []
        self.failed = False
        self.owner_connection = None
        self.starts = 0
        self.policy_cache = {}
        self.policy_loads = {}
        self.auth_executor = ThreadPoolExecutor(max_workers=8, thread_name_prefix='fh-view')
        self.control_executor = ThreadPoolExecutor(max_workers=32, thread_name_prefix='fh-control')
        self.agent_executor = ThreadPoolExecutor(max_workers=24, thread_name_prefix='fh-agent-auth')
        def reserved_engine(slots):
            return create_engine(settings.database_url, pool_size=slots, max_overflow=0, pool_timeout=2,
                connect_args={'options': '-c default_transaction_read_only=on -c statement_timeout=2000',
                              'connect_timeout': 2})
        self.view_engine = reserved_engine(8)
        self.control_engine = reserved_engine(32)
        self.agent_engine = reserved_engine(24)
        self.view_factory = sessionmaker(self.view_engine, expire_on_commit=False)
        self.control_factory = sessionmaker(self.control_engine, expire_on_commit=False)
        self.agent_factory = sessionmaker(self.agent_engine, expire_on_commit=False)
        self.stop_engine = create_engine(settings.database_url, pool_size=12, max_overflow=0, pool_timeout=2,
            connect_args={'options': '-c default_transaction_read_only=on -c statement_timeout=2000',
                          'connect_timeout': 2})
        self.stop_factory = sessionmaker(self.stop_engine, expire_on_commit=False)
        self.stop_executor = ThreadPoolExecutor(max_workers=12, thread_name_prefix='fh-stop')
        self.stop_slots = asyncio.Semaphore(12)
        self.stop_cache = OrderedDict()
        self.stop_cache_lock = threading.RLock()
        self.stop_cache_epoch = 0
        self.stop_changes = deque(maxlen=1024)
        self.stop_cache_ttl = .25
        self.stop_listeners = []
        self.policy_peers = {}
        self.policy_members = {}
        self.policy_controls = set()
        self.policy_pipelines = {}
        self.agent_pipeline = None
        self.archive_tasks = set()
        self.archive_closers = set()
        self.audit_groups = {}
        self.audit_dropped = 0
        self.source_drop_total = 0
        self.audit_overloaded = False
        self.audit_storage_failed = False
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
        self.watch_stop_invalidations()
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
        await self.inventory.close()
        for task in self.tasks + list(self.archive_closers):
            task.cancel()
        await asyncio.gather(*self.tasks, *self.archive_closers, return_exceptions=True)
        await asyncio.gather(*(p.close() for p in set(self.policy_pipelines.values()) | set(self.policy_loads.values())))
        self.policy_loads.clear()
        self.policy_pipelines.clear()
        self.policy_peers.clear()
        self.policy_members.clear()
        self.policy_cache.clear()
        self.policy_controls.clear()
        if self.agent_pipeline:
            await self.agent_pipeline.close()
        for executor in (self.auth_executor, self.control_executor, self.agent_executor, self.stop_executor):
            await asyncio.to_thread(executor.shutdown, wait=True, cancel_futures=True)
        for engine in (self.view_engine, self.control_engine, self.agent_engine, self.stop_engine):
            engine.dispose()
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
        self.audit._queue.close()
        for name, callback in self.stop_listeners:
            event.remove(ORMSession, name, callback)
        self.stop_listeners.clear()
        self.audit_engine.dispose()
        self.phone_ack_engine.dispose()
        self.run_engine.dispose()
        self.read_engine.dispose()

    def invalidate_stop_cache(self, users=None, robots=None):
        # None/None is a conservative fallback for an unscoped bulk mutation.
        users, robots = frozenset(users or ()), frozenset(robots or ())
        with self.stop_cache_lock:
            self.stop_cache_epoch += 1
            self.stop_changes.append((self.stop_cache_epoch, users, robots))
            for key, cached in list(self.stop_cache.items()):
                if not (users or robots) or cached[1].user in users or key[2] in robots:
                    del self.stop_cache[key]

    def stop_scope_changed(self, epoch, actor, rid):
        # A read older than the bounded journal fails closed rather than losing
        # a revocation. No database work occurs between this check and STOP.
        if self.stop_changes and epoch < self.stop_changes[0][0] - 1:
            return True
        return any(version > epoch and (not (users or robots) or actor.user in users or str(rid) in robots)
                   for version, users, robots in self.stop_changes)

    def watch_stop_invalidations(self):
        marker = ('fh-stop-dirty', id(self))
        fields = {User: ('locked', 'archived_at', 'role', 'org_id'),
                  Session: ('revoked_at', 'expires_at', 'token_hash', 'csrf_hash', 'client', 'user_id', 'org_id'),
                  Robot: ('archived_at', 'org_id', 'simulation')}
        def collect(db, users=(), robots=(), global_change=False):
            change = db.info.setdefault(marker, [set(), set(), False])
            change[0].update(str(value) for value in users if value is not None)
            change[1].update(str(value) for value in robots if value is not None)
            change[2] |= global_change
        def flushed(db, *_):
            for row in db.dirty | db.deleted:
                if type(row) in fields and (row in db.deleted or any(
                        inspect(row).attrs[field].history.has_changes() for field in fields[type(row)])):
                    if isinstance(row, Robot):
                        collect(db, robots=[row.id])
                    elif isinstance(row, User):
                        collect(db, users=[row.id])
                    else:
                        # Reassigning a session invalidates both old/new users.
                        collect(db, users=[row.user_id, *inspect(row).attrs.user_id.history.deleted])
        def executed(state):
            if state.is_update or state.is_delete:
                statement = state.statement
                table = getattr(getattr(statement, 'table', None), 'name', None)
                column = {'users': User.id, 'sessions': Session.user_id, 'robots': Robot.id}.get(table)
                if column is not None:
                    # Parameterized executemany cannot be reliably scoped here.
                    if state.parameters:
                        collect(state.session, global_change=True)
                    else:
                        query = select(column)
                        if statement.whereclause is not None:
                            query = query.where(statement.whereclause)
                        ids = state.session.scalars(query).all()
                        collect(state.session, **{'robots' if table == 'robots' else 'users': ids})
        def committed(db):
            change = db.info.pop(marker, None)
            if change and (change[0] or change[1] or change[2]):
                self.invalidate_stop_cache(*((None, None) if change[2] else change[:2]))
        def rolled_back(db):
            db.info.pop(marker, None)
        for name, callback in (('before_flush', flushed), ('do_orm_execute', executed),
                               ('after_commit', committed), ('after_rollback', rolled_back)):
            event.listen(ORMSession, name, callback)
            self.stop_listeners.append((name, callback))

    def stop_key(self, headers, cookies, rid):
        auth = headers.get('authorization')
        raw, client = ((auth[7:], 'app') if auth and auth.startswith('Bearer ') else
                       ('', 'app') if auth else (cookies.get('fh_s'), 'web'))
        if not raw:
            raise self.api_error(401, 'AUTH_REQUIRED', '로그인이 필요합니다.')
        csrf = headers.get('x-fh-csrf') if client == 'web' else None
        return (digest(raw), client, str(rid), digest(csrf) if csrf else None)

    def load_stop_scope(self, key):
        token_hash, client, rid, csrf = key
        with self.stop_factory() as db:
            row = db.execute(select(User, Session, Robot).join(Session, Session.user_id == User.id)
                .outerjoin(Robot, and_(Robot.id == UUID(rid), Robot.org_id == User.org_id))
                .where(User.org_id == self.settings.org_id, Session.org_id == self.settings.org_id,
                    Session.token_hash == token_hash, Session.client == client,
                    Session.revoked_at.is_(None), Session.expires_at > now())).first()
            if row is None or row.User.locked or row.User.archived_at:
                raise self.api_error(401, 'AUTH_REQUIRED', '로그인이 필요합니다.')
            user, session, robot = row
            self.authorize(user, 'LOGIN')
            if client == 'web' and (not csrf or not session.csrf_hash or not hmac.compare_digest(csrf, session.csrf_hash)):
                raise self.api_error(403, 'FORBIDDEN', '요청 확인 값을 확인하세요.')
            if robot is None:
                raise self.api_error(404, 'NOT_FOUND', '로봇을 찾을 수 없습니다.')
            self.authorize(user, 'ROBOT_STOP', robot)
            return Actor(str(user.id), str(session.id), str(uuid4()), user.display_name, user.role), session.expires_at

    async def stop_actor(self, headers, cookies, rid):
        key, started = self.stop_key(headers, cookies, rid), self.clock()
        with self.stop_cache_lock:
            epoch = self.stop_cache_epoch
            cached = self.stop_cache.get(key)
            if cached and started - cached[0] <= self.stop_cache_ttl and cached[2] > now():
                self.stop_cache.move_to_end(key)
                return cached[1], epoch
        def finished(done):
            self.stop_slots.release()
            if not done.cancelled():
                done.exception()  # observe a read that outlived its caller deadline
        try:
            # Admission waiting and the read share one deadline. Only submitted
            # work owns a slot after cancellation; no executor backlog is added.
            async with asyncio.timeout(DB_READ_TIMEOUT):
                await self.stop_slots.acquire()
                try:
                    future = asyncio.get_running_loop().run_in_executor(self.stop_executor, self.load_stop_scope, key)
                except BaseException:
                    self.stop_slots.release()
                    raise
                future.add_done_callback(finished)
                actor, expires = await asyncio.shield(future)
        except TRANSIENT_DB as exc:
            raise self.api_error(503, 'SERVER_BUSY', '정지 접수를 확인하지 못했습니다.') from exc
        with self.stop_cache_lock:
            if expires <= now():
                raise self.api_error(401, 'AUTH_REQUIRED', '로그인이 필요합니다.')
            if self.stop_scope_changed(epoch, actor, rid):
                raise self.api_error(503, 'SERVER_BUSY', '권한 변경 후 정지를 다시 요청하세요.')
            if self.clock() - started <= self.stop_cache_ttl:
                self.stop_cache[key] = (started, actor, expires)
                while len(self.stop_cache) > 256:
                    self.stop_cache.popitem(last=False)
        return actor, epoch

    def identity(self, headers, cookies, connection, *, factory=None):
        """Read-only identity: deliberately does not call REST's writing identity."""
        auth = headers.get('authorization')
        if auth:
            raw, client = (auth[7:], 'app') if auth.startswith('Bearer ') else ('', 'app')
        else:
            raw, client = cookies.get('fh_s'), 'web'
        if not raw:
            raise self.api_error(401, 'AUTH_REQUIRED', '로그인이 필요합니다.')
        with (factory or self.factory)() as db:
            session = db.scalar(select(Session).where(Session.org_id == self.settings.org_id,
                Session.client == client, Session.token_hash == digest(raw),
                Session.revoked_at.is_(None), Session.expires_at > now()))
            user = db.get(User, session.user_id) if session else None
            if not user or user.locked or user.archived_at or user.org_id != self.settings.org_id:
                raise self.api_error(401, 'AUTH_REQUIRED', '로그인이 필요합니다.')
            self.authorize(user, 'LOGIN')
            return Actor(str(user.id), str(session.id), connection, user.display_name, user.role)

    def access(self, actor, robots, permission, with_settings=False, *, factory=None):
        with (factory or self.factory)() as db:
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
                for permission in ('ROBOT_SUMMARY', 'ROBOT_READ', 'O_OWN', 'ROBOT_STOP'):
                    try:
                        self.authorize(user, permission, robot)
                        allowed.add(permission)
                    except self.api_error as exc:
                        if exc.code in ('ADMIN_NO_REAL_CONTROL', 'PHONE_DIRECT_REQUIRED'):
                            allowed.add(exc.code)
                rights[str(robot.id)] = frozenset(allowed)
            return Policy(rights, C.OrgSettings.model_validate(org.settings), session.expires_at, checked)

    def load_policy_batch(self, lane):
        actors = []
        for sid, peer in list(self.policy_peers.items()):
            cached = self.policy_cache.get(sid)
            owner = cached is not None and any('O_OWN' in rights for rights in cached.rights.values())
            # Unknown sessions warm both lanes once. Afterwards viewers cannot
            # consume the reserved controller budget. Any current owner stays warm.
            if cached is None or (lane == 'control' and (owner or sid in self.policy_controls)) or (lane == 'view' and not owner):
                actors.append(peer.actor)
        if not actors:
            return {}
        checked = self.clock()
        agents = list(self.agents.items())
        factory = self.control_factory if lane == 'control' else self.view_factory
        with factory() as db:
            # Plain immutable SQL rows avoid constructing ORM identity graphs
            # for every overlapping read of the same organization.
            rows = db.execute(select(User.id.label('user_id'), User.org_id,
                User.role, User.locked, User.archived_at.label('user_archived_at'),
                Session.id.label('session_id'), Session.revoked_at, Session.expires_at,
                Organization.settings).join(Session, Session.user_id == User.id).join(
                Organization, Organization.id == User.org_id).where(
                Session.id.in_([UUID(a.session) for a in actors]), User.org_id == self.settings.org_id,
                Session.org_id == self.settings.org_id)).all()
            robots = db.execute(select(Robot.id, Robot.org_id, Robot.archived_at,
                Robot.owner_user_id, Robot.agent_token_hash, Robot.simulation).where(Robot.org_id == self.settings.org_id,
                                                     Robot.archived_at.is_(None))).all()
            rows = {str(row.session_id): row for row in rows}
            result = PolicyBatch()
            user_rights = {}
            robot_values = tuple(tuple(r) for r in robots)
            result.agents = self.verify_agents(agents, {str(r.id): r for r in robots})
            for actor in actors:
                try:
                    row = rows.get(actor.session)
                    if not row:
                        raise self.api_error(401, 'AUTH_REQUIRED', '로그인이 필요합니다.')
                    user = SimpleNamespace(id=row.user_id, org_id=row.org_id, role=row.role,
                                           locked=row.locked, archived_at=row.user_archived_at)
                    if (str(user.id) != actor.user or user.locked or user.archived_at
                            or row.revoked_at or row.expires_at <= now()):
                        raise self.api_error(401, 'AUTH_REQUIRED', '로그인이 필요합니다.')
                    self.authorize(user, 'LOGIN')
                    if user.id not in user_rights:
                        user_rights[user.id] = policy_rights(self.authorize, self.api_error,
                            (user.id, user.org_id, user.role, user.locked, user.archived_at), robot_values)
                    rights = user_rights[user.id]
                    result[actor.session] = Policy(rights, C.OrgSettings.model_validate(row.settings),
                                                   row.expires_at, checked)
                except self.api_error as exc:
                    result[actor.session] = exc
            return result

    async def release_policy(self, peer):
        sid = peer.actor.session
        members = self.policy_members.get(sid, {})
        members.pop(peer.actor.connection, None)
        if members:
            self.policy_peers[sid] = next(iter(members.values()))
            return
        self.policy_members.pop(sid, None)
        self.policy_peers.pop(sid, None)
        self.policy_controls.discard(sid)
        self.policy_loads.pop(sid, None)
        self.policy_cache.pop(sid, None)
        if not self.policy_peers:
            pipelines = list(self.policy_pipelines.values())
            self.policy_pipelines.clear()
            # Retire every producer before yielding: the close caller can be
            # cancelled, or another peer can register while shutdown waits.
            for pending in pipelines:
                pending.task.cancel()
            await asyncio.gather(*(pending.close() for pending in pipelines))

    async def refresh_policy(self, peer, *, after=None):
        sid = peer.actor.session
        self.policy_peers[sid] = peer
        self.policy_members.setdefault(sid, {})[peer.actor.connection] = peer
        lane = 'control' if sid in self.policy_controls else 'view'
        # Both lanes stay warm. Starting a new thread/pool pipeline only after
        # take would consume the 50ms margin of a 450ms authorization snapshot.
        for purpose, executor in (('view', self.auth_executor), ('control', self.control_executor)):
            current = self.policy_pipelines.get(purpose)
            if current is None or current.task.done():
                if current and not current.task.cancelled():
                    current.task.exception()
                self.policy_pipelines[purpose] = ReadAhead(
                    lambda purpose=purpose: self.load_policy_batch(purpose), self.clock, executor,
                    offset=.01 if purpose == 'control' else 0,
                    min_interval=.015 if purpose == 'control' else .1)
        pending = self.policy_pipelines[lane]
        self.policy_loads[sid] = pending
        cached = self.policy_cache.get(sid)
        if cached is None or self.clock() - cached.checked >= .035 or (after is not None and cached.checked <= after):
            async with asyncio.timeout(DB_READ_TIMEOUT):
                while True:
                    available = [p for p in self.policy_pipelines.values()
                                 if isinstance(p.latest, dict) and sid in p.latest
                                 and (after is None or p.stamp > after)]
                    if available:
                        best = max(available, key=lambda p: p.stamp)
                        batch, started = best.latest, best.stamp
                        cached = batch[sid]
                        break
                    # Wait for either shared lane to advance, without polling
                    # per screen. Empty batches advance only their own lane's
                    # watermark; they cannot skip the other lane's snapshot.
                    waits = [asyncio.create_task(p.next(after=max(p.stamp,
                                 after if after is not None else float('-inf'))))
                             for p in self.policy_pipelines.values()]
                    try:
                        done, _ = await asyncio.wait(waits, return_when=asyncio.FIRST_COMPLETED)
                        for task in done:
                            task.result()
                    finally:
                        for task in waits:
                            task.cancel()
                        await asyncio.gather(*waits, return_exceptions=True)
            if isinstance(cached, self.api_error):
                raise cached
            cached = replace(cached, checked=min(started, cached.checked))
            self.policy_cache[sid] = cached
            if not any('O_OWN' in rights for rights in cached.rights.values()):
                self.policy_controls.discard(sid)
        peer.policy = cached

    def subscribe(self, peer, msg):
        robots = [str(rid) for rid in msg.robots]
        self.cached_access(peer, robots, 'ROBOT_READ')
        if any(rid in self.robot_changes for rid in robots):
            raise LeaseError('POLICY_STALE', '담당 변경을 확인하고 있습니다.', 503)
        peer.revoked_robots.difference_update(robots)
        peer.subscriptions = {rid: set(msg.streams) for rid in robots}
        self.streams()
        for rid in robots:
            self.apply([self.arbiter.announce(rid)])

    async def resolve_subscription(self, peer, msg, after):
        # Use the existing bounded shared read-ahead producer, but require a
        # snapshot started after this request. No new per-message DB backlog.
        # The receiver remains free to process STOP while this task waits.
        try:
            await self.refresh_policy(peer, after=after)
            robots = [str(rid) for rid in msg.robots]
            self.cached_access(peer, [], 'LOGIN')
            if any(rid not in peer.policy.rights for rid in robots):
                raise LeaseError('NOT_FOUND', '로봇을 찾을 수 없습니다.', 404)
            self.apply(self.arbiter.tick())
            self.subscribe(peer, msg)
            self.put(peer, C.ScreenReply(id=msg.id, ok=True).model_dump(mode='json'))
        except self.api_error as exc:
            # A known robot without ROBOT_READ is still a permanent denial.
            await self.deny_screen(peer, 4401 if exc.status == 401 else 4403)
        except (LeaseError, *TRANSIENT_DB) as exc:
            self.put(peer, {'t': 'reply', 'id': msg.id, 'ok': False, 'error': {
                'code': exc.code if isinstance(exc, LeaseError) else 'SERVER_BUSY',
                'message': exc.message if isinstance(exc, LeaseError) else '권한 확인을 기다리고 있습니다.',
                'detail': {'status': exc.status if isinstance(exc, LeaseError) else 503}}})
        except Exception:
            log.warning('Subscription refresh failed; closing safely')
            with suppress(Exception):
                await self.deny_screen(peer, 1013)

    def begin_robot_change(self, rid):
        if self.owner_connection is None or self.owner_uncertain or rid in self.robot_changes:
            raise self.api_error(503, 'SERVER_BUSY', '실시간 중재기를 확인하세요.')
        self.robot_changes.add(rid)

    def end_robot_change(self, rid):
        self.robot_changes.discard(rid)

    def revoke_robot_control(self, peer, rid):
        # Losing motion authority does not imply losing ROBOT_READ.
        r = self.arbiter.robots.get(rid)
        controlled = bool(r and ((r.holder and r.holder.actor == peer.actor)
            or (r.transfer and r.transfer.actor == peer.actor)))
        if r:
            if controlled:
                self.apply(self.arbiter.revoke(rid, peer.actor))
            elif r.request and r.request.actor == peer.actor:
                self.apply(self.arbiter.cancel_request(rid))
        return controlled

    def revoke_robot_peer(self, peer, rid, reason='ACCESS_REVOKED', force=False):
        controlled = self.revoke_robot_control(peer, rid)
        affected = rid in peer.subscriptions or controlled or force
        if not affected or rid in peer.revoked_robots:
            return
        peer.delivery_epochs[rid] = peer.delivery_epochs.get(rid, 0) + 1
        peer.revoked_robots.add(rid)
        retained = []
        while not peer.queue.empty():
            item = peer.queue.get_nowait()
            payload = item.get('_delivery', item.get('_revocation', item))
            if str(payload.get('robot')) != rid:
                retained.append(item)
        for item in retained:
            peer.queue.put_nowait(item)
        # This constant, non-private control message clears legacy fh-rt/1 UI
        # state even after ROBOT_READ was lost. Safe agent outputs precede it.
        self.put(peer, {'_revocation': {'t': 'lease', 'robot': rid, 'holder': None,
            'lease_id': None, 'since': None}})
        self.put(peer, C.ScreenSubscriptionRevoked(robot=rid, reason=reason).model_dump(mode='json'))
        peer.subscriptions.pop(rid, None)
        self.streams()

    def robot_changed(self, rid, old_owner=None, deleted=False):
        if old_owner is not None:
            self.robot_changed_at[(rid, old_owner)] = self.clock()
        if deleted:
            self.last_state_received.pop(rid, None)
            self.__dict__.get('phone_ack_contention',{}).pop(rid,None)
            self.deleted_robots.add(rid)
            self.deleted_at[rid] = self.clock()
            self.inventory.forget(rid)
        # Ordinary socket loss retains a holder for 15 s. Reassignment must
        # revoke that actor too, even though it no longer has a screen peer.
        r = self.arbiter.robots.get(rid)
        actor = r.holder.actor if r and r.holder else r.transfer.actor if r and r.transfer else None
        if actor and (deleted or actor.user == old_owner):
            self.apply(self.arbiter.revoke(rid, actor))
        elif r and r.request and (deleted or r.request.actor.user == old_owner):
            self.apply(self.arbiter.cancel_request(rid))
        for peer in list(self.screens.values()):
            if deleted or (old_owner is not None and peer.actor.user == old_owner):
                self.revoke_robot_peer(peer, rid, 'ROBOT_DELETED' if deleted else 'ACCESS_REVOKED',
                    force=actor == peer.actor)

    def cached_access(self, peer, robots, permission, *, safety=False):
        policy = peer.policy
        if policy is None or policy.expires_at <= now() or peer.closing:
            raise self.api_error(401, 'AUTH_REQUIRED', '로그인이 필요합니다.')
        if permission in ('O_OWN', 'ROBOT_STOP') and any(
                'ADMIN_NO_REAL_CONTROL' in policy.rights.get(rid, ()) for rid in robots):
            from .api import ADMIN_NO_REAL_CONTROL
            raise self.api_error(403, 'ADMIN_NO_REAL_CONTROL', ADMIN_NO_REAL_CONTROL)
        if permission in ('O_OWN', 'ROBOT_STOP') and any(
                'PHONE_DIRECT_REQUIRED' in policy.rights.get(rid, ()) for rid in robots):
            raise self.api_error(403, 'PHONE_DIRECT_REQUIRED', '실기 조종·STOP은 현장 폰에서 직접 하세요.')
        if permission in ('ROBOT_READ', 'O_OWN') and any(
                rid in peer.revoked_robots and (permission not in policy.rights.get(rid, ())
                    or policy.checked < self.robot_changed_at.get((rid, peer.actor.user), float('-inf')))
                for rid in robots):
            # A known revocation is a denial, not transient policy uncertainty.
            # A later fresh grant may permit a new subscription generation.
            raise self.api_error(404 if permission == 'ROBOT_READ' else 403,
                'NOT_FOUND' if permission == 'ROBOT_READ' else 'NOT_ROBOT_OWNER', '로봇 접근 권한이 없습니다.')
        # Previously verified STOP scope stays usable during a slow refresh.
        # Motion is disabled once its authorization snapshot is 500 ms old.
        if not safety and self.clock() - policy.checked > 0.5:
            raise LeaseError('POLICY_STALE', '권한 확인을 기다리고 있습니다.', 503)
        for rid in robots:
            if rid in self.deleted_robots:
                raise self.api_error(404, 'NOT_FOUND', '로봇을 찾을 수 없습니다.')
            if not safety and policy.checked < self.robot_changed_at.get((rid, peer.actor.user), float('-inf')):
                raise LeaseError('POLICY_STALE', '담당 변경을 확인하고 있습니다.', 503)
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
        peer.closing = True
        peer.revoke_on_close = True
        self.revoke_actor(peer.actor)
        await peer.socket.close(code=code)

    def retire_agent(self, rid, peer):
        # Terminal refusal takes effect before an awaitable close handshake.
        # Preserve safe outputs/audits first, then forbid new take/state input.
        if self.agents.get(rid) is peer:
            peer.auth_checked = float('-inf')
            self.apply(self.arbiter.revoke(rid, op='EXPIRE'))
        peer.closing = True

    def ingress_allowed(self, peer, *, archive=False):
        at = self.clock()
        budget, stamp = ('archive_budget', 'archive_budget_at') if archive else ('budget', 'budget_at')
        balance = min(100.0, getattr(peer, budget) + max(0, at - getattr(peer, stamp)) * 100)
        setattr(peer, stamp, at)
        setattr(peer, budget, balance - 1 if balance >= 1 else balance)
        return balance >= 1

    async def reject_upgrade(self, ws, code):
        # ASGI denial responses preserve HTTP 401 versus 403 before upgrade.
        # Older ASGI servers without the extension receive explicit WS codes.
        if 'websocket.http.response' in getattr(ws, 'scope', {}).get('extensions', {}):
            status = 401 if code == 4401 else 403
            await ws.send_denial_response(JSONResponse({'error': {
                'code': 'AUTH_REQUIRED' if status == 401 else 'FORBIDDEN',
                'message': '로그인이 필요합니다.' if status == 401 else '접속 권한을 확인하세요.',
                'detail': {}}}, status_code=status, headers={'Cache-Control': 'no-store'}))
        else:
            await ws.accept()
            await ws.close(code=code)

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
        accepted = True
        try:
            if not isinstance(self.audit, FairAuditQueue) and self.audit._queue.io is not None:
                # Reserve space for revocation/connection teardown of every
                # already-admitted context before closing further admission.
                self.audit._queue.io.reserve(256 + 4 * (len(self.arbiter.robots) + len(self.agents) + len(self.screens)))
            self.audit.put_nowait(effect)
        except SourceArchiveFull:
            self.block_archive_source(effect.robot, 'CAPACITY')
            return False
        except asyncio.QueueFull:
            accepted = False
        except Exception:
            self.fail_audit_storage()
            raise
        if isinstance(self.audit, FairAuditQueue):
            self.source_drop_total += self.audit.take_dropped()
        else:
            self.audit_dropped += self.audit.take_dropped()
        if self.audit.full() and not self.audit_overloaded:
            self.audit_overloaded = True
            self.free_pending = True
            self.finish_effects()
        return accepted

    def note_audit(self, rid, body):
        if (isinstance(self.audit, FairAuditQueue) and not self.audit.admission_open(rid)
                and body['op'] not in self.audit.RESERVED):
            return
        # Preserve transitions individually; repeatable external input is bounded
        # by (robot, user, code), 256 groups and a global 20/s first-event budget.
        op = body['op']
        stamped = Effect('audit', rid, {**body, 'at': now()})
        critical = op in ('TAKE', 'RELEASE', 'REQUEST', 'ACCEPT', 'DECLINE', 'TIMEOUT',
                          'EXPIRE', 'RUN_PAUSE_TAKEOVER', 'STOP_CONFIRM_FAILED')
        if critical or AuditQueue.urgent(stamped):
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
        if isinstance(self.audit, FairAuditQueue):
            self.audit.flush_drop_summaries()
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
        if self.audit_overloaded and not self.audit_storage_failed and self.audit.qsize() < max(1, self.audit.maxsize // 4):
            self.audit_overloaded = False
        if self.audit_dropped and self.audit.qsize() < max(1, self.audit.maxsize // 4) and self.arbiter.robots:
            rid = next(iter(self.arbiter.robots))
            count, self.audit_dropped = self.audit_dropped, 0
            self.queue_audit(Effect('audit', rid, {'op': 'AUDIT_DROPPED', 'at': now(), 'data': {'count': count}}))

    def agent_identity(self, headers):
        return self.agent_auth(headers)[0]

    def agent_auth(self, headers):
        """Keep DB provenance separate from IDs persisted in history."""
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
            return str(matches[0].id), matches[0].simulation is True

    def put(self, peer, body):
        if peer.closing:
            return
        if peer.actor and 'robot' in body and body.get('t') != 'subscription.revoked':
            body = {'_delivery': body}
        if '_delivery' in body:
            body = {**body, '_epoch': peer.delivery_epochs.get(str(body['_delivery']['robot']), 0)}
        try:
            if peer.actor and body.get('t') == 'ping':
                peer.urgent.put_nowait(body)
            else:
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
                        # DB provenance only. Unknown/real peers never receive control,
                        # including startup/disconnect/overload-generated STOP effects.
                        if not peer.simulation and body.get('t') in (
                                'lease', 'cmd', 'unlock', 'stop', 'run.start', 'run.control',
                                'run.confirm', 'floor.set', 'slam'):
                            continue
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
                        if body['t'] == 'lease' and outgoing.get('lease_id'):
                            # Publish the confirming STOP generation before the
                            # owner can enable unlock from its new lease.
                            self.put(peer, self.screen_state(rid))
                        self.put(peer, {'_delivery': outgoing})
        finally:
            self.effect_depth -= 1
            self.finish_effects()

    def emergency_free(self):
        # Dispatch every safe output before recording. Overflow no longer
        # discards the very lease revocations that it caused.
        safety, records = [], []
        for rid in self.arbiter.robots:
            for effect in self.arbiter.revoke(rid, op='EXPIRE'):
                (records if effect.target == 'audit' else safety).append(effect)
        self.apply(safety + records)

    async def send_body(self, peer, body, delivery=None):
        if peer.actor is None and not peer.simulation and body.get('t') in (
                'lease', 'cmd', 'unlock', 'stop', 'run.start', 'run.control',
                'run.confirm', 'floor.set', 'slam'):
            return False
        async with peer.send_lock:
            if delivery is not None:
                rid, epoch = delivery
                if rid in peer.revoked_robots or epoch != peer.delivery_epochs.get(rid, 0):
                    return False
                self.cached_access(peer, [body['robot']], 'ROBOT_READ')
            await asyncio.wait_for(peer.socket.send_json(body), timeout=0.25)
            return True

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
                queued = await peer.queue.get()
                body = queued.get('_delivery', queued.get('_revocation', queued))
                private = '_delivery' in queued or (screen and 'robot' in body
                    and body.get('t') != 'subscription.revoked' and '_revocation' not in queued)
                if not private:
                    await self.send_body(peer, body)
                    continue
                rid = str(body['robot'])
                epoch = queued.get('_epoch', peer.delivery_epochs.get(rid, 0))
                try:
                    async with asyncio.timeout(DB_RETRY_GRACE):
                        while True:
                            if rid in peer.revoked_robots or epoch != peer.delivery_epochs.get(rid, 0):
                                break
                            try:
                                await self.send_body(peer, body, delivery=(rid, epoch))
                                break
                            except LeaseError:
                                try:
                                    await self.refresh_policy(peer)
                                    await asyncio.sleep(.005)
                                except TRANSIENT_DB:
                                    await asyncio.sleep(0.1)
                except self.api_error as exc:
                    if exc.status == 401:
                        await self.deny_screen(peer, 4401)
                        return
                    self.revoke_robot_peer(peer, rid,
                        'ROBOT_DELETED' if rid in self.deleted_robots else 'ACCESS_REVOKED')
        except (WebSocketDisconnect, RuntimeError, asyncio.TimeoutError):
            peer.closing = True
            with suppress(Exception):
                await peer.socket.close(code=1013)

    async def receive(self, ws, *, agent=False):
        await self.audit._queue.writable()
        packet = await ws.receive()
        # A frame already waiting on recv has not yet been accepted by us.
        await self.audit._queue.writable()
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
                if not origin or origin not in (expected, self.settings.tunnel_origin):
                    raise self.api_error(403, 'FORBIDDEN', '접속 출처를 확인하세요.')
        except self.api_error as exc:
            await self.reject_upgrade(ws, 4401 if exc.status == 401 else 4403)
            return
        except TRANSIENT_DB:
            await self.retry_later(ws)
            return
        peer = Peer(ws, actor=actor, last_rx=self.clock(), last_ping=self.clock(), budget_at=self.clock())
        accepted = False
        rejection = None
        try:
            try:
                await self.refresh_policy(peer)
            except self.api_error as exc:
                rejection = 4401 if exc.status == 401 else 4403
                return
            except TRANSIENT_DB:
                rejection = 1013
                return
            await ws.accept()
            accepted = True
        finally:
            if not accepted:
                await self.release_policy(peer)
                # Finish cleanup before publishing a close, which lets the
                # client cancel the ASGI task immediately on receipt.
                if rejection == 1013:
                    await self.retry_later(ws)
                elif rejection is not None:
                    await self.reject_upgrade(ws, rejection)
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
                            self.cached_access(peer, [str(urgent.robot)], 'ROBOT_STOP', safety=True)
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
                    policy = 'ROBOT_READ' if msg.t == 'sub' else ('ROBOT_STOP' if msg.t == 'stop' else 'O_OWN' if rid else 'LOGIN')
                    safe = msg.t in ('stop', 'lease.release', 'hidden', 'lease.cancel')
                    if msg.t == 'sub':
                        if peer.subscription_task and not peer.subscription_task.done():
                            raise LeaseError('SERVER_BUSY', '앞선 구독 확인을 기다리고 있습니다.', 503)
                        if any('ROBOT_READ' not in peer.policy.rights.get(robot, ())
                               or robot in peer.revoked_robots or robot in self.deleted_robots
                               or robot in self.robot_changes for robot in robots):
                            peer.subscription_task = asyncio.create_task(
                                self.resolve_subscription(peer, msg, self.clock()))
                            continue
                    if not safe and rid in self.robot_changes:
                        raise LeaseError('POLICY_STALE', '담당 변경을 확인하고 있습니다.', 503)
                    settings = self.cached_access(peer, robots, policy, safety=safe)
                    if msg.t in ('lease.take', 'lease.request') and rid in peer.revoked_robots:
                        raise LeaseError('SUBSCRIPTION_REQUIRED', '로봇 화면을 다시 열어 주세요.')
                    if msg.t in ('lease.take', 'lease.request', 'cmd', 'unlock'):
                        self.policy_controls.add(actor.session)
                    if (rid and msg.t != 'lease.cancel' and isinstance(self.audit, FairAuditQueue)
                            and not self.audit.admission_open(rid)):
                        if msg.t == 'stop':
                            self.apply([e for e in self.arbiter.stop(rid, actor) if e.target != 'audit'])
                        raise LeaseError('ROBOT_ARCHIVE_BUSY', '로봇 기록 저장을 확인하세요.', 503)
                    self.apply(self.arbiter.tick())  # expiry before new input
                    if msg.t == 'lease.take' and self.audit_storage_failed:
                        io = self.audit._queue.io
                        if io is not None and not io.pending and io.error is None and not self.audit.full():
                            self.audit_storage_failed = False
                            self.audit_overloaded = False
                    if (self.failed or self.audit_overloaded or self.owner_uncertain) and not safe and msg.t not in ('ping', 'sub'):
                        raise LeaseError('SERVER_BUSY', '서버 기록을 확인하고 있습니다.', 503)
                    if msg.t == 'stop':
                        self.apply(self.arbiter.stop(rid, actor))
                    if msg.t == 'sub':
                        self.subscribe(peer, msg)
                    elif msg.t == 'ping':
                        pass  # ping never extends a lease heartbeat
                    elif msg.t == 'stop':
                        pass
                    elif msg.t == 'lease.release':
                        self.apply(self.arbiter.release(rid, actor))
                    elif msg.t == 'lease.cancel':
                        self.apply(self.arbiter.cancel(rid, actor))
                    elif msg.t == 'hidden':
                        self.apply(self.arbiter.hidden(rid, actor))
                    else:
                        if rid not in self.agents or self.agents[rid].closing:
                            raise LeaseError('ROBOT_OFFLINE', '로봇 연결이 끊겼습니다.', 503)
                        if self.clock() - self.agents[rid].auth_checked > 0.5:
                            raise LeaseError('ROBOT_AUTH_PENDING', '로봇 인증 확인을 기다리고 있습니다.', 503)
                        if msg.t == 'lease.take':
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
        except WebSocketDisconnect:
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
            if peer.subscription_task:
                peer.subscription_task.cancel()
            with suppress(asyncio.CancelledError):
                await asyncio.gather(sender, urgent_sender, watcher,
                    *([peer.subscription_task] if peer.subscription_task else []), return_exceptions=True)
            with suppress(asyncio.CancelledError):
                await self.release_policy(peer)
            self.streams()

    def screen_state(self, rid):
        online, state = live_state(self, rid)
        return C.ScreenState(robot=rid, connection='ONLINE' if online else 'OFFLINE',
            telemetry_source=state.get('telemetry_source'),
            status=state.get('status'), battery=state.get('battery'), location=state.get('location'),
            devices=state.get('devices', []), speed=state.get('speed'), latency_ms=None,
            latched=state.get('latched'), safety_reason=state.get('safety_reason'), stop_gen=state.get('stop_gen'),
            applied=state.get('applied')).model_dump(mode='json')

    async def screen_watch(self, peer):
        try:
            while True:
                await asyncio.sleep(0.01)
                try:
                    await self.refresh_policy(peer)
                    self.cached_access(peer, [], 'LOGIN')
                    for rid in list(peer.subscriptions):
                        try:
                            self.cached_access(peer, [rid], 'ROBOT_READ')
                        except self.api_error as exc:
                            if exc.status == 401:
                                raise
                            self.revoke_robot_peer(peer, rid,
                                'ROBOT_DELETED' if rid in self.deleted_robots else 'ACCESS_REVOKED')
                    for rid, r in list(self.arbiter.robots.items()):
                        if ((r.holder and r.holder.actor == peer.actor)
                                or (r.transfer and r.transfer.actor == peer.actor)
                                or (r.request and r.request.actor == peer.actor)):
                            try:
                                self.cached_access(peer, [rid], 'O_OWN')
                            except self.api_error as exc:
                                if exc.status == 401:
                                    raise
                                self.revoke_robot_control(peer, rid)
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
                        self.put(peer, self.screen_state(rid))
        except (WebSocketDisconnect, RuntimeError):
            return
        except Exception:
            with suppress(Exception):
                await self.deny_screen(peer, 1013)

    def verify_agents(self, peers, robots):
        result = AgentBatch()
        result.simulations = {}
        for rid, peer in peers:
            robot = robots.get(rid)
            result.simulations[rid] = (robot is not None and robot.simulation is True, peer)
            raw = peer.socket.headers.get('authorization', '')
            if robot and hmac.compare_digest(robot.agent_token_hash or b'\x00' * 32, digest(raw[7:])):
                result[rid] = (rid, peer)
            else:
                result[rid] = (self.api_error(403, 'FORBIDDEN', '에이전트 인증을 확인하세요.'), peer)
        return result

    def load_agent_batch(self):
        peers = list(self.agents.items())
        with self.agent_factory() as db:
            robots = {str(r.id): r for r in db.execute(select(Robot.id, Robot.org_id,
                Robot.archived_at, Robot.owner_user_id, Robot.agent_token_hash, Robot.simulation, Robot.sim_generation).where(
                Robot.id.in_([UUID(rid) for rid, _ in peers]), Robot.org_id == self.settings.org_id,
                Robot.archived_at.is_(None)))}
            batch = self.verify_agents(peers, robots)
            batch.floor_authority = {}
            # A legacy sim peer without a manager generation has no floor
            # authority. Do not delay its one-query auth snapshot with map I/O.
            if any(r.simulation and r.sim_generation > 0 for r in robots.values()):
                bindings = []
                for world in ('v5_building', 'warehouse'):
                    try:
                        bindings.extend(approved_bindings(db, self.settings.org_id, world))
                    except (ValueError, KeyError, TypeError):
                        pass
                batch.floor_authority = {rid: (r.sim_generation, bindings)
                    for rid, r in robots.items() if r.simulation and r.sim_generation > 0}
            return batch

    async def agent_watch(self, rid, peer):
        if self.agent_pipeline is None or self.agent_pipeline.task.done():
            self.agent_pipeline = ReadAhead(lambda: self.load_agent_batch(), self.clock, self.agent_executor)
        try:
            await self._agent_watch(rid, peer, self.agent_pipeline)
        finally:
            if not self.agents and self.agent_pipeline:
                pending, self.agent_pipeline = self.agent_pipeline, None
                await pending.close()

    async def _agent_watch(self, rid, peer, pending):
        while True:
            await asyncio.sleep(0.01)
            try:
                if pending.task.done():
                    if self.agent_pipeline is pending:
                        if not pending.task.cancelled():
                            pending.task.exception()
                        self.agent_pipeline = ReadAhead(lambda: self.load_agent_batch(), self.clock, self.agent_executor)
                    pending = self.agent_pipeline
                available = [(p.latest.agents, p.stamp) for p in self.policy_pipelines.values()
                             if getattr(p.latest, 'agents', None) is not None and rid in p.latest.agents]
                if isinstance(pending.latest, dict) and rid in pending.latest:
                    available.append((pending.latest, pending.stamp))
                if available:
                    batch, started = max(available, key=lambda item: item[1])
                else:
                    batch, started = await pending.next()
                for candidate in self.policy_pipelines.values():
                    identities = getattr(candidate.latest, 'agents', None)
                    if candidate.stamp > started and identities is not None and rid in identities:
                        batch, started = identities, candidate.stamp
                provenance = getattr(batch, 'simulations', {}).get(rid)
                if provenance is not None and provenance[1] is peer:
                    peer.simulation = provenance[0]
                identity = batch.get(rid)
                if identity is None:
                    continue
                if isinstance(identity, self.api_error):
                    raise identity
                if isinstance(identity, tuple):
                    identity, bound_peer = identity
                    if bound_peer is not peer:
                        continue
                if isinstance(identity, self.api_error):
                    raise identity
                if self.agents.get(rid) is not peer or peer.closing:
                    return
                if identity != rid:
                    raise self.api_error(403, 'FORBIDDEN', '에이전트 인증을 확인하세요.')
                peer.auth_checked = max(peer.auth_checked, started)
                if self.clock() - peer.auth_checked > .5:
                    raise asyncio.TimeoutError()
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
                    self.retire_agent(rid, peer)
                    await peer.socket.close(code=4403)
                return
            except Exception:
                log.warning('Agent authorization refresh failed; closing safely')
                if self.agents.get(rid) is peer:
                    self.retire_agent(rid, peer)
                    with suppress(Exception):
                        await peer.socket.close(code=1013)
                return

    async def phone_revocations(self, rid, peer):
        from .phone_pass import pending
        peer.phone_revoke_sent = 0
        try:
            while self.agents.get(rid) is peer and not peer.closing:
                retry = getattr(peer,'phone_revoke_retry',None)
                if retry is not None:
                    peer.phone_revoke_sent = min(peer.phone_revoke_sent,retry)
                    peer.phone_revoke_retry = None
                frames = await self.read(pending, self.factory, self.settings.org_id, rid, peer.phone_revoke_sent, self.phone_pass_clock)
                for frame in frames:
                    if self.agents.get(rid) is not peer or peer.closing:
                        return
                    self.put(peer, frame)
                    peer.phone_revoke_sent = frame['seq']
                await asyncio.sleep(.1)
        except Exception:
            # Durable rows remain pending for reconnect. Never ACK locally.
            log.warning('Phone revocation delivery unavailable; reconnecting agent')
            if self.agents.get(rid) is peer:
                self.retire_agent(rid, peer)
                with suppress(Exception):
                    await peer.socket.close(code=1013,reason='REVOCATION_DELIVERY_UNAVAILABLE')

    def queue_phone_ack(self, rid, peer, seq):
        if self.agents.get(rid) is not peer or peer.closing:
            return
        if seq <= getattr(peer, 'phone_revoke_sent', 0):
            if seq not in peer.phone_ack_pending:
                try:
                    peer.phone_ack_queue.put_nowait(seq)
                    peer.phone_ack_pending.add(seq)
                except asyncio.QueueFull:
                    self.retry_phone_revocation(peer,seq)

    def retry_phone_revocation(self, peer, seq):
        retry = seq - 1
        previous = getattr(peer,'phone_revoke_retry',None)
        peer.phone_revoke_retry = retry if previous is None else min(previous,retry)
        peer.phone_revoke_sent = min(peer.phone_revoke_sent,retry)

    async def store_phone_ack(self, rid, seq):
        from .phone_pass import acknowledge
        # A timed-out to_thread can still commit. Keep its robot slot occupied
        # across reconnects; neither completion nor callbacks touch peer state.
        stores = self.__dict__.setdefault('phone_ack_stores', {})
        while (prior := stores.get(rid)) is not None:
            await asyncio.shield(prior)
            if stores.get(rid) is prior:
                del stores[rid]
        task = asyncio.create_task(asyncio.to_thread(
            acknowledge,self.phone_pass_factory,self.settings.org_id,rid,seq))
        stores[rid] = task
        def finished(done):
            if stores.get(rid) is done:
                del stores[rid]
            if not done.cancelled():
                error = done.exception()  # observe failure even after the writer left
                if error is None:
                    state = self.__dict__.get('phone_ack_contention',{}).get(rid)
                    if state is not None:
                        state['failures'] = 0  # preserve warning time across recovery
        task.add_done_callback(finished)
        await asyncio.shield(task)

    def note_phone_ack_contention(self, rid, peer, seq):
        if rid in self.__dict__.get('deleted_robots',set()):
            return
        states = self.__dict__.setdefault('phone_ack_contention',{})
        state = states.setdefault(rid,{'failures':0,'warning_at':float('-inf')})
        state['failures'] += 1
        at = self.clock()
        if at-state['warning_at'] >= 30:
            pending = peer.phone_ack_pending | {seq}
            log.warning('Phone revocation ACK pool contention robot=%s cause=POOL_TIMEOUT consecutive=%d pending_seq=%d..%d',
                rid,state['failures'],min(pending),max(pending))
            state['warning_at'] = at

    async def phone_ack_writer(self, rid, peer):
        while True:
            seq = await peer.phone_ack_queue.get()
            try:
                await asyncio.wait_for(self.store_phone_ack(rid,seq),PHONE_ACK_STORAGE_TIMEOUT)
            except PoolTimeout:
                # Pool contention is not a DB failure. Keep this ACK unconfirmed
                # and replay its immutable frame on the next pending cycle.
                if self.agents.get(rid) is peer and not peer.closing:
                    self.note_phone_ack_contention(rid,peer,seq)
                    self.retry_phone_revocation(peer,seq)
            except Exception as exc:
                log.warning('Phone revocation ACK storage unavailable; reconnecting agent')
                if self.agents.get(rid) is peer:
                    self.retire_agent(rid,peer)
                    with suppress(Exception):
                        reason = ('REVOCATION_ACK_STORAGE_TIMEOUT' if isinstance(
                            exc,asyncio.TimeoutError) else 'REVOCATION_ACK_STORAGE_UNAVAILABLE')
                        await peer.socket.close(code=1013,reason=reason)
                return
            finally:
                peer.phone_ack_pending.discard(seq)
                peer.phone_ack_queue.task_done()

    async def run_report_writer(self, rid, peer):
        from .runs import record, sample_path, snapshot, rejection, execution_capabilities
        while True:
            kind, payload, at = await peer.run_reports.get()
            try:
                if kind == 'pose':
                    await self.read(sample_path, self.run_factory, self.settings.org_id, rid, payload, at)
                else:
                    receipt = await self.read(record, self.run_factory, self.settings.org_id, rid, payload,
                        execution_capabilities(self, rid, peer=peer))
                    if receipt and self.agents.get(rid) is peer and not peer.closing:
                        self.put(peer, receipt)  # durable decision committed before any projection
                    if receipt and receipt['t'] == 'run.report_rejected':
                        continue
                    if isinstance(payload, dict):
                        payload = AGENT.validate_python(payload)
                    identifier = payload.run_id if payload.t == 'run.update' else payload.data.get('run_id')
                    try:
                        current = await self.read(snapshot, self.factory, self.settings.org_id, rid, identifier)
                    except Exception:
                        log.warning('Committed run projection unavailable')
                        continue  # projection failure cannot replace a committed receipt
                    if self.agents.get(rid) is peer and not peer.closing:
                        previous = self.runs.get(rid)
                        if current is not None:
                            self.runs[rid] = {**(previous or {}), **current}
                        elif (payload.t == 'run.update' and previous
                              and previous['run_id'] == str(payload.run_id)
                              and previous['status'] not in ('COMPLETED', 'FAILED', 'CANCELED', 'ABORTED')):
                            previous.update(status=payload.status, step=payload.step,
                                            wait_reason=payload.wait_reason, fail_code=payload.fail_code)
                        run = self.runs.get(rid)
                        holder = self.arbiter.robot(rid).holder
                        if (run and run['status'] in ('COMPLETED', 'FAILED', 'CANCELED', 'ABORTED')
                                and holder and holder.holder_type == 'RUN'
                                and run.get('lease_id') == holder.lease_id):
                            self.apply(self.arbiter.revoke(rid))
            except Exception:
                raw = payload if isinstance(payload, dict) else payload.model_dump(mode='json', exclude_unset=True)
                retry = rejection(raw, 'RUN_REPORT_STORAGE') if kind == 'report' else None
                if retry is not None and self.agents.get(rid) is peer and not peer.closing:
                    self.put(peer, retry)  # no ACK and no uncommitted permanent decision
                    continue
                if self.agents.get(rid) is peer:
                    self.retire_agent(rid, peer)
                    with suppress(Exception):
                        await peer.socket.close(code=1013, reason='RUN_REPORT_STORAGE')
                return
            finally:
                peer.run_reports.task_done()

    async def agent_ws(self, ws: WebSocket):
        if self.owner_connection is None or self.failed:
            await self.retry_later(ws)
            return
        try:
            auth_started = self.clock()
            rid = await self.read(self.agent_identity, ws.headers)
        except self.api_error as exc:
            await self.reject_upgrade(ws, 4401 if exc.status == 401 else 4403)
            return
        except TRANSIENT_DB:
            await self.retry_later(ws)
            return
        if isinstance(self.audit, FairAuditQueue) and not self.audit.reconnect_allowed(rid):
            await self.retry_later(ws)
            return
        await ws.accept()
        peer = Peer(ws, last_rx=self.clock(), last_ping=self.clock(), auth_checked=auth_started,
                    budget_at=self.clock(), archive_budget_at=self.clock())
        sender = watcher = revoker = ack_writer = run_writer = None
        hello_done = False
        try:
            async with asyncio.timeout(HELLO_TIMEOUT):
                while True:
                    raw = await self.receive(ws, agent=True)
                    if not self.ingress_allowed(peer):
                        self.retire_agent(rid, peer)
                        await ws.close(code=1013)
                        return
                    if isinstance(raw, dict) and raw.get('proto') not in (None, 'fh-agent/2'):
                        self.note_audit(rid, {'op': 'AGENT_PROTOCOL_MISMATCH', 'data': {'expected': 'fh-agent/2'}})
                        self.retire_agent(rid, peer)
                        await ws.close(code=4406, reason='PROTOCOL_MISMATCH')
                        return
                    try:
                        hello = C.AgentHello.model_validate(raw)
                        break
                    except ValidationError:
                        self.note_audit(rid, {'op': 'AGENT_INVALID_HELLO', 'severity': 'WARN',
                            'data': {'reason': 'INVALID_DEVICE_INVENTORY_OR_HELLO'}})
            hello_done = True
            # Metadata writes can wait behind a row/audit lock. Revalidate the
            # token before publishing a connected peer or granting authority.
            auth_started = self.clock()
            _, peer.simulation = await self.read(self.agent_auth, ws.headers)
            peer.auth_checked = auth_started
            if rid in self.deleted_robots:
                await ws.close(code=4403)
                return
            if rid in self.robot_changes:
                await ws.close(code=1013, reason='ROBOT_CHANGE_PENDING')
                return
            old = self.agents.get(rid)
            if old:
                old.closing = True
                await old.socket.close(code=1012)
            # A validated hello starts a new metadata generation even when the
            # old socket's finally runs after this peer has replaced it.
            self.inventory.forget(rid)
            self.agents[rid] = peer
            self.inventory.submit(rid, [d.model_dump(mode='json') for d in hello.devices],
                hello.robot_model, digest(ws.headers.get('authorization', '')[7:]))
            r = self.arbiter.robot(rid)
            fresh_reference = r.stop_ref < C.MAX_SAFE_INTEGER
            r.stop_gen = hello.stop_gen
            r.latched = hello.latched
            self.apply(self.arbiter.revoke(rid, op='EXPIRE'))
            peer.state = {'devices': [d.model_dump(mode='json') for d in hello.devices],
                          'latched': hello.latched, 'stop_gen': hello.stop_gen}
            if hello.execution_capabilities is not None:
                peer.state['execution_capabilities'] = hello.execution_capabilities.model_dump(mode='json')
            run = hello.run.model_dump(mode='json') if hello.run else None
            from .runs import snapshot
            persisted = await self.read(snapshot, self.factory, self.settings.org_id, rid, run['run_id'] if run else None)
            if persisted is not None:
                # Direct-agent runs are observations, never server-owned RUN leases.
                # Server reconnection alone must not fabricate a PAUSED transition.
                self.runs[rid] = persisted
            elif run and run['status'] not in ('COMPLETED', 'FAILED', 'CANCELED', 'ABORTED'):
                run['status'] = 'PAUSED'
                run['wait_reason'] = 'RECONNECTED'
                self.runs[rid] = run
                # RUN remains reserved after the same stop verification barrier.
                if fresh_reference and peer.simulation:
                    r.transfer = Transfer(None, self.clock() + 2, r.stop_ref)
            else:
                self.runs.pop(rid, None)
            self.apply([Effect('audit', rid, {'op': 'AGENT_CONNECTED'})])
            sender = asyncio.create_task(self.writer(peer))
            watcher = asyncio.create_task(self.agent_watch(rid, peer))
            revoker = asyncio.create_task(self.phone_revocations(rid, peer))
            ack_writer = asyncio.create_task(self.phone_ack_writer(rid,peer))
            peer.run_reports = asyncio.Queue(maxsize=128)
            peer.path_sample_at = float('-inf')
            run_writer = asyncio.create_task(self.run_report_writer(rid, peer))
            # Compatibility alias for join/diagnostics, never a peer-owned queue.
            peer.archive = self.audit
            self.streams()
            while True:
                raw = await self.receive(ws, agent=True)
                if self.agents.get(rid) is not peer or peer.closing:
                    return
                archive = isinstance(raw, dict) and raw.get('t') == 'event'
                admitted = True if archive else self.ingress_allowed(peer)
                if not admitted and not archive:
                    self.retire_agent(rid, peer)
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
                    self.retire_agent(rid, peer)
                    await ws.close(code=4406, reason='PROTOCOL_MISMATCH')
                    return
                try:
                    msg = AGENT.validate_python(raw)
                except ValidationError:
                    from .runs import report_identity
                    if raw.get('t') in ('event', 'run.update') and report_identity(raw) is not None:
                        if peer.run_reports.full():
                            self.retire_agent(rid, peer)
                            await ws.close(code=1013, reason='RUN_REPORT_STORAGE')
                            return
                        peer.run_reports.put_nowait(('report', raw, None))
                        continue
                    if archive:
                        admitted = self.ingress_allowed(peer)
                    self.note_audit(rid, {'op': 'AGENT_INVALID_FRAME'})
                    if not admitted:
                        self.retire_agent(rid, peer)
                        await ws.close(code=1013)
                        return
                    continue
                if msg.t == 'hello':
                    # Same-socket recovery must get a fresh connection/identity.
                    self.retire_agent(rid, peer)
                    await ws.close(code=1012, reason='RECONNECT_REQUIRED')
                    return
                self.apply(self.arbiter.tick())
                if msg.t == 'state':
                    accepted = self.accept_state(rid, peer, msg)
                    if accepted and self.clock() - peer.path_sample_at >= 1:
                        peer.path_sample_at = self.clock()
                        if peer.record_pose is not None and not peer.run_reports.full():
                            peer.run_reports.put_nowait(('pose', peer.record_pose, now()))
                    if accepted and msg.devices_changed is not None:
                        self.inventory.submit(rid, [d.model_dump(mode='json') for d in msg.devices_changed],
                            None, digest(ws.headers.get('authorization', '')[7:]))
                elif msg.t == 'phone.revoke.ack':
                    self.queue_phone_ack(rid,peer,msg.seq)
                elif msg.t in ('event', 'run.update') and (msg.t == 'run.update'
                        or 'agent_instance_id' in msg.model_fields_set or 'run_id' in msg.data
                        or msg.code.startswith('RUN_')):
                    if peer.run_reports.full():
                        self.retire_agent(rid, peer)
                        await ws.close(code=1013, reason='RUN_RECORDING_UNAVAILABLE')
                        return
                    peer.run_reports.put_nowait(('report', raw, None))
                elif msg.t == 'event' and msg.code == 'STOP_REQUEST_APPLIED':
                    from .stop_requests import confirm
                    await self.read(confirm, self.run_factory, self.settings.org_id, rid, msg.data)
                elif msg.t == 'event':
                    from .runs import public_data
                    effect = Effect('audit', rid, {**msg.model_dump(mode='json'), 'data': public_data(msg.data), 'op': 'AGENT_EVENT', 'at': now()})
                    # Parsing never waits behind archival pacing. Exhaustion is
                    # explicit and fail-safe rather than silently losing events.
                    if isinstance(self.audit, FairAuditQueue) and not self.audit.event_allowed(rid):
                        self.block_archive_source(rid, 'EVENT_RATE')
                        if getattr(peer, 'archive_close', None):
                            await asyncio.shield(peer.archive_close)
                        return
                    if not self.queue_audit(effect):
                        if getattr(peer, 'archive_close', None):
                            await asyncio.shield(peer.archive_close)
                        return
                    await asyncio.sleep(0)
                # ping, cmd.ack, media are validated no-op extension points.
        except self.api_error:
            self.retire_agent(rid, peer)
            await ws.close(code=4403)
        except asyncio.TimeoutError:
            self.retire_agent(rid, peer)
            await ws.close(code=1013, reason='AGENT_OPERATION_TIMEOUT' if hello_done else 'HELLO_TIMEOUT')
        except ValidationError:
            self.retire_agent(rid, peer)
            await ws.close(code=1011, reason='INTERNAL_VALIDATION')
        except WebSocketDisconnect:
            pass
        except Exception:
            log.warning('Agent connection failed; closing safely')
            with suppress(Exception):
                self.retire_agent(rid, peer)
                await ws.close(code=1013)
        finally:
            if self.agents.get(rid) is peer:
                self.agents.pop(rid, None)
                self.inventory.forget(rid)
                self.apply(self.arbiter.revoke(rid, op='EXPIRE'))
                self.apply([Effect('audit', rid, {'op': 'AGENT_DISCONNECTED'})])
            peer.closing = True
            for task in (sender, watcher, revoker, ack_writer, run_writer):
                if task:
                    task.cancel()
            with suppress(asyncio.CancelledError):
                await asyncio.gather(*(t for t in (sender, watcher, revoker, ack_writer, run_writer) if t), return_exceptions=True)

    def accept_state(self, rid, peer, msg):
        if self.agents.get(rid) is not peer or peer.closing:
            return False
        if self.owner_uncertain or self.clock() - peer.auth_checked > 0.5:
            return False
        data = msg.model_dump(mode='json')
        peer.state.update({k: data[k] for k in ('speed', 'latched', 'safety_reason', 'stop_gen', 'applied')})
        peer.state['battery'] = C.Battery(soc=msg.battery.soc, updated_at=now()).model_dump(mode='json') if msg.battery.soc is not None else None
        pose = data['pose']
        context = pose.get('floor_context')
        stale_floor = False
        if context is not None:
            token = (context['generation'], context['run_id'], context['epoch'], context['floor_rev'])
            previous = peer.floor_token
            stale_floor = (context['robot_id'] != rid or (previous is not None and (
                token[:2] != previous[:2] or token[2] < previous[2] or token[3] < previous[3])))
            if not stale_floor:
                peer.floor_token = token
                pipeline = self.agent_pipeline
                authority = (getattr(pipeline.latest, 'floor_authority', None)
                    if pipeline is not None and self.clock() - pipeline.stamp <= .5 else None)
                entry = authority.get(rid) if authority else None
                if (entry is None or entry[0] != context['generation']
                        or not matches_context(context, entry[1])):
                    # Preserve the observed error, but never paint a pose on a
                    # changed/unverified approved version. No command gates change.
                    context.update(floor_id=None, map_version_id=None, sha256=None,
                                   source_pgm_sha256=None, reason='approval_unverified')
                    for key in ('floor_id', 'map_version_id', 'x', 'y', 'yaw', 'confidence'):
                        pose[key] = None
                elif (pose['floor_id'], pose['map_version_id']) != (context['floor_id'], context['map_version_id']):
                    pose.update(floor_id=None, map_version_id=None, x=None, y=None, yaw=None, confidence=None)
        peer.record_pose = None
        if not stale_floor:
            peer.record_pose = dict(pose)
            peer.state['location'] = (C.Location(**pose, updated_at=now()).model_dump(mode='json')
                if context is not None or any(pose[key] is not None for key in ('x', 'y', 'yaw')) else None)
        run = data.get('reported_run') if 'reported_run' in msg.model_fields_set else self.runs.get(rid)
        peer.state['status'] = 'STOP_LATCHED' if msg.latched else 'PAUSED' if run and run['status'] == 'PAUSED' else 'RUNNING' if msg.mode == 'RUN' else 'TELEOP' if msg.mode == 'USER' else 'IDLE'
        if msg.devices_changed is not None:
            peer.state['devices'] = data['devices_changed']
        peer.state.update({k: data[k] for k in ('controller', 'controller_device',
            'controller_connected', 'controller_since', 'reported_run', 'mode')})
        peer.state['phone_reported'] = 'reported_run' in msg.model_fields_set
        peer.state_received_at = self.clock()
        self.last_state_received[rid] = now()
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
            if len(self.tasks) > 1 and self.tasks[1].done() and not self.tasks[1].cancelled():
                self.tasks[1].exception()  # observe a failed consumer before replacement
                self.fail_audit_storage()
                self.tasks[1] = asyncio.create_task(self.auditor())
            at = self.clock()
            # No authorization snapshot survives this grace period (motion is
            # bounded by 500 ms, unverified peers close after 5 s).
            self.robot_changed_at = {key: stamp for key, stamp in self.robot_changed_at.items()
                                     if at - stamp <= DB_RETRY_GRACE + 1}
            for rid, stamp in list(self.deleted_at.items()):
                if at - stamp > DB_RETRY_GRACE + 1 and rid not in self.agents:
                    self.arbiter.robots.pop(rid, None)
                    self.runs.pop(rid, None)
                    self.deleted_at.pop(rid)
                    self.deleted_robots.discard(rid)
                    for screen in self.screens.values():
                        screen.delivery_epochs.pop(rid, None)
                        screen.revoked_robots.discard(rid)
            for peer in list(self.screens.values()):
                if at - peer.last_ping >= 1 and not peer.closing:
                    peer.last_ping = at
                    self.put(peer, C.ScreenServerPing(t_server=now()).model_dump(mode='json'))
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
        with self.audit_factory.begin() as db:
            if op in ('TAKE', 'RELEASE', 'REQUEST', 'ACCEPT', 'DECLINE', 'TIMEOUT', 'EXPIRE', 'RUN_TAKE', 'RUN_PAUSE_TAKEOVER'):
                db.add(LeaseLog(org_id=self.settings.org_id, robot_id=rid, op=op, user_id=user,
                    other_user_id=UUID(body['other_user_id']) if body.get('other_user_id') else None,
                    session_id=UUID(body['session_id']) if body.get('session_id') else None, at=body['at']))
            ev = Event(org_id=self.settings.org_id, robot_id=rid, user_id=user, at=body['at'],
                category='SAFETY' if op in ('STOP', 'STOP_CONFIRM_FAILED') else 'LINK' if op.startswith('AGENT_') else 'LEASE',
                code=body.get('code', op), severity=body.get('severity', 'INFO').upper(),
                robot_at=body.get('robot_at'), data=body.get('data', {}))
            if isinstance(ev.robot_at, str):
                from datetime import datetime
                ev.robot_at = datetime.fromisoformat(ev.robot_at)
            if op == 'AGENT_EVENT':
                ev.category = CATEGORIES.get(ev.code, 'LINK') if ev.code in AGENT_CODES else 'LINK'
            else:
                ev.category = CATEGORIES.get(ev.code, ev.category)
            render(db, ev, agent=op == 'AGENT_EVENT', other_user_id=body.get('other_user_id'))
            db.add(ev)
            if op != 'AGENT_EVENT' or ev.code in AGENT_CODES:
                append_for_event(db, ev, other_user_id=body.get('other_user_id'))
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

    def block_archive_source(self, rid, reason):
        if not isinstance(self.audit, FairAuditQueue):
            self.fail_audit_storage(reason)
            return
        channel = self.audit.channel(rid)
        if channel.blocked:
            return
        channel.blocked = True
        channel.retry_at = self.clock() + 1
        # Physical delivery is scheduled before diagnostic/file work, and only
        # this robot is revoked. Other robots retain their leases and budgets.
        self.apply(self.arbiter.revoke(rid, op='EXPIRE'))
        peer = self.agents.get(rid)
        if peer is not None:
            peer.auth_checked = float('-inf')
            peer.closing = True
            task = asyncio.create_task(self.close_archive_source(rid, peer))
            peer.archive_close = task
            self.archive_closers.add(task)
            task.add_done_callback(self.archive_closers.discard)
        self.queue_audit(Effect('audit', rid, {'op': 'HISTORY_STORAGE_BLOCKED', 'at': now(),
            'code': 'HISTORY_STORAGE_BLOCKED', 'data': {'reason': reason}}))

    async def close_archive_source(self, rid, peer):
        try:
            await self.send_body(peer, {'t': 'lease', 'lease_id': None, 'holder_type': None})
            await self.send_body(peer, {'t': 'stop', 'by_user_id': None,
                                       'stop_ref': self.arbiter.robot(rid).stop_ref})
        except (Exception, asyncio.CancelledError):
            pass  # the close reason is also an explicit storage-stop signal
        finally:
            with suppress(Exception):
                await peer.socket.close(code=1013, reason='ROBOT_ARCHIVE_LIMIT')

    def fail_audit_storage(self, reason="DEQUEUE_FAILED"):
        # A failed dequeue has not transferred ownership: retain the FIFO head
        # and latch the input gate even if earlier drains cleared overload.
        first = not self.audit_storage_failed
        self.audit_storage_failed = self.audit_overloaded = True
        if first:
            self.emergency_free()
            robot = next(iter(self.arbiter.robots), None)
            if robot is not None:
                try:
                    self.queue_audit(Effect('audit', robot, {'op': 'HISTORY_STORAGE_BLOCKED',
                        'code': 'HISTORY_STORAGE_BLOCKED', 'at': now(), 'data': {'reason': reason}}))
                except Exception:
                    log.warning('History fault event could not be retained')

    async def auditor(self):
        while True:
            try:
                effect = await self.audit.get()
            except Exception as exc:
                self.fail_audit_storage()
                log.warning('Realtime history dequeue unavailable (%s); retrying', type(exc).__name__)
                await asyncio.sleep(.5)
                continue
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
                            'at': effect.body.get('at', now()), 'data': {'count': 1, 'error_type': type(exc).__name__,
                                **{k: v for k, v in effect.body.get('data', {}).items() if k in ('server_received_at', 'robot_sequence')}}})
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

    class StopResponse(JSONResponse):
        def __init__(self, records, reservations):
            super().__init__({'requested': True}, status_code=202)
            self.records, self.reservations = records, reservations
        async def __call__(self, scope, receive, send):
            try:
                await super().__call__(scope, receive, send)
            finally:
                # The response object owns the accepted records even if sending
                # is cancelled. No file/DB operation precedes response delivery.
                if self.reservations is not None:
                    for reservation in self.reservations:
                        realtime.audit.commit(reservation)
                else:
                    realtime.apply(self.records)

    @app.post('/api/v1/robots/{robot_id}/stop', status_code=202)
    async def stop(robot_id: UUID, request: Request):
        if realtime.owner_connection is None:
            raise api_error(503, 'SERVER_BUSY', '실시간 중재기 연결을 확인하세요.')
        actor, epoch = await realtime.stop_actor(request.headers, request.cookies, robot_id)
        with realtime.stop_cache_lock:
            if realtime.stop_scope_changed(epoch, actor, robot_id):
                raise api_error(503, 'SERVER_BUSY', '권한 변경 후 정지를 다시 요청하세요.')
            effects = realtime.arbiter.stop(str(robot_id), actor)
            safety = [e for e in effects if e.target != 'audit']
            records = [e for e in effects if e.target == 'audit']
            try:
                reservations = ([realtime.audit.reserve(e) for e in records]
                                if isinstance(realtime.audit, FairAuditQueue) else None)
            except SourceArchiveFull:
                realtime.apply(safety)
                realtime.block_archive_source(str(robot_id), 'CAPACITY')
                raise api_error(503, 'SERVER_BUSY', '로봇 정지 접수 기록을 확인하지 못했습니다.')
            realtime.apply(safety)
        return StopResponse(records, reservations)
