"""One-use pairing: public code carries no credential; poll secret never persists."""
import asyncio
import hmac
import secrets
from contextlib import suppress
from datetime import timedelta
from uuid import UUID, uuid4

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from fastapi import Request, Response
from starlette.websockets import WebSocketDisconnect
from sqlalchemy import delete, func, select
from sqlalchemy.dialects.postgresql import insert

from apps.contracts import models as C
from . import phone_pass
from .models import Event, Pairing, PairingRate, Robot, now
from .event_messages import render
from .robots import robot_object
from .security import digest, token

TTL = timedelta(minutes=10)
MAX_PENDING = 100


class NoStorePairing:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope['type'] != 'http' or not scope['path'].startswith('/api/v1/pairing/'):
            return await self.app(scope, receive, send)
        async def no_store(message):
            if message['type'] == 'http.response.start':
                message = {**message, 'headers': [(k, v) for k, v in message['headers']
                    if k.lower() != b'cache-control'] + [(b'cache-control', b'no-store')]}
            await send(message)
        await self.app(scope, receive, no_store)


def expire(factory, org_id):
    """Durable expiry history includes robots whose agent is offline."""
    with factory.begin() as db:
        for robot in db.scalars(select(Robot).where(Robot.org_id == org_id,
                Robot.field_approval_expires_at <= now()).with_for_update(skip_locked=True)):
            expired = robot.field_approval_expires_at
            robot.field_approval_expires_at = None
            db.add(render(db, Event(org_id=org_id, robot_id=robot.id, category='SAFETY',
                code='FIELD_APPROVAL_EXPIRED', severity='INFO', data={'expires_at': expired.isoformat()})))


def revoke_on_agent_connect(factory, org_id, rid, token_hash):
    """Persist before publishing a new authenticated real-agent connection."""
    from .api import lock_organization
    with factory.begin() as db:
        lock_organization(db, org_id)
        robot = db.scalar(select(Robot).where(Robot.org_id == org_id,
            Robot.id == UUID(rid), Robot.archived_at.is_(None)).with_for_update())
        if robot is None or not hmac.compare_digest(robot.agent_token_hash, token_hash):
            return False
        if not robot.simulation and robot.field_approval_expires_at is not None:
            robot.field_approval_expires_at = None
            db.add(render(db, Event(org_id=org_id, robot_id=robot.id, category='SAFETY',
                code='FIELD_APPROVAL_REVOKED', severity='INFO', data={'reason': 'AGENT_RECONNECTED'})))
    return True


async def close_connection(rt, rid):
    peer = rt.agents.get(rid)
    if peer is None:
        return
    # A token watcher may already be closing the old socket after commit.
    # In either case, try safe delivery before closing, never fail a durable
    # credential revocation just because the old transport has disappeared.
    with suppress(WebSocketDisconnect, RuntimeError, asyncio.TimeoutError):
        await rt.send_body(peer, {'t': 'lease', 'lease_id': None, 'holder_type': None})
        await rt.send_body(peer, {'t': 'stop', 'by_user_id': None,
                                  'stop_ref': rt.arbiter.robot(rid).stop_ref})
    peer.closing = True
    with suppress(WebSocketDisconnect, RuntimeError, asyncio.TimeoutError):
        await peer.socket.close(code=4403)


