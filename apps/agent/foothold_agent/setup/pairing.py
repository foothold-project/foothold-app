"""Bounded pairing HTTP transport; secrets never enter URLs, reprs or errors."""
from datetime import datetime
import json
import math
import time
from urllib.parse import urlsplit, urlunsplit
from urllib.request import Request, build_opener, HTTPRedirectHandler, ProxyHandler
from uuid import UUID

from .storage import Credentials


def timestamp(value):
    if isinstance(value, str):
        parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
        if parsed.tzinfo is None:
            raise ValueError('timezone required')
        value = parsed.timestamp()
    if type(value) not in (int, float) or not math.isfinite(value):
        raise ValueError('finite timestamp required')
    return float(value)


def origin(value):
    parsed = urlsplit(value)
    if (parsed.scheme not in ('https', 'http') or not parsed.hostname or parsed.username
            or parsed.password or parsed.query or parsed.fragment or parsed.path not in ('', '/')
            or parsed.scheme == 'http' and parsed.hostname != '127.0.0.1'):
        raise ValueError('HTTPS server origin required (HTTP only on loopback)')
    return urlunsplit((parsed.scheme, parsed.netloc, '', '', ''))


def ws_origin(value):
    parsed = urlsplit(value)
    return origin(urlunsplit(('https' if parsed.scheme == 'wss' else 'http', parsed.netloc, '', '', '')))


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


class Pairing:
    def __init__(self, server, *, post=None, wall=time.time):
        self.server = origin(server)
        self.wall = wall
        self._post = post or self._http
        self._id = self._secret = None
        self.code = None
        self.expires_at = None

    def _http(self, path, body):
        request = Request(self.server+path, json.dumps(body).encode(),
                          {'Content-Type': 'application/json', 'Cache-Control': 'no-store'}, method='POST')
        # No inherited proxy and no redirect can carry the one-time secret elsewhere.
        with build_opener(ProxyHandler({}), NoRedirect()).open(request, timeout=5) as response:
            payload = response.read(8193)
            if len(payload) > 8192:
                raise ValueError('pairing response exceeds limit')
            value = json.loads(payload)
            if not isinstance(value, dict):
                raise ValueError('pairing object required')
            return value

    def start(self, serial):
        value = self._post('/api/v1/pairing/start', {'model': 'unitree_go2', 'robot_serial': serial})
        pairing_id = str(UUID(value['pairing_id']))
        code, secret = value['code'], value['poll_secret']
        expires = timestamp(value['expires_at'])
        if (not isinstance(code, str) or len(code) != 6 or not code.isascii() or not code.isdigit()
                or not isinstance(secret, str) or not 32 <= len(secret) <= 256
                or not self.wall() < expires <= self.wall()+600):
            raise ValueError('invalid pairing response')
        self._id, self._secret, self.code, self.expires_at = pairing_id, secret, code, expires

    def poll(self, serial):
        if self._secret is None or self.wall() >= self.expires_at:
            self.clear()
            raise PermissionError('pairing expired or consumed')
        value = self._post(f'/api/v1/pairing/{self._id}/poll', {'poll_secret': self._secret})
        state = value.get('state')
        if state == 'waiting':
            return None
        self.clear()
        if state != 'paired':
            raise PermissionError('pairing no longer available')
        credentials = Credentials(value['robot_id'], serial, value['agent_token'], value['agent_ws_url'])
        if ws_origin(credentials.agent_ws_url) != self.server:
            raise PermissionError('agent endpoint must share pairing server origin')
        return credentials

    def clear(self):
        self._id = self._secret = self.code = self.expires_at = None
