"""REST scope only: authentication, accounts, robot summaries, organization settings."""
import base64
from contextlib import asynccontextmanager
import os
from dataclasses import dataclass
from datetime import timedelta
from typing import Annotated, Literal
from uuid import UUID

from fastapi import Depends, FastAPI, Request, Response, Query
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from sqlalchemy import create_engine, func, select, text, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session as DBSession, sessionmaker
from starlette.exceptions import HTTPException

from apps.contracts import models as C
from .models import Event, Organization, Robot, Session, User, now
from .security import digest, hash_password, token, verify_password


@dataclass(frozen=True)
class Settings:
    database_url: str
    org_id: UUID
    web_session_seconds: int = 86400

    @classmethod
    def from_env(cls):
        return cls(os.environ['FH_DATABASE_URL'], UUID(os.environ['FH_ORG_ID']))


class APIError(Exception):
    def __init__(self, status, code, message, detail=None):
        self.status, self.code, self.message = status, code, message
        self.detail = detail or {}


def fail(status, code, message):
    raise APIError(status, code, message)


def authorize(user: User, permission: str, robot: Robot | None = None):
    """One A/O policy, used on every request (no cached role/ownership claims)."""
    if robot is not None and robot.org_id != user.org_id:
        fail(404, 'NOT_FOUND', '로봇을 찾을 수 없습니다.')
    allowed = {
        'LOGIN': user.role in ('ORG_ADMIN', 'OPERATOR'),
        'A': user.role == 'ORG_ADMIN',
        'O': user.role in ('ORG_ADMIN', 'OPERATOR'),
        'O_OWN': user.role == 'ORG_ADMIN' or (
            robot is not None and robot.org_id == user.org_id and robot.owner_user_id == user.id),
    }
    if not allowed.get(permission, False):
        fail(403, 'FORBIDDEN', '권한이 없습니다.')


def event(db, org_id, code, message, user_id=None, data=None, severity='INFO'):
    db.add(Event(org_id=org_id, category='ACCOUNT', code=code, message=message,
                 user_id=user_id, data=data or {}, severity=severity))


def user_object(db, user):
    robots = db.scalars(select(Robot.id).where(Robot.org_id == user.org_id,
                          Robot.owner_user_id == user.id, Robot.archived_at.is_(None))).all()
    return C.User(id=user.id, username=user.username, display_name=user.display_name,
                  role=user.role, locked=user.locked, robot_ids=robots, created_at=user.created_at)


def robot_object(db, robot):
    owner = db.get(User, robot.owner_user_id) if robot.owner_user_id else None
    return C.RobotSummary(id=robot.id, name=robot.name, model=robot.model,
        owner=C.Person(id=owner.id, display_name=owner.display_name) if owner else None,
        connection='OFFLINE', status=None, battery=None, location=None, lease=None,
        current_run=None, devices=[], attention=[])


def cursor_value(cursor):
    if not cursor:
        return None
    try:
        return UUID(base64.urlsafe_b64decode(cursor.encode()).decode())
    except (ValueError, UnicodeError):
        fail(400, 'VALIDATION', '목록 위치가 올바르지 않습니다.')


def page(db, query, model, limit, cursor, serialize):
    after = cursor_value(cursor)
    if after:
        query = query.where(model.id > after)
    rows = list(db.scalars(query.order_by(model.id).limit(limit + 1)))
    has_more = len(rows) > limit
    rows = rows[:limit]
    next_cursor = base64.urlsafe_b64encode(str(rows[-1].id).encode()).decode() if has_more else None
    return {'items': [serialize(db, row) for row in rows], 'next_cursor': next_cursor}


