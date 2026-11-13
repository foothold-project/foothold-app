"""SDK observation workers + separate latest-only outbound media/1 sockets.

No control/Core methods or safety locks are reachable from these workers.
JPEG acquisition/encoding and point conversion never run on the control loop.
"""
import asyncio
import base64
from datetime import datetime, timezone
import json
import math
import secrets
import struct
import threading
import time
from urllib.parse import urlsplit, urlunsplit
from urllib.request import Request, build_opener, ProxyHandler
from concurrent.futures import ThreadPoolExecutor

from . import sdk
from .identity import expected_serial
from .record import Recorder
from foothold_agent.mapping.inputs import DEFAULT_TOPIC
from foothold_agent.mapping.poses import Poses, media_pose

MAX_INPUT_BYTES = 2_000_000
MAX_INPUT_POINTS = 100_000
MAX_POINTS = 4000


def dimensions(data):
    at = 2
    size = None
    if not data.startswith(b'\xff\xd8') or not data.endswith(b'\xff\xd9'):
        raise ValueError('JPEG envelope')
    while at+4 <= len(data):
        if data[at] != 255:
            break
        while at < len(data) and data[at] == 255:
            at += 1
        if at+3 > len(data):
            break
        marker = data[at]
        at += 1
        if marker == 0xDA:
            if size is not None:
                return size
            break
        if marker in (0xD8, 0xD9):
            break
        length = int.from_bytes(data[at:at+2], 'big')
        if length < 2 or at+length > len(data):
            break
        if marker in (0xC0, 0xC1, 0xC2) and length >= 8:
            if size is not None:
                raise ValueError('multiple JPEG frame headers')
            w, h = int.from_bytes(data[at+5:at+7], 'big'), int.from_bytes(data[at+3:at+5], 'big')
            if 1 <= w <= 1920 and 1 <= h <= 1080:
                size = w, h
            else:
                break
        at += length
    raise ValueError('bounded JPEG raster required')


def video(data):
    if not 4 <= len(data) <= MAX_INPUT_BYTES:
        raise ValueError('bounded camera input required')
    raw = bytes(data)
    w, h = dimensions(raw)
    import cv2
    import numpy as np
    image = cv2.imdecode(np.frombuffer(raw, dtype=np.uint8), cv2.IMREAD_COLOR)
    if image is None or image.shape[:2] != (h, w):
        raise ValueError('camera decode failed')
    scale = min(1., 640/w, 360/h)
    w, h = max(1, int(w*scale)), max(1, int(h*scale))
    image = cv2.resize(image, (w, h))
    for quality in (75, 60, 45, 30, 20, 10):
        ok, encoded = cv2.imencode('.jpg', image, [cv2.IMWRITE_JPEG_QUALITY, quality])
        if ok and len(encoded) <= 65536:
            return dict(t='media.video', source='go2_front', frame='go2_front_camera',
                mime='image/jpeg', width=w, height=h, jpeg=base64.b64encode(encoded).decode('ascii')), None
    raise ValueError('camera output exceeds bounds')


