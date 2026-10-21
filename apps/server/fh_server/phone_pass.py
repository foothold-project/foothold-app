"""Short-lived offline credentials and a durable revocation outbox; no leases."""
import base64
import hmac
import json
import os
import re
import stat
import time
from uuid import UUID, uuid4

from sqlalchemy import delete, select, func, update
from .models import Event, PhonePass, PhoneRevocation, PhoneRevocationBatch, PhonePassDenials, now
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


MAX_REVOCATIONS = 4096
MAX_REVOCATION_BYTES = 1024 * 1024
MAX_REVOCATION_FRAME = 4096
ROBOT_CLOCK_GRACE = 60


def pack(rows):
    """Immutable wire-sized groups; reserve the largest valid sequence width."""
    items, members = [], []
    for row in rows:
        candidate = json.loads(json.dumps(items))
        if candidate and candidate[-1]['until'] == row.exp and len(candidate[-1]['jtis']) < 64:
            candidate[-1]['jtis'].append(str(row.jti))
        else:
            candidate.append(dict(jtis=[str(row.jti)], until=row.exp))
        size = len(json.dumps(dict(t='phone.revoke',seq=2**53-1,items=candidate),separators=(',',':')).encode())
        if len(candidate) > 16 or size > 4096:
            yield items, members
            candidate, members = [dict(jtis=[str(row.jti)],until=row.exp)], []
        items = candidate
        members.append(row)
    if items:
        yield items, members


def revoke(db, org_id, *, user_id=None, robot_id=None, device=None, purpose=None, clock=time.time):
    """Same organization-locked transaction as policy; never cap a safety reduction."""
    query = select(PhonePass).where(PhonePass.org_id == org_id, PhonePass.exp > int(clock()) - ROBOT_CLOCK_GRACE)
    for field, value in (('user_id', user_id), ('robot_id', robot_id), ('device', device), ('purpose', purpose)):
        if value is not None:
            query = query.where(getattr(PhonePass, field) == value)
    existing = select(PhoneRevocation.jti).where(PhoneRevocation.org_id == org_id)
    rows = list(db.scalars(query.where(PhonePass.jti.not_in(existing)).order_by(PhonePass.robot_id,PhonePass.exp,PhonePass.jti)))
    robots = {row.robot_id for row in rows}
    for rid in robots:
        for items, members in pack([row for row in rows if row.robot_id == rid]):
            batch = PhoneRevocationBatch(org_id=org_id,robot_id=rid,items=items,
                                         until=max(i['until'] for i in items))
            db.add(batch); db.flush()
            db.add_all([PhoneRevocation(org_id=org_id,robot_id=rid,jti=row.jti,until=row.exp,batch_id=batch.id)
                        for row in members])
    db.flush()


def reserved_usage(db, org_id, robot_id, current):
    """Reserve retained agent rows, including ACKed batches, plus future worst cases."""
    cutoff = current - ROBOT_CLOCK_GRACE
    batches = list(db.scalars(select(PhoneRevocationBatch).where(
        PhoneRevocationBatch.org_id == org_id, PhoneRevocationBatch.robot_id == robot_id,
        PhoneRevocationBatch.until > cutoff)))
    revoked = select(PhoneRevocation.jti).where(PhoneRevocation.org_id == org_id)
    active = db.scalar(select(func.count()).select_from(PhonePass).where(
        PhonePass.org_id == org_id, PhonePass.robot_id == robot_id,
        PhonePass.exp > cutoff, PhonePass.jti.not_in(revoked)))
    batch_bytes = sum(len(json.dumps(dict(t='phone.revoke',seq=b.id,items=b.items),
        sort_keys=True,separators=(',',':')).encode()) for b in batches)
    return len(batches) + active, batch_bytes + active * MAX_REVOCATION_FRAME


def reserved_count(db, org_id, robot_id, current):
    return reserved_usage(db,org_id,robot_id,current)[0]


