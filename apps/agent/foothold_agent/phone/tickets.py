"""Strict compact JWS HS256 verification using only the standard library.

One key per robot; agents must never share keys across robots. No token logging.
The control server issues credentials; verification never calls that server.
"""

import base64
import hashlib
import hmac
import json
import math
import os
import re
import sqlite3
import stat
import time
from uuid import UUID

MAX_LIFETIME = 600
MAX_USED = 4096


class TicketError(ValueError):
    pass


def uuid(value):
    if not isinstance(value, str):
        raise ValueError("UUID required")
    return str(UUID(value))


def unbase64(value):
    if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9_-]+', value):
        raise ValueError("invalid base64url")
    decoded = base64.urlsafe_b64decode(value + '=' * (-len(value) % 4))
    if base64.urlsafe_b64encode(decoded).rstrip(b'=').decode() != value:
        raise ValueError("noncanonical base64url")
    return decoded


def json_object(raw):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("duplicate key")
            result[key] = value
        return result
    value = json.loads(raw, object_pairs_hook=unique,
                       parse_constant=lambda _: (_ for _ in ()).throw(ValueError("nonfinite")))
    if not isinstance(value, dict):
        raise ValueError("object required")
    return value


def private_file(path, *, create=False):
    """Open nonblocking/no-follow, then validate the actual descriptor, not a stat race."""
    flags = os.O_RDWR | os.O_CREAT if create else os.O_RDONLY
    flags |= os.O_NONBLOCK | os.O_NOFOLLOW | os.O_CLOEXEC
    descriptor = os.open(path, flags, 0o600)
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077 or info.st_uid != os.geteuid():
            raise ValueError('phone credential files must be private regular files owned by the process user')
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


def load_keys(path):
    """Provisioned out of band, outside Git: {kid: unpadded_base64url_secret}."""
    with os.fdopen(private_file(path), 'rb') as source:
        raw = source.read(65537)
    if len(raw) > 65536:
        raise ValueError("phone key file too large")
    keys = {kid: unbase64(secret) for kid, secret in json_object(raw).items()}
    if not keys or len(keys) > 16 or any(
            not re.fullmatch(r'[A-Za-z0-9_-]{1,64}', kid) or len(secret) < 32
            for kid, secret in keys.items()):
        raise ValueError("invalid phone key ring")
    return keys