def points(raw, *, max_points=MAX_POINTS, frames=('lidar_link', 'utlidar_lidar')):
    data, width, height, step, row_step, big, fields, frame = raw
    if (frame not in frames or
            any(type(x) is not int for x in (width, height, step, row_step)) or
            not 1 <= width*height <= MAX_INPUT_POINTS or min(width, height) < 1 or
            not 12 <= step <= 256 or row_step < width*step or
            len(data) != height*row_step or len(data) > MAX_INPUT_BYTES or type(big) is not bool):
        raise ValueError('bounded sensor-frame cloud required')
    offsets = {}
    for name, offset, datatype, count in fields:
        if name in ('x','y','z'):
            if name in offsets or datatype != 7 or count != 1 or type(offset) is not int or not 0 <= offset <= step-4:
                raise ValueError('float32 XYZ layout required')
            offsets[name] = offset
    if set(offsets) != {'x','y','z'} or any(abs(a-b)<4 for i,a in enumerate(offsets.values()) for b in tuple(offsets.values())[i+1:]):
        raise ValueError('unique nonoverlapping XYZ fields required')
    unpack = struct.Struct('>f' if big else '<f').unpack_from
    output = bytearray()
    stride = max(1, math.ceil(width*height/max_points))
    for index in range(0, width*height, stride):
        row, col = divmod(index, width)
        at = row*row_step + col*step
        xyz = tuple(unpack(data, at+offsets[key])[0] for key in ('x','y','z'))
        if not all(math.isfinite(x) for x in xyz):
            continue
        if any(abs(x)>10000 for x in xyz):
            raise ValueError('point range exceeded')
        output.extend(struct.pack('<fff', *xyz))
    return dict(t='media.points', source='l1', frame='lidar_link', map_version_id=None, pose=None,
        count=len(output)//12, truncated=stride>1, encoding='xyz_f32le', byte_length=len(output)), bytes(output)


class Source:
    def __init__(self, config, env, channel, *, factory=sdk.observation, now=time.monotonic,
                 recorder=None, enabled=lambda: True, include_depth=True):
        self.config, self.env, self.channel = config, env, channel
        self.factory, self.now = factory, now
        self.enabled = enabled
        self.recorder = recorder if recorder is not None else Recorder(env)
        self.owns_recorder = recorder is None
        self.closing = threading.Event()
        self.lock = threading.Lock()
        self.latest = {}
        self.raw_cloud = None
        self.deskew_cloud = None
        self.poses = Poses(now)
        self.last_odom_points = self.now()
        self.next_deskew = float('-inf')
        self.last_deskew_stamp = -1
        self.next_lidar_publish = float('-inf')
        self.next_cloud = float('-inf')
        self.last_cloud_stamp = -1
        self.seq = dict(rgb=0, lidar=0)
        self.epoch = secrets.randbits(52)
        self.threads = []
        from foothold_agent.depth.source import Source as DepthSource
        self.depth_source = DepthSource(config, env, recorder=self.recorder,
                                        recording_allowed=enabled) if include_depth else None
        if self.depth_source is not None:
            self.depth_source.epoch = self.epoch

    def start(self):
        self.recorder.start()
        if self.depth_source is not None:
            self.depth_source.start()
        self.threads = [threading.Thread(target=fn, daemon=True, name='go2-observe-'+name)
            for name, fn in (('rgb', self.camera), ('lidar', self.lidar))]
        for thread in self.threads:
            thread.start()

    def publish(self, channel, received, frame):
        if not 0 <= self.now()-received <= 1 or self.closing.is_set() or not self.enabled():
            return
        header, payload = frame
        with self.lock:
            self.seq[channel] += 1
            header.update(t=header['t'], version='media/1', robot=self.config.robot,
                epoch=self.epoch, episode_id=None, channel=channel, seq=self.seq[channel],
                captured_at=datetime.now(timezone.utc).isoformat())
            self.latest[channel] = received, header, payload

    def camera(self):
        try:
            client = self.factory(self.env, self.channel, expected_serial(self.config.approval))
            while not self.closing.is_set() and self.enabled():
                code, data = client.GetImageSample()
                received = self.now()
                if type(code) is int and code == 0:
                    if self.closing.is_set() or not self.enabled():
                        break
                    try:
                        self.recorder.rgb(data)
                    except Exception:
                        pass  # recording failure must never suppress publication
                    try:
                        self.publish('rgb', received, video(data))
                    except (ValueError, TypeError, OSError, ImportError):
                        pass
                self.closing.wait(.2)
        except Exception:
            pass  # observation loss is reported as NO_VIDEO, never a control fault

    def cloud(self, message, *, deskewed=False):
        received = self.now()
        next_cloud = self.next_deskew if deskewed else self.next_cloud
        if received < next_cloud or self.closing.is_set() or not self.enabled():
            return
        try:
            fields = message.fields
            stamp = message.header.stamp
            if (type(stamp.sec) is not int or type(stamp.nanosec) is not int or
                    not 0 <= stamp.sec <= 0x7FFFFFFF or not 0 <= stamp.nanosec < 1_000_000_000):
                return
            marker = stamp.sec*1_000_000_000+stamp.nanosec
            previous = self.last_deskew_stamp if deskewed else self.last_cloud_stamp
            if (not 0 < marker or marker <= previous or len(message.data)>MAX_INPUT_BYTES
                    or len(fields)>32 or message.width*message.height>MAX_INPUT_POINTS):
                return
            raw = (bytes(message.data), message.width, message.height, message.point_step,
                message.row_step, message.is_bigendian,
                tuple((f.name, f.offset, f.datatype, f.count) for f in fields), message.header.frame_id)
            with self.lock:
                if deskewed:
                    if raw[-1] != 'odom':
                        return
                    self.deskew_cloud = received, raw, marker
                    self.next_deskew, self.last_deskew_stamp = received+.5, marker
                else:
                    self.raw_cloud = received, raw
                    self.next_cloud, self.last_cloud_stamp = received+.5, marker
        except (AttributeError, TypeError, ValueError, OverflowError):
            return

    def deskewed(self, message):
        self.cloud(message, deskewed=True)

    def publish_clouds(self):
        if self.now() < self.next_lidar_publish or self.closing.is_set() or not self.enabled():
            return
        with self.lock:
            raw, self.raw_cloud = self.raw_cloud, None
            deskew, self.deskew_cloud = self.deskew_cloud, None
        if raw is not None:
            try:
                self.recorder.lidar(raw[1])  # recorder retains original sensor coordinates
            except Exception:
                pass
        try:
            if deskew is not None:
                received, data, stamp = deskew
                pose = self.poses.nearest(received, stamp)
                if pose is not None and 0 <= self.now()-received <= 1:
                    header, payload = points(data, frames=('odom',))
                    header.update(frame='odom', pose=media_pose(pose))
                    self.publish('lidar', received, (header, payload))
                    self.last_odom_points = self.now()
                    self.next_lidar_publish = self.now()+.5
                    return
        except (ValueError, TypeError, OverflowError):
            pass
        try:
            if raw is not None and self.now()-self.last_odom_points >= 3:
                self.publish('lidar', raw[0], points(raw[1]))
                self.next_lidar_publish = self.now()+.5
        except (ValueError, TypeError, OverflowError):
            pass

    def lidar(self):
        subscribers = []
        try:
            subscribers.append(self.factory(self.env, self.channel, expected_serial(self.config.approval), callback=self.cloud))
            if hasattr(self.channel, 'add_sport_listener'):
                self.channel.add_sport_listener(self.poses.sport)
            # Factory above validates approval/identity before any additional
            # read-only subscription on the very same participant.
            if hasattr(self.channel, 'cloud'):
                try:
                    subscribers.append(self.channel.cloud(DEFAULT_TOPIC, self.deskewed))
                except Exception:
                    pass  # raw fallback remains available without deskewed DDS
            else:
                self.last_odom_points = float('-inf')  # raw-only observation adapters
            if hasattr(self.channel, 'odometry'):
                try:
                    subscribers.append(self.channel.odometry(self.poses.odom))
                except Exception:
                    pass  # sport state is the pose fallback
            while not self.closing.wait(.02) and self.enabled():
                self.publish_clouds()
        except Exception:
            pass
        finally:
            if hasattr(self.channel, 'remove_sport_listener'):
                self.channel.remove_sport_listener(self.poses.sport)
            for subscriber in subscribers:
                try:
                    subscriber.Close()
                except Exception:
                    pass

    def sample(self, channel):
        if self.closing.is_set() or not self.enabled():
            return None
        if channel == 'depth':
            return self.depth_source.sample(channel) if self.depth_source is not None else None
        with self.lock:
            item = self.latest.get(channel)
        return item if item and 0 <= self.now()-item[0] <= 1 else None

    def close(self):
        self.closing.set()  # never await a stalled SDK/video worker on safety's loop
        if self.depth_source is not None:
            self.depth_source.close()
        if self.owns_recorder:
            self.recorder.close()


class Publisher:
    channels = ('rgb', 'lidar', 'depth')
    def __init__(self, config, env, channel, *, source_factory=Source, channels=None):
        self.config = config
        if channels is not None:
            self.channels = channels
        self.source = source_factory(config, env, channel)
        self.executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix='go2-media-upload')
        self.opener = build_opener(ProxyHandler({}))

    def url(self, channel):
        url = urlsplit(self.config.link.url)
        scheme = 'https' if url.scheme == 'wss' else 'http'
        return urlunsplit((scheme, url.netloc, url.path.rsplit('/',1)[0]+'/drive-media/'+channel, '', ''))

    def upload(self, channel, header, payload):
        # HTTP avoids raising the deployment's 4096-byte control WS limit.
        body = json.dumps({'header':header, 'points':None if payload is None else
            base64.b64encode(payload).decode('ascii')}, allow_nan=False).encode()
        if len(body) > 100_000:
            raise ValueError('observation body exceeds bound')
        request = Request(self.url(channel), data=body, method='POST', headers={
            'Authorization':'Bearer '+self.config.link.token,'Content-Type':'application/json'})
        with self.opener.open(request, timeout=.5) as response:
            if response.status != 202:
                raise ValueError('observation upload rejected')
            response.read(128)

    async def stream(self, channel):
        seq = -1
        while True:
            try:
                item = self.source.sample(channel)
                header = payload = None
                if item is not None and item[1]['seq'] != seq:
                    _, header, payload = item
                elif item is None:
                    header = dict(t='media.status', version='media/1', robot=self.config.robot,
                        epoch=self.source.epoch, episode_id=None, channel=channel,
                        state='NO_POINTS' if channel=='lidar' else 'NO_VIDEO',
                        reason='No fresh source sample within 1 second')
                if header is not None:
                    await asyncio.wait_for(asyncio.get_running_loop().run_in_executor(
                        self.executor, self.upload, channel, header, payload), .6)
                    if item is not None:
                        seq = header['seq']
                await asyncio.sleep(.5 if channel=='lidar' else .2)
            except asyncio.CancelledError:
                raise
            except Exception:
                await asyncio.sleep(1)  # observation failure never touches motion

    async def run(self):
        self.source.start()
        tasks = [asyncio.create_task(self.stream(channel)) for channel in self.channels]
        try:
            await asyncio.gather(*tasks)
        finally:
            self.source.close()
            self.executor.shutdown(wait=False, cancel_futures=True)
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)


