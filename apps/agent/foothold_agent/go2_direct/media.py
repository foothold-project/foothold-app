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


def points(raw):
    data, width, height, step, row_step, big, fields, frame = raw
    if (frame not in ('lidar_link', 'utlidar_lidar') or
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
    stride = max(1, math.ceil(width*height/MAX_POINTS))
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
    def __init__(self, config, env, channel, *, factory=sdk.observation, now=time.monotonic):
        self.config, self.env, self.channel = config, env, channel
        self.factory, self.now = factory, now
        self.closing = threading.Event()
        self.lock = threading.Lock()
        self.latest = {}
        self.raw_cloud = None
        self.next_cloud = float('-inf')
        self.last_cloud_stamp = -1
        self.seq = dict(rgb=0, lidar=0)
        self.epoch = secrets.randbits(52)
        self.threads = []

    def start(self):
        self.threads = [threading.Thread(target=fn, daemon=True, name='go2-observe-'+name)
            for name, fn in (('rgb', self.camera), ('lidar', self.lidar))]
        for thread in self.threads:
            thread.start()

    def publish(self, channel, received, frame):
        if not 0 <= self.now()-received <= 1 or self.closing.is_set():
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
            client = self.factory(self.env, self.channel, self.config.approval.robot_serial)
            while not self.closing.is_set():
                code, data = client.GetImageSample()
                received = self.now()
                if type(code) is int and code == 0:
                    try:
                        self.publish('rgb', received, video(data))
                    except (ValueError, TypeError, OSError, ImportError):
                        pass
                self.closing.wait(.2)
        except Exception:
            pass  # observation loss is reported as NO_VIDEO, never a control fault

    def cloud(self, message):
        received = self.now()
        if received < self.next_cloud or self.closing.is_set():
            return
        try:
            fields = message.fields
            stamp = message.header.stamp
            if (type(stamp.sec) is not int or type(stamp.nanosec) is not int or
                    not 0 <= stamp.sec <= 0x7FFFFFFF or not 0 <= stamp.nanosec < 1_000_000_000):
                return
            marker = stamp.sec*1_000_000_000+stamp.nanosec
            if (not 0 < marker or marker <= self.last_cloud_stamp or len(message.data)>MAX_INPUT_BYTES
                    or len(fields)>32 or message.width*message.height>MAX_INPUT_POINTS):
                return
            raw = (bytes(message.data), message.width, message.height, message.point_step,
                message.row_step, message.is_bigendian,
                tuple((f.name, f.offset, f.datatype, f.count) for f in fields), message.header.frame_id)
            with self.lock:
                self.raw_cloud = received, raw
            self.next_cloud, self.last_cloud_stamp = received+.5, marker
        except (AttributeError, TypeError, ValueError, OverflowError):
            return

    def lidar(self):
        subscriber = None
        try:
            subscriber = self.factory(self.env, self.channel, self.config.approval.robot_serial, callback=self.cloud)
            while not self.closing.wait(.02):
                with self.lock:
                    item, self.raw_cloud = self.raw_cloud, None
                if item is not None:
                    try:
                        self.publish('lidar', item[0], points(item[1]))
                    except (ValueError, TypeError, OverflowError):
                        pass
        except Exception:
            pass
        finally:
            if subscriber is not None:
                try:
                    subscriber.Close()
                except Exception:
                    pass

    def sample(self, channel):
        with self.lock:
            item = self.latest.get(channel)
        return item if item and 0 <= self.now()-item[0] <= 1 else None

    def close(self):
        self.closing.set()  # never await a stalled SDK/video worker on safety's loop


class Publisher:
    def __init__(self, config, env, channel, *, source_factory=Source):
        self.config = config
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
        tasks = [asyncio.create_task(self.stream(channel)) for channel in ('rgb','lidar')]
        try:
            await asyncio.gather(*tasks)
        finally:
            self.source.close()
            self.executor.shutdown(wait=False, cancel_futures=True)
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
