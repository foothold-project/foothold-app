"""Versioned frames. Chunk names are exclusively owned by one capture session."""
from collections import deque
from dataclasses import dataclass
import json
from pathlib import Path
import struct
import warnings

MAGIC = b'FHREC01\n'
HEADER = struct.Struct('!QQIII')  # monotonic ns, Unix ns, metadata bytes, stored bytes, input bytes
MAX_SAMPLE = 256 * 1024**2
PATTERN = 'chunk-' + '[0-9]' * 8 + '.fhr'


@dataclass
class Sample:
    mono: int
    wall: int
    meta: dict
    payload: bytes
    size: int


class Chunks:
    def __init__(self, root, limit, piece, seconds):
        self.root = Path(root)
        self.root.mkdir(mode=0o700, parents=True, exist_ok=True)
        if self.root.is_symlink() or any(self.root.iterdir()):
            raise ValueError('use an empty, private capture directory')
        self.limit, self.piece, self.period = limit, min(piece, limit), seconds * 10**9
        self.files = deque()
        self.total = self.index = self.current = 0
        self.stream = None

    def append(self, sample):
        meta = json.dumps(sample.meta, separators=(',', ':')).encode()
        length = HEADER.size + len(meta) + len(sample.payload)
        if (len(meta) > 4096 or max(sample.size, len(sample.payload)) > MAX_SAMPLE
                or length + len(MAGIC) > self.limit):
            raise ValueError('one frame exceeds the capture limit')
        rotate = (not self.stream or self.current + length > self.piece
                  or sample.mono - self.start >= self.period)
        if rotate:
            self.close()
        needed = length + (len(MAGIC) if rotate else 0)
        while self.total + needed > self.limit:
            path, size = self.files.popleft()
            path.unlink()
            self.total -= size
        if rotate:
            self.index += 1
            path = self.root / f'chunk-{self.index:08}.fhr'
            self.stream = path.open('xb')
            self.stream.write(MAGIC)
            self.start, self.current, self.path = sample.mono, len(MAGIC), path
            self.total += len(MAGIC)
        self.stream.write(HEADER.pack(sample.mono, sample.wall, len(meta), len(sample.payload), sample.size))
        self.stream.write(meta)
        self.stream.write(sample.payload)
        self.stream.flush()
        self.current += length
        self.total += length

    def close(self):
        if self.stream:
            self.stream.close()
            self.files.append((self.path, self.current))
            self.stream = None


def samples(root, *, headers_only=False):
    paths = sorted(Path(root).glob(PATTERN))
    if not paths:
        raise ValueError('no capture chunks')
    for path in paths:
        with path.open('rb') as stream:
            end = path.stat().st_size
            if stream.read(len(MAGIC)) != MAGIC:
                if path == paths[-1] and end < len(MAGIC):
                    warnings.warn('incomplete last chunk header')
                    return
                raise ValueError('invalid capture header')
            while raw := stream.read(HEADER.size):
                if len(raw) == HEADER.size:
                    mono, wall, nmeta, size, original = HEADER.unpack(raw)
                    if nmeta > 4096 or max(size, original) > MAX_SAMPLE:
                        raise ValueError('invalid capture frame length')
                    if stream.tell() + nmeta + size <= end:
                        meta = json.loads(stream.read(nmeta))
                        if headers_only and meta['kind'] != 'system':
                            stream.seek(size, 1)
                            payload = b''
                        else:
                            payload = stream.read(size)
                        yield Sample(mono, wall, meta, payload, original)
                        continue
                if path != paths[-1]:
                    raise ValueError('truncated interior capture chunk')
                warnings.warn('incomplete final frame after interrupted capture')
                break
