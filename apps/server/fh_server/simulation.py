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
from apps.contracts.simulation_ports import allowed_ports, extra_ports_from_env
from .models import Robot
from . import phone_pass
from .security import digest, token


# Exact pre-creation rejections only. Unknown codes/statuses remain uncertain.
START_REJECTIONS = frozenset({
    (400, 'SIM_VALIDATION'), (400, 'SIM_IDENTITY_INVALID'), (400, 'SIM_CREDENTIAL_INVALID'),
    (404, 'SIM_WORLD_NOT_FOUND'), (404, 'SIM_SLOT_NOT_FOUND'),
    (409, 'SIM_WORLD_BUSY'), (409, 'SIM_OWNER_LIMIT'),
    (409, 'SIM_NATIVE_SINGLE_ONLY'), (409, 'SIM_ROBOT_LIMIT'),
})


class RelayError(Exception):
    def __init__(self, code='SIM_UNAVAILABLE', status=503, detail=None):
        self.code, self.status = code, status
        # Never relay arbitrary remote text, paths or credentials. Optional
        # diagnostics cannot change the existing code/status verdict.
        self.detail = {}
        if isinstance(detail, dict):
            try:
                safe = {k: v for k, v in detail.items() if k in C.SimFailureDetail.model_fields}
                self.detail = C.SimFailureDetail.model_validate(safe).model_dump(exclude_none=True)
            except (ValueError, TypeError):
                self.detail = {'reason': 'unknown'}


def start_not_created(error):
    return ((error.status, error.code) == (503, 'SIM_UNAVAILABLE')
            and error.detail.get('reason') == 'resources_low'
            and error.detail.get('start_not_created') is True)


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, newurl):
        return None  # authenticated loopback requests must never follow redirects


class Relay:
    def __init__(self, url, key_path):
        parsed = urlsplit(url)
        if (parsed.scheme != 'http' or parsed.hostname != '127.0.0.1' or parsed.username is not None
                or parsed.password is not None or parsed.path or parsed.query or parsed.fragment
                or parsed.port not in allowed_ports(extra_ports_from_env())):
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
        try:
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
                # The outer boundary also covers reading/decoding an error body.
                # Only code/status and allowlisted diagnostics cross it.
                body = json.loads(error.read(4097))['error']
                code = body['code']
                if not isinstance(code, str) or not code.startswith('SIM_') or len(code) > 64:
                    code = 'SIM_UNAVAILABLE'
                raise RelayError(code, error.code if error.code in (400, 404, 409, 503) else 503,
                                 body.get('detail')) from None
        except RelayError as error:
            raise error from None
        except (ConnectionRefusedError, URLError) as error:
            cause = error.reason if isinstance(error, URLError) else error
            detail = {'reason': 'manager_unreachable'} if isinstance(cause, ConnectionRefusedError) else None
            raise RelayError(detail=detail) from None
        except Exception:
            # Transport, status, body and decoder failures are all uncertain.
            # BaseException (interrupts, cancellation, exit) deliberately escapes.
            raise RelayError() from None


