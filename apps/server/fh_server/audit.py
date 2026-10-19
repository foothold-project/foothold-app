"""Robot-owned bounded histories; one fair consumer, no reconnect-owned backlog."""
import asyncio
from collections import OrderedDict, deque
from dataclasses import dataclass, field
import pickle

from .history import History, HistoryPending
from .leases import Effect
from .models import now

SAFETY_CODES = {'SERVER_LINK_LOST', 'LINK_LOSS_TIMEOUT', 'EXECUTOR_STALLED',
                'PROTOCOL_MISMATCH', 'TRANSPORT_BACKPRESSURE', 'STOP_GEN_EXHAUSTED',
                'LEASE_INVALID', 'BRIDGE_STATE_INVALID', 'HISTORY_STORAGE_BLOCKED'}
class AuditQueue(asyncio.Queue):
    """One runtime FIFO: evict ordinary history first, spill safety-only excess.

    No reconnect can create another backlog. A popped record remains owned by
    the single auditor until INSERT succeeds (independent of socket lifetime).
    """
    @staticmethod
    def urgent(effect):
        body = effect.body
        return (body.get('op') in ('STOP', 'STOP_CONFIRM_FAILED', 'TAKE', 'RELEASE',
                'REQUEST', 'ACCEPT', 'DECLINE', 'TIMEOUT', 'EXPIRE',
                'RUN_PAUSE_TAKEOVER', 'AUDIT_DROPPED', 'AGENT_CONNECTED',
                'AGENT_DISCONNECTED', 'AGENT_PROTOCOL_MISMATCH', 'AGENT_BACKLOG_OVERFLOW', 'HISTORY_STORAGE_BLOCKED')
                or body.get('code') in SAFETY_CODES
                or body.get('severity', '').upper() in ('ERROR', 'CRITICAL', 'BAD'))

    def _init(self, maxsize):
        self._queue = History(maxsize, self.urgent, lambda e: e.body.get('_count', 1))

    def put_nowait(self, effect):
        before = len(self._queue)
        if not self._queue.append(effect):
            raise asyncio.QueueFull
        evicted = before + 1 - len(self._queue)
        self._unfinished_tasks += 1 - evicted
        self._finished.clear()
        self._wakeup_next(self._getters)

    async def put(self, effect):
        self.put_nowait(effect)

    async def get(self):
        while True:
            try:
                return await super().get()
            except HistoryPending:
                await self._queue.readable()

    def _get(self):
        return self._queue.pop()

    def take_dropped(self):
        count, self._queue.dropped = self._queue.dropped, 0
        return count


class SourceArchiveFull(Exception):
    pass


@dataclass
class Channel:
    queue: AuditQueue
    count: int = 0
    size: int = 0
    sequence: int = 0
    tokens: float = 512
    token_at: float = 0
    blocked: bool = False
    retry_at: float = 0
    sizes: dict = field(default_factory=dict)
    staged: deque = field(default_factory=deque)
    flushing: bool = False
    inspecting: bool = False
    dropped: int = 0


class HistoryView:
    """Explicit diagnostics over the bounded per-robot queues, never file I/O."""
    io = None
    def __init__(self, parent):
        self.parent = parent
    @property
    def memory(self):
        return tuple(item for c in self.parent.channels.values() for item in c.queue._queue.memory)
    def __iter__(self):
        return iter([e for c in self.parent.channels.values() for e in c.queue._queue])
    async def snapshot(self):
        records = []
        for c in tuple(self.parent.channels.values()):
            c.inspecting = True
            staged = [slot[0] for slot in c.staged]
            try:
                records.extend(await c.queue._queue.snapshot())
                records.extend(staged)
            finally:
                c.inspecting = False
                self.parent.flush(c)
        return records
    async def writable(self):
        return  # a robot's stalled storage must never pause another robot
    def close(self):
        for c in self.parent.channels.values():
            c.queue._queue.close()


