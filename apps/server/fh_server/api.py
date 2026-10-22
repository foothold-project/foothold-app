"""REST scope only: authentication, accounts, robot summaries, organization settings."""
import asyncio
import base64
from contextlib import asynccontextmanager
import json
import os
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Annotated, Literal
from uuid import UUID

from fastapi import Depends, FastAPI, Request, Response, Query
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from sqlalchemy import create_engine, func, or_, select, text, tuple_, update
from sqlalchemy.exc import DataError, DBAPIError, IntegrityError
from sqlalchemy.orm import Session as DBSession, sessionmaker
from starlette.exceptions import HTTPException

from apps.contracts import models as C
from .models import Event, Organization, Robot, RobotDevice, Session, User, now
from .security import digest, hash_password, token, verify_password, web_csrf
from .robots import attention, device_error, live_state, robot_object, robot_objects
from .rate_limits import close_rate_windows, record_rate_limit
from .event_messages import render
from . import approvals, assignments, phone_pass
from .tunnel import tunnel_origin


@dataclass(frozen=True)
class Settings:
    database_url: str
    org_id: UUID
    web_session_seconds: int = 86400
    ws_origin: str | None = None
    files_root: str = '/var/lib/foothold/files'
    phone_pass_keys: str | None = None
    simmgr_url: str | None = None
    simmgr_auth_file: str | None = None
    tunnel_origin: str | None = None

    @classmethod
    def from_env(cls):
        return cls(os.environ['FH_DATABASE_URL'], UUID(os.environ['FH_ORG_ID']),
                   ws_origin=os.environ.get('FH_WS_ORIGIN'),
                   files_root=os.environ.get('FH_FILES_ROOT', '/var/lib/foothold/files'),
                   phone_pass_keys=os.environ.get('FH_PHONE_PASS_KEYS'),
                   simmgr_url=os.environ.get('FH_SIM_MANAGER_URL'), simmgr_auth_file=os.environ.get('FH_SIM_AUTH_FILE'),
                   tunnel_origin=tunnel_origin(os.environ))


class APIError(Exception):
    def __init__(self, status, code, message, detail=None):
        self.status, self.code, self.message = status, code, message
        self.detail = detail or {}


def fail(status, code, message, detail=None):
    raise APIError(status, code, message, detail)


def authorize(user: User, permission: str, robot: Robot | None = None):
    """One A/O policy, used on every request (no cached role/ownership claims)."""
    if robot is not None and (robot.org_id != user.org_id or getattr(robot, 'archived_at', None)):
        fail(404, 'NOT_FOUND', '로봇을 찾을 수 없습니다.')
    valid_role = user.role in ('ORG_ADMIN', 'OPERATOR')
    owns = user.role == 'ORG_ADMIN' or (robot is not None and robot.owner_user_id == user.id)
    if permission == 'ROBOT_READ' and not owns:
        fail(404, 'NOT_FOUND', '로봇을 찾을 수 없습니다.')
    if permission == 'O_OWN' and not owns:
        fail(403, 'NOT_ROBOT_OWNER', '담당 로봇만 조종하거나 배정할 수 있습니다.')
    allowed = {
        'LOGIN': valid_role,
        'A': user.role == 'ORG_ADMIN',
        'O': valid_role,
        'ROBOT_SUMMARY': valid_role and robot is not None,
        'ROBOT_READ': valid_role and robot is not None and owns,
        'O_OWN': valid_role and robot is not None and owns,
    }
    if not allowed.get(permission, False):
        fail(403, 'FORBIDDEN', '권한이 없습니다.')


def event(db, org_id, code, user_id=None, data=None, severity='INFO', category='ACCOUNT'):
    db.add(render(db, Event(org_id=org_id, category=category, code=code,
                 user_id=user_id, data=data or {}, severity=severity)))


def user_object(db, user):
    robots = db.scalars(select(Robot.id).where(Robot.org_id == user.org_id,
                          Robot.owner_user_id == user.id, Robot.archived_at.is_(None))).all()
    return C.User(id=user.id, username=user.username, display_name=user.display_name,
                  role=user.role, locked=user.locked, robot_ids=robots, created_at=user.created_at)



def cursor_value(cursor):
    if not cursor:
        return None
    try:
        if len(cursor) > 512:
            raise ValueError('cursor too long')
        stamp, identifier = json.loads(base64.b64decode(cursor.encode(), altchars=b'-_', validate=True))
        at = datetime.fromisoformat(stamp)
        if at.tzinfo is None or at.utcoffset() is None:
            raise ValueError('timezone required')
        return at, UUID(identifier)
    except (ValueError, UnicodeError, TypeError):
        fail(400, 'VALIDATION', '목록 위치가 올바르지 않습니다.')


def page(db, query, model, limit, cursor, serialize, serialize_many=None):
    after = cursor_value(cursor)
    if after:
        query = query.where(tuple_(model.created_at, model.id) > after)
    rows = list(db.scalars(query.order_by(model.created_at, model.id).limit(limit + 1)))
    has_more = len(rows) > limit
    rows = rows[:limit]
    next_cursor = None
    if has_more:
        row = rows[-1]
        value = [row.created_at.astimezone(timezone.utc).isoformat(), str(row.id)]
        next_cursor = base64.urlsafe_b64encode(json.dumps(value).encode()).decode()
    return {'items': serialize_many(db, rows) if serialize_many else [serialize(db, row) for row in rows], 'next_cursor': next_cursor}


