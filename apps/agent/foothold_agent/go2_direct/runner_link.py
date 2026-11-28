"""START C++ 실행기와 같은 기기 안 (127.0.0.1 UDP) 앱 입력 길. 규약: runner_cpp/APP-MOVES.md

보내는 것: 키 한 번 {seq, key, action, request_id} · 속도 {seq, vx, vy, wz} (연결 프로그램 출력 주기마다, 0 포함).
  앱 STOP (operator stop) 동안은 속도 대신 {seq, stop: 1, id} 를 출력 주기마다, 잠금 풀기 뒤 {seq, stop: 0, id} 를
  실행기 응답 stopped=false 가 올 때까지. id 는 그 STOP 의 번호라 더 새 STOP 뒤의 옛 해제는 버린다 (양쪽 다).
  모든 묶음에 token: 실행기가 시작 때 만든 0600 파일 (TOKEN_FILE) 값. 값은 기록에 남기지 않는다.
받는 것: 실행기 응답 {seq, result, reason?, request_id?, phase, remote, stopped}. 응답이 없으면 키 요청은 RUNNER_SENT 그대로.
seq 는 CLOCK_MONOTONIC ns (같은 기기라 실행기가 0.5 초 넘은 묶음을 버린다).
"""
import json
import os
import socket
import stat
import threading
import time
from collections import OrderedDict

PORT_ENV = 'FH_START_MOVE_PORT'
STATUS_MAX_AGE_S = .20
MAX_BYTES = 512
RESULTS = frozenset({'STARTED', 'IGNORED', 'ACCEPTED'})
PHASES = frozenset({'high', 'acquiring', 'standing_up', 'policy', 'sitting', 'dog_sitting', 'moving',
                    'damping', 'returning', 'recovering', 'unknown'})
REASONS = frozenset({'phase', 'remote', 'busy', 'not_stopped', 'stopped', 'stale'})
TOKEN_FILE = '/tmp/foothold-start-app.token'   # runner_cpp app_input.hpp app_token_path


def port_from(env=os.environ):
    port = env.get(PORT_ENV, '')
    return int(port) if port.isdigit() and 1024 <= int(port) <= 65535 else None


class RunnerLink:
    def __init__(self, port, *, now=time.monotonic):
        self.port, self.now = port, now
        self._lock = threading.Lock()
        self._seq = 0
        self._sent = OrderedDict()   # seq -> request_id (키 묶음만 · 응답 짝 확인용)
        self._acks = []
        self._status = None
        self._stop_id = 0     # 보낸 STOP 중 가장 새 번호 (그보다 옛 해제는 보내지 않는다)
        self._token = None    # ((st_dev, st_ino, st_mtime_ns), 값)
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.sock.bind(('127.0.0.1', 0))
        self.sock.setblocking(False)

    @classmethod
    def configured(cls, env=os.environ, **kw):
        port = port_from(env)
        return None if port is None else cls(port, **kw)

    def _read_token(self):
        """실행기 세션 토큰. 내 계정 · 0600 파일만 믿는다 (아니면 OSError: 아무것도 보내지 않음)."""
        fd = os.open(TOKEN_FILE, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
        try:
            info = os.fstat(fd)
            if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid()
                    or info.st_mode & 0o077):
                raise PermissionError('runner token file must be 0600 and mine')
            key = (info.st_dev, info.st_ino, info.st_mtime_ns)
            if self._token is None or self._token[0] != key:
                value = os.read(fd, 129).decode('ascii').strip()
                if not value or len(value) > 128:
                    raise PermissionError('runner token file empty')
                self._token = (key, value)
            return self._token[1]
        finally:
            os.close(fd)

    def _send(self, body):
        with self._lock:
            token = self._read_token()
            self._seq = max(self._seq + 1, time.monotonic_ns())
            body = dict(seq=self._seq, token=token, **body)
            self.sock.sendto(json.dumps(body, separators=(',', ':')).encode(), ('127.0.0.1', self.port))
            return self._seq

    def key(self, key, action, request_id):
        """키 한 번. 소켓 오류는 OSError 로 올린다 (부르는 쪽이 RUNNER_SEND_FAILED)."""
        seq = self._send(dict(key=key, action=action, request_id=request_id))
        with self._lock:
            self._sent[seq] = request_id
            while len(self._sent) > 64:
                self._sent.popitem(last=False)
        return seq

    def velocity(self, velocity):
        """출력 주기마다 한 번. 실패는 삼킨다: 실행기 응답이 끊겨 상태가 낡으면 화면 조종이 막힌다 (닫힌 쪽)."""
        try:
            self._send(dict(vx=float(velocity[0]), vy=float(velocity[1]), wz=float(velocity[2])))
        except OSError:
            pass

    def stop(self, on, stop_id):
        """앱 STOP 묶음 {stop: 1, id} (리모컨 막대보다 앞섬) · 해제 {stop: 0, id}. 실패는 velocity 처럼 삼킨다.
        더 새 STOP 을 이미 보냈으면 옛 해제는 보내지 않는다 (참이면 보냄)."""
        with self._lock:
            if on:
                self._stop_id = max(self._stop_id, stop_id)
            elif stop_id < self._stop_id:
                return False
        try:
            self._send(dict(stop=1 if on else 0, id=stop_id))
        except OSError:
            return False
        return True

    def poll(self):
        while True:
            try:
                raw, peer = self.sock.recvfrom(MAX_BYTES + 1)
            except (BlockingIOError, InterruptedError):
                return
            except OSError:
                return   # 실행기 포트가 닫혀 있으면 ICMP 거부가 여기로 온다
            if peer != ('127.0.0.1', self.port) or len(raw) > MAX_BYTES:
                continue
            self._feed(raw)

    def _feed(self, raw):
        try:
            msg = json.loads(raw)
            seq, result, phase, remote = msg['seq'], msg['result'], msg['phase'], msg['remote']
            stopped = msg['stopped']
            reason, request_id = msg.get('reason'), msg.get('request_id')
            if (type(seq) is not int or result not in RESULTS or phase not in PHASES or type(remote) is not bool
                    or type(stopped) is not bool or (reason is not None and reason not in REASONS)):
                return
        except (ValueError, TypeError, KeyError):
            return
        with self._lock:
            if seq > self._seq:
                return   # 보낸 적 없는 번호
            if self._status is None or seq > self._status['seq']:   # 늦게 온 옛 응답이 새 잠금 상태를 덮지 않게
                self._status = dict(phase=phase, remote=remote, stopped=stopped, seq=seq, received=self.now())
            if request_id is not None and self._sent.get(seq) == request_id:
                del self._sent[seq]
                self._acks.append(dict(request_id=request_id, result=result, reason=reason, phase=phase))

    def status(self):
        """마지막 응답의 실행기 상태 (0.2 초 안) 또는 None."""
        with self._lock:
            s = self._status
            return dict(s) if s is not None and 0 <= self.now() - s['received'] <= STATUS_MAX_AGE_S else None

    def take_acks(self):
        with self._lock:
            acks, self._acks = self._acks, []
            return acks

    def close(self):
        self.sock.close()
