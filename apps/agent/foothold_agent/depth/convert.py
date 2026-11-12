"""Bounded synthetic-testable metric depth → colour JPEG, never RGB → depth."""
import base64
import math
import re
import struct

MAX_BYTES = 8_388_608
MAX_WIDTH, MAX_HEIGHT = 1920, 1080
PNG = b'\x89PNG\r\n\x1a\n'


def limits(low, high):
    if (type(low) not in (int, float) or type(high) not in (int, float)
            or not math.isfinite(low) or not math.isfinite(high) or not 0 <= low < high <= 10000):
        raise ValueError('increasing finite metric depth range required')
    return float(low), float(high)


def raster(width, height):
    if (type(width) is not int or type(height) is not int
            or not 1 <= width <= MAX_WIDTH or not 1 <= height <= MAX_HEIGHT):
        raise ValueError('bounded depth raster required')


def raw_depth(message):
    import numpy as np
    width, height, step = message.width, message.height, message.step
    raster(width, height)
    encoding = message.encoding
    if encoding not in ('16UC1', '32FC1') or type(message.is_bigendian) is not int or message.is_bigendian not in (0, 1):
        raise ValueError('16UC1 millimetres or 32FC1 metres required')
    size = 2 if encoding == '16UC1' else 4
    if (type(step) is not int or not width*size <= step <= width*size+4096
            or len(message.data) != height*step or len(message.data) > MAX_BYTES):
        raise ValueError('bounded depth row layout required')
    raw = bytes(message.data)
    dtype = np.dtype(('>' if message.is_bigendian else '<')+('u2' if size == 2 else 'f4'))
    image = np.ndarray((height, width), dtype=dtype, buffer=raw, strides=(step, size)).astype(np.float32)
    return image*.001 if size == 2 else image


def compressed_depth(message):
    import cv2
    import numpy as np
    if not isinstance(message.format, str) or len(message.format) > 128 or len(message.data) > MAX_BYTES:
        raise ValueError('bounded compressed depth required')
    # JPEG colour and ambiguous mono formats are deliberately never accepted.
    match = re.fullmatch(r'(16UC1|32FC1);\s*(compressedDepth png|png compressed)\s*', message.format)
    if not match:
        raise ValueError('explicit metric PNG depth required (RVL unsupported)')
    encoding, transport = match.groups()
    raw = bytes(message.data)
    offset = 12 if transport == 'compressedDepth png' else 0
    png = raw[offset:]
    if (len(png) < 33 or not png.startswith(PNG) or png[8:16] != b'\x00\x00\x00\x0dIHDR'
            or png[24:29] != b'\x10\x00\x00\x00\x00'):
        raise ValueError('16-bit single-channel noninterlaced PNG required')
    width, height = struct.unpack('>II', png[16:24])
    raster(width, height)  # checked before invoking the native decoder
    image = cv2.imdecode(np.frombuffer(png, np.uint8), cv2.IMREAD_UNCHANGED)
    if image is None or image.dtype != np.uint16 or image.shape != (height, width):
        raise ValueError('depth PNG decode failed')
    if encoding == '16UC1':
        return image.astype(np.float32)*.001
    if offset != 12:
        raise ValueError('32FC1 needs compressedDepth inverse-depth parameters')
    mode, a, b = struct.unpack('<iff', raw[:12])
    if mode != 0 or not math.isfinite(a) or not math.isfinite(b) or a <= 0:
        raise ValueError('invalid inverse-depth parameters')
    valid = (image != 0) & (image > b)
    result = np.full(image.shape, np.nan, dtype=np.float32)
    result[valid] = a/(image[valid].astype(np.float32)-b)
    return result


def colour(message, low=.2, high=5.):
    import cv2
    import numpy as np
    low, high = limits(low, high)
    image = compressed_depth(message) if hasattr(message, 'format') else raw_depth(message)
    height, width = image.shape
    scale = min(1., 640/width, 360/height)
    width, height = max(1, int(width*scale)), max(1, int(height*scale))
    image = cv2.resize(image, (width, height), interpolation=cv2.INTER_NEAREST)
    valid = np.isfinite(image) & (image > 0)
    bounded = np.where(valid, np.clip(image, low, high), high)
    indices = np.rint(255*(high-bounded)/(high-low)).astype(np.uint8)
    coloured = cv2.applyColorMap(indices, cv2.COLORMAP_TURBO)
    coloured[~valid] = 0
    frame = getattr(getattr(message, 'header', None), 'frame_id', '')
    if not isinstance(frame, str) or not re.fullmatch(r'[A-Za-z0-9_/-]{1,128}', frame):
        frame = 'depth_camera'
    for quality in (75, 60, 45, 30, 20, 10):
        ok, encoded = cv2.imencode('.jpg', coloured, [cv2.IMWRITE_JPEG_QUALITY, quality])
        if ok and len(encoded) <= 65536:
            return dict(t='media.video', source='go2_depth', frame=frame, mime='image/jpeg',
                        width=width, height=height, jpeg=base64.b64encode(encoded).decode('ascii'),
                        depth_min_m=low, depth_max_m=high), None
    raise ValueError('depth JPEG exceeds bounds')
