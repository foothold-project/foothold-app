"""50 Hz 실기 기록 (팀장 11/22 결정 9 · lead 11/23 09:39 전달): START 가 켜진 동안 내내, 또는 순정 걷기 읽기 전용 기록.

한 줄 JSON 하나가 한 틱. 파일은 켤 때마다 새로 (`<이름>-<시각>-NNN.jsonl`), 한 파일 MAX_FILE_BYTES 넘으면 다음 번호.
폴더 전체가 max_total_bytes 를 넘으면 더 쓰지 않고 한 번 알린다 (지우지 않음 · 디스크 지킴).
"""
from __future__ import annotations

import json
import os
import queue
import threading
import time
from pathlib import Path

MAX_FILE_BYTES = 50_000_000
MAX_TOTAL_BYTES = 2_000_000_000


def r4(v):
    return None if v is None else [round(float(x), 4) for x in v]


# 실행기가 저수준 (START) 인 동안만 있는 파일. 순정 기록 (factory_record) 은 이 파일이 있으면 DDS 구독까지 끄고 쉰다
# (팀장 11/23 14:43: START 중 순정 기록 76 % CPU · 정책 주기 0.02 초가 85 번 0.03 초 넘음 → 인터넷 없이 Jetson 안에서 바로 끄고 켬).
START_FLAG = Path('/tmp/foothold-start-active')


class TraceWriter:
    def __init__(self, folder: Path, name: str, *, max_total_bytes=MAX_TOTAL_BYTES, max_file_bytes=MAX_FILE_BYTES, on_full=lambda: None):
        self.folder, self.name = Path(folder), name
        self.folder.mkdir(parents=True, exist_ok=True)
        self.max_total, self.max_file, self.on_full = max_total_bytes, max_file_bytes, on_full
        self.stem = f'{name}-{time.strftime("%Y%m%d-%H%M%S")}'
        self.index, self.fh, self.size, self.full, self.rows = 0, None, 0, False, 0
        self.total = sum(p.stat().st_size for p in self.folder.glob('*.jsonl'))

    @property
    def path(self):
        return self.folder / f'{self.stem}-{self.index:03d}.jsonl'

    def write(self, row: dict):
        if self.full:
            return False
        line = (json.dumps(row, separators=(',', ':'), ensure_ascii=False) + '\n').encode()
        if self.total + len(line) > self.max_total:
            self.full = True
            self.close()
            self.on_full()
            return False
        if self.fh is None or self.size + len(line) > self.max_file:
            if self.fh is not None:
                self.fh.close()
                self.index += 1
            self.fh, self.size = open(self.path, 'ab'), 0
        self.fh.write(line)
        self.size += len(line)
        self.total += len(line)
        self.rows += 1
        return True

    def flush(self):
        if self.fh is not None:
            self.fh.flush()

    def close(self):
        if self.fh is not None:
            self.fh.close()
            self.fh = None


class ThreadedTraceWriter:
    """TraceWriter 를 별도 스레드에서 쓴다 (팀장 11/23 16:06: 기록 쓰기를 제어 반복에서 뺌). 제어 반복은 줄을 큐에 넣기만 한다.
    TraceWriter 와 같은 꼴 (write · flush · close · rows · path)."""
    def __init__(self, *args, **kw):
        self.inner = TraceWriter(*args, **kw)
        self.q = queue.SimpleQueue()
        self.th = threading.Thread(target=self._run, name='trace-writer', daemon=True)
        self.th.start()

    def _run(self):
        n = 0
        while True:
            row = self.q.get()
            if row is None:
                break
            if row == 'flush':
                self.inner.flush()
                continue
            self.inner.write(row)
            n += 1
            if n % 50 == 0:
                self.inner.flush()
        self.inner.close()

    def write(self, row: dict):
        self.q.put(row)
        return True

    def flush(self):
        self.q.put('flush')

    def close(self):
        if self.th.is_alive():
            self.q.put(None)
            self.th.join(timeout=5.)

    @property
    def rows(self):
        return self.inner.rows

    @property
    def path(self):
        return self.inner.path


def pin_cpus(cpus):
    """가능한 코어만 골라 이 프로세스를 묶는다 (MAXN 8 코어면 실행기 4~7 · 나머지 0~3). 없는 코어면 그대로 둠."""
    try:
        online = os.sched_getaffinity(0) | set(range(os.cpu_count() or 0))
        want = {c for c in cpus if c in online}
        avail = set()
        for c in want:
            try:
                if open(f'/sys/devices/system/cpu/cpu{c}/online').read().strip() != '1':
                    continue
            except OSError:
                pass   # cpu0 은 online 파일이 없을 수 있음
            avail.add(c)
        if avail and avail != os.sched_getaffinity(0):
            os.sched_setaffinity(0, avail)
        return sorted(os.sched_getaffinity(0))
    except (AttributeError, OSError):
        return None