def create_app(settings: Settings | None = None):
    settings = settings or Settings.from_env()
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
                OR has_schema_privilege(current_user, 'public', 'CREATE')
                FROM pg_roles WHERE rolname = current_user"""))
            if unsafe:
                raise RuntimeError('Server must use a restricted fh_app database role')
        try:
            yield
        finally:
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

    def database():
        with factory() as db:
            yield db
            db.commit()

    DB = Annotated[DBSession, Depends(database, scope='function')]

    def identity(request: Request, db: DB):
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
        user = db.get(User, session.user_id) if session else None
        if not user or user.locked or user.archived_at or user.org_id != settings.org_id:
            fail(401, 'AUTH_REQUIRED', '로그인이 필요합니다.')
        authorize(user, 'LOGIN')
        if client == 'web' and request.method not in ('GET', 'HEAD', 'OPTIONS'):
            csrf = request.headers.get('x-fh-csrf')
            if not csrf or not session.csrf_hash or digest(csrf) != session.csrf_hash:
                fail(403, 'FORBIDDEN', '요청 확인 값이 올바르지 않습니다.')
        session.last_seen_at = now()
        return user, session

    Identity = Annotated[tuple, Depends(identity, scope='function')]
    Limit = Annotated[int, Query(ge=1, le=100)]
    prefix = '/api/v1'

    @app.post(prefix + '/auth/login', response_model=C.LoginResponse)
    def login(body: C.LoginRequest, request: Request, response: Response, db: DB):
        username = db.scalar(select(func.lower(body.username)))
        ip = request.client.host if request.client else 'unknown'
        # Transaction locks serialize failures per IP and account across workers.
        for key in sorted([f'login:ip:{ip}', f'login:user:{settings.org_id}:{username}']):
            db.execute(text('SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))'), {'key': key})
        recent = select(func.count()).select_from(Event).where(
            Event.org_id == settings.org_id, Event.code == 'LOGIN_FAILED',
            Event.at > now() - timedelta(minutes=5))
        limited = any(db.scalar(recent.where(Event.data[key].astext == value)) >= 5
                      for key, value in [('ip', ip), ('username', username)])
        if limited:
            fail(429, 'RATE_LIMITED', '로그인 시도가 많습니다. 잠시 뒤 다시 시도하세요.')
        user = db.scalar(select(User).where(User.org_id == settings.org_id,
            func.lower(User.username) == username, User.archived_at.is_(None)))
        correct = verify_password(body.password, user.password_hash if user else dummy_hash)
        if not user or not correct or user.locked:
            event(db, settings.org_id, 'LOGIN_FAILED', '로그인에 실패했습니다.',
                  user.id if user else None, {'ip': ip, 'username': username}, 'WARN')
            db.commit()  # Authentication failure must survive the error response.
            fail(401, 'AUTH_REQUIRED', '계정 또는 비밀번호를 확인하세요.')
        access, refresh, csrf = token(), token(), token()
        session = Session(org_id=user.org_id, user_id=user.id, client=body.client,
            token_hash=digest(access), device_label=body.device_label,
            expires_at=now() + timedelta(seconds=settings.web_session_seconds if body.client == 'web' else 900),
            csrf_hash=digest(csrf) if body.client == 'web' else None,
            refresh_hash=digest(refresh) if body.client == 'app' else None,
            refresh_expires_at=now() + timedelta(days=30) if body.client == 'app' else None)
        db.add(session)
        event(db, user.org_id, 'LOGIN', f'{user.display_name}님이 로그인했습니다.', user.id)
        result = C.LoginResponse(**user_object(db, user).model_dump())
        if body.client == 'web':
            response.set_cookie('fh_s', access, max_age=settings.web_session_seconds,
                                httponly=True, secure=True, samesite='strict', path='/api/v1')
            result.csrf_token = csrf
        else:
            result.access_token, result.refresh_token = access, refresh
        return result

    @app.post(prefix + '/auth/refresh', response_model=C.TokenResponse)
    def refresh(body: C.RefreshRequest, db: DB):
        session = db.scalar(select(Session).where(Session.org_id == settings.org_id,
            Session.client == 'app', Session.refresh_hash == digest(body.refresh_token),
            Session.revoked_at.is_(None), Session.refresh_expires_at > now()).with_for_update())
        user = db.get(User, session.user_id) if session else None
        if not user or user.locked or user.archived_at:
            fail(401, 'AUTH_REQUIRED', '다시 로그인하세요.')
        access, refresh = token(), token()
        session.token_hash, session.refresh_hash = digest(access), digest(refresh)
        session.expires_at, session.last_seen_at = now() + timedelta(minutes=15), now()
        return C.TokenResponse(access_token=access, refresh_token=refresh)

    @app.post(prefix + '/auth/logout', status_code=204)
    def logout(response: Response, auth: Identity, db: DB):
        user, session = auth
        session.revoked_at = now()
        event(db, user.org_id, 'LOGOUT', f'{user.display_name}님이 로그아웃했습니다.', user.id)
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
        event(db, user.org_id, 'USER_UPDATED', '내 정보를 변경했습니다.', user.id, values)
        return user_object(db, user)

    @app.post(prefix + '/me/password', status_code=204)
    def password(body: C.PasswordChange, auth: Identity, db: DB):
        user = auth[0]
        if not verify_password(body.current_password, user.password_hash):
            fail(403, 'FORBIDDEN', '현재 비밀번호를 확인하세요.')
        user.password_hash = hash_password(body.new_password)
        db.execute(update(Session).where(Session.org_id == user.org_id, Session.user_id == user.id,
                                        Session.revoked_at.is_(None)).values(revoked_at=now()))
        event(db, user.org_id, 'PASSWORD_CHANGED', '비밀번호를 변경했습니다.', user.id)

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
        event(db, actor.org_id, 'USER_CREATED', '계정을 만들었습니다.', actor.id, {'user_id': str(user.id), 'role': user.role})
        return user_object(db, user)

    def find_user(db, actor, user_id):
        authorize(actor, 'A')
        user = db.scalar(select(User).where(User.org_id == actor.org_id, User.id == user_id,
                                           User.archived_at.is_(None)))
        if not user:
            fail(404, 'NOT_FOUND', '계정을 찾을 수 없습니다.')
        return user

    @app.patch(prefix + '/users/{user_id}', response_model=C.User)
    def patch_user(user_id: UUID, body: C.UserPatch, auth: Identity, db: DB):
        actor = auth[0]
        user = find_user(db, actor, user_id)
        values = body.model_dump(exclude_unset=True)
        if any(value is None for value in values.values()):
            fail(400, 'VALIDATION', '빈 값으로 바꿀 수 없습니다.')
        for key, value in values.items():
            setattr(user, key, value)
        if values.get('locked'):
            db.execute(update(Session).where(Session.user_id == user.id).values(revoked_at=now()))
        event(db, actor.org_id, 'USER_UPDATED', '계정 권한·정보를 변경했습니다.', actor.id,
              {'user_id': str(user.id), **values})
        return user_object(db, user)

    @app.delete(prefix + '/users/{user_id}', status_code=204)
    def delete_user(user_id: UUID, auth: Identity, db: DB):
        actor = auth[0]
        user = find_user(db, actor, user_id)
        if db.scalar(select(Robot.id).where(Robot.org_id == actor.org_id, Robot.owner_user_id == user.id,
                                           Robot.archived_at.is_(None)).limit(1)):
            fail(409, 'VERSION_CONFLICT', '담당 로봇을 먼저 변경하세요.')
        user.archived_at = now()
        db.execute(update(Session).where(Session.user_id == user.id).values(revoked_at=now()))
        event(db, actor.org_id, 'USER_ARCHIVED', '계정을 보관했습니다.', actor.id, {'user_id': str(user.id)})

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
        session.revoked_at = now()
        event(db, actor.org_id, 'SESSION_REVOKED', '기기 로그인을 종료했습니다.', actor.id,
              {'session_id': str(session_id)})

    @app.get(prefix + '/robots', response_model=C.RobotList)
    def robots(auth: Identity, db: DB, scope: Literal['mine', 'all'] = 'mine',
               limit: Limit = 50, cursor: str | None = None):
        user = auth[0]
        authorize(user, 'O')
        query = select(Robot).where(Robot.org_id == user.org_id, Robot.archived_at.is_(None))
        if scope == 'mine':
            query = query.where(Robot.owner_user_id == user.id)
        return page(db, query, Robot, limit, cursor, robot_object)

    @app.get(prefix + '/robots/{robot_id}', response_model=C.RobotSummary)
    def robot(robot_id: UUID, auth: Identity, db: DB):
        user = auth[0]
        row = db.scalar(select(Robot).where(Robot.id == robot_id, Robot.org_id == user.org_id,
                                           Robot.archived_at.is_(None)))
        if not row:
            fail(404, 'NOT_FOUND', '로봇을 찾을 수 없습니다.')
        # This skeleton only exposes summary fields, including for non-owners.
        return robot_object(db, row)

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
        org = db.scalar(select(Organization).where(Organization.id == user.org_id).with_for_update())
        result = C.OrgSettings.model_validate({**org.settings, **values})
        org.settings = result.model_dump()
        event(db, user.org_id, 'ORG_SETTINGS_UPDATED', '조직 기준값을 변경했습니다.', user.id, values)
        return result

    return app
