"""Short-lived offline credentials and a durable revocation outbox; no leases."""
import base64
import hmac
import json
import os
import re
import stat
import time
from uuid import UUID, uuid4

from sqlalchemy import delete, select
from .models import Event, PhonePass, PhoneRevocation, now
from .event_messages import render


def b64(raw):
    return base64.urlsafe_b64encode(raw).rstrip(b'=').decode('ascii')


def load_keys(path):
    if path is None:
        return {}
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    with os.fdopen(fd, 'rb') as source:
        info = os.fstat(source.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077 or info.st_uid != os.geteuid():
            raise ValueError('phone key file requires process ownership and private regular file')
        raw = source.read(1048577)
    if len(raw) > 1048576:
        raise ValueError('phone key file too large')
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError('duplicate phone key field')
            result[key] = value
        return result
    data = json.loads(raw, object_pairs_hook=unique)
    result = {}
    robot_secrets = set()
    if not isinstance(data, dict):
        raise ValueError('invalid robot key map')
    for robot, entry in data.items():
        if str(UUID(robot)) != robot or not isinstance(entry, dict) or set(entry) != {'active', 'keys'}:
            raise ValueError('invalid robot key entry')
        keys = entry['keys']
        if not isinstance(keys, dict) or not 1 <= len(keys) <= 16 or entry['active'] not in keys:
            raise ValueError('explicit active phone key required')
        decoded = {}
        for kid, secret in keys.items():
            if not re.fullmatch(r'[A-Za-z0-9_-]{1,64}', kid) or not isinstance(secret, str) or not re.fullmatch(r'[A-Za-z0-9_-]+', secret):
                raise ValueError('invalid phone key')
            value = base64.urlsafe_b64decode(secret + '=' * (-len(secret) % 4))
            if b64(value) != secret or len(value) < 32:
                raise ValueError('phone key must contain at least256 random bits')
            decoded[kid] = value
        if robot_secrets.intersection(decoded.values()):
            raise ValueError('phone keys must not be shared across robots')
        robot_secrets.update(decoded.values())
        result[robot] = (entry['active'], decoded)
    return result


def audit(db, user, code, **data):
    db.add(render(db, Event(org_id=user.org_id, user_id=user.id, category='ACCOUNT',
                          code=code, severity='INFO', data=data)))


def revoke(db, org_id, *, user_id=None, robot_id=None, device=None, purpose=None):
    """Call inside the same organization-locked transaction as the policy write."""
    query = select(PhonePass).where(PhonePass.org_id == org_id, PhonePass.exp > int(time.time()))
    for field, value in (('user_id', user_id), ('robot_id', robot_id), ('device', device), ('purpose', purpose)):
        if value is not None:
            query = query.where(getattr(PhonePass, field) == value)
    rows = list(db.scalars(query))
    existing = set(db.scalars(select(PhoneRevocation.jti).where(PhoneRevocation.org_id == org_id)))
    for row in rows:
        if row.jti not in existing:
            db.add(PhoneRevocation(org_id=org_id, robot_id=row.robot_id, jti=row.jti, until=row.exp))
    db.flush()


class Issuer:
    def __init__(self, keys, fail, clock=time.time):
        self.keys, self.fail, self.clock = keys, fail, clock

    def deny(self, db, user, status, code, retry_after=None):
        audit(db, user, 'PHONE_PASS_DENIED', reason=code)
        db.commit()  # denial must survive the HTTP error rollback
        self.fail(status, code, '폰 출입증을 발급하지 못했습니다.',
                  {'retry_after': retry_after} if retry_after is not None else {})

    def issue(self, db, user, robot, body):
        current = int(self.clock())
        db.execute(delete(PhonePass).where(PhonePass.org_id == user.org_id, PhonePass.exp <= current))
        db.execute(delete(PhoneRevocation).where(PhoneRevocation.org_id == user.org_id, PhoneRevocation.until <= current))
        entry = self.keys.get(str(robot.id))
        if entry is None:
            self.deny(db, user, 503, 'PASS_KEY_MISSING')
        live = list(db.scalars(select(PhonePass).where(PhonePass.org_id == user.org_id,
                                                    PhonePass.user_id == user.id, PhonePass.exp > current)))
        device = body.device
        recent = [p for p in live if p.device == device and p.iat > current - 60]
        if len(recent) >= 10:
            self.deny(db, user, 429, 'PASS_RATE_LIMIT', min(p.iat for p in recent) + 60 - current)
        devices = {p.device for p in live}
        if device not in devices and len(devices) >= 4:
            # Earliest time at which a complete device slot becomes free.
            retry = min(max(p.exp for p in live if p.device == d) for d in devices) - current
            self.deny(db, user, 429, 'PASS_DEVICE_LIMIT', retry)
        others = [p for p in live if p.device == device and p.purpose == 'control'
                  and p.robot_id != robot.id] if body.purpose == 'control' else []
        acked = set(db.scalars(select(PhoneRevocation.jti).where(PhoneRevocation.org_id == user.org_id,
                                                     PhoneRevocation.acked_at.is_not(None))))
        blocked = [p for p in others if p.jti not in acked]
        if blocked:
            if body.switch:
                # Explicit consent only; a mistaken issue request must not stop the old robot.
                for rid in {p.robot_id for p in blocked}:
                    revoke(db, user.org_id, user_id=user.id, robot_id=rid, device=device, purpose='control')
            self.deny(db, user, 409, 'PASS_SWITCH_PENDING' if body.switch else 'PASS_OTHER_ROBOT',
                      max(p.exp for p in blocked) - current)
        kid, keys = entry
        claims = dict(iss='fh-control', aud='fh-phone/1', org=str(user.org_id), robot=str(robot.id),
                      sub=str(user.id), device=str(device), purpose=body.purpose,
                      iat=current, exp=current+600, jti=str(uuid4()))
        header = b64(json.dumps(dict(alg='HS256', typ='JWT', kid=kid), separators=(',', ':')).encode())
        payload = b64(json.dumps(claims, separators=(',', ':')).encode())
        signed = header + '.' + payload
        compact = signed + '.' + b64(hmac.digest(keys[kid], signed.encode('ascii'), 'sha256'))
        db.add(PhonePass(org_id=user.org_id, user_id=user.id, robot_id=robot.id, device=device,
                         purpose=body.purpose, jti=UUID(claims['jti']), iat=current, exp=current+600))
        audit(db, user, 'PHONE_PASS_ISSUED', jti=claims['jti'], robot_id=str(robot.id),
              device=str(device), purpose=body.purpose, iat=current, exp=current+600)
        return dict(token=compact, exp=current+600, kid=kid)


def pending(factory, org_id, robot_id, after):
    with factory() as db:
        rows = db.scalars(select(PhoneRevocation).where(PhoneRevocation.org_id == org_id,
            PhoneRevocation.robot_id == UUID(robot_id), PhoneRevocation.until > int(time.time()),
            PhoneRevocation.seq > after).order_by(PhoneRevocation.seq).limit(4))
        return [dict(t='phone.revoke', seq=r.seq, items=[dict(jtis=[str(r.jti)], until=r.until)]) for r in rows]


def acknowledge(factory, org_id, robot_id, seq):
    with factory.begin() as db:
        row = db.scalar(select(PhoneRevocation).where(PhoneRevocation.org_id == org_id,
            PhoneRevocation.robot_id == UUID(robot_id), PhoneRevocation.seq == seq))
        if row is not None and row.acked_at is None:
            row.acked_at = now()
