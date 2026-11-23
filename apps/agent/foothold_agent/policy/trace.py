"""50 Hz 실기 기록 (팀장 11/22 결정 9 · lead 11/23 09:39 전달): START 가 켜진 동안 내내, 또는 순정 걷기 읽기 전용 기록.

한 줄 JSON 하나가 한 틱. 파일은 켤 때마다 새로 (`<이름>-<시각>-NNN.jsonl`), 한 파일 MAX_FILE_BYTES 넘으면 다음 번호.
폴더 전체가 max_total_bytes 를 넘으면 더 쓰지 않고 한 번 알린다 (지우지 않음 · 디스크 지킴).
"""
from __future__ import annotations

import json
import time
from pathlib import Path

MAX_FILE_BYTES = 50_000_000
MAX_TOTAL_BYTES = 2_000_000_000


def r4(v):
    return None if v is None else [round(float(x), 4) for x in v]


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
