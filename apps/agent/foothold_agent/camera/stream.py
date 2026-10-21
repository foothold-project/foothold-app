"""JPEG pass-through: no codec/ROS imports, wall-clock 5 Hz and one pending image."""
import asyncio
import base64
import re
import threading
import time

MAX_BYTES = 65536
MAX_WIDTH, MAX_HEIGHT = 640, 360
NON_FILL = re.compile(b"[^\xff]")


def jpeg_size(data):
    if not isinstance(data, bytes) or not 4 <= len(data) <= MAX_BYTES or not data.startswith(b'\xff\xd8') or not data.endswith(b'\xff\xd9'):
        raise ValueError('invalid JPEG envelope')
    offset = 2
    while offset + 4 <= len(data):
        if data[offset] != 255:
            raise ValueError('invalid JPEG marker')
        found = NON_FILL.search(data, offset)
        if found is None:
            break
        offset = found.start()
        marker = data[offset]
        offset += 1
        if marker in (0xD8, 0xD9, 0xDA):
            break
        length = int.from_bytes(data[offset:offset + 2], 'big')
        if length < 2 or offset + length > len(data):
            raise ValueError('invalid JPEG segment')
        if marker in (0xC0, 0xC1, 0xC2):
            if length < 8:
                break
            height = int.from_bytes(data[offset + 3:offset + 5], 'big')
            width = int.from_bytes(data[offset + 5:offset + 7], 'big')
            if not 1 <= width <= MAX_WIDTH or not 1 <= height <= MAX_HEIGHT:
                raise ValueError('JPEG dimensions exceed bounds')
            return width, height
        offset += length
    raise ValueError('JPEG dimensions missing')


class Camera:
    def __init__(self, robot, *, now=time.monotonic):
        self.robot, self.now = robot, now
        self.lock = threading.Lock()
        self.pending = None
        self.queues = set()
        self.latest = None
        self.seq = 0
        self.received = None
        self.closed = False
        self.next_submit = float("-inf")

    def submit(self, data, format='jpeg'):
        # Called in the ROS thread. One bounded copy, no safety/session access.
        received = self.now()
        with self.lock:
            throttled = received < self.next_submit
            if not throttled:
                self.next_submit = received + .2
        if throttled:
            # An overspeed producer must release the GIL, rather than spin on
            # rejected frames and starve the independent control/watchdog loop.
            # No lock, consumer, queue or network operation is waited on.
            time.sleep(0)
            return False
        if self.closed or format.lower() not in ('jpeg', 'jpg') or len(data) > MAX_BYTES:
            return False
        data = bytes(data)
        try:
            width, height = jpeg_size(data)
        except ValueError:
            return False
        with self.lock:
            self.pending = (data, width, height, received)
        return True

    def subscribe(self):
        queue = asyncio.Queue(maxsize=1)
        self.queues.add(queue)
        self._put(queue, self.status())
        return queue

    def unsubscribe(self, queue):
        self.queues.discard(queue)

    @staticmethod
    def _put(queue, message):
        if queue.full():
            queue.get_nowait()
        queue.put_nowait(message)

    def status(self):
        return dict(t='camera.status', robot=self.robot, state='NO_VIDEO')

    def sample(self):
        with self.lock:
            pending, self.pending = self.pending, None
        if pending is not None:
            data, width, height, received = pending
            if 0 <= self.now() - received <= 1:
                self.seq += 1
                self.received = received
                self.latest = dict(t='camera.frame', robot=self.robot, seq=self.seq,
                    mime='image/jpeg', width=width, height=height, jpeg=base64.b64encode(data).decode('ascii'))
                for queue in tuple(self.queues):
                    self._put(queue, self.latest)
                return
        if self.received is None or self.now() - self.received > 1:
            self.latest = None
            for queue in tuple(self.queues):
                self._put(queue, self.status())

    async def run(self):
        try:
            while True:
                self.sample()
                await asyncio.sleep(.2)
        finally:
            self.closed = True
            with self.lock:
                self.pending = None
            self.latest = None
            self.queues.clear()
