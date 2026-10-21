"""Authenticated lifecycle relay. Phone commands and pass issuance stay independent."""
import json
import os
import stat
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import Request, build_opener, ProxyHandler, HTTPRedirectHandler
from uuid import UUID

from fastapi import Response
from sqlalchemy import select

from apps.contracts import models as C
from .models import Robot
from . import phone_pass
from .security import digest, token


class RelayError(Exception):
    def __init__(self, code='SIM_UNAVAILABLE', status=503):
        self.code, self.status = code, status


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, newurl):
        return None  # authenticated loopback requests must never follow redirects


class Relay:
    def __init__(self, url, key_path):
        parsed = urlsplit(url)
        if (parsed.scheme != 'http' or parsed.hostname != '127.0.0.1' or parsed.username
                or parsed.password or parsed.path or parsed.query or parsed.fragment
                or parsed.port not in range(9430, 9450)):
            raise ValueError('simulation manager requires explicit loopback URL and approved port')
        fd = os.open(key_path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
        with os.fdopen(fd, 'rb') as source:
            info = os.fstat(source.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077 or info.st_uid != os.geteuid():
                raise ValueError('private simulation service key file required')
            self.secret = source.read(257).decode().strip()
        if not 32 <= len(self.secret) <= 256 or not self.secret.isascii():
            raise ValueError('service key must have 32..256 ASCII characters')
        self.url = url
        self.opener = build_opener(ProxyHandler({}), NoRedirect())

    def request(self, method, path, body=None):
        request = Request(self.url + path, method=method,
            data=json.dumps(body).encode() if body is not None else None,
            headers={'Authorization': 'Bearer ' + self.secret, 'Content-Type': 'application/json'})
        try:
            with self.opener.open(request, timeout=5 if method == 'GET' else 180) as response:
                raw = response.read(65537)
            if len(raw) > 65536:
                raise RelayError()
            return json.loads(raw)
        except HTTPError as error:
            # Only code/status crosses this boundary, never remote text/credentials.
            try:
                code = json.loads(error.read(4097))['error']['code']
                if not isinstance(code, str) or not code.startswith('SIM_') or len(code) > 64:
                    code = 'SIM_UNAVAILABLE'
            except (ValueError, KeyError, TypeError):
                code = 'SIM_UNAVAILABLE'
            raise RelayError(code, error.code if error.code in (400, 404, 409, 503) else 503) from None
        except (URLError, OSError, ValueError):
            raise RelayError() from None


def install(app, DB, Identity, fail, authorize, event, issuer, settings, lock_organization):
    app.state.simmgr = Relay(settings.simmgr_url, settings.simmgr_auth_file) if settings.simmgr_url else None

    def call(method, path, body=None, on_error=None):
        relay = app.state.simmgr
        if relay is None:
            if on_error is not None:
                on_error('SIM_DISABLED')
            fail(503, 'SIM_DISABLED', '시뮬 관리자가 연결되지 않았습니다.')
        try:
            return relay.request(method, path, body)
        except RelayError as error:
            if on_error is not None:
                on_error(error.code)
            fail(error.status, error.code, '시뮬 요청을 처리하지 못했습니다.')

    @app.get('/api/v1/simulation/worlds', response_model=C.SimCatalog)
    def worlds(auth: Identity):
        user = auth[0]
        authorize(user, 'O')
        return call('GET', '/v1/worlds?' + urlencode({'org_id': str(user.org_id)}))

    @app.get('/api/v1/simulation/robots', response_model=C.SimRobotList)
    def robots(auth: Identity, db: DB):
        user = auth[0]
        authorize(user, 'O')
        result = C.SimRobotList.model_validate(call('GET', '/v1/robots?' + urlencode({'org_id': str(user.org_id)})))
        allowed = set(db.scalars(select(Robot.id).where(Robot.org_id == user.org_id,
            Robot.simulation.is_(True), Robot.archived_at.is_(None),
            *([] if user.role == 'ORG_ADMIN' else [Robot.owner_user_id == user.id]))))
        return C.SimRobotList(items=[r for r in result.items if r.robot_id in allowed])

    @app.post('/api/v1/simulation/robots', response_model=C.SimRobot, status_code=201)
    def add(body: C.SimStartRequest, auth: Identity, db: DB, response: Response):
        user = auth[0]
        authorize(user, 'O')
        rid = str(body.robot_id)
        # Keys are provisioned by the existing PR43 key path; never issue a new scheme.
        if rid not in issuer.keys:
            fail(503, 'PASS_KEY_MISSING', '시뮬 로봇 출입증 키가 없습니다.')
        # Identity takes the organization write lock. Release it before any relay IO.
        db.commit()
        catalogue = C.SimCatalog.model_validate(call('GET', '/v1/worlds?' + urlencode({'org_id': str(user.org_id)})))
        if body.robot_id not in catalogue.slots:
            fail(404, 'NOT_FOUND', '시뮬 로봇을 찾을 수 없습니다.')
        lock_organization(db, user.org_id)
        row = db.get(Robot, body.robot_id)
        if row is not None and (row.org_id != user.org_id or not row.simulation or row.archived_at):
            fail(404, 'NOT_FOUND', '시뮬 로봇을 찾을 수 없습니다.')
        if row is not None and row.owner_user_id is not None:
            authorize(user, 'O_OWN', row)
            if row.owner_user_id != user.id:
                fail(409, 'SIM_SLOT_BUSY', '이 시뮬 슬롯은 다른 사람이 사용 중입니다.')
            if row.sim_state != 'ACTIVE':
                fail(409, 'SIM_SLOT_BUSY', '시뮬 슬롯의 전환이 끝나지 않았습니다.')
            generation = row.sim_generation
            db.commit()
            current = C.SimRobotList.model_validate(call('GET', '/v1/robots?' + urlencode({'org_id': str(user.org_id)})))
            found = next((r for r in current.items if r.robot_id == body.robot_id), None)
            lock_organization(db, user.org_id)
            db.refresh(row)
            if (row.sim_generation != generation or row.sim_state != 'ACTIVE' or found is None
                    or found.generation != generation or found.world_id != body.world_id or found.owner_id != user.id):
                fail(409, 'SIM_SLOT_BUSY', '이 시뮬 슬롯은 사용 중입니다.')
            return found
        raw = token()
        if row is None:
            row = Robot(id=body.robot_id, org_id=user.org_id, name='시뮬 ' + rid[:8], model='unitree_go2',
                simulation=True, sim_generation=0, agent_token_hash=digest(raw))
            db.add(row)
        row.owner_user_id = user.id
        row.sim_generation += 1
        row.sim_state = 'STARTING'
        row.agent_token_hash = digest(raw)
        generation = row.sim_generation
        authorize(user, 'O_OWN', row)
        db.flush()
        event(db, user.org_id, 'SIM_ROBOT_REQUESTED', user.id, {'robot_id': rid,
              'world_id': body.world_id, 'generation': generation, 'simulation': True}, category='LINK')
        db.commit()
        result = C.SimRobot.model_validate(call('POST', '/v1/robots', dict(world_id=body.world_id,
            robot_id=rid, owner_id=str(user.id), org_id=str(user.org_id), agent_token=raw, generation=generation)))
        lock_organization(db, user.org_id)
        db.refresh(row)
        if row.sim_generation != generation or row.sim_state != 'STARTING':
            fail(409, 'SIM_GENERATION_MISMATCH', '시뮬 슬롯의 세대가 바뀌었습니다.')
        if (result.robot_id != row.id or result.owner_id != user.id or result.world_id != body.world_id
                or result.generation != generation):
            fail(503, 'SIM_IDENTITY_MISMATCH', '시뮬 연결 정보를 확인하지 못했습니다.')
        row.sim_state = 'ACTIVE'
        event(db, user.org_id, 'SIM_ROBOT_REGISTERED', user.id, {'robot_id': rid, 'world_id': body.world_id,
              'generation': generation, 'launcher': result.launcher, 'simulation': True}, category='LINK')
        response.headers['Cache-Control'] = 'no-store'
        return result

    @app.delete('/api/v1/simulation/robots/{robot_id}', status_code=204)
    def remove(robot_id: UUID, auth: Identity, db: DB):
        user = auth[0]
        row = db.get(Robot, robot_id)
        if row is None or row.org_id != user.org_id or not row.simulation or row.archived_at:
            fail(404, 'NOT_FOUND', '시뮬 로봇을 찾을 수 없습니다.')
        authorize(user, 'O_OWN', row)
        generation = row.sim_generation
        if row.sim_state == 'IDLE':
            return Response(status_code=204)
        if row.sim_state == 'STARTING':
            fail(409, 'SIM_SLOT_BUSY', '시뮬 슬롯을 시작 중입니다.')
        row.sim_state = 'STOPPING'
        phone_pass.revoke(db, user.org_id, robot_id=robot_id, clock=issuer.clock)
        db.commit()  # revocations survive a failed/uncertain manager response
        def removal_failed(code):
            event(db, user.org_id, 'SIM_ROBOT_REMOVE_FAILED', user.id,
                  {'robot_id': str(robot_id), 'reason': code}, category='LINK')
            db.commit()
        call('DELETE', '/v1/robots/' + str(robot_id), {'generation': generation}, on_error=removal_failed)
        # A pass could be issued while the manager was stopping. Serialize the
        # final sweep and slot release with the existing organization write lock.
        lock_organization(db, user.org_id)
        db.refresh(row)
        if row.sim_generation != generation or row.sim_state != 'STOPPING':
            event(db, user.org_id, 'SIM_ROBOT_REMOVE_STALE', user.id,
                  {'robot_id': str(robot_id), 'generation': generation}, category='LINK')
            db.commit()
            fail(409, 'SIM_GENERATION_MISMATCH', '시뮬 슬롯의 세대가 바뀌었습니다.')
        phone_pass.revoke(db, user.org_id, robot_id=robot_id, clock=issuer.clock)
        row.sim_state = 'IDLE'
        row.owner_user_id = None
        row.agent_token_hash = digest(token())
        # Keep identity, provenance and pass/revocation history; no archive/reuse shortcut.
        event(db, user.org_id, 'SIM_ROBOT_REMOVED', user.id, {'robot_id': str(robot_id)}, category='LINK')
        return Response(status_code=204)