class Verifier:
    def __init__(self, robot, keys, *, org, replay_path, clock_trusted,
                 wall=time.time, now=time.monotonic):
        self.robot, self.keys = uuid(robot), dict(keys)
        self.org = uuid(org)
        if not keys or any(not isinstance(k, str) or not isinstance(v, bytes) or len(v) < 32
                           for k, v in keys.items()):
            raise ValueError("phone keys require at least 256 bits")
        self.wall, self.now = wall, now
        self.trusted = clock_trusted is True
        self.anchor_wall, self.anchor_mono = wall(), now()
        self.last_wall = self.anchor_wall
        self.revocation_failed = False
        if replay_path != ':memory:':
            descriptor = private_file(replay_path, create=True)
            try:
                self.db = sqlite3.connect(replay_path, timeout=.05)
                before, after = os.fstat(descriptor), os.stat(replay_path, follow_symlinks=False)
                if (before.st_dev, before.st_ino) != (after.st_dev, after.st_ino):
                    self.db.close()
                    raise ValueError('replay journal path changed')
            finally:
                os.close(descriptor)
        else:
            self.db = sqlite3.connect(replay_path, timeout=.05)  # direct test construction only
        self.db.execute('PRAGMA page_size=4096')
        self.db.execute('PRAGMA max_page_count=256')
        if (self.db.execute('PRAGMA page_size').fetchone()[0] != 4096
                or self.db.execute('PRAGMA page_count').fetchone()[0] > 256):
            self.db.close()
            raise ValueError('invalid replay journal size')
        self.db.execute('PRAGMA synchronous=FULL')
        self.db.execute('CREATE TABLE IF NOT EXISTS used (jti TEXT PRIMARY KEY, exp INTEGER NOT NULL)')
        self.db.execute('CREATE TABLE IF NOT EXISTS revoked (seq INTEGER PRIMARY KEY, body TEXT NOT NULL, until INTEGER NOT NULL)')
        self.db.execute('CREATE TABLE IF NOT EXISTS metadata (robot TEXT PRIMARY KEY, wall REAL NOT NULL)')
        rows = self.db.execute('SELECT robot, wall FROM metadata').fetchall()
        if rows and (len(rows) != 1 or rows[0][0] != self.robot or self.last_wall < rows[0][1]):
            self.trusted = False

    def check_clock(self):
        current = self.wall()
        if (not self.trusted or not math.isfinite(current) or not math.isfinite(self.now())
                or self.now() < self.anchor_mono or current < self.last_wall
                or abs((current - self.anchor_wall) - (self.now() - self.anchor_mono)) > 5):
            self.trusted = False  # explicit operator recovery/restart required
            raise TicketError('CLOCK_UNTRUSTED')
        self.last_wall = current
        return current

    def close(self):
        self.db.close()

    @staticmethod
    def _revocation(frame):
        if (not isinstance(frame, dict) or set(frame) != {'t', 'seq', 'items'}
                or frame['t'] != 'phone.revoke' or type(frame['seq']) is not int
                or not 1 <= frame['seq'] <= 2**53-1
                or not isinstance(frame['items'], list) or not 1 <= len(frame['items']) <= 16):
            raise ValueError('invalid revocation frame')
        for item in frame['items']:
            if not isinstance(item, dict) or type(item.get('until')) is not int or not 0 <= item['until'] <= 2**53-1:
                raise ValueError('invalid revocation deadline')
            if item.get('jtis') is not None:
                if set(item) - {'jtis', 'until', 'sub', 'device'} or item.get('sub') is not None or item.get('device') is not None:
                    raise ValueError('ambiguous revocation selector')
                if not isinstance(item['jtis'], list) or not 1 <= len(item['jtis']) <= 64:
                    raise ValueError('invalid revoked IDs')
                for nonce in item['jtis']:
                    if uuid(nonce) != nonce:
                        raise ValueError('noncanonical revoked ID')
            else:
                if set(item) - {'sub', 'device', 'until', 'jtis'} or uuid(item['sub']) != item['sub']:
                    raise ValueError('invalid revoked subject')
                if item.get('device') is not None and uuid(item['device']) != item['device']:
                    raise ValueError('invalid revoked device')
        return frame

    @staticmethod
    def matches(ticket, items, current):
        return any((current is None or item['until'] > current) and (
            ticket['jti'] in item['jtis'] if item.get('jtis') is not None else
            ticket['user'] == item['sub'] and (item.get('device') is None or ticket['device'] == item['device'])
            and (current is not None or ticket['issued'] < item['until']))
            for item in items)

    def revoked(self, ticket):
        if self.revocation_failed:
            raise TicketError('REVOCATION_STORAGE_FAILED')
        current = self.check_clock()
        try:
            return any(self.matches(ticket, json_object(body)['items'], current)
                       for body, in self.db.execute('SELECT body FROM revoked WHERE until > ?', (current,)))
        except (ValueError, sqlite3.Error):
            self.revocation_failed = True
            raise TicketError('REVOCATION_STORAGE_FAILED') from None

    def revoke(self, frame):
        """Authenticated server facade only. FULL commit completes before ACK."""
        try:
            current = self.check_clock()
            self._revocation(frame)
            body = json.dumps(frame, sort_keys=True, separators=(',', ':'))
            if len(body.encode()) > 4096:
                raise ValueError('revocation frame too large')
            until = max(i['until'] for i in frame['items'])
            with self.db:
                self.db.execute('DELETE FROM revoked WHERE until <= ?', (current,))
                old = self.db.execute('SELECT body FROM revoked WHERE seq = ?', (frame['seq'],)).fetchone()
                if old is not None and old[0] != body:
                    raise ValueError('conflicting revocation sequence')
                if old is None and until > current:
                    if self.db.execute('SELECT count(*) FROM revoked').fetchone()[0] >= MAX_USED:
                        raise ValueError('revocation journal full')
                    self.db.execute('INSERT INTO revoked VALUES (?, ?, ?)', (frame['seq'], body, until))
                self.db.execute('INSERT OR REPLACE INTO metadata VALUES (?, ?)', (self.robot, current))
        except (ValueError, TypeError, KeyError, sqlite3.Error, TicketError, OverflowError):
            self.revocation_failed = True  # fail closed until explicit recovery/restart
            raise TicketError('REVOCATION_STORAGE_FAILED') from None

    def verify(self, token):
        try:
            if not isinstance(token, str) or len(token) > 2048:
                raise ValueError("token size")
            header64, payload64, signature64 = token.split('.')
            header = json_object(unbase64(header64))
            if set(header) != {'alg', 'typ', 'kid'} or header['alg'] != 'HS256' or header['typ'] != 'JWT':
                raise ValueError("header")
            key = self.keys[header['kid']]
            signed = (header64 + '.' + payload64).encode('ascii')
            if not hmac.compare_digest(hmac.digest(key, signed, hashlib.sha256), unbase64(signature64)):
                raise ValueError("signature")
            claims = json_object(unbase64(payload64))
            if set(claims) != {'iss', 'aud', 'org', 'robot', 'sub', 'device', 'purpose', 'iat', 'exp', 'jti'}:
                raise ValueError("claims")
            if claims['iss'] != 'fh-control' or claims['aud'] != 'fh-phone/1':
                raise ValueError("scope")
            if claims['robot'] != self.robot:
                raise ValueError("robot")
            if uuid(claims['org']) != self.org or claims['purpose'] not in ('control', 'view'):
                raise ValueError('scope')
            user, nonce, device = uuid(claims['sub']), uuid(claims['jti']), uuid(claims['device'])
            checked_at = self.now()
            issued, expires, current = claims['iat'], claims['exp'], self.check_clock()
            if (type(issued) is not int or type(expires) is not int
                    or not 0 <= issued < expires <= 2**53 - 1
                    or not 0 < expires - issued <= MAX_LIFETIME
                    or not issued <= current < expires):
                raise ValueError("expiry")
            if self.revoked({'user': user, 'device': device, 'jti': nonce}):
                raise ValueError('revoked ticket')
            # A bounded, durable spent-ID journal also rejects replay after restart.
            # FULL commit completes BEFORE the hello is accepted. I/O failure
            # denies admission; the sink's independent watchdog remains required.
            with self.db:
                self.db.execute('DELETE FROM used WHERE exp <= ?', (current,))
                if self.db.execute('SELECT count(*) FROM used').fetchone()[0] >= MAX_USED:
                    raise ValueError('replay journal full')
                self.db.execute('INSERT INTO used VALUES (?, ?)', (nonce, expires))
                self.db.execute('INSERT OR REPLACE INTO metadata VALUES (?, ?)', (self.robot, current))
            deadline = checked_at + min(expires - current, MAX_LIFETIME)
            if self.now() >= deadline:
                raise ValueError('ticket expired during admission')
            return {'user': user, 'device': device, 'purpose': claims['purpose'], 'jti': nonce, 'issued': issued, 'expires': expires,
                    'deadline': deadline}
        except (ValueError, TypeError, KeyError, UnicodeError, RecursionError, OverflowError, sqlite3.Error):
            raise TicketError("TICKET_INVALID") from None
