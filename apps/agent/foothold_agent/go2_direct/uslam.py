"""Read-only onboard SLAM observations. Each media worker keeps one pending DDS sample."""
from contextlib import ExitStack
from datetime import datetime, timezone
from functools import partial
import hashlib
import logging
import math
import re
import struct
import threading

from .identity import expected_serial
from foothold_agent.mapping.poses import media_pose, timestamp

CLOUD = 'rt/uslam/frontend/cloud_world_ds'
MAP = 'rt/uslam/cloud_map'
FRONTEND = 'rt/uslam/frontend/odom'
LOCALIZATION = 'rt/uslam/localization/odom'
TOPICS = {'slam': (CLOUD,), 'slam_pose': (FRONTEND, LOCALIZATION)}
FORMATS = {1: 'b', 2: 'B', 3: 'h', 4: 'H', 5: 'i', 6: 'I', 7: 'f', 8: 'd'}
MAX_POINTS = 4000
MAX_INPUT_BYTES = 16_000_000
OBSERVATIONS = 5
LOG = logging.getLogger(__name__)
FRAME = re.compile(r'[A-Za-z0-9_/-]{1,128}')
# Log only known sensor vocabulary verbatim. Unknown identifiers remain comparable
# across samples without putting a private namespace or device name in the log.
LABELS = frozenset(('map', 'world', 'odom', 'body', 'base', 'base_link', 'lidar_link',
                    'camera_init', 'imu_link', 'uslam', 'lidar', 'utlidar_lidar',
                    'x', 'y', 'z', 'intensity', 'ring', 'time', 'timestamp', 'reflectivity',
                    'rgb', 'rgba', 'normal_x', 'normal_y', 'normal_z', 'curvature'))


class InvalidSample(ValueError):
    """Fixed diagnostic code safe for the observation log."""


def label(value):
    if not isinstance(value, str):
        return '?'
    if len(value) <= 128 and all(part in LABELS for part in value.strip('/').split('/')):
        return value
    return '#' + hashlib.sha256(value[:128].encode('utf-8', 'replace')).hexdigest()[:10]


def frame_id(value):
    if not isinstance(value, str) or not FRAME.fullmatch(value):
        raise InvalidSample('invalid_frame')
    return value


def cloud(message):
    width, height, step, row = message.width, message.height, message.point_step, message.row_step
    if (any(type(n) is not int for n in (width, height, step, row))
            or min(width, height, step) < 1 or row < width * step
            or not len(message.data) == row * height <= MAX_INPUT_BYTES):
        raise InvalidSample('invalid_cloud_dimensions')
    if type(message.is_bigendian) is not bool or not 3 <= len(message.fields) <= 64:
        raise InvalidSample('invalid_cloud_layout')
    endian = '>' if message.is_bigendian else '<'
    axes = {}
    occupied = set()
    for field in message.fields:
        if field.name not in ('x', 'y', 'z'):
            continue
        if (field.name in axes or type(field.count) is not int or field.count != 1
                or type(field.datatype) is not int or field.datatype not in FORMATS
                or type(field.offset) is not int):
            raise InvalidSample('invalid_xyz_field')
        reader = struct.Struct(endian + FORMATS[field.datatype])
        end = field.offset + reader.size
        if not 0 <= field.offset < end <= step or occupied.intersection(range(field.offset, end)):
            raise InvalidSample('invalid_xyz_offset')
        occupied.update(range(field.offset, end))
        axes[field.name] = field.offset, reader
    if len(axes) != 3:
        raise InvalidSample('missing_xyz')
    # Decode just the selected coordinates, even when the SDK supplies a list
    # of octets. Converting a whole map list would hold the GIL on large frames.
    data = message.data
    try:
        data = memoryview(data).cast('B')
        buffered = True
    except TypeError:
        buffered = False
    count = width * height
    take = min(MAX_POINTS, count)
    layout = [axes[axis] for axis in 'xyz']
    payload = bytearray()
    for sample in range(take):
        index = sample * count // take
        y, x = divmod(index, width)
        at = y * row + x * step
        if buffered:
            point = tuple(reader.unpack_from(data, at + offset)[0] for offset, reader in layout)
        else:
            point = tuple(reader.unpack(bytes(data[at + offset:at + offset + reader.size]))[0]
                          for offset, reader in layout)
        if not all(math.isfinite(v) for v in point):
            continue
        if any(abs(v) > 10000 for v in point):
            raise InvalidSample('coordinate_out_of_range')
        payload.extend(struct.pack('<fff', *point))
    if not payload:
        raise InvalidSample('no_finite_points')
    return dict(t='media.slam_points', source=CLOUD, frame=frame_id(message.header.frame_id),
                count=len(payload)//12, encoding='xyz_f32le', byte_length=len(payload),
                truncated=take < count), bytes(payload)


