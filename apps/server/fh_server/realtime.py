"""WebSocket transport and effect adapter; safe outputs never wait for audit writes.

A single ASGI process owns the arbiter. SQL reads run off the event loop, use no
row/advisory locks and never update session.last_seen_at. Audit writes have their
own connection pool/worker; a blocked insert cannot delay STOP or lease null.
"""
import asyncio
from contextlib import suppress
from dataclasses import dataclass, field
from datetime import timedelta
import json
import logging
import time
from uuid import UUID, uuid4

from fastapi import Request, WebSocket, WebSocketDisconnect
from pydantic import TypeAdapter, ValidationError
from sqlalchemy import create_engine, select, text
from sqlalchemy.orm import sessionmaker

from apps.contracts import models as C
from .leases import Actor, Arbiter, Effect, LeaseError, Transfer
from .models import Event, LeaseLog, Organization, Robot, Session, User, now
from .security import digest

log = logging.getLogger(__name__)
SCREEN = TypeAdapter(C.ScreenMessage)
AGENT = TypeAdapter(C.AgentMessage)
MAX_FRAME = 4096


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


class Realtime:
    def __init__(self, settings, factory, authorize, api_error, clock=time.monotonic):
        self.settings = settings
        self.read_engine = create_engine(settings.database_url, pool_size=5, max_overflow=5,
            connect_args={'options': '-c default_transaction_read_only=on -c statement_timeout=2000'})
        self.factory = sessionmaker(self.read_engine, expire_on_commit=False)
        self.authorize, self.api_error, self.clock = authorize, api_error, clock
        self.arbiter = Arbiter(clock)
        self.screens: dict[str, Peer] = {}
        self.agents: dict[str, Peer] = {}
        self.runs: dict[str, dict] = {}  # executor persistence is a later task
        self.audit = asyncio.Queue(4096)
        self.audit_engine = create_engine(settings.database_url, pool_size=1, max_overflow=0,
                                         connect_args={'options': '-c lock_timeout=1000 -c statement_timeout=2000'})
        self.audit_factory = sessionmaker(self.audit_engine, expire_on_commit=False)
        self.tasks = []
        self.failed = False
        self.owner_connection = None
        self.starts = 0

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
            return
        self.tasks = [asyncio.create_task(self.ticker()), asyncio.create_task(self.auditor()),
                      asyncio.create_task(self.ownership_watch())]

    def ownership_alive(self):
        alive = self.owner_connection.scalar(text("SELECT EXISTS (SELECT 1 FROM pg_locks "
            "WHERE pid=pg_backend_pid() AND locktype='advisory' AND granted)"))
        self.owner_connection.commit()
        return alive

    async def ownership_watch(self):
        while True:
            await asyncio.sleep(0.5)
            try:
                alive = await asyncio.to_thread(self.ownership_alive)
            except Exception:
                alive = False
            if not alive:
                self.failed = True
                self.emergency_free()
                for peer in [*self.agents.values(), *self.screens.values()]:
                    asyncio.create_task(peer.socket.close(code=1013))
                return

    async def close(self):
        if self.starts <= 0:
            return
        self.starts -= 1
        if self.starts:
            return
        for task in self.tasks:
            task.cancel()
        await asyncio.gather(*self.tasks, return_exceptions=True)
        if self.owner_connection is not None:
            with suppress(Exception):
                self.owner_connection.execute(text('SELECT pg_advisory_unlock(hashtextextended(:key, 0))'),
                    {'key': 'fh-realtime:' + str(self.settings.org_id)})
            self.owner_connection.close()
            self.owner_connection = None
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

    def agent_identity(self, headers):
        raw = headers.get('authorization', '')
        if not raw.startswith('Bearer ') or not raw[7:]:
            raise self.api_error(401, 'AUTH_REQUIRED', '에이전트 인증이 필요합니다.')
        with self.factory() as db:
            rows = db.scalars(select(Robot).where(Robot.org_id == self.settings.org_id,
                Robot.agent_token_hash == digest(raw[7:]), Robot.archived_at.is_(None))).all()
            if len(rows) != 1:
                raise self.api_error(403, 'FORBIDDEN', '에이전트 인증을 확인하세요.')
            return str(rows[0].id)

    def put(self, peer, body):
        if peer.closing:
            return
        try:
            peer.queue.put_nowait(body)
        except asyncio.QueueFull:
            peer.closing = True
            asyncio.create_task(peer.socket.close(code=1013))

    def apply(self, effects):
        """Synchronous effect enqueue. First two revoke effects cannot interleave."""
        for effect in effects:
            body, rid = dict(effect.body), effect.robot
            target = effect.target
            if target == 'agent':
                peer = self.agents.get(rid)
                if peer:
                    if body['t'] == 'cmd':
                        body['t_server'] = now().isoformat().replace('+00:00', 'Z')
                    # Safety transitions discard any unsent movement inputs. They
                    # keep lease-null/stop order and bypass queued telemetry/ping.
                    if body['t'] in ('stop', 'lease'):
                        retained = []
                        while not peer.queue.empty():
                            item = peer.queue.get_nowait()
                            if item.get('t') not in ('cmd', 'ping', 'streams'):
                                retained.append(item)
                        for item in retained:
                            peer.queue.put_nowait(item)
                    self.put(peer, body)
            elif target == 'audit':
                try:
                    self.audit.put_nowait(Effect('audit', rid, {**body, 'at': now()}))
                except asyncio.QueueFull:
                    # Fail closed on unrecordable state changes. STOP is already
                    # enqueued above; no database access on this failure path.
                    self.failed = True
                    self.emergency_free()
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
                    # Delivery performs a fresh policy check outside the safety
                    # path; the wire writer never blocks arbiter progress.
                    self.put(peer, {'_delivery': outgoing})

    def emergency_free(self):
        for rid, r in self.arbiter.robots.items():
            r.holder = r.transfer = r.request = None
            peer = self.agents.get(rid)
            if peer:
                self.put(peer, {'t': 'lease', 'lease_id': None, 'holder_type': None})
                self.put(peer, {'t': 'stop', 'by_user_id': None})

    async def writer(self, peer, screen=False):
        try:
            while True:
                body = await peer.queue.get()
                if '_delivery' in body:
                    body = body['_delivery']
                    try:
                        await asyncio.to_thread(self.access, peer.actor, [body['robot']], 'ROBOT_READ')
                    except self.api_error as exc:
                        await peer.socket.close(code=4401 if exc.status == 401 else 4403)
                        return
                await asyncio.wait_for(peer.socket.send_json(body), timeout=0.25)
        except (WebSocketDisconnect, RuntimeError, asyncio.TimeoutError):
            peer.closing = True
            with suppress(Exception):
                await peer.socket.close(code=1013)

    async def receive(self, ws):
        packet = await ws.receive()
        if packet['type'] == 'websocket.disconnect':
            raise WebSocketDisconnect(packet.get('code', 1000))
        raw = packet.get('text')
        if raw is None or len(raw.encode('utf-8')) > MAX_FRAME:
            await ws.close(code=1009 if raw is not None else 1003)
            raise WebSocketDisconnect(1009)
        try:
            data = json.loads(raw)
            if not isinstance(data, dict):
                raise ValueError()
            return data
        except (ValueError, RecursionError):
            await ws.close(code=1007)
            raise WebSocketDisconnect(1007)

    def streams(self):
        for rid, agent in self.agents.items():
            enabled = set().union(*(p.subscriptions.get(rid, set()) for p in self.screens.values()))
            self.put(agent, {'t': 'streams', **{k: k in enabled for k in ('rgb', 'depth', 'lidar', 'map')}})

    async def screen_ws(self, ws: WebSocket):
        if self.owner_connection is None or self.failed:
            await ws.close(code=1013)
            return
        cid = str(uuid4())
        try:
            actor = await asyncio.to_thread(self.identity, ws.headers, ws.cookies, cid)
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
        await ws.accept()
        peer = Peer(ws, actor=actor, last_rx=self.clock())
        self.screens[cid] = peer
        sender = asyncio.create_task(self.writer(peer, True))
        watcher = asyncio.create_task(self.screen_watch(peer))
        try:
            first = True
            while True:
                raw = await self.receive(ws)
                if (first and raw.get('proto') != 'fh-rt/1') or ('proto' in raw and raw['proto'] != 'fh-rt/1'):
                    await ws.close(code=4403, reason='PROTOCOL_MISMATCH')
                    return
                first = False
                try:
                    msg = SCREEN.validate_python(raw)
                    rid = str(msg.robot) if hasattr(msg, 'robot') else None
                    robots = [str(x) for x in msg.robots] if msg.t == 'sub' else ([rid] if rid else [])
                    policy = 'ROBOT_READ' if msg.t == 'sub' else ('ROBOT_SUMMARY' if msg.t == 'stop' else 'O_OWN' if rid else 'LOGIN')
                    settings = await asyncio.to_thread(self.access, actor, robots, policy, msg.t == 'lease.request')
                    self.apply(self.arbiter.tick())  # expiry before new input
                    if self.failed and msg.t != 'stop':
                        raise LeaseError('SERVER_BUSY', '서버 기록을 확인하고 있습니다.', 503)
                    if msg.t == 'sub':
                        peer.subscriptions = {r: set(msg.streams) for r in robots}
                        self.streams()
                        for robot in robots:
                            self.apply([self.arbiter.announce(robot)])
                    elif msg.t == 'ping':
                        pass  # ping never extends a lease heartbeat
                    elif msg.t == 'stop':
                        self.apply(self.arbiter.stop(rid, actor))
                    else:
                        if rid not in self.agents or self.agents[rid].closing:
                            raise LeaseError('ROBOT_OFFLINE', '로봇 연결이 끊겼습니다.', 503)
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
                                    await asyncio.to_thread(self.access, pending.actor, [rid], 'O_OWN')
                                except self.api_error:
                                    self.apply(self.arbiter.cancel_request(rid))
                                    raise LeaseError('LEASE_REQUEST_STALE', '요청자의 조종 권한이 바뀌었습니다.')
                                self.apply(self.arbiter.tick())
                            self.apply(self.arbiter.respond(rid, actor, str(msg.request_id), msg.accept))
                        elif msg.t == 'lease.release':
                            self.apply(self.arbiter.release(rid, actor))
                        elif msg.t == 'hidden':
                            self.apply(self.arbiter.hidden(rid, actor))
                        elif msg.t == 'cmd':
                            self.apply(self.arbiter.cmd(rid, actor, str(msg.lease_id), msg.seq, msg.axes))
                        elif msg.t == 'unlock':
                            self.apply(self.arbiter.unlock(rid, actor, str(msg.lease_id), msg.stop_gen))
                    self.put(peer, C.ScreenReply(id=msg.id, ok=True).model_dump(mode='json'))
                except ValidationError:
                    self.put(peer, {'t': 'reply', 'id': str(raw.get('id', ''))[:128], 'ok': False,
                                    'error': {'code': 'VALIDATION', 'message': '입력 형식을 확인하세요.', 'detail': {}}})
                except (self.api_error, LeaseError) as exc:
                    if isinstance(exc, self.api_error) and exc.status in (401, 403, 404):
                        await ws.close(code=4401 if exc.status == 401 else 4403)
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
            # Socket loss preserves existing holder for 15 s, but cannot complete
            # a new transfer to a vanished connection.
            for rid, r in self.arbiter.robots.items():
                if r.request and r.request.actor == actor:
                    self.apply(self.arbiter.cancel_request(rid))
                if r.transfer and r.transfer.actor == actor:
                    self.apply(self.arbiter.revoke(rid, actor))
            sender.cancel()
            watcher.cancel()
            await asyncio.gather(sender, watcher, return_exceptions=True)
            self.streams()

    async def screen_watch(self, peer):
        try:
            while True:
                await asyncio.sleep(0.1)
                try:
                    await asyncio.to_thread(self.access, peer.actor, list(peer.subscriptions), 'ROBOT_READ')
                    for rid, r in list(self.arbiter.robots.items()):
                        if (r.holder and r.holder.actor == peer.actor) or (r.transfer and r.transfer.actor == peer.actor):
                            await asyncio.to_thread(self.access, peer.actor, [rid], 'O_OWN')
                except self.api_error as exc:
                    for rid, r in self.arbiter.robots.items():
                        if (r.holder and r.holder.actor == peer.actor) or (r.transfer and r.transfer.actor == peer.actor):
                            self.apply(self.arbiter.revoke(rid, peer.actor))
                    await peer.socket.close(code=4401 if exc.status == 401 else 4403)
                    return
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
            for rid, r in self.arbiter.robots.items():
                if (r.holder and r.holder.actor == peer.actor) or (r.transfer and r.transfer.actor == peer.actor):
                    self.apply(self.arbiter.revoke(rid, peer.actor))
            with suppress(Exception):
                await peer.socket.close(code=1013)

    async def agent_ws(self, ws: WebSocket):
        if self.owner_connection is None or self.failed:
            await ws.close(code=1013)
            return
        try:
            rid = await asyncio.to_thread(self.agent_identity, ws.headers)
        except self.api_error as exc:
            await ws.close(code=4401 if exc.status == 401 else 4403)
            return
        await ws.accept()
        peer = Peer(ws, last_rx=self.clock(), last_ping=self.clock())
        sender = None
        try:
            raw = await asyncio.wait_for(self.receive(ws), 3)
            hello = C.AgentHello.model_validate(raw)
            old = self.agents.get(rid)
            if old:
                old.closing = True
                await old.socket.close(code=1012)
            self.agents[rid] = peer
            r = self.arbiter.robot(rid)
            self.apply(self.arbiter.revoke(rid, op='EXPIRE'))
            r.stop_gen, r.latched = hello.stop_gen, hello.latched
            peer.state = {'devices': [d.model_dump(mode='json') for d in hello.devices],
                          'latched': hello.latched, 'stop_gen': hello.stop_gen}
            run = hello.run.model_dump(mode='json') if hello.run else None
            if run and run['status'] not in ('COMPLETED', 'FAILED', 'ABORTED'):
                run['status'] = 'PAUSED'
                run['wait_reason'] = 'RECONNECTED'
                self.runs[rid] = run
                self.put(peer, {'t': 'run.control', 'run_id': run['run_id'], 'op': 'pause'})
                # RUN remains reserved after the same stop verification barrier.
                r.transfer = Transfer(None, self.clock() + 2, hello.stop_gen)
            else:
                self.runs.pop(rid, None)
            self.apply([Effect('audit', rid, {'op': 'AGENT_CONNECTED'})])
            sender = asyncio.create_task(self.writer(peer))
            self.streams()
            while True:
                raw = await self.receive(ws)
                if self.agents.get(rid) is not peer:
                    return
                if peer.closing or await asyncio.to_thread(self.agent_identity, ws.headers) != rid:
                    await ws.close(code=4403)
                    return
                if self.agents.get(rid) is not peer:
                    return
                peer.last_rx = self.clock()
                msg = AGENT.validate_python(raw)
                if msg.t == 'hello':
                    # Same-socket recovery must get a fresh connection/identity.
                    await ws.close(code=1012, reason='RECONNECT_REQUIRED')
                    return
                self.apply(self.arbiter.tick())
                if msg.t == 'state':
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
                            await asyncio.to_thread(self.access, pending.actor, [rid], 'O_OWN')
                        except self.api_error:
                            self.apply(self.arbiter.revoke(rid, pending.actor))
                    if self.agents.get(rid) is not peer or peer.closing:
                        return
                    self.apply(self.arbiter.state(rid, msg.latched, msg.applied, msg.stop_gen))
                elif msg.t == 'event':
                    self.apply([Effect('audit', rid, {'op': 'AGENT_EVENT', **msg.model_dump(mode='json')})])
                elif msg.t == 'run.update':
                    # Placeholder: accept matching paused/terminal reports only;
                    # no mission execution or persistence is claimed here.
                    run = self.runs.get(rid)
                    if run and run['run_id'] == str(msg.run_id) and msg.status in ('PAUSED', 'COMPLETED', 'FAILED', 'ABORTED'):
                        run.update(status=msg.status, step=msg.step)
                        if msg.status != 'PAUSED':
                            self.apply(self.arbiter.revoke(rid))
                # ping, cmd.ack, media are validated no-op extension points.
        except self.api_error:
            await ws.close(code=4403)
        except (ValidationError, asyncio.TimeoutError):
            await ws.close(code=4403, reason='PROTOCOL_MISMATCH_OR_INVALID_FRAME')
        except WebSocketDisconnect:
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
            if sender:
                sender.cancel()
                await asyncio.gather(sender, return_exceptions=True)

    async def ticker(self):
        while True:
            await asyncio.sleep(0.025)
            self.apply(self.arbiter.tick())
            at = self.clock()
            for rid, peer in list(self.agents.items()):
                if at - peer.last_rx >= 3 and not peer.closing:
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
            'STOP_CONFIRM_FAILED': '로봇 정지 확인에 실패했습니다.',
            'AGENT_CONNECTED': '로봇이 연결되었습니다.', 'AGENT_DISCONNECTED': '로봇 연결이 끊겼습니다.'}
        with self.audit_factory.begin() as db:
            if op in ('TAKE', 'RELEASE', 'REQUEST', 'ACCEPT', 'DECLINE', 'TIMEOUT', 'EXPIRE', 'RUN_TAKE'):
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

    async def auditor(self):
        while True:
            effect = await self.audit.get()
            while True:
                try:
                    ev = await asyncio.to_thread(self.record, effect)
                    self.apply([Effect('screens', effect.robot, {'t': 'event', **ev})])
                    break
                except Exception:
                    # Retain the same item, retry with bounded DB lock timeout;
                    # backpressure eventually fails leases closed, never STOP.
                    log.warning('Realtime audit unavailable; retrying')
                    await asyncio.sleep(0.5)
            self.audit.task_done()


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
