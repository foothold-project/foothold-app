"""Drive the production setup session with scheduled DDS input and memory-only robot ports."""
import asyncio
from collections import Counter
import os
import tempfile
import threading
import time
from types import SimpleNamespace

from ..depth.discovery import COMPRESSED, IMAGE
from ..depth.source import Publisher as DepthPublisher, Source as DepthSource
from ..go2_direct.actions import ACTIONS
from ..go2_direct.media import Publisher, Source
from ..go2_direct.record import Recorder
from ..link.client import Client
from ..mapping import runtime as mapping
from ..mapping.inputs import Handle, LOW_TOPIC, ObservationInputs, RAW_TOPIC, SPORT_TOPIC
from ..setup.runtime import Inputs, run
from ..setup.storage import Credentials
from ..setup.view import Status
from .storage import samples
from .topics import CAMERA, DEPTH, FIXED, SYSTEM, types

# Preserve a serial change/freshness gap, without exposing a field identifier
# to the local server or requiring physical MAC confirmation.
FIRST_SN = (1000, 1)
LOCAL_ROBOT = '00000000-0000-4000-8000-000000000001'


class MemoryChannel(ObservationInputs):
    def __init__(self, inputs):
        self.inputs = inputs
        self.cloud_bus = self
        self.sport_listeners = ()
        self.lock = threading.Lock()
        self.listeners = {}
        self.first_sn = None
        self.image = self.row = self.camera = None

    def subscribe(self, topic, callback, *, odometry=False):
        with self.lock:
            self.listeners.setdefault(topic, set()).add(callback)
        return Handle(self, topic, callback)

    def remove(self, topic, callback):
        with self.lock:
            self.listeners[topic].discard(callback)

    def dispatch(self, item, idls):
        topic, kind = item.meta['topic'], item.meta['kind']
        if topic == SYSTEM:
            return
        if topic == CAMERA and kind == 'camera':
            with self.lock:
                self.camera = item.payload or None
            return
        if FIXED.get(topic) != kind and kind not in DEPTH.values():
            raise ValueError('unknown recording topic or type')
        msg = idls[kind].deserialize(item.payload)
        if kind in DEPTH.values():
            with self.lock:
                self.row = dict(name=topic, type=IMAGE if kind == 'image' else COMPRESSED, supported=True)
                self.image = msg
        elif topic == LOW_TOPIC:
            sn = tuple(msg.sn)
            if self.first_sn is None:
                self.first_sn = sn
            msg.sn = list(FIRST_SN if sn == self.first_sn else (1000, 2))
            self.inputs.lowstate(msg)
        elif topic == SPORT_TOPIC:
            self.sport(self.inputs.sportmodestate, msg)
        else:
            with self.lock:
                listeners = tuple(self.listeners.get(topic, ()))
            for callback in listeners:
                callback(msg)

    def GetImageSample(self):
        with self.lock:
            data, self.camera = self.camera, None
        return (0, data) if data else (1, b'')

    def poll(self):
        with self.lock:
            return [self.row] if self.row else []

    def take(self, row):
        with self.lock:
            if self.row == row and self.image is not None:
                msg, self.image = self.image, None
                return [msg]
            return []


class FakeSport:
    """All accepted SDK operations terminate here; the only effect is a counter."""
    def __init__(self, calls):
        self.calls = calls

    def __getattr__(self, name):
        if name not in ACTIONS and name != 'Move':
            raise AttributeError(name)
        def discard(*args):
            self.calls[name] += 1
            return 0
        return discard


def play(root, speed, stopped, dispatch, *, clock=time.monotonic_ns):
    counts = Counter()
    first = None
    for item in samples(root):
        if first is None:
            first, start = item.mono, clock()
        target = start + (item.mono - first) / speed
        if stopped.wait(max(0, (target - clock()) / 1e9)):
            break
        dispatch(item)
        counts[item.meta['topic']] += 1
    return counts