def odometry(message, topic):
    p, q = message.pose.pose.position, message.pose.pose.orientation
    position, quaternion = (p.x, p.y, p.z), (q.w, q.x, q.y, q.z)
    if (not all(type(v) in (int, float) and math.isfinite(v) for v in (*position, *quaternion))
            or any(abs(v) > 10000 for v in position)):
        raise InvalidSample('invalid_pose')
    norm = math.hypot(*quaternion)
    if not .9 <= norm <= 1.1:
        raise InvalidSample('invalid_orientation')
    pose = media_pose((None, None, position, tuple(v/norm for v in quaternion)))
    return dict(t='media.slam_pose', source=topic, frame=frame_id(message.header.frame_id),
                child_frame=frame_id(message.child_frame_id), pose=pose), None


def observe(topic, message, number, interval):
    def integer(value):
        return value if type(value) is int and abs(value) <= 2**32 else '?'

    header = getattr(message, 'header', None)
    stamp = getattr(header, 'stamp', None)
    if topic in (CLOUD, MAP):
        fields = getattr(message, 'fields', ())
        layout = [(label(f.name), integer(f.offset), integer(f.datatype), integer(f.count))
                  for f in fields[:64]]
        width, height = integer(message.width), integer(message.height)
        details = ('PointCloud2_ fields=%s width=%s height=%s points=%s point_step=%s row_step=%s big=%s' % (
            layout, width, height, width*height if isinstance(width, int) and isinstance(height, int) else '?',
            integer(message.point_step), integer(message.row_step), message.is_bigendian is True))
    else:
        pose = getattr(getattr(message, 'pose', None), 'pose', None)
        position = getattr(pose, 'position', None)
        orientation = getattr(pose, 'orientation', None)
        fields = [f'position.{axis}' for axis in 'xyz' if hasattr(position, axis)]
        fields += [f'orientation.{axis}' for axis in 'xyzw' if hasattr(orientation, axis)]
        details = 'Odometry_ fields=%s child=%s' % (','.join(fields), label(getattr(message, 'child_frame_id', None)))
    LOG.warning('GO2_SLAM observation topic=%s sample=%d frame=%s stamp_sec=%s stamp_nanosec=%s interval_ms=%s %s',
                topic, number, label(getattr(header, 'frame_id', None)),
                integer(getattr(stamp, 'sec', None)), integer(getattr(stamp, 'nanosec', None)),
                interval, details)