class Issuer:
    def __init__(self, keys, fail, clock=time.time):
        self.keys, self.fail, self.clock = keys, fail, clock

    def deny(self, db, user, status, code, retry_after=None):
        current = self.clock()
        row = db.scalar(select(PhonePassDenials).where(PhonePassDenials.org_id == user.org_id).with_for_update())
        if row is None:
            row = PhonePassDenials(org_id=user.org_id,count=0,reported_at=current,reasons={},users={})
            db.add(row)
        row.count += 1
        row.reasons = {**row.reasons,code:row.reasons.get(code,0)+1}
        identity = str(user.id)
        row.users = {**row.users,identity:row.users.get(identity,0)+1}
        self._flush_denials(db,row,current)
        db.commit()  # denial must survive the HTTP error rollback
        self.fail(status, code, '폰 출입증을 발급하지 못했습니다.',
                  {'retry_after': retry_after} if retry_after is not None else {})

    @staticmethod
    def _flush_denials(db, row, current):
        if row.count and current - row.reported_at >= 1:
            top = sorted(row.users.items(),key=lambda item:(-item[1],item[0]))[:8]
            db.add(render(db, Event(org_id=row.org_id,category='ACCOUNT',code='PHONE_PASS_DENIED',
                severity='INFO',data={'count':row.count,'reasons':row.reasons,
                    'users':[{'user_id':user,'count':count} for user,count in top],
                    'other_count':row.count-sum(count for _,count in top)})))
            row.count, row.reasons, row.users, row.reported_at = 0, {}, {}, current

    def flush_denials(self, factory, org_id):
        with factory.begin() as db:
            row = db.scalar(select(PhonePassDenials).where(PhonePassDenials.org_id == org_id,
                PhonePassDenials.count > 0,PhonePassDenials.reported_at <= self.clock()-1).with_for_update())
            if row is not None:
                self._flush_denials(db,row,self.clock())

    def issue(self, db, user, robot, body):
        current = int(self.clock())
        db.execute(delete(PhonePass).where(PhonePass.org_id == user.org_id, PhonePass.exp <= current - ROBOT_CLOCK_GRACE))
        db.execute(delete(PhoneRevocation).where(PhoneRevocation.org_id == user.org_id, PhoneRevocation.until <= current - ROBOT_CLOCK_GRACE))
        db.execute(delete(PhoneRevocationBatch).where(PhoneRevocationBatch.org_id == user.org_id, PhoneRevocationBatch.until <= current - ROBOT_CLOCK_GRACE))
        reserved_rows, reserved_bytes = reserved_usage(db,user.org_id,robot.id,current)
        if reserved_rows + 1 > MAX_REVOCATIONS or reserved_bytes + MAX_REVOCATION_FRAME > MAX_REVOCATION_BYTES:
            self.deny(db,user,503,'PASS_REVOCATION_CAPACITY',600)
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
        active_robot = [p for p in live if p.robot_id == robot.id]
        if len(active_robot) >= 8:
            self.deny(db, user, 429, 'PASS_ACTIVE_LIMIT', min(p.exp for p in active_robot) - current)
        others = [p for p in live if p.device == device and p.purpose == 'control'
                  and p.robot_id != robot.id] if body.purpose == 'control' else []
        acked = set(db.scalars(select(PhoneRevocation.jti).where(PhoneRevocation.org_id == user.org_id,
                                                     PhoneRevocation.acked_at.is_not(None))))
        blocked = [p for p in others if p.jti not in acked]
        if blocked:
            if body.switch:
                # Explicit consent only; a mistaken issue request must not stop the old robot.
                for rid in {p.robot_id for p in blocked}:
                    revoke(db, user.org_id, user_id=user.id, robot_id=rid, device=device, purpose='control',clock=self.clock)
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


def pending(factory, org_id, robot_id, after, clock=time.time):
    with factory() as db:
        rows = db.scalars(select(PhoneRevocationBatch).where(PhoneRevocationBatch.org_id == org_id,
            PhoneRevocationBatch.robot_id == UUID(robot_id), PhoneRevocationBatch.until > int(clock()) - ROBOT_CLOCK_GRACE,
            PhoneRevocationBatch.id > after).order_by(PhoneRevocationBatch.id).limit(4))
        return [dict(t='phone.revoke',seq=r.id,items=r.items) for r in rows]


def acknowledge(factory, org_id, robot_id, seq):
    with factory.begin() as db:
        # A batch ACK confirms every contained JTI atomically, only for this robot.
        db.execute(update(PhoneRevocation).where(PhoneRevocation.org_id == org_id,
            PhoneRevocation.robot_id == UUID(robot_id), PhoneRevocation.batch_id == seq,
            PhoneRevocation.acked_at.is_(None)).values(acked_at=now()))
