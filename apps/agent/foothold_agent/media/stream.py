"""Latest-only media mailboxes independent of control queues, locks and journal."""
import asyncio
from datetime import datetime, timezone
import importlib.util
import multiprocessing
import time

from .mailbox import LatestSlot
from .processing import MAX_CLOUD_BYTES, MAX_INPUT_POINTS, worker

CHANNELS = ('rgb', 'external', 'lidar')


class Media:
    def __init__(self, robot, *, rgb_enabled=True, external_source=None, now=time.monotonic):
        if external_source not in (None, 'gazebo_external'):
            raise ValueError('unsupported external media source')
        self.robot, self.now = robot, now
        self.binding = None
        self.generation = 0
        self.queues = {channel: set() for channel in CHANNELS}
        self.seq = dict.fromkeys(CHANNELS, 0)
        self.latest = {}
        self.next_send = dict.fromkeys(CHANNELS, float('-inf'))
        self.next_submit = dict.fromkeys(CHANNELS, float('-inf'))
        self.processes = {}
        self.ctx = multiprocessing.get_context('spawn')
        self.reasons = {} if external_source else {'external': 'External camera source is not connected'}
        if not rgb_enabled:
            self.reasons['rgb'] = 'RGB source is disabled'
        if importlib.util.find_spec('PIL') is None:
            for channel in ('rgb', 'external'):
                self.reasons.setdefault(channel, 'JPEG decoder (Pillow) is unavailable')
        self.closed = False

    def start(self):
        for channel in CHANNELS:
            if channel in self.reasons:
                continue
            incoming, outgoing, closing = LatestSlot(self.ctx, MAX_CLOUD_BYTES + 8192), LatestSlot(self.ctx, 100_000), self.ctx.Event()
            process = self.ctx.Process(target=worker, args=(channel, incoming, outgoing, closing),
                                       name='media-' + channel, daemon=True)
            process.start()
            self.processes[channel] = process, incoming, outgoing, closing

    def bind(self, binding):
        if binding != self.binding:
            self.generation += 1
            self.binding = binding
            self.latest.clear()
            for channel in CHANNELS:
                for queue in self.queues[channel]:
                    while not queue.empty():
                        queue.get_nowait()
            # In-flight conversion carries the previous binding and is discarded.

    def available(self, channel):
        entry = self.processes.get(channel)
        return (self.binding is not None and channel not in self.reasons
                and entry is not None and entry[0].is_alive() and not self.closed)

    def reason(self, channel):
        return self.reasons.get(channel, 'Media binding or worker is unavailable')

    def submit(self, channel, raw, *, captured_at=None, expected_generation=None):
        received = self.now()
        binding, generation = self.binding, self.generation
        if expected_generation is not None and generation != expected_generation:
            return False
        if not self.available(channel) or received < self.next_submit[channel]:
            time.sleep(0)  # overspeed ROS producer must yield the GIL
            return False
        if channel in ('rgb', 'external'):
            if len(raw) > 65536:
                return False
            raw = bytes(raw)
        # Raw cloud snapshots were bounded before copying in submit_cloud().
        captured = captured_at or datetime.now(timezone.utc).isoformat()
        item = (dict(binding), generation, received, captured, raw)
        incoming = self.processes[channel][1]
        if not incoming.put(item):
            return False
        self.next_submit[channel] = received + (.5 if channel == 'lidar' else .2)
        return True

    def submit_cloud(self, message, *, captured_at=None, expected_generation=None):
        try:
            if (len(message.data) > MAX_CLOUD_BYTES or len(message.fields) > 32
                    or message.width * message.height > MAX_INPUT_POINTS):
                return False
            if not self.available('lidar') or self.now() < self.next_submit['lidar']:
                time.sleep(0)
                return False
            raw = (bytes(message.data), message.width, message.height, message.point_step,
                   message.row_step, message.is_bigendian,
                   tuple((f.name, f.offset, f.datatype, f.count) for f in message.fields),
                   message.header.frame_id)
            return self.submit('lidar', raw, captured_at=captured_at, expected_generation=expected_generation)
        except (AttributeError, TypeError, ValueError):
            return False

    @staticmethod
    def _put(queue, item):
        if queue.full():
            queue.get_nowait()
        queue.put_nowait(item)

    def status(self, channel):
        if self.binding is None:
            return None
        return {**self.binding, 't': 'media.status', 'version': 'media/1', 'channel': channel,
                'state': ('UNAVAILABLE' if not self.available(channel) else
                          'NO_POINTS' if channel == 'lidar' else 'NO_VIDEO'),
                'reason': self.reason(channel) if not self.available(channel) else 'No fresh source sample within 1 second'}

    def subscribe(self, channel):
        queue = asyncio.Queue(maxsize=1)
        self.queues[channel].add(queue)
        status = self.status(channel)
        if status is not None:
            self._put(queue, (self.now(), status, None))
        return queue

    def unsubscribe(self, channel, queue):
        self.queues[channel].discard(queue)

    def sample(self):
        now = self.now()
        for channel in CHANNELS:
            entry = self.processes.get(channel)
            if entry:
                result = entry[2].take()
                if result is not None:
                    generation, received, header, payload = result
                    if (generation == self.generation and self.binding is not None and
                            all(header[key] == value for key, value in self.binding.items())
                            and 0 <= now - received <= 1):
                        self.latest[channel] = received, header, payload
            latest = self.latest.get(channel)
            if latest is not None and not 0 <= now - latest[0] <= 1:
                self.latest.pop(channel, None)
                latest = None
            if now < self.next_send[channel]:
                continue
            self.next_send[channel] = now + (.5 if channel == 'lidar' else .2)
            if latest is not None:
                # Each converted frame is published at most once; seq is global per channel.
                received, header, payload = latest
                if '_sent' in header:
                    continue
                self.seq[channel] += 1
                header = {**header, 'seq': self.seq[channel]}
                latest[1]['_sent'] = True
                item = received, header, payload
            else:
                status = self.status(channel)
                if status is None:
                    continue
                item = now, status, None
            for queue in tuple(self.queues[channel]):
                self._put(queue, item)

    async def run(self):
        while True:
            self.sample()
            await asyncio.sleep(.05)

    def close(self):
        self.closed = True
        self.bind(None)
        for process, incoming, outgoing, closing in self.processes.values():
            closing.set()
        for process, incoming, outgoing, closing in self.processes.values():
            process.join(timeout=.3)
            if process.is_alive():
                process.terminate()  # only this owned conversion child
                process.join(timeout=.3)
        self.processes.clear()
