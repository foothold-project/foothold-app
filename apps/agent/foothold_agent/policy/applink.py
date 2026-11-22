"""앱 명령 받기: 같은 Jetson 의 연결 프로그램이 loopback UDP 로 넘기는 속도 · 모드 (팀장 11/22 15:39 앱 연결 B 단계).

한 줄 JSON 하나가 한 묶음: {"seq": 7, "vx": 0.3, "vy": 0.0, "wz": 0.0, "mode": "start"}
  seq   늘어나는 정수. 같거나 작으면 버린다 (순서 뒤바뀜 · 재전송)
  vx vy wz  m/s · rad/s. 없으면 0. 실행기가 학습 상한으로 자른다
  mode  start · classic · free_walk · sit · damp 중 하나 (없으면 속도만)
127.0.0.1 에만 묶는다. 리모컨이 늘 우선이고, 속도는 0.3 초 안에 새로 오지 않으면 버린다. 실기 미확인 (수행 전).
"""
from __future__ import annotations

import json
import math
import socket
import time

APP_TIMEOUT_S = .3
MAX_BYTES = 512
MODES = frozenset({'start', 'classic', 'free_walk', 'sit', 'damp'})


class AppLink:
    def __init__(self, port: int | None = None, *, clock=time.monotonic):
        self.clock = clock
        self.sock = None
        if port is not None:
            self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            self.sock.bind(('127.0.0.1', port))
            self.sock.setblocking(False)
        self.seq, self.vel, self.stamp, self.pending = -1, None, 0., None
        self.rejected = 0

    @property
    def port(self):
        return self.sock.getsockname()[1] if self.sock else None

    def feed(self, raw: bytes) -> bool:
        """한 묶음을 읽는다. 틀린 묶음은 세기만 하고 버린다 (이전 명령은 그대로 시간이 지나 사라짐)."""
        try:
            if len(raw) > MAX_BYTES:
                raise ValueError('too large')
            msg = json.loads(raw)
            seq = msg['seq']
            if not isinstance(seq, int) or isinstance(seq, bool) or seq <= self.seq:
                raise ValueError('seq')
            vel = tuple(float(msg.get(k, 0.)) for k in ('vx', 'vy', 'wz'))
            if not all(math.isfinite(v) for v in vel):
                raise ValueError('not finite')
            mode = msg.get('mode')
            if mode is not None and mode not in MODES:
                raise ValueError('mode')
        except (ValueError, TypeError, KeyError, AttributeError):
            self.rejected += 1
            return False
        self.seq, self.vel, self.stamp = seq, vel, self.clock()
        if mode is not None:
            self.pending = mode
        return True

    def poll(self):
        while self.sock is not None:
            try:
                raw, peer = self.sock.recvfrom(MAX_BYTES + 1)
            except BlockingIOError:
                return
            if peer[0] == '127.0.0.1':
                self.feed(raw)

    def velocity(self):
        """새 속도 (vx, vy, wz) 또는 None (없음 · 0.3 초 넘게 끊김)."""
        if self.vel is None or self.clock() - self.stamp > APP_TIMEOUT_S:
            return None
        return self.vel

    def take_mode(self):
        mode, self.pending = self.pending, None
        return mode

    def close(self):
        if self.sock is not None:
            self.sock.close()
            self.sock = None