class Reader:
    def __init__(self, source, channel):
        self.source, self.channel = source, channel
        self.lock = threading.Lock()
        self.ready = threading.Event()
        self.pending = None
        self.observed = {}
        self.stamps = {}
        self.last_error = {}
        self.map_observed = threading.Event()

    def rejected(self, topic, reason):
        if self.last_error.get(topic) != reason:
            LOG.warning('GO2_SLAM dropped topic=%s reason=%s', topic, reason)
            self.last_error[topic] = reason

    def receive(self, topic, message):
        if self.source.closing.is_set():
            return
        received = self.source.now()
        sample = message
        if topic == CLOUD:
            try:
                if len(message.data) > MAX_INPUT_BYTES:
                    sample = None  # keep the rejection, release the oversized DDS buffer
            except (AttributeError, TypeError):
                sample = None
        with self.lock:
            number, previous = self.observed.get(topic, (0, None))
            if number < OBSERVATIONS:
                self.observed[topic] = number + 1, received
            if topic != MAP:
                self.pending = topic, received, datetime.now(timezone.utc).isoformat(), sample
                self.ready.set()
            elif number + 1 >= OBSERVATIONS:
                self.map_observed.set()
        if number < OBSERVATIONS:
            try:
                observe(topic, message, number+1, None if previous is None else round((received-previous)*1000))
            except (AttributeError, TypeError, ValueError, OverflowError):
                LOG.warning('GO2_SLAM observation topic=%s sample=%d reason=malformed_metadata', topic, number+1)

    def run(self):
        source = self.source
        source.authorize(source.env, source.channel, expected_serial(source.config.approval))
        with self.lock:
            self.pending = None
            self.ready.clear()
        self.stamps.clear()
        with ExitStack() as stack:
            probe = stack.enter_context(ExitStack())
            if self.channel == 'slam' and not self.map_observed.is_set():
                try:
                    handle = source.channel.cloud_bus.subscribe(MAP, partial(self.receive, MAP))
                    probe.callback(handle.Close)
                except Exception:
                    self.rejected(MAP, 'reader_unavailable')
            subscribed = False
            for topic in TOPICS[self.channel]:
                try:
                    handle = source.channel.cloud_bus.subscribe(topic, partial(self.receive, topic),
                                                               odometry=topic != CLOUD)
                except Exception:
                    self.rejected(topic, 'reader_unavailable')
                    continue
                stack.callback(handle.Close)
                subscribed = True
            if not subscribed:
                return
            source.start_ready(self.channel)
            next_send = float('-inf')
            while not source.closing.is_set() and source.enabled():
                if self.channel == 'slam' and self.map_observed.is_set():
                    probe.close()
                if not self.ready.wait(.5):
                    continue
                if source.closing.wait(max(0, next_send - source.now())):
                    break
                next_send = source.now() + 1
                frame = self.take_frame()
                if frame is None or source.closing.is_set() or not source.enabled():
                    continue
                header, payload = frame
                topic = header['source']
                try:
                    source.slam_upload(self.channel, header, payload)
                    self.last_error.pop(topic, None)
                except (OSError, ValueError):
                    self.rejected(topic, 'upload_failed')

    def take_frame(self):
        # Release the raw DDS reference before HTTP (including on failure/idle).
        with self.lock:
            topic, received, captured, message = self.pending
            self.pending = None
            self.ready.clear()
        source = self.source
        if source.now()-received > 1 or not source.enabled():
            return None
        if message is None:
            self.rejected(topic, 'invalid_cloud_buffer')
            return None
        try:
            try:
                stamp = timestamp(message.header.stamp)
            except (AttributeError, ValueError):
                raise InvalidSample('invalid_stamp') from None
            previous = self.stamps.get(topic)
            # A new SLAM run may restart its DDS clock after a silent interval.
            if previous and stamp <= previous[0] and received-previous[1] < 3:
                self.stamps[topic] = previous[0], received
                raise InvalidSample('non_increasing_stamp')
            header, payload = cloud(message) if topic == CLOUD else odometry(message, topic)
        except (ValueError, AttributeError, TypeError, OverflowError, struct.error) as error:
            reason = str(error) if isinstance(error, InvalidSample) else 'malformed_sample'
            self.rejected(topic, reason)
            return None
        self.stamps[topic] = stamp, received
        if source.now()-received > 1:
            return None
        source.seq[self.channel] += 1
        header.update(version='media/1', robot=source.config.robot, epoch=source.epoch,
                      episode_id=None, channel=self.channel, seq=source.seq[self.channel],
                      captured_at=captured)
        return header, payload