def revoke_user_sessions(db, user, *, clock=phone_pass.time.time):
    phone_pass.revoke(db, user.org_id, user_id=user.id,clock=clock)
    db.execute(update(Session).where(Session.org_id == user.org_id, Session.user_id == user.id,
                                    Session.revoked_at.is_(None)).values(revoked_at=now()))


def lock_organization(db, org_id):
    # All authenticated writes take this before flushing sessions/users.
    # NO KEY UPDATE still serializes writers, while permitting FK KEY SHARE
    # checks from login/refresh and deferred audit insertion.
    with db.no_autoflush:
        return db.scalar(select(Organization).where(Organization.id == org_id)
                         .with_for_update(key_share=True))


def protect_last_admin(db, user, values=None, *, archive=False):
    values = values or {}
    removing = archive or values.get('role', user.role) != 'ORG_ADMIN' or values.get('locked', user.locked)
    if user.role == 'ORG_ADMIN' and not user.locked and not user.archived_at and removing:
        remaining = db.scalar(select(User.id).where(User.org_id == user.org_id, User.id != user.id,
            User.role == 'ORG_ADMIN', User.locked.is_(False), User.archived_at.is_(None)).limit(1))
        if not remaining:
            fail(409, 'LAST_ORG_ADMIN', '마지막 총괄 계정은 강등·잠금·삭제할 수 없습니다.')


