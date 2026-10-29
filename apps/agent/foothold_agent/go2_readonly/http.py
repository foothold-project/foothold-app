"""Local status GET only; no phone hub, command dispatch, or server registration."""

from collections import deque
from dataclasses import dataclass
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import secrets
import socket
import threading
import time

from foothold_agent.discovery import Advertisement

CODE_LIFETIME_S = 1800
MAX_WORKERS = 16
MAX_CONNECTIONS_PER_ADDRESS = 4
REQUEST_DEADLINE_S = 3
MAX_FAILURE_ADDRESSES = 128


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
        self._failures = {}
        self._lock = threading.Lock()

    def authorize(self, code, address='local'):
        with self._lock:
            now = self.now()
            for peer, failures in list(self._failures.items()):
                while failures and now - failures[0] >= 60:
                    failures.popleft()
                if not failures:
                    del self._failures[peer]
            if now >= self.expires:
                return 401
            failures = self._failures.get(address)
            if failures and len(failures) >= 5:
                return 429
            if not hmac.compare_digest(code, self.code):
                if failures is None:
                    if len(self._failures) >= MAX_FAILURE_ADDRESSES:
                        return 429
                    failures = self._failures[address] = deque()
                failures.append(now)
                return 401
            return 200


class BoundedHTTPServer(ThreadingHTTPServer):
    """Admission before thread/header parsing; deadline covers the entire request."""
    daemon_threads = True
    request_queue_size = MAX_WORKERS

    def __init__(self, address, handler, *, max_workers, max_per_address, request_deadline):
        if max_workers < 1 or max_per_address < 1 or request_deadline <= 0:
            raise ValueError('positive HTTP resource limits required')
        self._slots = threading.BoundedSemaphore(max_workers)
        self._peers = {}
        self._admission_lock = threading.Lock()
        self.max_per_address = max_per_address
        self.request_deadline = request_deadline
        super().__init__(address, handler)

    def process_request(self, request, client_address):
        peer = client_address[0]
        with self._admission_lock:
            admitted = self._peers.get(peer, 0) < self.max_per_address and self._slots.acquire(False)
            if admitted:
                self._peers[peer] = self._peers.get(peer, 0) + 1
        if not admitted:
            # No worker or blocking write is allocated for rejected connections.
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except BaseException:
            self._release(peer)
            raise

    def _release(self, peer):
        with self._admission_lock:
            self._peers[peer] -= 1
            if not self._peers[peer]:
                del self._peers[peer]
            self._slots.release()

    def process_request_thread(self, request, client_address):
        def expire():
            try:
                request.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
        deadline = threading.Timer(self.request_deadline, expire)
        deadline.daemon = True
        started = False
        try:
            deadline.start()
            started = True
            super().process_request_thread(request, client_address)
        finally:
            deadline.cancel()
            if started:
                deadline.join()
            else:
                self.shutdown_request(request)
            self._release(client_address[0])

    def handle_error(self, request, client_address):
        pass  # timeouts/disconnects must not log client addresses or headers


def make_server(address, state, access, *, max_workers=MAX_WORKERS,
                max_per_address=MAX_CONNECTIONS_PER_ADDRESS, request_deadline=REQUEST_DEADLINE_S):
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
            status = access.authorize(code, self.client_address[0])
            return self.reply(status, state.snapshot() if status == 200 else None)

        def do_POST(self):
            self.reply(405)

        do_PUT = do_PATCH = do_DELETE = do_OPTIONS = do_HEAD = do_POST

    return BoundedHTTPServer(address, Handler, max_workers=max_workers,
                             max_per_address=max_per_address, request_deadline=request_deadline)
