"""User-authorized, bounded observer relay; no motion or lifecycle operations."""
from collections import OrderedDict
from threading import Lock
import logging
import time
from typing import Literal
from urllib.parse import urlencode
from uuid import UUID

from fastapi import Request
from fastapi.responses import JSONResponse
from pydantic import ValidationError
from starlette.concurrency import run_in_threadpool

from apps.contracts import models as C
from .models import Robot
from .simulation import RelayError, parse_robot_list


logger = logging.getLogger(__name__)


def relay_failure(stage, status, code, validation=None):
    # Only fixed stages and protocol outcomes: no identity, body, URL, secret,
    # upstream exception text or validation input enters the server log.
    if validation is None:
        logger.warning("external camera relay stage=%s status=%s code=%s", stage, status, code)
    else:
        logger.warning("external camera relay stage=%s status=%s code=%s fields=%s",
                       stage, status, code, slot_validation_fields(validation))


def slot_validation_fields(error):
    """Only schema field names/indexes and error kinds; extra keys may be secrets."""
    if isinstance(error, TypeError):
        return '$:type_error'
    models = {'items': C.SimRobot, 'expired': C.SimExpired, 'cleanup': C.SimCleanupSlot}
    fields = []
    for issue in error.errors(include_input=False, include_context=False, include_url=False)[:16]:
        path = []
        model = C.SimRobotList
        for part in issue['loc']:
            if type(part) is int:
                path.append(str(part))
            elif isinstance(part, str) and model is not None and part in model.model_fields:
                path.append(part)
                model = models.get(part) if model is C.SimRobotList else None
            else:
                path.append('<extra>')
                model = None
        fields.append(('.'.join(path) or '$') + ':' + issue['type'])
    return ','.join(fields)


class Admission:
    """One server process per organization, as required by server deployment.

    Unix microseconds seed sequences after restart (well below JS MAX_SAFE_INTEGER);
    max(last+1, wall clock) also tolerates a clock correction within this process.
    A global sequence is stronger than the required per-robot/episode/epoch order.
    """
    def __init__(self):
        self.lock = Lock()
        self.last_seq = 0
        self.users = OrderedDict()

    def reserve(self, user_id, robot_id):
        with self.lock:
            at = time.monotonic()
            # Keep only active 100ms windows, with a hard memory bound. Saturation
            # rejects a new key rather than evicting another viewer's live limit.
            while self.users and next(iter(self.users.values())) <= at - .1:
                self.users.popitem(last=False)
            key = (user_id, robot_id)
            if key in self.users or len(self.users) >= 4096:
                return None
            self.users[key] = at
            self.last_seq = max(self.last_seq + 1, time.time_ns() // 1000)
            return self.last_seq


def install(app, UploadIdentity, upload_write, fail, authorize):
    admission = Admission()

    def call(path, body=None):
        relay = app.state.simmgr
        if relay is None:
            relay_failure('manager_disabled', 503, 'SIM_DISABLED')
            fail(503, 'SIM_DISABLED', '시뮬 관리자가 연결되지 않았습니다.', {'reason': 'manager_unreachable'})
        try:
            return relay.request('GET' if body is None else 'POST', path, body, timeout=.5)
        except RelayError as error:
            relay_failure('slots_transport' if body is None else 'command_transport', error.status, error.code)
            fail(error.status, error.code, '외부 카메라 요청을 처리하지 못했습니다.', error.detail)

    @app.post('/api/v1/robots/{robot_id}/external-camera/{operation}')
    async def external_camera(robot_id: UUID, operation: Literal['view', 'reset', 'cancel'],
                              request: Request, auth: UploadIdentity):
        # Do not let a client-controlled stream hold a DB connection or org lock.
        raw = bytearray()
        async for chunk in request.stream():
            if len(raw) + len(chunk) > 4096:
                fail(413, 'BODY_TOO_LARGE', '외부 카메라 본문은 4096바이트 이하여야 합니다.')
            raw.extend(chunk)
        try:
            body = C.ExternalCameraViewRequest.model_validate_json(bytes(raw))
        except ValidationError:
            fail(400, 'VALIDATION', '외부 카메라 입력 형식을 확인하세요.')

        def owned(db, user):
            row = db.get(Robot, robot_id)
            if row is None:
                fail(404, 'NOT_FOUND', '로봇을 찾을 수 없습니다.')
            authorize(user, 'ROBOT_READ', row)
            if not row.simulation:
                fail(409, 'UNAVAILABLE', '실기 로봇에는 Gazebo 외부 카메라가 없습니다.')
            if body.robot != str(robot_id):
                fail(409, 'SIM_OBSERVER_BINDING', '요청과 경로의 로봇이 다릅니다.')
            if row.sim_state != 'ACTIVE' or row.owner_user_id is None:
                fail(409, 'SIM_OBSERVER_UNAVAILABLE', '실행 중인 시뮬 슬롯이 아닙니다.')
            return row

        def relay():
            def prepare(db, user):
                row = owned(db, user)
                seq = admission.reserve(user.id, robot_id)
                if seq is None:
                    fail(409, 'SIM_OBSERVER_RATE_LIMIT', '사용자·로봇당 100ms 뒤 다시 요청하세요.')
                return row.sim_generation, row.owner_user_id, user.org_id, seq
            generation, owner, org, seq = upload_write(request, auth, prepare)
            # No organization lock/DB transaction during either bounded RPC.
            try:
                slots = parse_robot_list(call('/v1/robots?' + urlencode({'org_id': str(org)})))
            except (ValidationError, TypeError) as error:
                relay_failure('slots_response', 503, 'SIM_UNAVAILABLE', error)
                fail(503, 'SIM_UNAVAILABLE', '시뮬 연결 정보를 확인하지 못했습니다.')
            slot = next((r for r in slots.items if r.robot_id == robot_id), None)
            if (slot is None or slot.state != 'RUNNING' or slot.generation != generation
                    or slot.owner_id != owner):
                fail(409, 'SIM_OBSERVER_UNAVAILABLE', '등록된 실행 중 시뮬 슬롯과 다릅니다.')

            def recheck(db, user):
                row = owned(db, user)  # refresh current auth and ownership after GET
                if row.sim_generation != generation or row.owner_user_id != owner:
                    fail(409, 'SIM_OBSERVER_BINDING', '시뮬 슬롯의 담당자 또는 세대가 바뀌었습니다.')
            upload_write(request, auth, recheck)
            payload = body.model_dump(mode='json')
            payload['seq'] = seq  # client sequence is validated but never trusted
            result = call(f'/v1/robots/{robot_id}/external-camera/{operation}', payload)
            expected = dict(accepted=True, shared=True, seq=seq, operation=operation)
            if (not isinstance(result, dict) or result != expected
                    or result.get('accepted') is not True or result.get('shared') is not True
                    or type(result.get('seq')) is not int):
                relay_failure('command_response', 503, 'SIM_UNAVAILABLE')
                fail(503, 'SIM_UNAVAILABLE', '외부 카메라 접수 응답을 확인하지 못했습니다.')
            return expected

        return JSONResponse(await run_in_threadpool(relay), headers={'Cache-Control': 'no-store'})