async def replay(root, speed, port, *, idls=None):
    # Only a numeric loopback port is configurable. No field setup/credential file.
    online = port is not None
    token = os.environ['FH_REPLAY_TOKEN'] if online else 'offline'
    robot = os.environ['FH_REPLAY_ROBOT_ID'] if online else LOCAL_ROBOT
    creds = Credentials(robot, '1000-1', token, f'ws://127.0.0.1:{port or 1}/api/v1/agent/ws')
    class ReplayStatus(Status):
        connected_once = False

        def update(self, **values):
            self.connected_once |= values.get('connected') is True
            super().update(**values)

    status, inputs = ReplayStatus(), Inputs()
    channel = MemoryChannel(inputs)
    calls = Counter()
    stop, interrupted = asyncio.Event(), threading.Event()
    codecs = types() if idls is None else idls

    class Offline(Client):
        async def run(self):
            try:
                self._emit(self.session.connect())
                while not stop.is_set():
                    self._emit(self.session.receive(dict(t='ping', seq=0)))
                    if not self.sink.active and not self.sink.pending and inputs.feedback.sample():
                        self._emit(self.session.receive(dict(t='field_approval', expires_at=time.time()+60)))
                    await asyncio.sleep(.05)
            finally:
                self.session._messages.close()

    def media(credentials, approval, bus, recorder, enabled):
        config = SimpleNamespace(robot=robot, link=creds.link, approval=approval)
        def observation(env, channel, serial, *, callback=None):
            return bus.cloud(RAW_TOPIC, callback) if callback else bus
        source = Source(config, {}, bus, factory=observation, recorder=recorder,
                        enabled=enabled, include_depth=False, authorize=lambda *_: None)
        publisher = Publisher(config, {}, bus, source_factory=lambda *_: source, channels=('rgb', 'lidar'))
        if not online:
            publisher.upload = lambda *_: None
            source.slam_upload = publisher.upload
        return publisher

    def images(_, row):
        return SimpleNamespace(take=lambda: channel.take(row), close=lambda: None)
    config = SimpleNamespace(robot=robot, link=creds.link)
    depth = DepthSource(config, participant=lambda: channel,
                        discovery=lambda _: SimpleNamespace(poll=channel.poll, close=lambda: None), images=images)
    depth_publisher = DepthPublisher(config, source=depth)
    if not online:
        depth_publisher.upload = lambda *_: None
    with tempfile.TemporaryDirectory(prefix='foothold-replay-') as cache:
        def mapper(session, bus, link, robot, env, *, enabled):
            return mapping.attach(session, bus, link, robot, {'FH_MAPPING_CACHE_DIR': cache}, enabled=enabled)
        runtime = asyncio.create_task(run(creds, SimpleNamespace(name='replay'), inputs, channel,
            ready=True, check_nic=lambda: True, status=status, stop=stop,
            client_factory=Client if online else Offline, connect=lambda *_: (FakeSport(calls), FakeSport(calls)),
            recorder_factory=lambda *a, **kw: Recorder({'FH_RECORD': '0'}),
            depth_source=depth, media_factory=media, mapping_factory=mapper))
        depth_task = asyncio.create_task(depth_publisher.run())
        playback = asyncio.create_task(asyncio.to_thread(play, root, speed, interrupted,
                                                         lambda item: channel.dispatch(item, codecs)))
        try:
            done, _ = await asyncio.wait((runtime, playback, depth_task), return_when=asyncio.FIRST_COMPLETED)
            for task in done:
                task.result()
            if playback not in done:
                raise RuntimeError('agent stopped before the last frame')
            if online and not status.connected_once:
                raise RuntimeError('local agent session did not connect during playback')
            return dict(received=dict(playback.result()), fake_output=dict(calls))
        finally:
            interrupted.set()
            stop.set()
            depth.close()
            depth_task.cancel()
            try:
                await asyncio.gather(playback, runtime)
            finally:
                await asyncio.gather(depth_task, return_exceptions=True)
