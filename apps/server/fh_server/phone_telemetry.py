"""Phone-authenticated display ingress, isolated from agent peers and arbiter.

No robot command interface, durable state queue, or synthetic agent connection.
The phone is the attributed reporter; this is not signed sensor attestation.
"""
import base64
from copy import deepcopy
import hmac
import json
import re
import threading
import time
from sqlalchemy import select

from apps.contracts import models as C
from .models import PhonePass, PhoneRevocation, now
from .phone_pass import b64


def decode(part):
    if not re.fullmatch(r'[A-Za-z0-9_-]+', part):
        raise ValueError('invalid compact part')
    value = base64.urlsafe_b64decode(part+'='*(-len(part) % 4))
    if b64(value) != part:
        raise ValueError('noncanonical compact part')
    return value


def unique(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('duplicate compact field')
        result[key] = value
    return result


def verify_pass(issuer, db, user, robot, compact, fail):
    """Require signed possession AND the still-active issued DB row, bound to login."""
    try:
        header_part, payload_part, signature_part = compact.split('.')
        header = json.loads(decode(header_part), object_pairs_hook=unique)
        if (not isinstance(header, dict) or set(header) != {'alg', 'typ', 'kid'} or
                header['alg'] != 'HS256' or header['typ'] != 'JWT'):
            raise ValueError('invalid header')
        _, keys = issuer.keys[str(robot.id)]
        signature = hmac.digest(keys[header['kid']], (header_part+'.'+payload_part).encode('ascii'), 'sha256')
        if not hmac.compare_digest(signature, decode(signature_part)):
            raise ValueError('invalid signature')
        claims = C.PhoneTicketClaims.model_validate(json.loads(decode(payload_part), object_pairs_hook=unique))
        current = issuer.clock()
        row = db.get(PhonePass, claims.jti)
        if (claims.org != user.org_id or str(claims.robot) != str(robot.id) or claims.sub != user.id
                or claims.surface != 'phone' or claims.run_cancel or not claims.iat <= current < claims.exp
                or not 0 < claims.exp-claims.iat <= 600 or row is None
                or (row.org_id, row.user_id, row.robot_id, row.device, row.purpose, row.iat, row.exp) !=
                   (user.org_id, user.id, robot.id, claims.device, claims.purpose, claims.iat, claims.exp)
                or db.scalar(select(PhoneRevocation.seq).where(
                    PhoneRevocation.org_id == user.org_id, PhoneRevocation.jti == claims.jti)) is not None):
            raise ValueError('inactive or mismatched pass')
        return claims
    except (ValueError, TypeError, KeyError, UnicodeError):
        fail(403, 'PHONE_STATE_PASS', '이 로봇의 유효한 폰 출입증이 필요합니다.')


class PhoneTelemetry:
    TTL_S = 3.
    MAX_ROBOTS = 1024
    MAX_PASSES = 8192

    def __init__(self, *, clock=time.monotonic, wall=time.time):
        self.clock, self.wall = clock, wall
        self._lock = threading.Lock()
        self._states, self._passes = {}, {}

    def accept(self, body, claims, fail):
        at, wall = self.clock(), self.wall()
        age = wall-body.observed_at.timestamp()
        if not -1. <= age <= 2.:
            fail(409, 'PHONE_STATE_STALE', '새로 받은 상태만 전송하세요.')
        age = max(0., age)
        remaining = min(self.TTL_S-age-body.sensor_age_ms/1000, claims.exp-wall)
        if remaining <= 0:
            fail(409, 'PHONE_STATE_STALE', '새로 받은 상태만 전송하세요.')
        rid, jti = str(body.robot), str(claims.jti)
        data = body.state.model_dump(mode='json')
        # Readouts never update arbiter, STOP references, agent ownership or runs.
        state = dict(speed=data['speed'], source='PHONE',
                     battery=(C.Battery(soc=body.state.battery.soc, updated_at=now()).model_dump(mode='json')
                              if body.state.battery.soc is not None else None),
                     devices=data.get('devices_changed') or [])
        with self._lock:
            self._states = {k: v for k, v in self._states.items() if v['expires'] > at}
            self._passes = {k: v for k, v in self._passes.items() if v['expires'] > at}
            previous = self._passes.get(jti)
            if previous is not None:
                if body.sequence <= previous['sequence']:
                    fail(409, 'PHONE_STATE_SEQUENCE', '이미 받은 상태입니다.')
                if at-previous['received'] < .5:
                    fail(429, 'PHONE_STATE_RATE', '상태는 초당 한 번 전송하세요.')
            existing = self._states.get(rid)
            if existing and existing['serial'] != body.robot_serial:
                fail(409, 'PHONE_STATE_IDENTITY', '기체 식별값을 다시 확인하세요.')
            if ((rid not in self._states and len(self._states) >= self.MAX_ROBOTS) or
                    (jti not in self._passes and len(self._passes) >= self.MAX_PASSES)):
                fail(503, 'PHONE_STATE_CAPACITY', '상태 수신을 잠시 후 다시 시도하세요.')
            self._passes[jti] = dict(sequence=body.sequence, received=at, expires=at+claims.exp-wall)
            self._states[rid] = dict(state=state, serial=body.robot_serial, expires=at+remaining,
                                     sampled_at=at-age-body.sensor_age_ms/1000)

    def get(self, rid):
        with self._lock:
            item = self._states.get(str(rid))
            if item is None or item['expires'] <= self.clock():
                self._states.pop(str(rid), None)
                return None
            return {**deepcopy(item['state']), 'age_s': max(0., self.clock()-item['sampled_at']),
                    'valid_for_s': max(0., item['expires']-self.clock())}


def install(app, DB, Identity, fail, authorize, issuer, find_robot):
    from fastapi import Response
    from uuid import UUID
    cache = PhoneTelemetry(clock=app.state.realtime.clock, wall=lambda: issuer.clock())
    app.state.realtime.phone_telemetry = cache

    @app.post('/api/v1/robots/{robot_id}/phone-state', status_code=204)
    def receive(robot_id: UUID, body: C.PhoneStateUpload, auth: Identity, db: DB):
        user, session = auth
        if session.client != 'app':
            fail(403, 'PHONE_STATE_APP', '로그인한 폰 앱에서만 상태를 전송할 수 있습니다.')
        robot = find_robot(db, user, robot_id)
        authorize(user, 'ROBOT_READ', robot)
        if robot.simulation or body.robot != robot_id:
            fail(409, 'PHONE_STATE_ROBOT', '실기 로봇 식별값을 확인하세요.')
        claims = verify_pass(issuer, db, user, robot, body.pass_token, fail)
        if body.state.controller is not None and body.state.controller != user.id:
            fail(409, 'PHONE_STATE_CONTROLLER', '폰 상태의 조종자를 확인하세요.')
        cache.accept(body, claims, fail)
        return Response(status_code=204, headers={'Cache-Control': 'no-store'})