def install(app, DB, Identity, fail, authorize, event, issuer, settings, lock_organization):
    app.state.simmgr = Relay(settings.simmgr_url, settings.simmgr_auth_file) if settings.simmgr_url else None

    def call(method, path, body=None, on_error=None, on_rejection=None):
        relay = app.state.simmgr
        if relay is None:
            if on_error is not None:
                on_error('SIM_DISABLED')
            fail(503, 'SIM_DISABLED', '시뮬 관리자가 연결되지 않았습니다.', {'reason': 'manager_unreachable'})
        try:
            return relay.request(method, path, body)
        except RelayError as error:
            if on_rejection is not None:
                on_rejection(error)
            if on_error is not None:
                on_error(error.code)
            fail(error.status, error.code, '시뮬 요청을 처리하지 못했습니다.', error.detail)

    @app.get('/api/v1/simulation/worlds', response_model=C.SimCatalog)
    def worlds(auth: Identity):
        user = auth[0]
        authorize(user, 'O')
        return call('GET', '/v1/worlds?' + urlencode({'org_id': str(user.org_id)}))

    @app.get('/api/v1/simulation/robots', response_model=C.SimRobotList)
    def robots(auth: Identity, db: DB):
        user = auth[0]
        authorize(user, 'O')
        db.commit()
        # A missing/unreachable manager must not hide durable owned slots. This
        # is only a cleanup target list, never proof that a runtime has stopped.
        try:
            if app.state.simmgr is None:
                raise RelayError('SIM_DISABLED')
            result = C.SimRobotList.model_validate(app.state.simmgr.request(
                'GET', '/v1/robots?' + urlencode({'org_id': str(user.org_id)})))
        except (RelayError, ValueError, TypeError):
            result = C.SimRobotList(items=[])
        rows = list(db.scalars(select(Robot).where(Robot.org_id == user.org_id,
            Robot.simulation.is_(True), Robot.archived_at.is_(None),
            *([] if user.role == 'ORG_ADMIN' else [Robot.owner_user_id == user.id]))))
        allowed = {row.id: row for row in rows}
        items = [r for r in result.items if r.robot_id in allowed
                 and allowed[r.robot_id].sim_state != 'IDLE'
                 and allowed[r.robot_id].sim_generation == r.generation
                 and allowed[r.robot_id].owner_user_id == r.owner_id]
        present = {r.robot_id for r in items}
        return C.SimRobotList(items=items, cleanup=[C.SimCleanupSlot(robot_id=row.id,
            owner_id=row.owner_user_id, generation=row.sim_generation,
            can_recover=row.sim_manager_instance_id is not None)
            for row in rows if row.id not in present and row.sim_state != 'IDLE'
            and row.owner_user_id is not None])

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
                fail(409, 'SIM_SLOT_BUSY', '이 시뮬 슬롯은 다른 사람이 사용 중입니다.', {'reason': 'slot_busy'})
            if row.sim_state != 'ACTIVE':
                fail(409, 'SIM_SLOT_BUSY', '시뮬 슬롯의 전환이 끝나지 않았습니다.', {'reason': 'slot_busy'})
            generation = row.sim_generation
            db.commit()
            current = C.SimRobotList.model_validate(call('GET', '/v1/robots?' + urlencode({'org_id': str(user.org_id)})))
            found = next((r for r in current.items if r.robot_id == body.robot_id), None)
            lock_organization(db, user.org_id)
            db.refresh(row)
            if (row.sim_generation != generation or row.sim_state != 'ACTIVE' or found is None
                    or found.generation != generation or found.world_id != body.world_id or found.owner_id != user.id):
                fail(409, 'SIM_SLOT_BUSY', '이 시뮬 슬롯은 사용 중입니다.', {'reason': 'slot_busy'})
            return found
        raw = token()
        if row is None:
            row = Robot(id=body.robot_id, org_id=user.org_id, name='시뮬 ' + rid[:8], model='unitree_go2',
                simulation=True, sim_generation=0, agent_token_hash=digest(raw))
            db.add(row)
        row.owner_user_id = user.id
        row.sim_generation += 1
        row.sim_state = 'STARTING'
        row.sim_manager_instance_id = catalogue.manager_instance_id
        row.agent_token_hash = digest(raw)
        generation = row.sim_generation
        authorize(user, 'O_OWN', row)
        db.flush()
        event(db, user.org_id, 'SIM_ROBOT_REQUESTED', user.id, {'robot_id': rid,
              'world_id': body.world_id, 'generation': generation, 'simulation': True}, category='LINK')
        db.commit()
        def start_rejected(error):
            if (error.status, error.code) not in START_REJECTIONS and not start_not_created(error):
                return
            lock_organization(db, user.org_id)
            db.refresh(row)
            if row.sim_generation == generation and row.sim_state == 'STARTING':
                phone_pass.revoke(db, user.org_id, robot_id=row.id, clock=issuer.clock)
                row.sim_state = 'IDLE'
                row.owner_user_id = None
                row.agent_token_hash = digest(token())
                event(db, user.org_id, 'SIM_ROBOT_START_REJECTED', user.id,
                      {'robot_id': rid, 'generation': generation, 'reason': error.code}, category='LINK')
                db.commit()
        start_error = None
        try:
            result = app.state.simmgr.request('POST', '/v1/robots', dict(world_id=body.world_id,
                robot_id=rid, owner_id=str(user.id), org_id=str(user.org_id), agent_token=raw, generation=generation))
        except RelayError as error:
            if (error.status, error.code) in START_REJECTIONS or start_not_created(error):
                start_rejected(error)
                fail(error.status, error.code, '시뮬 요청을 처리하지 못했습니다.', error.detail)
            start_error = error
        # Even an uncertain first delivery can cross a manager restart.
        lock_organization(db, user.org_id)
        db.refresh(row)
        not_created = start_error is not None and (start_error.status, start_error.code) == (409, 'SIM_GENERATION_STALE')
        if row.sim_generation != generation or row.sim_state != 'STARTING' or not_created:
            # Release the organization write lock before the single best-effort
            # compensating RPC. Never mutate a successor's credentials/ownership.
            db.commit()
            compensation = 'NOT_CREATED' if not_created else 'REMOVED_OR_ABSENT'
            if not not_created:
                try:
                    app.state.simmgr.request('DELETE', '/v1/robots/' + rid, {'generation': generation})
                except RelayError as error:
                    compensation = error.code
            event(db, user.org_id, 'SIM_ROBOT_START_STALE', user.id,
                  {'robot_id': rid, 'generation': generation, 'compensation': compensation}, category='LINK')
            db.commit()
            if start_error is not None:
                fail(start_error.status, start_error.code, '시뮬 요청을 처리하지 못했습니다.', start_error.detail)
            fail(409, 'SIM_GENERATION_MISMATCH', '시뮬 슬롯의 세대가 바뀌었습니다.')
        if start_error is not None:
            fail(start_error.status, start_error.code, '시뮬 요청을 처리하지 못했습니다.', start_error.detail)
        try:
            result = C.SimRobot.model_validate(result)
        except (ValueError, TypeError):
            fail(503, 'SIM_IDENTITY_MISMATCH', '시뮬 연결 정보를 확인하지 못했습니다.')
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
        manager_instance_id = row.sim_manager_instance_id
        if row.sim_state == 'IDLE':
            return Response(status_code=204)
        row.sim_state = 'STOPPING'
        phone_pass.revoke(db, user.org_id, robot_id=robot_id, clock=issuer.clock)
        db.commit()  # revocations survive a failed/uncertain manager response
        def removal_failed(code):
            event(db, user.org_id, 'SIM_ROBOT_REMOVE_FAILED', user.id,
                  {'robot_id': str(robot_id), 'reason': code}, category='LINK')
            db.commit()
        removal_error = None
        try:
            if app.state.simmgr is None:
                raise RelayError('SIM_DISABLED', detail={'reason': 'manager_unreachable'})
            result = C.SimRemoval.model_validate(app.state.simmgr.request('DELETE', '/v1/robots/' + str(robot_id),
                {'generation': generation}))
            # Same-process cancellation fences delayed delivery as before. Lost
            # memory across restart needs a different instance AND the complete
            # startup absence/resource proof; legacy unbound slots stay owned.
            if result.absent and (manager_instance_id is None or not result.startup_clean):
                raise RelayError('SIM_RECOVERY_UNPROVEN')
        except RelayError as error:
            removal_error = error
        except (ValueError, TypeError):
            removal_error = RelayError('SIM_RECOVERY_UNPROVEN')
        # A pass could be issued while the manager was stopping. Serialize the
        # final sweep and slot release with the existing organization write lock.
        lock_organization(db, user.org_id)
        db.refresh(row)
        if removal_error is not None:
            removal_failed(removal_error.code)
            fail(removal_error.status, removal_error.code, '시뮬 요청을 처리하지 못했습니다.', removal_error.detail)
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
        event(db, user.org_id, 'SIM_ROBOT_REMOVED', user.id, {'robot_id': str(robot_id),
              'generation': generation, 'manager_instance_id': str(result.manager_instance_id),
              'recovered_absent': result.absent and result.manager_instance_id != manager_instance_id}, category='LINK')
        return Response(status_code=204)
