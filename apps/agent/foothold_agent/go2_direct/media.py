"""SDK observation workers + separate latest-only outbound media/1 sockets.

No control/Core methods or safety locks are reachable from these workers.
JPEG acquisition/encoding and point conversion never run on the control loop.
"""
import asyncio
import base64
from collections import Counter
from dataclasses import dataclass
from datetime import datetime, timezone
import json
import logging
import math
import os
import secrets
import struct
import threading
import time
from urllib.parse import urlsplit, urlunsplit
from urllib.request import Request, build_opener, ProxyHandler
from urllib.error import HTTPError, URLError
from concurrent.futures import ThreadPoolExecutor

from . import sdk, uslam
from .identity import expected_serial
from .record import Recorder
from foothold_agent.mapping.inputs import DEFAULT_TOPIC, RAW_TOPIC
from foothold_agent.mapping.poses import Poses, media_pose
from foothold_agent.media.edges import annotate, enabled as edges_enabled

MAX_INPUT_BYTES = 2_000_000
MAX_INPUT_POINTS = 100_000
MAX_POINTS = 4000
MAX_DRIVE_POINTS = 20_000
MAX_DRIVE_BODY = 4*((MAX_DRIVE_POINTS*12+2)//3) + 4*((MAX_DRIVE_POINTS+2)//3) + 8192


def drive_max_points(env):
    value = env.get('FH_DRIVE_LIDAR_MAX_POINTS', str(MAX_POINTS))
    try:
        count = int(value)
        if 1000 <= count <= MAX_DRIVE_POINTS:
            return count
    except (ValueError, TypeError, OverflowError):
        pass
    logging.getLogger(__name__).warning(
        'GO2_MEDIA invalid FH_DRIVE_LIDAR_MAX_POINTS; using 4000 (allowed 1000..20000)')
    return MAX_POINTS


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


def points(raw, *, max_points=MAX_POINTS, frames=('lidar_link', 'utlidar_lidar'), edge_enabled=False):
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
    return annotate(dict(t='media.points', source='l1', frame='lidar_link', map_version_id=None, pose=None,
        count=len(output)//12, truncated=stride>1, encoding='xyz_f32le', byte_length=len(output)),
        bytes(output), edge_enabled=edge_enabled)


class Source:
    def __init__(self, config, env, channel, *, factory=sdk.observation, now=time.monotonic,
                 recorder=None, enabled=lambda: True, include_depth=True, authorize=sdk.authorize_observation):
        self.config, self.env, self.channel = config, env, channel
        self.max_points = drive_max_points(env)
        self.factory, self.now = factory, now
        self.enabled = enabled
        self.authorize = authorize
        self.slam_upload = None  # bound by the hardware publisher when enabled
        self.recorder = recorder if recorder is not None else Recorder(env)
        self.owns_recorder = recorder is None
        self.closing = threading.Event()
        self.lock = threading.Lock()
        self.latest = {}
        self.start_failures = {}
        self.raw_cloud = None
        self.deskew_cloud = None
        self.poses = Poses(now)
        self.last_odom_points = self.now()
        self.next_deskew = float('-inf')
        self.last_deskew_stamp = -1
        self.next_lidar_publish = float('-inf')
        self.next_cloud = float('-inf')
        self.last_cloud_stamp = -1
        self.seq = dict.fromkeys(('rgb', 'lidar', *uslam.TOPICS), 0)
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
        self.threads = [threading.Thread(target=self.observe, args=(name, fn),
                                       daemon=True, name='go2-observe-'+name)
            for name, fn in (('rgb', self.camera), ('lidar', self.lidar))]
        if self.slam_upload is not None:
            for channel in uslam.TOPICS:
                reader = uslam.Reader(self, channel)
                self.threads.append(threading.Thread(target=self.observe, args=(channel, reader.run),
                                                     daemon=True, name='go2-observe-' + channel))
        for thread in self.threads:
            thread.start()

    def observe(self, channel, worker):
        while not self.closing.is_set():
            try:
                if self.enabled():
                    worker()
            except Exception as error:
                self.start_failed(channel, error)
            # Transient identity/approval freshness gaps must not permanently
            # retire a channel within the same approval epoch. Each worker's
            # factory still verifies the body before opening any SDK resource.
            self.closing.wait(1.)

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

    def start_failed(self, channel, error):
        reason = 'identity' if isinstance(error, PermissionError) else 'source'
        with self.lock:
            if self.start_failures.get(channel) == reason:
                return
            self.start_failures[channel] = reason
        logging.getLogger(__name__).warning(
            'GO2_MEDIA start_failed reason=%s channel=%s', reason, channel)

    def start_ready(self, channel):
        with self.lock:
            self.start_failures.pop(channel, None)

    def camera(self):
        # A retired approval may still be waiting for its SDK sample. Let the
        # next worker retry without queueing behind it or opening a new reader.
        lock = getattr(self.channel, 'video_lock', None)
        if lock is not None and not lock.acquire(blocking=False):
            return
        try:
            self._read_camera()
        finally:
            if lock is not None:
                lock.release()

    def _read_camera(self):
        try:
            client = self.factory(self.env, self.channel, expected_serial(self.config.approval))
            self.start_ready('rgb')
            while not self.closing.is_set() and self.enabled():
                try:
                    code, data = client.GetImageSample()
                except Exception as error:
                    self.start_failed('rgb', error)
                    # Retry the same VideoClient: the pinned SDK has no public
                    # close API, and replacing it leaks its DDS reader/writer.
                    self.closing.wait(1.)
                    continue
                self.start_ready('rgb')
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
        except Exception as error:
            self.start_failed('rgb', error)  # NO_VIDEO, never a control fault

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
                    header, payload = points(data, max_points=self.max_points, frames=('odom',), edge_enabled=edges_enabled(self.env))
                    header.update(frame='odom', pose=media_pose(pose))
                    self.publish('lidar', received, (header, payload))
                    self.last_odom_points = self.now()
                    self.next_lidar_publish = self.now()+.5
                    return
        except (ValueError, TypeError, OverflowError):
            pass
        try:
            if raw is not None and self.now()-self.last_odom_points >= 3:
                self.publish('lidar', raw[0], points(raw[1], max_points=self.max_points, edge_enabled=edges_enabled(self.env)))
                self.next_lidar_publish = self.now()+.5
        except (ValueError, TypeError, OverflowError):
            pass

    def lidar(self):
        subscribers = []
        try:
            subscribers.append(self.factory(self.env, self.channel, expected_serial(self.config.approval), callback=self.cloud))
            self.start_ready('lidar')
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
        except Exception as error:
            self.start_failed('lidar', error)
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


def upload_result(error):
    if isinstance(error, HTTPError):
        return f'http_{error.code}'
    if isinstance(error, (asyncio.TimeoutError, TimeoutError)) or (
            isinstance(error, URLError) and isinstance(error.reason, TimeoutError)):
        return 'timeout'
    if isinstance(error, (URLError, OSError)):
        return 'network_error'
    return 'error'


@dataclass
class UploadAttempt:
    started: float
    frame: str
    interval_ms: int | None
    body_bytes: int = 0  # set by the HTTP worker before it sends the request
    elapsed_ms: int = 0
    result: str = ''


def log_upload_window(channel, attempts):
    if not attempts:
        return

    def percentiles(values):
        ordered = sorted(values)
        return tuple(ordered[math.ceil(len(ordered)*p)-1] for p in (.5, .95)) if ordered else ()

    data = [a for a in attempts if a.frame != 'status' and a.body_bytes]
    points = [a for a in data if a.frame in ('odom', 'lidar_link')]
    logging.getLogger(__name__).warning(
        'GO2_MEDIA upload_summary channel=%s attempts=%d results=%s elapsed_ms_p50_p95=%s '
        'interval_ms_p50_p95=%s data_attempts=%d data_bytes_p50_p95=%s frames=%s ack_frames=%s',
        channel, len(attempts), dict(Counter(a.result for a in attempts)),
        percentiles(a.elapsed_ms for a in attempts),
        percentiles(a.interval_ms for a in attempts if a.interval_ms is not None),
        len(data), percentiles(a.body_bytes for a in data), dict(Counter(a.frame for a in points)),
        dict(Counter(a.frame for a in points if a.result == 'http_202')))


class Publisher:
    channels = ('rgb', 'lidar', 'depth')
    def __init__(self, config, env, channel, *, source_factory=Source, channels=None):
        self.config = config
        if channels is not None:
            self.channels = channels
        self.source = source_factory(config, env, channel)
        if (isinstance(self.source, Source) and hasattr(channel, 'cloud_bus')
                and env.get('FH_USLAM', '1') != '0'):
            self.source.slam_upload = self.upload
        # A stalled depth HTTP request must not occupy RGB/lidar's workers.
        self.executor = ThreadPoolExecutor(max_workers=len(self.channels), thread_name_prefix='go2-media-upload')
        self.opener = build_opener(ProxyHandler({}))
        self.last_lidar_upload = None

    def url(self, channel):
        url = urlsplit(self.config.link.url)
        scheme = 'https' if url.scheme == 'wss' else 'http'
        return urlunsplit((scheme, url.netloc, url.path.rsplit('/',1)[0]+'/drive-media/'+channel, '', ''))

    def upload(self, channel, header, payload, attempt=None):
        # HTTP avoids raising the deployment's 4096-byte control WS limit.
        body = json.dumps({'header':header, 'points':None if payload is None else
            base64.b64encode(payload).decode('ascii')}, allow_nan=False).encode()
        if len(body) > (MAX_DRIVE_BODY if channel == 'lidar' else 100_000):
            raise ValueError('observation body exceeds bound')
        request = Request(self.url(channel), data=body, method='POST', headers={
            'Authorization':'Bearer '+self.config.link.token,'Content-Type':'application/json',
            'Connection':'close'})
        response = None
        if attempt is not None:
            attempt.body_bytes = len(body)
        try:
            response = self.opener.open(request, timeout=.5 if channel == 'depth' else .9)
            if response.status != 202:
                raise HTTPError(request.full_url, response.status, 'observation upload rejected', None, None)
            response.read(128)
        except HTTPError as error:
            error.close()  # urllib may raise before returning the response
            raise
        finally:
            # Executor cancellation cannot stop an in-flight upload; its bounded
            # socket timeout still reaches this cleanup even after wait_for ends.
            if response is not None:
                response.close()

    def log_lidar_upload(self, header, result):
        frame = 'points' if header['t'] == 'media.points' else 'no_points'
        if (frame, result) != self.last_lidar_upload:
            self.last_lidar_upload = frame, result
            logging.getLogger(__name__).warning('GO2_MEDIA lidar_upload frame=%s result=%s', frame, result)

    async def stream(self, channel):
        seq = -1
        live = channel in ('rgb', 'lidar')
        attempts = []
        previous_start = None
        cadence = .5 if channel == 'lidar' else .2
        pending = None
        try:
            while True:
                header = attempt = None
                result = 'http_202'
                delay = cadence
                try:
                    item = self.source.sample(channel)
                    payload = None
                    if item is None:
                        header = dict(t='media.status', version='media/1', robot=self.config.robot,
                            epoch=self.source.epoch, episode_id=None, channel=channel,
                            state='NO_POINTS' if channel=='lidar' else 'NO_VIDEO',
                            reason='No fresh source sample within 1 second')
                    else:
                        _, header, payload = item
                        if header['seq'] == seq:
                            # Poll only the source until it has a new sample.
                            await asyncio.sleep(.05 if live else cadence)
                            continue
                    started = time.monotonic()
                    if live:
                        interval = None if previous_start is None else round((started-previous_start)*1000)
                        previous_start = started
                        frame = 'status' if item is None else header.get('frame', 'unknown')
                        attempt = UploadAttempt(started, frame, interval)
                        if item is not None:
                            # A lost acknowledgment may still mean the relay accepted this seq.
                            seq = header['seq']
                    pending = asyncio.get_running_loop().run_in_executor(
                        self.executor, self.upload, channel, header, payload, attempt)
                    await asyncio.wait_for(asyncio.shield(pending) if live else pending,
                                           1.0 if live else .6)
                    if live:
                        # Count transfer time toward cadence; allow the relay's minimum
                        # 200 ms between accepted requests even if the next one is fast.
                        delay = max(.2, cadence - (time.monotonic()-started))
                    elif item is not None:
                        seq = header['seq']
                except asyncio.CancelledError:
                    raise
                except Exception as error:
                    result = upload_result(error)
                    delay = .2 if live and result == 'timeout' else 1
                if channel == 'lidar' and header is not None:
                    self.log_lidar_upload(header, result)
                if attempt is not None:
                    attempt.result = result
                    attempt.elapsed_ms = round((time.monotonic()-attempt.started)*1000)
                    attempts.append(attempt)
                    if len(attempts) == 32:
                        log_upload_window(channel, attempts)
                        attempts.clear()
                if live and pending is not None and not pending.done():
                    # wait_for cannot cancel a socket in an executor thread. Keep just
                    # this stream occupied until it settles, then sample the newest frame.
                    await asyncio.shield(asyncio.gather(pending, return_exceptions=True))
                pending = None
                await asyncio.sleep(delay)
        finally:
            if pending is not None:
                pending.cancel()  # drop queued work when the publisher retires
            log_upload_window(channel, attempts)

    async def run(self):
        tasks = []
        try:
            self.source.start()
            tasks = [asyncio.create_task(self.stream(channel)) for channel in self.channels]
            await asyncio.gather(*tasks)
        except Exception as error:
            reason = 'identity' if isinstance(error, PermissionError) else 'source'
            logging.getLogger(__name__).warning('GO2_MEDIA start_failed reason=%s', reason)
            raise
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
    inputs = subscriptions.state
    identity = getattr(inputs, 'mac_identity', None)

    def authorize(env, channel, observed_serial):
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
        if identity is None:
            # Preserve the serial/manual-trial verifier unchanged.
            if getattr(credentials, 'identity_source', None) == 'mac':
                raise PermissionError('confirmed media body identity unavailable')
            verify(approval, observed_serial)
        else:
            # Reuse setup's current connection/body evidence, including its
            # freshness and conflict latch. Never apply the manual trial's
            # exclusive two-neighbor policy to a confirmed MAC connection.
            binding = getattr(credentials, 'mounted_binding', None)
            if (getattr(credentials, 'identity_source', None) != 'mac'
                    or credentials.robot_mac != identity.mac
                    or identity.nic != approval.nic
                    or approval.robot_serial != identity.serial
                    or inputs.mac_identity is not identity
                    or not identity.valid() or inputs.identity() != identity.serial
                    or binding is not None and binding.get('robot_mac') != identity.mac):
                raise PermissionError('confirmed media body identity unavailable')
        if not enabled():
            raise PermissionError('approved observation channel required')

    def observation(env, channel, observed_serial, *, callback=None):
        authorize(env, channel, observed_serial)
        if callback is not None:
            return channel.cloud(RAW_TOPIC, callback)
        # VideoClient has no close API. Its DDS reader deserializes every
        # videohub reply even after its original worker has exited.
        if channel.video_client is None:
            from unitree_sdk2py.go2.video.video_client import VideoClient
            client = VideoClient()
            client.SetTimeout(sdk.SDK_TIMEOUT_S)
            client.Init()
            channel.video_client = client
        return channel.video_client

    config = SimpleNamespace(robot=credentials.robot_id, link=credentials.link, approval=approval)

    # Setup's DepthPublisher already owns /drive-media/depth across approvals.
    env = {'FH_USLAM': '0',  # mapping uses the independent Point-LIO/GLIM pipeline
           'FH_DRIVE_LIDAR_MAX_POINTS': os.environ.get('FH_DRIVE_LIDAR_MAX_POINTS', str(MAX_POINTS)),
           'FH_LIDAR_EDGE_ENABLED': os.environ.get('FH_LIDAR_EDGE_ENABLED', '0')}
    return Publisher(config, env, subscriptions, channels=('rgb', 'lidar'),
        source_factory=lambda config, env, channel: Source(config, env, channel,
            factory=observation, recorder=recorder, enabled=enabled, include_depth=False, authorize=authorize))
