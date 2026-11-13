"""Best-effort local observations; all filesystem/codec work stays on one daemon."""
import base64
import math
from datetime import datetime, timezone
from pathlib import Path
import queue
import re
import shutil
import threading
import time
from types import SimpleNamespace

MAX_SESSION_BYTES = 20_000_000_000
MIN_FREE_BYTES = 5_000_000_000
QUEUE_SIZE = 12


class Recorder:
    def __init__(self, env, *, status=None, root=None, disk_usage=shutil.disk_usage,
                 max_bytes=None, min_free=MIN_FREE_BYTES, queue_size=QUEUE_SIZE,
                 now=time.monotonic):
        self.enabled = env.get('FH_RECORD') != '0'
        self.status, self.root, self.disk_usage = status, root, disk_usage
        try:
            gb = float(env.get('FH_RECORD_MAX_GB', '20'))
            configured = int(gb*1_000_000_000) if math.isfinite(gb) and gb > 0 else MAX_SESSION_BYTES
        except (ValueError, TypeError, OverflowError):
            configured = MAX_SESSION_BYTES
        self.max_bytes = configured if max_bytes is None else max_bytes
        self.min_free, self.now = min_free, now
        self.next_depth = self.next_status = float('-inf')
        self.started_at = datetime.now(timezone.utc)
        self.queue = queue.Queue(maxsize=queue_size)
        self.stopped = threading.Event()
        self.thread = None
        self.path = None
        self.total_bytes = 0
        self.sequences = dict(rgb=0, lidar=0, depth=0)
        self.metadata = set()
        self.notice = ''

    def start(self):
        if self.enabled and self.thread is None and not self.stopped.is_set():
            try:
                self.thread = threading.Thread(target=self.run, daemon=True, name='go2-record')
                self.thread.start()
            except Exception:
                self.stop('기록 멈춤: 파일을 저장할 수 없습니다')

    def submit(self, kind, value, *, metadata='', captured_at=None):
        if not self.enabled or self.stopped.is_set():
            return False
        try:
            self.queue.put_nowait((kind, value, metadata, captured_at or datetime.now(timezone.utc)))
            return True
        except queue.Full:
            return False

    def rgb(self, data):
        if self.enabled and not self.stopped.is_set() and 4 <= len(data) <= 2_000_000:
            self.submit('rgb', bytes(data))

    def lidar(self, raw):
        self.submit('lidar', raw, metadata=raw[-1])

    def depth(self, message, frame, topic):
        if not self.enabled or self.stopped.is_set():
            return
        stamp = self.now()
        if stamp < self.next_depth:
            return
        # Copy only bounded sensor fields, never headers/configuration/credentials.
        if len(message.data) > 8_388_608:
            return
        names = ('format',) if hasattr(message, 'format') else ('width', 'height', 'step', 'encoding', 'is_bigendian')
        copy = SimpleNamespace(data=bytes(message.data), **{key: getattr(message, key) for key in names})
        if self.submit('depth', (copy, frame['jpeg']), metadata=topic):
            self.next_depth = stamp+1.

    def report(self, text, *, log=True):
        self.notice = text
        if log:
            try:
                print(text, flush=True)
            except Exception:
                pass
        if self.status is not None:
            try:
                self.status.update(record_notice=text)
            except Exception:
                pass

    def stop(self, text):
        if self.stopped.is_set():
            return
        self.stopped.set()
        self.report(text)

    def close(self):
        self.stopped.set()  # never join a disk/codec worker on the control loop

    def capacity(self, size):
        if self.stopped.is_set():
            return False
        if (self.total_bytes+size > self.max_bytes
                or self.disk_usage(self.path).free-size < self.min_free):
            self.stop('기록 멈춤: 저장 공간 부족')
            return False
        return True

    def write(self, path, data):
        if not self.capacity(len(data)) or self.stopped.is_set():
            return False
        with path.open('xb') as stream:
            stream.write(data)
        self.total_bytes += len(data)
        return True

    def progress(self, *, log=False):
        self.report(f'기록 저장 중: {self.path} · {self.total_bytes/1_000_000_000:.2f} GB', log=log)
        self.next_status = self.now()+1

    def prepare(self):
        root = self.root if self.root is not None else Path.home()/'FOOTHOLD-기록'
        root.mkdir(parents=True, exist_ok=True)
        name = self.started_at.astimezone().strftime('%Y%m%d-%H%M%S')
        # Reconnects in the same second must never overwrite an earlier session.
        self.path = root/name
        for suffix in range(1000):
            self.path = root/(name if suffix == 0 else f'{name}-{suffix}')
            try:
                self.path.mkdir()
                break
            except FileExistsError:
                continue
        else:
            raise OSError('recording directory unavailable')
        for channel in self.sequences:
            (self.path/channel).mkdir()
        info = f'started_at_utc: {self.started_at.isoformat()}\ndepth_topic: (waiting)\nlidar_frame: (waiting)\n'
        if self.write(self.path/'info.txt', info.encode('utf-8')):
            self.progress(log=True)

    def note(self, kind, value):
        if kind not in ('depth', 'lidar'):
            return
        # One line per distinct bounded topic/frame; no free-form exception text.
        if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9_/-]{1,256}', value):
            return
        entry = (kind, value)
        if entry in self.metadata or len(self.metadata) >= 64:
            return
        line = f'{"depth_topic" if kind == "depth" else "lidar_frame"}: {value}\n'.encode('utf-8')
        if not self.capacity(len(line)) or self.stopped.is_set():
            return
        with (self.path/'info.txt').open('ab') as stream:
            stream.write(line)
        self.total_bytes += len(line)
        self.metadata.add(entry)

    def encode(self, kind, value):
        if kind == 'rgb':
            return '.jpg', value
        if kind == 'lidar':
            from .media import points
            header, xyz = points(value, max_points=100000)
            ply = ('ply\nformat binary_little_endian 1.0\n'
                   f'element vertex {header["count"]}\n'
                   'property float x\nproperty float y\nproperty float z\nend_header\n').encode('ascii')
            return '.ply', ply+xyz
        message, jpeg = value
        if getattr(message, 'encoding', None) == '16UC1':
            import cv2
            import numpy as np
            image = np.ndarray((message.height, message.width), buffer=message.data,
                dtype=np.dtype('>u2' if message.is_bigendian else '<u2'), strides=(message.step, 2))
            ok, png = cv2.imencode('.png', image.astype(np.uint16))
            if not ok:
                raise OSError('depth encode failed')
            return '.png', png.tobytes()
        if getattr(message, 'format', '').startswith('16UC1;'):
            from foothold_agent.depth.convert import PNG
            offset = 12 if 'compressedDepth' in message.format else 0
            if message.data[offset:].startswith(PNG):
                return '.png', message.data[offset:]
        return '.jpg', base64.b64decode(jpeg, validate=True)

    def run(self):
        try:
            while not self.stopped.is_set():
                try:
                    kind, value, metadata, captured_at = self.queue.get(timeout=.1)
                except queue.Empty:
                    continue
                try:
                    if self.path is None:
                        self.prepare()
                    if self.stopped.is_set():
                        return
                    extension, data = self.encode(kind, value)
                    self.note(kind, metadata)
                    self.sequences[kind] += 1
                    stamp = captured_at.astimezone(timezone.utc).strftime('%Y%m%dT%H%M%S.%fZ')
                    self.write(self.path/kind/f'{self.sequences[kind]:08d}-{stamp}{extension}', data)
                    if not self.stopped.is_set() and self.now() >= self.next_status:
                        self.progress()
                finally:
                    self.queue.task_done()
        except Exception:
            self.stop('기록 멈춤: 파일을 저장할 수 없습니다')
        finally:
            # Release queued raw images promptly after a failure or disconnect.
            while True:
                try:
                    self.queue.get_nowait()
                    self.queue.task_done()
                except queue.Empty:
                    break