def create_app(settings: Settings | None = None):
    settings = settings or Settings.from_env()
    issuer = phone_pass.Issuer(phone_pass.load_keys(settings.phone_pass_keys), fail)
    engine = create_engine(settings.database_url, pool_pre_ping=True)
    if engine.dialect.name != 'postgresql':
        raise ValueError('PostgreSQL is required')
    factory = sessionmaker(engine, expire_on_commit=False)
    @asynccontextmanager
    async def lifespan(app):
        with engine.connect() as conn:
            unsafe = conn.scalar(text("""SELECT rolsuper OR rolcreaterole OR rolcreatedb
                OR has_table_privilege(current_user, 'events', 'UPDATE')
                OR has_table_privilege(current_user, 'events', 'DELETE')
                OR has_table_privilege(current_user, 'events', 'TRUNCATE')
                OR has_table_privilege(current_user, 'approvals', 'DELETE')
                OR has_table_privilege(current_user, 'approvals', 'TRUNCATE')
                OR has_table_privilege(current_user, 'approvals', 'UPDATE')
                OR EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'approvals'
                    AND column_name NOT IN ('status', 'decider_id', 'decided_at', 'decision_comment')
                    AND has_column_privilege(current_user, 'approvals', column_name, 'UPDATE'))
                OR has_table_privilege(current_user, 'map_versions', 'UPDATE')
                OR EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'map_versions' AND column_name <> 'status'
                    AND has_column_privilege(current_user, 'map_versions', column_name, 'UPDATE'))
                OR has_table_privilege(current_user, 'map_versions', 'DELETE')
                OR has_table_privilege(current_user, 'map_versions', 'TRUNCATE')
                OR has_table_privilege(current_user, 'uploads', 'UPDATE')
                OR has_table_privilege(current_user, 'uploads', 'DELETE')
                OR has_table_privilege(current_user, 'uploads', 'TRUNCATE')
                OR EXISTS (SELECT 1 FROM information_schema.tables
                    WHERE table_schema = 'public' AND table_name IN ('mission_versions', 'scenario_versions', 'missions', 'scenarios')
                    AND (has_table_privilege(current_user, table_name, 'DELETE')
                        OR has_table_privilege(current_user, table_name, 'TRUNCATE')
                        OR has_table_privilege(current_user, table_name, 'UPDATE')))
                OR EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name IN ('mission_versions', 'scenario_versions', 'missions', 'scenarios')
                    AND (table_name IN ('mission_versions', 'scenario_versions')
                        OR column_name NOT IN ('name', 'latest_version', 'version', 'archived_at'))
                    AND has_column_privilege(current_user, table_name, column_name, 'UPDATE'))
                OR EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name IN ('assignments', 'idempotency_receipts')
                    AND (has_table_privilege(current_user, table_name, 'DELETE')
                        OR has_table_privilege(current_user, table_name, 'TRUNCATE')
                        OR has_table_privilege(current_user, table_name, 'UPDATE')
                        OR (has_column_privilege(current_user, table_name, column_name, 'UPDATE')
                            AND NOT ((table_name = 'assignments' AND column_name IN ('status','approval_id','removed_at'))
                                OR (table_name = 'idempotency_receipts' AND column_name IN ('request_hash','response','status_code','expires_at'))))))
                OR has_schema_privilege(current_user, 'public', 'CREATE')
                FROM pg_roles WHERE rolname = current_user"""))
            if unsafe:
                raise RuntimeError('Server must use a restricted fh_app database role')
        await app.state.realtime.start()
        async def denial_auditor():
            while True:
                await asyncio.sleep(1)
                try:
                    await asyncio.to_thread(issuer.flush_denials,factory,settings.org_id)
                except Exception:
                    # Counters stay durable and retry; never drop a denial silently.
                    continue
        denial_task = asyncio.create_task(denial_auditor())
        simulation_task = asyncio.create_task(simulation.watch(app))
        try:
            yield
        finally:
            denial_task.cancel()
            simulation_task.cancel()
            await asyncio.gather(denial_task, simulation_task, return_exceptions=True)
            await app.state.realtime.close()
            engine.dispose()

    app = FastAPI(title='FOOTHOLD control API', version='1', lifespan=lifespan)
    app.state.engine = engine
    # Dummy hash makes unknown usernames pay the same password derivation cost.
    dummy_hash = hash_password(token())

    @app.exception_handler(APIError)
    async def api_error(request, exc):
        return JSONResponse(status_code=exc.status, content={'error': {
            'code': exc.code, 'message': exc.message, 'detail': exc.detail}})

    @app.exception_handler(RequestValidationError)
    async def validation_error(request, exc):
        if any(e['loc'][0] == 'header' and str(e['loc'][1]).lower() == 'idempotency-key' for e in exc.errors()):
            return JSONResponse(status_code=422, content={'error': {'code': 'VALIDATION', 'message': '멱등 키 형식을 확인하세요.', 'detail': {}}})
        if (request.url.path.startswith(('/api/v1/missions', '/api/v1/scenarios', '/api/v1/assignments'))
                and all(e['loc'][0] == 'body' for e in exc.errors())):
            fields = {'name', 'steps', 'action', 'params', 'camera', 'seconds', 'device', 'prompt',
                      'waypoints', 'floor_id', 'map_version_id', 'x', 'y', 'yaw', 'waypoint_ref',
                      'memo', 'scenario_id', 'scenario_version', 'robot_id', 'mission_id', 'mission_version', 'finish', 'mode', 'target', 'notes'}
            paths = ['.'.join(str(v) if isinstance(v, int) else v if v in fields else '?'
                             for v in e['loc'][1:]) for e in exc.errors()]
            return JSONResponse(status_code=422, content={'error': {
                'code': 'PRECHECK_FAILED', 'message': '임무·시나리오 입력을 확인하세요.',
                'detail': {'elements': paths}}})
        # Feature validation identifies a field without echoing input or database IDs.
        if request.url.path.endswith('/map-versions') and any('features' in e['loc'] for e in exc.errors()):
            fields = {'features', 'zones', 'waypoints', 'connectors', 'edits', 'id', 'type', 'name',
                      'polygon', 'x', 'y', 'yaw', 'kind', 'pair_floor_id', 'op', 'polyline', 'width'}
            paths = ['.'.join(str(v) if isinstance(v, int) else v if v in fields else '?'
                              for v in e['loc'][1:]) for e in exc.errors()]
            return JSONResponse(status_code=422, content={'error': {
                'code': 'INVALID_FEATURES', 'message': '지도 요소 형식을 확인하세요.',
                'detail': {'elements': paths}}})
        # Never echo request input, passwords or tokens from Pydantic errors.
        return JSONResponse(status_code=400, content={'error': {
            'code': 'VALIDATION', 'message': '입력 형식을 확인하세요.', 'detail': {}}})

    @app.exception_handler(HTTPException)
    async def http_error(request, exc):
        return JSONResponse(status_code=exc.status_code, content={'error': {
            'code': 'NOT_FOUND' if exc.status_code == 404 else 'VALIDATION',
            'message': '찾을 수 없습니다.' if exc.status_code == 404 else '요청을 확인하세요.', 'detail': {}}})

    @app.exception_handler(IntegrityError)
    async def conflict(request, exc):
        return JSONResponse(status_code=409, content={'error': {
            'code': 'VERSION_CONFLICT', 'message': '같은 값이 있거나 상태가 바뀌었습니다.', 'detail': {}}})

    @app.exception_handler(DataError)
    async def data_error(request, exc):
        return JSONResponse(status_code=400, content={'error': {
            'code': 'VALIDATION', 'message': '입력 형식을 확인하세요.', 'detail': {}}})

    @app.exception_handler(DBAPIError)
    @app.exception_handler(Exception)
    async def internal_error(request, exc):
        return JSONResponse(status_code=500, content={'error': {
            'code': 'INTERNAL_ERROR', 'message': '요청을 처리하지 못했습니다.', 'detail': {}}})

    def database():
        with factory() as db:
            yield db
            db.commit()

    DB = Annotated[DBSession, Depends(database, scope='function')]

    def authenticate(request, db, *, lock_writes=True, touch=True):
        bearer = request.headers.get('authorization', '')
        if bearer:
            if not bearer.startswith('Bearer '):
                fail(401, 'AUTH_REQUIRED', '로그인이 필요합니다.')
            raw, client = bearer[7:], 'app'
        else:
            raw, client = request.cookies.get('fh_s'), 'web'
        if not raw:
            fail(401, 'AUTH_REQUIRED', '로그인이 필요합니다.')
        session = db.scalar(select(Session).where(Session.org_id == settings.org_id,
            Session.token_hash == digest(raw), Session.client == client,
            Session.revoked_at.is_(None), Session.expires_at > now()))
        if session and lock_writes and request.method not in ('GET', 'HEAD', 'OPTIONS'):
            lock_organization(db, settings.org_id)
            db.refresh(session)
            if session.revoked_at or session.expires_at <= now():
                fail(401, 'AUTH_REQUIRED', '로그인이 필요합니다.')
        user = db.get(User, session.user_id) if session else None
        if not user or user.locked or user.archived_at or user.org_id != settings.org_id:
            fail(401, 'AUTH_REQUIRED', '로그인이 필요합니다.')
        authorize(user, 'LOGIN')
        if client == 'web' and request.method not in ('GET', 'HEAD', 'OPTIONS'):
            csrf = request.headers.get('x-fh-csrf')
            if not csrf or not session.csrf_hash or digest(csrf) != session.csrf_hash:
                fail(403, 'FORBIDDEN', '요청 확인 값이 올바르지 않습니다.')
        if touch:
            session.last_seen_at = now()
        return user, session

    def identity(request: Request, db: DB):
        return authenticate(request, db)

    def upload_identity(request: Request):
        # Read-only, short-lived authentication: no transaction/connection lives
        # through client-controlled body reception or CPU/file work.
        with factory() as db:
            user, session = authenticate(request, db, lock_writes=False, touch=False)
            return user.id, session.id

    def upload_write(request, expected, write):
        # Executed in the upload worker. Refresh authentication after all waits,
        # under the existing organization write lock, immediately before INSERT.
        with factory() as db:
            user, session = authenticate(request, db)
            if (user.id, session.id) != expected:
                fail(401, 'AUTH_REQUIRED', '로그인이 필요합니다.')
            result = write(db, user)
            db.commit()
            return result

    UploadIdentity = Annotated[tuple, Depends(upload_identity)]

    Identity = Annotated[tuple, Depends(identity, scope='function')]
    Limit = Annotated[int, Query(ge=1, le=100)]
    prefix = '/api/v1'

    @app.post(prefix + '/auth/login', response_model=C.LoginResponse)
    def login(body: C.LoginRequest, request: Request, response: Response, db: DB):
        username = db.scalar(select(func.lower(body.username)))
        account_key = digest(username).hex()
        ip = request.client.host if request.client else 'unknown'
        # Transaction locks serialize failures per IP and account across workers.
        for key in sorted([f'login:ip:{ip}', f'login:user:{settings.org_id}:{account_key}']):
            db.execute(text('SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))'), {'key': key})
        close_rate_windows(db, settings.org_id, now())
        recent = select(func.count()).select_from(Event).where(
            Event.org_id == settings.org_id, Event.code == 'LOGIN_FAILED',
            Event.at > now() - timedelta(minutes=5))
        for key_type, field, value in [('LOGIN_IP', 'ip', ip), ('LOGIN_ACCOUNT', 'account_key', account_key)]:
            if db.scalar(recent.where(Event.data[field].astext == value)) >= 5:
                record_rate_limit(db, settings.org_id, key_type, value, now(), data={field: value})
                db.commit()
                fail(429, 'RATE_LIMITED', '로그인 시도가 많습니다. 잠시 뒤 다시 시도하세요.')
        user = db.scalar(select(User).where(User.org_id == settings.org_id,
            func.lower(User.username) == username, User.archived_at.is_(None)))
        correct = verify_password(body.password, user.password_hash if user else dummy_hash)
        if not user or not correct or user.locked:
            event(db, settings.org_id, 'LOGIN_FAILED', user.id if user else None, {'ip': ip, 'account_key': account_key}, 'WARN')
            db.commit()  # Authentication failure must survive the error response.
            fail(401, 'AUTH_REQUIRED', '계정 또는 비밀번호를 확인하세요.')
        access, refresh = token(), token()
        csrf = web_csrf(access)
        session = Session(org_id=user.org_id, user_id=user.id, client=body.client,
            token_hash=digest(access), device_label=body.device_label,
            expires_at=now() + timedelta(seconds=settings.web_session_seconds if body.client == 'web' else 900),
            csrf_hash=digest(csrf) if body.client == 'web' else None,
            refresh_hash=digest(refresh) if body.client == 'app' else None,
            refresh_expires_at=now() + timedelta(days=30) if body.client == 'app' else None)
        db.add(session)
        event(db, user.org_id, 'LOGIN', user.id)
        result = C.LoginResponse(**user_object(db, user).model_dump())
        response.headers['Cache-Control'] = 'no-store'
        if body.client == 'web':
            response.set_cookie('fh_s', access, max_age=settings.web_session_seconds,
                                httponly=True, secure=True, samesite='strict', path='/api/v1')
            result.csrf_token = csrf
        else:
            result.access_token, result.refresh_token = access, refresh
        return result

    @app.post(prefix + '/auth/refresh', response_model=C.TokenResponse)
    def refresh(body: C.RefreshRequest, db: DB):
        refresh_hash = digest(body.refresh_token)
        session = db.scalar(select(Session).where(Session.org_id == settings.org_id,
            Session.client == 'app', or_(Session.refresh_hash == refresh_hash,
                Session.retired_refresh_hashes.contains([refresh_hash.hex()])),
            Session.revoked_at.is_(None), Session.refresh_expires_at > now()).with_for_update())
        user = db.get(User, session.user_id) if session else None
        if not user or user.locked or user.archived_at:
            fail(401, 'AUTH_REQUIRED', '다시 로그인하세요.')
        if session.refresh_hash != refresh_hash:
            session.revoked_at = now()
            event(db, user.org_id, 'SESSION_REVOKED', user.id, {'session_id': str(session.id), 'reason': 'REFRESH_REUSED'}, 'WARN')
            db.commit()
            fail(401, 'AUTH_REQUIRED', '다시 로그인하세요.')
        access, refresh = token(), token()
        session.retired_refresh_hashes = [*session.retired_refresh_hashes, refresh_hash.hex()]
        session.token_hash, session.refresh_hash = digest(access), digest(refresh)
        session.expires_at, session.last_seen_at = now() + timedelta(minutes=15), now()
        event(db, user.org_id, 'TOKEN_REFRESHED', user.id,
              {'session_id': str(session.id)})
        return C.TokenResponse(access_token=access, refresh_token=refresh)

    @app.get(prefix + '/auth/session', response_model=C.SessionInfo)
    def session_info(request: Request, response: Response, auth: Identity):
        _, session = auth
        csrf = None
        if session.client == 'web':
            csrf = web_csrf(request.cookies['fh_s'])
            session.csrf_hash = digest(csrf)
        response.headers['Cache-Control'] = 'no-store'
        return C.SessionInfo(client=session.client, csrf_token=csrf)

    @app.post(prefix + '/auth/logout', status_code=204)
    def logout(response: Response, auth: Identity, db: DB):
        user, session = auth
        session.revoked_at = now()
        phone_pass.revoke(db, user.org_id, user_id=user.id,clock=issuer.clock)
        event(db, user.org_id, 'LOGOUT', user.id)
        response.delete_cookie('fh_s', path='/api/v1', httponly=True, secure=True, samesite='strict')

    @app.get(prefix + '/me', response_model=C.User)
    def me(auth: Identity, db: DB):
        return user_object(db, auth[0])

    @app.patch(prefix + '/me', response_model=C.User)
    def patch_me(body: C.MePatch, auth: Identity, db: DB):
        user = auth[0]
        values = body.model_dump(exclude_unset=True)
        if any(value is None for value in values.values()):
            fail(400, 'VALIDATION', '빈 값으로 바꿀 수 없습니다.')
        for key, value in values.items():
            setattr(user, key, value)
        event(db, user.org_id, 'USER_UPDATED', user.id, values)
        return user_object(db, user)

    @app.post(prefix + '/me/password', status_code=204)
    def password(body: C.PasswordChange, auth: Identity, db: DB):
        user, session = auth
        # identity already holds the organization lock. The account advisory
        # lock follows it, before session/user writes or bulk revocation.
        with db.no_autoflush:
            db.execute(text('SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))'),
                       {'key': f'password:{user.org_id}:{user.id}'})
        db.refresh(user)
        db.refresh(session)
        if user.locked or user.archived_at or session.revoked_at or session.expires_at <= now():
            fail(401, 'AUTH_REQUIRED', '다시 로그인하세요.')
        session.last_seen_at = now()
        close_rate_windows(db, user.org_id, now())
        failures = db.scalar(select(func.count()).select_from(Event).where(
            Event.org_id == user.org_id, Event.user_id == user.id,
            Event.code == 'PASSWORD_CHANGE_FAILED', Event.at > now() - timedelta(minutes=5)))
        if failures >= 5:
            record_rate_limit(db, user.org_id, 'PASSWORD_ACCOUNT', str(user.id), now(), user_id=user.id)
            db.commit()
            fail(429, 'RATE_LIMITED', '비밀번호 확인 시도가 많습니다. 잠시 뒤 다시 시도하세요.')
        if not verify_password(body.current_password, user.password_hash):
            event(db, user.org_id, 'PASSWORD_CHANGE_FAILED', user.id, severity='WARN')
            db.commit()
            fail(403, 'FORBIDDEN', '현재 비밀번호를 확인하세요.')
        user.password_hash = hash_password(body.new_password)
        revoke_user_sessions(db, user,clock=issuer.clock)
        event(db, user.org_id, 'PASSWORD_CHANGED', user.id)

    @app.get(prefix + '/users', response_model=C.UserList)
    def users(auth: Identity, db: DB, limit: Limit = 50, cursor: str | None = None):
        user = auth[0]
        authorize(user, 'A')
        return page(db, select(User).where(User.org_id == user.org_id, User.archived_at.is_(None)),
                    User, limit, cursor, user_object)

    @app.post(prefix + '/users', response_model=C.User, status_code=201)
    def create_user(body: C.UserCreate, auth: Identity, db: DB):
        actor = auth[0]
        authorize(actor, 'A')
        user = User(org_id=actor.org_id, username=body.username, display_name=body.display_name,
                    role=body.role, password_hash=hash_password(body.temp_password))
        db.add(user)
        db.flush()
        event(db, actor.org_id, 'USER_CREATED', actor.id, {'user_id': str(user.id), 'role': user.role})
        return user_object(db, user)

    def find_user(db, actor, user_id, *, admin_change=False):
        if admin_change:
            lock_organization(db, actor.org_id)
            db.refresh(actor)
            if actor.locked or actor.archived_at:
                fail(401, 'AUTH_REQUIRED', '로그인이 필요합니다.')
        authorize(actor, 'A')
        user = db.scalar(select(User).where(User.org_id == actor.org_id, User.id == user_id,
                                           User.archived_at.is_(None)).execution_options(populate_existing=True))
        if not user:
            fail(404, 'NOT_FOUND', '계정을 찾을 수 없습니다.')
        return user

    @app.patch(prefix + '/users/{user_id}', response_model=C.User)
    def patch_user(user_id: UUID, body: C.UserPatch, auth: Identity, db: DB):
        actor = auth[0]
        user = find_user(db, actor, user_id, admin_change=True)
        values = body.model_dump(exclude_unset=True)
        if any(value is None for value in values.values()):
            fail(400, 'VALIDATION', '빈 값으로 바꿀 수 없습니다.')
        protect_last_admin(db, user, values)
        for key, value in values.items():
            setattr(user, key, value)
        if values.get('locked'):
            revoke_user_sessions(db, user,clock=issuer.clock)
        elif 'role' in values:
            phone_pass.revoke(db, user.org_id, user_id=user.id,clock=issuer.clock)
        event(db, actor.org_id, 'USER_UPDATED', actor.id,
              {'user_id': str(user.id), **values})
        return user_object(db, user)

    @app.delete(prefix + '/users/{user_id}', status_code=204)
    def delete_user(user_id: UUID, auth: Identity, db: DB):
        actor = auth[0]
        user = find_user(db, actor, user_id, admin_change=True)
        protect_last_admin(db, user, archive=True)
        if db.scalar(select(Robot.id).where(Robot.org_id == actor.org_id, Robot.owner_user_id == user.id,
                                           Robot.archived_at.is_(None)).limit(1)):
            fail(409, 'VERSION_CONFLICT', '담당 로봇을 먼저 변경하세요.')
        user.archived_at = now()
        revoke_user_sessions(db, user,clock=issuer.clock)
        event(db, actor.org_id, 'USER_ARCHIVED', actor.id, {'user_id': str(user.id)})

    @app.get(prefix + '/users/{user_id}/sessions', response_model=C.SessionList)
    def sessions(user_id: UUID, auth: Identity, db: DB, limit: Limit = 50, cursor: str | None = None):
        user = find_user(db, auth[0], user_id)
        return page(db, select(Session).where(Session.org_id == user.org_id, Session.user_id == user.id),
            Session, limit, cursor, lambda db, row: C.Session.model_validate(row, from_attributes=True))

    @app.delete(prefix + '/users/{user_id}/sessions/{session_id}', status_code=204)
    def revoke(user_id: UUID, session_id: UUID, auth: Identity, db: DB):
        actor = auth[0]
        find_user(db, actor, user_id)
        session = db.scalar(select(Session).where(Session.org_id == actor.org_id,
            Session.user_id == user_id, Session.id == session_id))
        if not session:
            fail(404, 'NOT_FOUND', '기기를 찾을 수 없습니다.')
        if session.revoked_at is None:
            phone_pass.revoke(db, actor.org_id, user_id=user_id,clock=issuer.clock)
            session.revoked_at = now()
            event(db, actor.org_id, 'SESSION_REVOKED', actor.id,
                  {'session_id': str(session_id)})

    @app.get(prefix + '/robots', response_model=C.RobotList)
    def robots(auth: Identity, db: DB, scope: Literal['mine', 'all'] = 'mine',
               limit: Limit = 50, cursor: str | None = None):
        user = auth[0]
        authorize(user, 'O')
        query = select(Robot).where(Robot.org_id == user.org_id, Robot.archived_at.is_(None))
        if scope == 'mine':
            query = query.where(Robot.owner_user_id == user.id)
        return page(db, query, Robot, limit, cursor, None,
            lambda db, rows: robot_objects(db, rows, user, app.state.realtime))

    @app.get(prefix + '/robots/{robot_id}', response_model=C.RobotSummary)
    def robot(robot_id: UUID, auth: Identity, db: DB):
        user = auth[0]
        row = db.scalar(select(Robot).where(Robot.id == robot_id, Robot.org_id == user.org_id,
                                           Robot.archived_at.is_(None)))
        if not row:
            fail(404, 'NOT_FOUND', '로봇을 찾을 수 없습니다.')
        authorize(user, 'ROBOT_SUMMARY', row)
        # Private live fields are masked for non-owners by the serializer.
        return robot_object(db, row, user, app.state.realtime)

    def find_robot(db, user, rid):
        row = db.scalar(select(Robot).where(Robot.id == rid, Robot.org_id == user.org_id,
            Robot.archived_at.is_(None)).with_for_update())
        if row is None:
            fail(404, 'NOT_FOUND', '로봇을 찾을 수 없습니다.')
        return row

    @app.post(prefix + '/robots/{robot_id}/phone-pass', response_model=C.PhonePassResponse)
    def issue_phone_pass(robot_id: UUID, body: C.PhonePassRequest, response: Response, auth: Identity, db: DB):
        user = auth[0]
        try:
            row = find_robot(db, user, robot_id)
            # Full live viewing has the same scope as existing ROBOT_READ.
            # Check it first so inaccessible robot existence stays hidden.
            authorize(user, 'ROBOT_READ', row)
            authorize(user, 'O_OWN' if body.purpose == 'control' else 'ROBOT_READ', row)
        except APIError:
            issuer.deny(db, user, 404, 'NOT_FOUND')
        response.headers['Cache-Control'] = 'no-store'
        return issuer.issue(db, user, row, body)

    def check_owner(db, user, owner_id):
        if owner_id is not None and db.scalar(select(User.id).where(User.id == owner_id,
                User.org_id == user.org_id, User.role == 'OPERATOR',
                User.locked.is_(False), User.archived_at.is_(None))) is None:
            fail(400, 'VALIDATION', '담당 운영 관리자를 확인하세요.')

    def robot_event(db, user, row, code, data):
        db.add(render(db, Event(org_id=user.org_id, robot_id=row.id, user_id=user.id,
            category='ACCOUNT', severity='INFO', code=code, data=data)))

    @app.post(prefix + '/robots', response_model=C.RobotCreated, status_code=201)
    def create_robot(body: C.RobotCreate, auth: Identity, db: DB, response: Response):
        user = auth[0]
        authorize(user, 'A')
        check_owner(db, user, body.owner_user_id)
        raw = token()
        row = Robot(org_id=user.org_id, name=body.name, model='unitree_go2',
            owner_user_id=body.owner_user_id, agent_token_hash=digest(raw))
        db.add(row)
        db.flush()
        robot_event(db, user, row, 'ROBOT_CREATED', {'name': row.name, 'owner_user_id': str(row.owner_user_id) if row.owner_user_id else None})
        response.headers['Cache-Control'] = 'no-store'
        return C.RobotCreated(robot=robot_object(db, row, user, app.state.realtime), agent_token=raw)

    @app.patch(prefix + '/robots/{robot_id}', response_model=C.RobotSummary)
    async def patch_robot(robot_id: UUID, body: C.RobotPatch, auth: Identity, db: DB):
        user = auth[0]
        authorize(user, 'A')
        rt, rid = app.state.realtime, str(robot_id)
        row = await asyncio.to_thread(find_robot, db, user, robot_id)
        if row.simulation and 'owner_user_id' in body.model_fields_set:
            fail(409, 'SIM_ROBOT_MANAGED', '시뮬 관리자에서만 담당자를 관리합니다.')
        changing_owner = ('owner_user_id' in body.model_fields_set
                          and body.owner_user_id != row.owner_user_id)
        if changing_owner:
            rt.begin_robot_change(rid)
        try:
            def write():
                values = body.model_dump(exclude_unset=True)
                if 'name' in values and values['name'] is None:
                    fail(400, 'VALIDATION', '이름을 입력하세요.')
                if 'owner_user_id' in values:
                    check_owner(db, user, values['owner_user_id'])
                old_owner = row.owner_user_id
                if changing_owner and old_owner is not None:
                    phone_pass.revoke(db, user.org_id, user_id=old_owner, robot_id=row.id,clock=issuer.clock)
                for key, value in values.items():
                    setattr(row, key, value)
                robot_event(db, user, row, 'ROBOT_UPDATED', {'name': row.name, 'old_owner_user_id': str(old_owner) if old_owner else None,
                     'owner_user_id': str(row.owner_user_id) if row.owner_user_id else None})
                db.commit()
                return row, old_owner
            row, old_owner = await asyncio.to_thread(write)
            if old_owner != row.owner_user_id:
                rt.robot_changed(rid, old_owner=str(old_owner) if old_owner else None)
            return await asyncio.to_thread(robot_object, db, row, user, rt)
        finally:
            if changing_owner:
                rt.end_robot_change(rid)

    @app.delete(prefix + '/robots/{robot_id}', status_code=204)
    async def delete_robot(robot_id: UUID, auth: Identity, db: DB):
        user = auth[0]
        authorize(user, 'A')
        rt, rid = app.state.realtime, str(robot_id)
        rt.begin_robot_change(rid)
        try:
            row = await asyncio.to_thread(find_robot, db, user, robot_id)
            if row.simulation:
                fail(409, 'SIM_ROBOT_MANAGED', '시뮬 관리자에서만 제거합니다.')
            await asyncio.to_thread(phone_pass.revoke, db, user.org_id, robot_id=row.id,clock=issuer.clock)
            record = rt.arbiter.robots.get(rid)
            run = rt.runs.get(rid)
            active_run = run and run.get('status') not in ('COMPLETED', 'FAILED', 'ABORTED')
            if (record and (record.holder or record.transfer)) or active_run:
                fail(409, 'VERSION_CONFLICT', '실행·조종을 끝낸 뒤 해제하세요.')
            def write():
                row.archived_at = now()
                row.agent_token_hash = digest(token())
                robot_event(db, user, row, 'ROBOT_ARCHIVED', {})
                db.commit()
            await asyncio.to_thread(write)
            rt.robot_changed(rid, deleted=True)
            agent = rt.agents.get(rid)
            if agent:
                agent.closing = True
                await agent.socket.close(code=4403)
        finally:
            rt.end_robot_change(rid)

    @app.get(prefix + '/dashboard', response_model=C.Dashboard)
    def dashboard(auth: Identity, db: DB):
        user = auth[0]
        query = select(Robot).where(Robot.org_id == user.org_id, Robot.archived_at.is_(None))
        if user.role != 'ORG_ADMIN':
            query = query.where(Robot.owner_user_id == user.id)
        rows = list(db.scalars(query))
        error_ids = set(db.scalars(select(RobotDevice.robot_id).where(RobotDevice.org_id == user.org_id,
            RobotDevice.robot_id.in_([r.id for r in rows]), RobotDevice.state == 'ERROR').distinct()))
        policy = C.OrgSettings.model_validate(db.get(Organization, user.org_id).settings)
        snapshots = [(row, *live_state(app.state.realtime, str(row.id))) for row in rows]
        operators = []
        if user.role == 'ORG_ADMIN':
            for operator in db.scalars(select(User).where(User.org_id == user.org_id,
                    User.role == 'OPERATOR', User.archived_at.is_(None)).order_by(User.created_at, User.id)):
                operators.append(C.OperatorCount(user_id=operator.id, display_name=operator.display_name,
                    robot_count=sum(row.owner_user_id == operator.id for row in rows)))
        return C.Dashboard(robots_total=len(rows), robots_online=sum(online for _, online, _ in snapshots),
            robots_attention=sum(bool(attention(online, state,
                device_error(app.state.realtime, str(row.id), row.id in error_ids), policy))
                for row, online, state in snapshots), robots_running=0,
            approvals_pending=approvals.pending_count(db, user), operators=operators)

    @app.get(prefix + '/org/settings', response_model=C.OrgSettings)
    def get_settings(auth: Identity, db: DB):
        return C.OrgSettings.model_validate(db.get(Organization, auth[0].org_id).settings)

    @app.patch(prefix + '/org/settings', response_model=C.OrgSettings)
    def patch_settings(body: C.OrgSettingsPatch, auth: Identity, db: DB):
        user = auth[0]
        authorize(user, 'A')
        values = body.model_dump(exclude_unset=True)
        if any(value is None for value in values.values()):
            fail(400, 'VALIDATION', '빈 값으로 바꿀 수 없습니다.')
        org = lock_organization(db, user.org_id)
        result = C.OrgSettings.model_validate({**org.settings, **values})
        org.settings = result.model_dump()
        event(db, user.org_id, 'ORG_SETTINGS_UPDATED', user.id, values)
        return result

    @app.post(prefix + '/robots/{robot_id}/agent-token', response_model=C.AgentTokenResponse)
    def agent_token(robot_id: UUID, auth: Identity, db: DB, response: Response):
        user = auth[0]
        authorize(user, 'A')
        row = db.scalar(select(Robot).where(Robot.id == robot_id, Robot.org_id == user.org_id,
                                           Robot.archived_at.is_(None)).with_for_update())
        if not row:
            fail(404, 'NOT_FOUND', '로봇을 찾을 수 없습니다.')
        if row.simulation:
            fail(409, 'SIM_TOKEN_MANAGED', '시뮬 관리자에서만 연결 키를 관리합니다.')
        raw = token()
        row.agent_token_hash = digest(raw)
        event(db, user.org_id, 'AGENT_TOKEN_ROTATED', user.id, {'robot_id': str(robot_id)})
        response.headers['Cache-Control'] = 'no-store'
        return C.AgentTokenResponse(agent_token=raw)

    from . import events_api, notifications, maps, missions, simulation
    simulation.install(app, DB, Identity, fail, authorize, event, issuer, settings, lock_organization)
    missions.install(app, DB, Identity, fail, authorize, event, page)
    assignments.install(app, DB, Identity, fail, page)
    approvals.install(app, DB, Identity, fail, authorize, page)
    events_api.install(app, DB, Identity, fail)
    notifications.install(app, DB, Identity, fail)
    maps.install(app, DB, Identity, fail, authorize, event, settings, UploadIdentity, upload_write)
    from .realtime import install
    install(app, settings, factory, authorize, APIError)
    app.state.phone_pass_issuer = issuer
    app.state.realtime.phone_pass_clock = lambda: issuer.clock()
    return app
