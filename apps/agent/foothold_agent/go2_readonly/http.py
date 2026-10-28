"""Local status GET only; no phone hub, command dispatch, or server registration."""

from collections import deque
from dataclasses import dataclass
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import secrets
import threading
import time

from foothold_agent.discovery import Advertisement

CODE_LIFETIME_S = 1800


@dataclass(frozen=True)
class ReadonlyAdvertisement(Advertisement):
    @property
    def properties(self):
        values = dict(v='1', name=self.name, model=self.model, mode='go2-readonly',
                      agent=f'http://{self.address}:{self.port}/go2/status')
        if self.rid is not None:
            values['rid'] = self.rid
        return {key.encode('ascii'): value.encode('utf-8') for key, value in values.items()}


class Access:
    def __init__(self, *, now=time.monotonic):
        self.now = now
        self.code = f'{secrets.randbelow(100000000):08d}'
        self.expires = now() + CODE_LIFETIME_S
        self._failures = deque()
        self._lock = threading.Lock()

    def authorize(self, code):
        with self._lock:
            now = self.now()
            while self._failures and now - self._failures[0] >= 60:
                self._failures.popleft()
            if now >= self.expires:
                return 401
            if len(self._failures) >= 5:
                return 429
            if not hmac.compare_digest(code, self.code):
                self._failures.append(now)
                return 401
            return 200


def make_server(address, state, access):
    class Handler(BaseHTTPRequestHandler):
        # One request per TCP connection. Never keep an unread command body alive.
        timeout = 3

        def log_message(self, *_):
            pass  # never log headers, codes, client addresses, or query strings

        def reply(self, status, body=None):
            raw = json.dumps(body or {'error': status}, allow_nan=False).encode('utf-8')
            self.send_response(status)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.send_header('Content-Length', str(len(raw)))
            self.send_header('Connection', 'close')
            if status == 429:
                self.send_header('Retry-After', '60')
            self.end_headers()
            self.wfile.write(raw)
            self.close_connection = True

        def do_GET(self):
            if self.path != '/go2/status':
                return self.reply(404)
            # Bound the header shape to ASCII for constant-time comparison.
            codes = self.headers.get_all('X-Foothold-Code', [])
            code = codes[0] if len(codes) == 1 else ''
            if len(code) != 8 or not code.isascii() or not code.isdigit():
                code = ''
            status = access.authorize(code)
            return self.reply(status, state.snapshot() if status == 200 else None)

        def do_POST(self):
            self.reply(405)

        do_PUT = do_PATCH = do_DELETE = do_OPTIONS = do_HEAD = do_POST

    return ThreadingHTTPServer(address, Handler)
