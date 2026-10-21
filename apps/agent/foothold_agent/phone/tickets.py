"""Strict compact JWS HS256 verification using only the standard library.

One key per robot; agents must never share keys across robots. No token logging.
The issuer is deliberately absent: tests create their own ephemeral credentials.
"""

import base64
import hashlib
import hmac
import json
import math
import os
import re
import sqlite3
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


def load_keys(path):
    """Provisioned out of band, outside Git: {kid: unpadded_base64url_secret}."""
    with open(path, 'rb') as source:
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
        if replay_path != ':memory:':
            descriptor = os.open(replay_path, os.O_CREAT | os.O_RDWR, 0o600)
            os.close(descriptor)
        self.db = sqlite3.connect(replay_path, timeout=.05)
        self.db.execute('PRAGMA page_size=4096')
        self.db.execute('PRAGMA max_page_count=256')
        if (self.db.execute('PRAGMA page_size').fetchone()[0] != 4096
                or self.db.execute('PRAGMA page_count').fetchone()[0] > 256):
            self.db.close()
            raise ValueError('invalid replay journal size')
        self.db.execute('PRAGMA synchronous=FULL')
        self.db.execute('CREATE TABLE IF NOT EXISTS used (jti TEXT PRIMARY KEY, exp INTEGER NOT NULL)')
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
            if uuid(claims['robot']) != self.robot:
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
            return {'user': user, 'device': device, 'purpose': claims['purpose'], 'jti': nonce, 'expires': expires,
                    'deadline': deadline}
        except (ValueError, TypeError, KeyError, UnicodeError, RecursionError, OverflowError, sqlite3.Error):
            raise TicketError("TICKET_INVALID") from None
