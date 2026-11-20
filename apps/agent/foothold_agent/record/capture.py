"""Passive domain-0 readers on one explicit interface, in the recorder process only."""
from collections import Counter, deque
from contextlib import closing, ExitStack
from http.client import HTTPConnection
import json
import os
import re
import socket
import struct
import threading
import time

from ..depth.discovery import DEFAULT_TOPICS, Discovery, choose
from ..go2_direct.uslam import label
from .journal import Journal
from .metrics import Metrics
from .storage import Chunks, MAX_SAMPLE, Sample
from .topics import DEPTH, FIXED, SYSTEM, types


class Inbox:
    """Stamp under the insertion lock, before decode/disk. No waiting for capacity."""
    def __init__(self):
        self.ready = threading.Condition()
        self.items = deque()
        self.bytes = 0
        self.drops = Counter()
        self.dds_lost = Counter()

    def put(self, topic, kind, data):
        with self.ready:
            if len(self.items) >= 4096 or self.bytes + len(data) > MAX_SAMPLE:
                self.drops[topic] += 1
                return
            self.items.append(Sample(time.monotonic_ns(), time.time_ns(),
                                     dict(topic=topic, kind=kind), data, len(data)))
            self.bytes += len(data)
            self.ready.notify()

    def get(self, timeout):
        with self.ready:
            if not self.items:
                self.ready.wait(timeout)
            if self.items:
                item = self.items.popleft()
                self.bytes -= len(item.payload)
                return item

    def losses(self):
        with self.ready:
            return dict(self.drops), dict(self.dds_lost)


def camera_image(data):
    """Drop APP/COM metadata, preserving the original compressed JPEG scans."""
    raw = bytes(data)
    if not raw.startswith(b'\xff\xd8'):
        return b''
    image = bytearray(raw[:2])
    at = 2
    while at < len(raw):
        start = at
        if raw[at] != 255:
            return b''
        while at < len(raw) and raw[at] == 255:
            at += 1
        if at == len(raw):
            return b''
        marker = raw[at]
        at += 1
        if marker == 0xd9:
            return bytes(image) + b'\xff\xd9'
        length = int.from_bytes(raw[at:at+2], 'big')
        if length < 2 or at + length > len(raw):
            return b''
        at += length
        if marker == 0xda:
            # After SOS the next unescaped marker ends an entropy-coded scan.
            end = re.search(rb'\xff+(?![\xff\x00\xd0-\xd7])', memoryview(raw)[at:])
            if not end:
                return b''
            at += end.start()
        if not (0xe0 <= marker <= 0xef or marker == 0xfe):
            image.extend(raw[start:at])
    return b''


def prepare(item, video, idls):
    kind = item.meta['kind']
    if kind in ('system', 'low', 'sport'):
        # Both state IDLs consist solely of numeric fields. LowState.sn is private.
        return item
    if kind == 'camera':
        # Pinned final Response_ in XCDR1: int64 request ID + API ID,
        # int32 status, string, sequence<uint8>. Read just the length for
        # metadata-only capture. No RPC identity, text or binary is decoded.
        raw = item.payload
        if raw[:2] not in (b'\x00\x00', b'\x00\x01') or len(raw) < 32:
            return None
        order = '<' if raw[1] else '>'
        api, code, text_bytes = struct.unpack_from(order + 'qiI', raw, 12)
        if api != 1001 or code or text_bytes < 1:
            return None
        at = (28 + text_bytes + 3) & ~3
        if at + 4 > len(raw):
            return None
        item.size, = struct.unpack_from(order + 'I', raw, at)
        if at + 4 + item.size > len(raw):
            return None
        item.payload = camera_image(raw[at+4:at+4+item.size]) if video else b''
        return item
    message = idls[kind].deserialize(item.payload)
    # Free-form ROS namespaces can identify a device. Preserve known vocabulary,
    # replacing other names before any bytes touch the output directory.
    def safe(value):
        return label(value).replace('#', 'private_') if value else value
    frame = safe(message.header.frame_id)
    changed = frame != message.header.frame_id
    message.header.frame_id = frame
    if kind == 'odom':
        value = safe(message.child_frame_id)
        changed |= value != message.child_frame_id
        message.child_frame_id = value
    if kind == 'cloud':
        for field in message.fields:
            value = safe(field.name)
            changed |= value != field.name
            field.name = value
    if kind in ('image', 'compressed'):
        key = 'encoding' if kind == 'image' else 'format'
        value = getattr(message, key)
        if not re.fullmatch(r'(?:16UC1|32FC1|mono16|mono8|rgb8|bgr8)(?:;\s*(?:compressedDepth(?: png| rvl)?|png compressed)\s*)?', value):
            setattr(message, key, 'unknown')
            changed = True
    if changed:
        item.payload = message.serialize()
    return item


def selected_status(port):
    # No proxies, redirects, credentials or settings-file access. Keep only the selected row.
    conn = HTTPConnection('127.0.0.1', port, timeout=.35)
    try:
        conn.request('GET', '/status')
        response = conn.getresponse()
        if response.status != 200:
            return None
        status = json.loads(response.read(128 * 1024))
        selected = status.get('depth_selected')
        return choose(status.get('depth_topics', []), selected) if selected else None
    finally:
        conn.close()


