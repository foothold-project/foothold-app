"""START C++ 실행기와 같은 기기 안 (127.0.0.1 UDP) 앱 입력 길. 규약: runner_cpp/APP-MOVES.md

보내는 것: 키 한 번 {seq, key, action, request_id} · 속도 {seq, vx, vy, wz} (연결 프로그램 출력 주기마다, 0 포함).
받는 것: 실행기 응답 {seq, result, reason?, request_id?, phase, remote}. 응답이 없으면 키 요청은 RUNNER_SENT 그대로.
seq 는 CLOCK_MONOTONIC ns (같은 기기라 실행기가 0.5 초 넘은 묶음을 버린다).
"""
import json
import os
import socket
import threading
import time
from collections import OrderedDict

PORT_ENV = 'FH_START_MOVE_PORT'
STATUS_MAX_AGE_S = .20
MAX_BYTES = 512
RESULTS = frozenset({'STARTED', 'IGNORED', 'ACCEPTED'})
PHASES = frozenset({'high', 'acquiring', 'standing_up', 'policy', 'sitting', 'dog_sitting', 'moving',
                    'damping', 'returning', 'recovering', 'unknown'})
REASONS = frozenset({'phase', 'remote', 'busy', 'not_stopped'})


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
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.sock.bind(('127.0.0.1', 0))
        self.sock.setblocking(False)

    @classmethod
    def configured(cls, env=os.environ, **kw):
        port = port_from(env)
        return None if port is None else cls(port, **kw)

    def _send(self, body):
        with self._lock:
            self._seq = max(self._seq + 1, time.monotonic_ns())
            body = dict(seq=self._seq, **body)
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
            reason, request_id = msg.get('reason'), msg.get('request_id')
            if (type(seq) is not int or result not in RESULTS or phase not in PHASES or type(remote) is not bool
                    or (reason is not None and reason not in REASONS)):
                return
        except (ValueError, TypeError, KeyError):
            return
        with self._lock:
            if seq > self._seq:
                return   # 보낸 적 없는 번호
            self._status = dict(phase=phase, remote=remote, received=self.now())
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
