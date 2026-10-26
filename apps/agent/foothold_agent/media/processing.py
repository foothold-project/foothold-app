"""Bounded observation conversion. Runs in child processes, never safety's loop."""
import base64
from datetime import datetime, timezone
from io import BytesIO
import math
import struct
import time

from foothold_agent.camera.stream import jpeg_size

MAX_CLOUD_BYTES = 2_000_000
MAX_INPUT_POINTS = 100_000


def video(data):
    """Validate a complete JPEG decode, including the actual raster dimensions."""
    from PIL import Image
    width, height = jpeg_size(data)
    with Image.open(BytesIO(data)) as image:
        if image.format != 'JPEG' or image.size != (width, height):
            raise ValueError('JPEG raster differs from header')
        image.load()
    return dict(width=width, height=height, mime='image/jpeg',
                jpeg=base64.b64encode(data).decode('ascii'))


def points(cloud):
    """PointCloud2 XYZ float32 only; row padding and byte order are explicit."""
    data, width, height, step, row_step, bigendian, fields, frame = cloud
    if (frame != 'lidar_link' or type(width) is not int or type(height) is not int
            or not 1 <= width * height <= MAX_INPUT_POINTS or width < 1 or height < 1
            or type(step) is not int or not 12 <= step <= 256
            or type(row_step) is not int or row_step < width * step
            or len(data) != height * row_step or len(data) > MAX_CLOUD_BYTES):
        raise ValueError('invalid PointCloud2 layout')
    offsets = {}
    for name, offset, datatype, count in fields:
        if name in ('x', 'y', 'z'):
            if name in offsets or datatype != 7 or count != 1 or not 0 <= offset <= step - 4:
                raise ValueError('expected unique float32 XYZ fields')
            offsets[name] = offset
    if set(offsets) != {'x', 'y', 'z'} or any(abs(a-b) < 4 for i, a in enumerate(offsets.values()) for b in tuple(offsets.values())[i+1:]):
        raise ValueError('XYZ fields missing or overlapping')
    read = struct.Struct('>f' if bigendian else '<f').unpack_from
    seen, output = set(), []
    truncated = False
    for row in range(height):
        for column in range(width):
            at = row * row_step + column * step
            xyz = tuple(read(data, at + offsets[key])[0] for key in ('x', 'y', 'z'))
            if not all(math.isfinite(v) and abs(v) <= 10_000 for v in xyz):
                raise ValueError('nonfinite or out-of-range point')
            cell = tuple(math.floor(v / .1) for v in xyz)
            if cell in seen:
                continue
            if len(output) >= 4000:
                truncated = True
                continue
            seen.add(cell)
            output.append(xyz)
    payload = b''.join(struct.pack('<fff', *xyz) for xyz in output)
    return dict(frame='lidar_link', map_version_id=None, pose=None,
                count=len(output), truncated=truncated, encoding='xyz_f32le',
                byte_length=len(payload)), payload


def convert(channel, item):
    binding, generation, received, captured, raw = item
    if not 0 <= time.monotonic() - received <= 1:
        return None
    age = (datetime.now(timezone.utc) - datetime.fromisoformat(captured)).total_seconds()
    if not -1 <= age <= 1:
        return None
    if channel == 'lidar':
        header, payload = points(raw)
    else:
        header, payload = video(raw), None
        header['frame'] = 'camera_color_optical_frame'
    header.update(binding, t='media.points' if channel == 'lidar' else 'media.video',
        version='media/1', channel=channel,
        source='l1' if channel == 'lidar' else 'd435i_rgb', captured_at=captured)
    return generation, received, header, payload


def worker(channel, incoming, outgoing, closing):
    next_frame = float('-inf')
    while not closing.is_set():
        if closing.wait(max(.01, next_frame - time.monotonic())):
            break
        item = incoming.take()
        if item is None:
            continue
        try:
            result = convert(channel, item)
        except (ValueError, TypeError, OSError, ImportError, SyntaxError):
            result = None
        next_frame = time.monotonic() + (.5 if channel == 'lidar' else .2)
        if result is not None:
            outgoing.put(result)