class Live:
    def __init__(self, nic, inbox):
        if not re.fullmatch(r'[a-zA-Z0-9_.:-]{1,15}', nic) or nic not in dict(socket.if_nameindex()).values():
            raise ValueError('explicit local robot interface required')
        from cyclonedds.domain import Domain, DomainParticipant
        self.domain = Domain(0, '<CycloneDDS><Domain><General><Interfaces>'
            f'<NetworkInterface name="{nic}"/></Interfaces></General></Domain></CycloneDDS>')
        self.participant = DomainParticipant(0)
        self.inbox, self.failure = inbox, None
        self.readers = []
        self.depth = self.selected = self.discovery = None
        try:
            for topic, kind in FIXED.items():
                self.readers.append(self.reader(topic, topic, kind))
        except BaseException:
            self.close()
            raise

    def reader(self, name, stored, kind):
        from cyclonedds.core import Listener
        from cyclonedds.qos import Policy, Qos
        from cyclonedds.sub import DataReader, ddspy_take
        from cyclonedds.topic import Topic

        def receive(reader):
            try:
                # The same raw take as pinned CycloneDDS 0.10.2 DataReader.take,
                # before it deserializes or attaches discovery/participant metadata.
                rows = ddspy_take(reader._ref, 16)
                if isinstance(rows, int):
                    raise RuntimeError('DDS take failed')
                for data, info in rows:
                    if info.valid_data:
                        self.inbox.put(stored, kind, data)
            except Exception as error:
                self.failure = error

        def lost(_, status):
            with self.inbox.ready:
                self.inbox.dds_lost[stored] += status.total_count_change

        topic = Topic(self.participant, name, types()[kind])
        qos = Qos(Policy.Reliability.BestEffort, Policy.Durability.Volatile, Policy.History.KeepLast(16),
                  Policy.DataRepresentation(use_cdrv0_representation=True),
                  Policy.TypeConsistency.AllowTypeCoercion(ignore_member_names=True))
        return DataReader(self.participant, topic, qos=qos, listener=Listener(on_data_available=receive, on_sample_lost=lost))

    def select(self, args):
        if args.status_port:
            try:
                row = selected_status(args.status_port)
            except (OSError, ValueError, KeyError, TypeError):
                row = None
        elif args.depth_selected == 'none':
            row = None
        else:
            if self.discovery is None:
                self.discovery = Discovery(self.participant)
            row = choose(self.discovery.poll(), args.depth_selected)
        if row == self.selected:
            return
        if self.depth is not None:
            self.depth.set_listener(None)
            self.depth = None
        self.selected = None
        if row:
            name = row['name']
            self.depth = self.reader(name, name if name in DEFAULT_TOPICS else 'depth_selected', DEPTH[row['type']])
            self.selected = row

    def close(self):
        if self.discovery:
            self.discovery.close()
        for reader in self.readers + ([self.depth] if self.depth is not None else []):
            reader.set_listener(None)
        self.depth = self.discovery = None
        self.readers.clear()
        self.participant = self.domain = None


def capture(args, stop, *, live_factory=Live, idls=None):
    os.umask(0o077)
    metrics = Metrics(args.agent_pid, args.nic)
    inbox = Inbox()
    with closing(Chunks(args.out, int(args.max_gb * 10**9), int(args.chunk_mb * 10**6),
                        args.chunk_seconds)) as chunks:
        codecs = types() if idls is None else idls
        monitor_done = threading.Event()
        failures = []
        journal = Journal()

        def monitor():
            try:
                due = time.monotonic()
                while True:
                    final = monitor_done.is_set()
                    events = journal.poll(metrics.pid, final=final)
                    data = metrics.sample()
                    data['locks'] = events
                    data['lock_journal'] = journal.state
                    data['queue_drops'], data['dds_lost'] = inbox.losses()
                    inbox.put(SYSTEM, 'system', (json.dumps(data, separators=(',', ':')) + '\n').encode())
                    if final:
                        return
                    live.select(args)
                    due = max(due + 1, time.monotonic())
                    monitor_done.wait(max(0, due - time.monotonic()))
            except Exception as error:
                failures.append(error)
                stop.set()

        def write(item):
            item = prepare(item, args.video, codecs)
            if item is not None:
                chunks.append(item)

        with ExitStack() as stack:
            live = stack.enter_context(closing(live_factory(args.nic, inbox)))
            thread = threading.Thread(target=monitor, name='recorder-status')
            thread.start()
            stack.callback(thread.join)
            stack.callback(monitor_done.set)
            while not stop.is_set():
                if live.failure is not None:
                    raise RuntimeError('DDS receiver stopped') from live.failure
                item = inbox.get(.2)
                if item:
                    write(item)
        while (item := inbox.get(0)) is not None:
            write(item)
        if failures:
            raise failures[0]