def install(app, DB, Identity, fail, authorize, settings, find_robot, robot_event, issuer):
    from .api import lock_organization
    prefix = '/api/v1'
    app.add_middleware(NoStorePairing)

    def missing():
        fail(404, 'PAIRING_NOT_FOUND', '연결 코드를 확인하거나 새로 발급하세요.')

    def operator(auth):
        user = auth[0]
        if user.role != 'OPERATOR':
            fail(403, 'FORBIDDEN', '담당 운영자만 로봇을 연결할 수 있습니다.')
        return user

    def rate(db, request, lane, user=None):
        at = now()
        window = at.replace(minute=at.minute // 10 * 10, second=0, microsecond=0)
        keys = [(f'{lane}:ip:{request.client.host if request.client else "unknown"}',
                 10 if lane == 'start' else 20)]
        if user is not None:
            keys.append((f'{lane}:user:{user.id}', 10))
        blocked = False
        for key, limit in keys:
            stmt = insert(PairingRate).values(org_id=settings.org_id, key_hash=digest(key),
                window_start=window, count=1)
            count = db.scalar(stmt.on_conflict_do_update(
                index_elements=['org_id', 'key_hash', 'window_start'],
                set_={'count': PairingRate.count + 1}).returning(PairingRate.count))
            blocked |= count > limit
        db.execute(delete(PairingRate).where(PairingRate.org_id == settings.org_id,
            PairingRate.window_start < at - timedelta(days=1)))
        # Invalid codes and 429s must not roll back the attempt counters.
        db.commit()
        if blocked:
            fail(429, 'PAIRING_RATE_LIMIT', '연결 시도가 많습니다. 잠시 뒤 다시 시도하세요.')
        lock_organization(db, settings.org_id)

    def lookup(db, pairing_id):
        row = db.scalar(select(Pairing).where(Pairing.id == pairing_id,
            Pairing.org_id == settings.org_id).with_for_update())
        if row is None or row.expires_at <= now():
            missing()
        return row

    @app.post(prefix + '/pairing/start', response_model=C.PairingStarted)
    def start(body: C.PairingStart, request: Request, response: Response, db: DB):
        rate(db, request, 'start')
        db.execute(delete(Pairing).where(Pairing.org_id == settings.org_id, Pairing.expires_at <= now()))
        if db.scalar(select(func.count()).select_from(Pairing).where(
                Pairing.org_id == settings.org_id, Pairing.robot_id.is_(None))) >= MAX_PENDING:
            fail(429, 'PAIRING_CAPACITY', '연결 대기가 많습니다. 잠시 뒤 다시 시도하세요.')
        poll_secret, raw, identifier = token(), token(), uuid4()
        for _ in range(20):
            code = f'{secrets.randbelow(1_000_000):06d}'
            if db.scalar(select(Pairing.id).where(Pairing.code_hash == digest(code))) is None:
                break
        else:
            fail(503, 'PAIRING_CAPACITY', '새 연결 코드를 준비하지 못했습니다.')
        nonce = secrets.token_bytes(12)
        # The poll secret is the encryption key; the server stores only its hash.
        # Confirm activates this pre-generated credential without exposing it.
        ciphertext = nonce + AESGCM(digest('pairing-token:' + poll_secret)).encrypt(nonce, raw.encode(), identifier.bytes)
        row = Pairing(id=identifier, org_id=settings.org_id, code_hash=digest(code),
            poll_hash=digest(poll_secret), token_hash=digest(raw), token_ciphertext=ciphertext,
            robot_serial=body.robot_serial, expires_at=now() + TTL, consumed=False)
        db.add(row)
        response.headers['Cache-Control'] = 'no-store'
        return C.PairingStarted(pairing_id=identifier, code=code, expires_at=row.expires_at,
                                poll_secret=poll_secret)

    @app.post(prefix + '/pairing/claim', response_model=C.PairingClaimed)
    def claim(body: C.PairingClaim, request: Request, response: Response, auth: Identity, db: DB):
        user = operator(auth)
        rate(db, request, 'claim', user)
        row = db.scalar(select(Pairing).where(Pairing.org_id == settings.org_id,
            Pairing.code_hash == digest(body.code)).with_for_update())
        if (row is None or row.expires_at <= now() or row.robot_id is not None
                or row.consumed or row.claimed_by not in (None, user.id)):
            missing()
        row.claimed_by = user.id
        response.headers['Cache-Control'] = 'no-store'
        return C.PairingClaimed(pairing_id=row.id, robot_serial=row.robot_serial, expires_at=row.expires_at)

    @app.post(prefix + '/pairing/{pairing_id}/confirm', response_model=C.RobotSummary)
    async def confirm(pairing_id: UUID, body: C.PairingConfirm, response: Response, auth: Identity, db: DB):
        user = operator(auth)
        row = await asyncio.to_thread(lookup, db, pairing_id)
        if row.claimed_by != user.id or row.robot_id is not None or row.consumed:
            missing()
        if not body.name.strip():
            fail(400, 'VALIDATION', '로봇 이름을 입력하세요.')
        def existing_robot():
            return db.scalar(select(Robot).where(Robot.serial == row.robot_serial,
                Robot.archived_at.is_(None)).with_for_update())
        existing = await asyncio.to_thread(existing_robot)
        if existing is not None:
            if (existing.org_id != user.org_id or existing.owner_user_id != user.id
                    or existing.simulation):
                fail(409, 'ROBOT_ALREADY_PAIRED', '담당 운영에게 넘겨받기 또는 삭제를 요청하세요.')
            rt, rid = app.state.realtime, str(existing.id)
            rt.begin_robot_change(rid)
            try:
                rt.set_field_approval(rid, None)
                def reconnect():
                    if existing.field_approval_expires_at is not None:
                        robot_event(db, user, existing, 'FIELD_APPROVAL_REVOKED', {'reason': 'REPAIRED'})
                    existing.name = body.name.strip()
                    existing.agent_token_hash = row.token_hash
                    existing.field_approval_expires_at = None
                    phone_pass.revoke(db, user.org_id, robot_id=existing.id, clock=issuer.clock)
                    row.robot_id = existing.id
                    robot_event(db, user, existing, 'ROBOT_REPAIRED', {'name': existing.name})
                    db.commit()
                await asyncio.to_thread(reconnect)
                rt.set_field_approval(rid, None)
                await close_connection(rt, rid)
                response.headers['Cache-Control'] = 'no-store'
                return await asyncio.to_thread(robot_object, db, existing, user, rt)
            finally:
                rt.end_robot_change(rid)
        def create():
            robot = Robot(org_id=user.org_id, owner_user_id=user.id, name=body.name.strip(),
                model='unitree_go2', simulation=False, serial=row.robot_serial, agent_token_hash=row.token_hash)
            db.add(robot)
            db.flush()
            row.robot_id = robot.id
            robot_event(db, user, robot, 'ROBOT_CREATED', {'name': robot.name, 'paired': True})
            return robot_object(db, robot, user, app.state.realtime)
        response.headers['Cache-Control'] = 'no-store'
        return await asyncio.to_thread(create)

    @app.post(prefix + '/pairing/{pairing_id}/poll', response_model=C.PairingWaiting | C.PairingPaired)
    def poll(pairing_id: UUID, body: C.PairingPoll, request: Request, response: Response, db: DB):
        row = db.scalar(select(Pairing).where(Pairing.id == pairing_id,
            Pairing.org_id == settings.org_id).with_for_update())
        valid = hmac.compare_digest(row.poll_hash if row else bytes(32), digest(body.poll_secret))
        if not valid or row is None or row.expires_at <= now():
            missing()
        response.headers['Cache-Control'] = 'no-store'
        if row.consumed:
            return C.PairingWaiting(state='consumed')
        if row.robot_id is None:
            return C.PairingWaiting(state='waiting')
        # A revoke/delete between confirm and poll must never release an old key.
        robot = db.scalar(select(Robot).where(Robot.id == row.robot_id,
            Robot.org_id == settings.org_id, Robot.archived_at.is_(None)))
        if robot is None or not hmac.compare_digest(robot.agent_token_hash, row.token_hash):
            missing()
        encrypted = row.token_ciphertext
        raw = AESGCM(digest('pairing-token:' + body.poll_secret)).decrypt(encrypted[:12], encrypted[12:], row.id.bytes).decode()
        row.consumed, row.token_ciphertext = True, None
        address = request.url.replace(scheme='wss' if request.url.scheme == 'https' else 'ws',
                                      path=prefix + '/agent/ws', query='')
        return C.PairingPaired(robot_id=row.robot_id, agent_token=raw, agent_ws_url=str(address))

    async def field_change(robot_id, auth, db, body=None):
        user = operator(auth)
        row = await asyncio.to_thread(find_robot, db, user, robot_id)
        authorize(user, 'ROBOT_WRITE', row)
        if row.simulation:
            fail(400, 'VALIDATION', '현장 확인은 실기 로봇에만 필요합니다.')
        if body is not None and (set(body.checks) != C.FIELD_APPROVAL_CHECKS
                                or len(body.checks) != len(C.FIELD_APPROVAL_CHECKS)):
            fail(400, 'VALIDATION', '필수 현장 안전 항목을 모두 확인하세요.')
        rt, rid = app.state.realtime, str(robot_id)
        rt.begin_robot_change(rid)
        try:
            expiry = now() + timedelta(minutes=30) if body is not None else None
            def write():
                row.field_approval_expires_at = expiry
                robot_event(db, user, row, 'FIELD_APPROVAL_GRANTED' if expiry else 'FIELD_APPROVAL_REVOKED',
                    {'expires_at': expiry.isoformat() if expiry else None,
                     'checks': sorted(C.FIELD_APPROVAL_CHECKS) if expiry else []})
                db.commit()
            # Close the motion gate and revoke the lease before any I/O wait.
            rt.set_field_approval(rid, None)
            await asyncio.to_thread(write)
            rt.set_field_approval(rid, expiry)
            return expiry
        finally:
            rt.end_robot_change(rid)

    @app.post(prefix + '/robots/{robot_id}/field-approval', response_model=C.FieldApproval)
    async def approve(robot_id: UUID, body: C.FieldApprovalRequest, auth: Identity, db: DB):
        return C.FieldApproval(expires_at=await field_change(robot_id, auth, db, body))

    @app.delete(prefix + '/robots/{robot_id}/field-approval', status_code=204)
    async def revoke(robot_id: UUID, auth: Identity, db: DB):
        await field_change(robot_id, auth, db)

    @app.delete(prefix + '/robots/{robot_id}/connection', status_code=204)
    async def disconnect(robot_id: UUID, auth: Identity, db: DB):
        user = operator(auth)
        row = await asyncio.to_thread(find_robot, db, user, robot_id)
        authorize(user, 'ROBOT_WRITE', row)
        if row.simulation:
            fail(409, 'SIM_TOKEN_MANAGED', '시뮬 관리자에서 연결을 관리합니다.')
        rt, rid = app.state.realtime, str(robot_id)
        rt.begin_robot_change(rid)
        try:
            rt.set_field_approval(rid, None)
            def write():
                row.agent_token_hash = digest(token())
                if row.field_approval_expires_at is not None:
                    robot_event(db, user, row, 'FIELD_APPROVAL_REVOKED', {'reason': 'DISCONNECTED'})
                row.field_approval_expires_at = None
                phone_pass.revoke(db, user.org_id, robot_id=row.id, clock=issuer.clock)
                robot_event(db, user, row, 'ROBOT_DISCONNECTED', {})
                db.commit()
            await asyncio.to_thread(write)
            rt.set_field_approval(rid, None)
            await close_connection(rt, rid)
        finally:
            rt.end_robot_change(rid)