class FairAuditQueue:
    RAM_RECORDS = 64
    MAX_RECORDS = 512
    MAX_BYTES = 2 * 1024 * 1024
    RESERVE_RECORDS = 32
    RESERVE_BYTES = 32 * 1024
    RESERVED = {'EXPIRE', 'AGENT_DISCONNECTED', 'HISTORY_STORAGE_BLOCKED', 'AUDIT_DROPPED'}

    def __init__(self, owner):
        self.owner = owner
        self.channels = OrderedDict()
        self.changed = asyncio.Event()
        self.inflight = None
        self._queue = HistoryView(self)
        self.dropped = 0

    @property
    def maxsize(self):
        return self.MAX_RECORDS * max(1, len(self.channels))
    @property
    def _unfinished_tasks(self):
        return sum(c.count for c in self.channels.values())
    def channel(self, rid):
        if rid not in self.channels:
            c = Channel(AuditQueue(self.RAM_RECORDS), token_at=self.owner.clock())
            self.channels[rid] = c
            c.queue._queue.background(
                lambda error, rid=rid: self.owner.block_archive_source(rid, type(error).__name__),
                lambda rid=rid: self.owner.block_archive_source(rid, 'BACKPRESSURE'),
                on_ready=lambda c=c: self.resume(c))
        return self.channels[rid]
    def resume(self, c):
        self.flush(c)
        self.changed.set()

    def admission_open(self, rid):
        c = self.channels.get(rid)
        return c is None or (not c.blocked and c.count < self.MAX_RECORDS - self.RESERVE_RECORDS
                             and c.size < self.MAX_BYTES - self.RESERVE_BYTES)
    def event_allowed(self, rid):
        c = self.channel(rid)
        at = self.owner.clock()
        c.tokens = min(512, c.tokens + max(0, at - c.token_at) * 100)
        c.token_at = at
        if c.tokens < 1 or not self.admission_open(rid):
            return False
        c.tokens -= 1
        return True
    def reconnect_allowed(self, rid):
        c = self.channels.get(rid)
        if c is None or not c.blocked:
            return True
        io = c.queue._queue.io
        if (self.owner.clock() >= c.retry_at and c.count <= self.RAM_RECORDS and c.size <= 256 * 1024
                and not io.pending and io.error is None):
            c.blocked = False
            return True  # never restores a lease/unlock/motion
        return False
    def reserve(self, effect, *, ready=False):
        c = self.channel(effect.robot)
        reserved = effect.body.get('op') in self.RESERVED
        limit = self.MAX_RECORDS if reserved else self.MAX_RECORDS - self.RESERVE_RECORDS
        byte_limit = self.MAX_BYTES if reserved else self.MAX_BYTES - self.RESERVE_BYTES
        stamp = effect.body.get('at') or now()
        body = {**effect.body, 'at': stamp, 'data': {**effect.body.get('data', {}),
                'server_received_at': stamp.isoformat(), 'robot_sequence': c.sequence + 1}}
        effect = Effect(effect.target, effect.robot, body)
        size = len(pickle.dumps(effect))
        if (c.blocked and not reserved) or c.count >= limit or c.size + size > byte_limit:
            raise SourceArchiveFull(effect.robot)
        c.sequence += 1
        c.count += 1
        c.size += size
        c.sizes[c.sequence] = size
        slot = [effect, ready]
        c.staged.append(slot)
        if ready:
            self.flush(c)
        self.changed.set()
        return c, slot

    def flush(self, c):
        if c.flushing or c.inspecting:
            return
        c.flushing = True
        try:
            while c.staged and c.staged[0][1]:
                io = c.queue._queue.io
                if io.error is not None or io.pending >= io.HIGH_WATER:
                    break  # accepted records stay bounded in this channel's stage
                effect, _ = c.staged[0]
                try:
                    c.queue.put_nowait(effect)
                except asyncio.QueueFull:
                    self.release(c, effect)
                else:
                    evicted = c.queue._queue.last_evicted
                    if evicted is not None:
                        self.release(c, evicted)
                dropped = c.queue.take_dropped()
                self.dropped += dropped
                c.dropped += dropped
                c.staged.popleft()
        finally:
            c.flushing = False
        self.changed.set()

    def release(self, c, effect):
        size = c.sizes.pop(effect.body['data']['robot_sequence'])
        c.count -= 1
        c.size -= size

    def commit(self, reservation):
        c, slot = reservation
        slot[1] = True
        self.flush(c)

    def put_nowait(self, effect):
        self.reserve(effect, ready=True)

    async def put(self, effect):
        self.put_nowait(effect)
    def flush_drop_summaries(self):
        for rid, c in tuple(self.channels.items()):
            if not c.dropped:
                continue
            count, c.dropped = c.dropped, 0
            try:
                self.put_nowait(Effect('audit', rid, {'op': 'AUDIT_DROPPED', 'at': now(),
                    '_count': count, 'data': {'count': count, 'source': 'ROBOT_HISTORY'}}))
            except SourceArchiveFull:
                c.dropped += count  # keep the summary until reserved room recovers

    def take_dropped(self):
        count, self.dropped = self.dropped, 0
        return count
    def qsize(self):
        return sum(c.queue.qsize() + len(c.staged) for c in self.channels.values())
    def empty(self):
        return not self.qsize()
    def full(self):
        return False  # source limits never set the organization-wide busy gate
    def get_nowait(self):
        if self.inflight is not None:
            return self.inflight[1]
        for rid, c in tuple(self.channels.items()):
            if c.queue.empty():
                continue
            try:
                effect = c.queue.get_nowait()
            except HistoryPending:
                continue
            except Exception as error:
                self.owner.block_archive_source(rid, type(error).__name__)
                continue
            self.channels.move_to_end(rid)
            self.inflight = c, effect
            return effect
        raise asyncio.QueueEmpty
    async def get(self):
        while True:
            self.changed.clear()
            try:
                return self.get_nowait()
            except asyncio.QueueEmpty:
                await self.changed.wait()
    def task_done(self):
        c, effect = self.inflight
        self.inflight = None
        self.release(c, effect)
        c.queue.task_done()
        self.changed.set()
    async def join(self):
        # Seed once: repeated producer wake-ups must not make summaries evict
        # the entire ordinary backlog. The normal auditor/ticker flush follows.
        self.flush_drop_summaries()
        while True:
            if not self._unfinished_tasks:
                return
            self.changed.clear()
            if self._unfinished_tasks:
                await self.changed.wait()