def approved_publisher(credentials, approval, subscriptions, recorder, enabled):
    """Desktop observations reuse the existing approved DDS participant/NIC.

    No file-based manual approval, new participant or motion client is opened.
    SDK imports and camera construction stay on observation daemon workers.
    """
    from types import SimpleNamespace

    def observation(env, channel, observed_serial, *, callback=None):
        import socket
        from .approval import Approval, SERVER_CLOCK_SKEW_S, validate_value
        from .identity import verify
        from foothold_agent.go2_readonly.sdk import Subscriptions
        if (not enabled() or type(approval) is not Approval or type(channel) is not Subscriptions
                or not channel._started or channel.nic != approval.nic
                or approval.nic not in {name for _, name in socket.if_nameindex()}):
            raise PermissionError('approved observation channel required')
        validate_value(dict(v=1, purpose='go2-field-motion', nic=approval.nic,
                            robot_serial=approval.robot_serial, expires_at=approval.expires_at),
                       approval.nic, clock_skew_s=SERVER_CLOCK_SKEW_S)
        verify(approval, observed_serial)
        if callback is not None:
            return channel.cloud('rt/utlidar/cloud', callback)
        from unitree_sdk2py.go2.video.video_client import VideoClient
        client = VideoClient()
        client.SetTimeout(sdk.SDK_TIMEOUT_S)
        client.Init()
        return client

    config = SimpleNamespace(robot=credentials.robot_id, link=credentials.link, approval=approval)
    return Publisher(config, {}, subscriptions, channels=('rgb', 'lidar'),
        source_factory=lambda config, env, channel: Source(config, env, channel,
            factory=observation, recorder=recorder, enabled=enabled, include_depth=False))
