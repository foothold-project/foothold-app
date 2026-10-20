"""Bounded map codecs. No user filename/path is ever used as a storage path."""
import hashlib
import math
import re
import struct
import zlib

MAX_IMAGE = 8 * 1024 * 1024
MAX_YAML = 16 * 1024
MAX_DIMENSION = 4096
PNG_MAGIC = b'\x89PNG\r\n\x1a\n'


def dimensions(width, height):
    if not 1 <= width <= MAX_DIMENSION or not 1 <= height <= MAX_DIMENSION:
        raise ValueError('지도 치수는 1~4096 픽셀이어야 합니다.')


def chunk(kind, value):
    return struct.pack('!I', len(value)) + kind + value + struct.pack('!I', zlib.crc32(kind + value))


def gray_png(width, height, pixels):
    scanlines = b''.join(b'\0' + pixels[y * width:(y + 1) * width] for y in range(height))
    return PNG_MAGIC + chunk(b'IHDR', struct.pack('!IIBBBBB', width, height, 8, 0, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(scanlines)) + chunk(b'IEND', b'')


def pgm_png(data):
    position = 0
    def token():
        nonlocal position
        while position < len(data):
            if data[position] in b' \t\r\n\v\f':
                position += 1
            elif data[position] == 35:
                end = data.find(b'\n', position)
                position = len(data) if end < 0 else end + 1
            else:
                break
        start = position
        while position < len(data) and data[position] not in b' \t\r\n\v\f#':
            position += 1
        value = data[start:position]
        if not value or len(value) > 16:
            raise ValueError('PGM 헤더가 올바르지 않습니다.')
        return value
    magic = token()
    if magic not in (b'P2', b'P5'):
        raise ValueError('PGM 매직 바이트가 올바르지 않습니다.')
    width, height, maximum = (int(token()) for _ in range(3))
    dimensions(width, height)
    if not 1 <= maximum <= 65535:
        raise ValueError('PGM 최댓값이 올바르지 않습니다.')
    count = width * height
    if magic == b'P5':
        if position >= len(data) or data[position] not in b' \t\r\n\v\f':
            raise ValueError('PGM 픽셀 구분자가 없습니다.')
        # Consume exactly the raster delimiter: a pixel may itself be whitespace/#.
        if data[position:position + 2] == b'\r\n':
            position += 2
        else:
            position += 1
        raster = data[position:]
        if len(raster) != count * (2 if maximum > 255 else 1):
            raise ValueError('PGM 픽셀 수가 치수와 다릅니다.')
        values = struct.unpack(f'!{count}H', raster) if maximum > 255 else raster
    else:
        values = [int(token()) for _ in range(count)]
        remaining = re.sub(rb'#[^\r\n]*', b'', data[position:])
        if remaining.strip():
            raise ValueError('PGM 픽셀이 너무 많습니다.')
    if any(v > maximum or v < 0 for v in values):
        raise ValueError('PGM 픽셀 값이 범위를 벗어났습니다.')
    pixels = bytes(round(v * 255 / maximum) for v in values)
    return gray_png(width, height, pixels), width, height


def png_image(data):
    if not data.startswith(PNG_MAGIC):
        raise ValueError('PNG 매직 바이트가 올바르지 않습니다.')
    offset, width, height, header, ended = 8, None, None, None, False
    compressed = bytearray()
    palette, idat, idat_closed = False, False, False
    while offset < len(data):
        if offset + 12 > len(data):
            raise ValueError('PNG 청크가 잘렸습니다.')
        length = struct.unpack('!I', data[offset:offset + 4])[0]
        kind = data[offset + 4:offset + 8]
        end = offset + length + 12
        if end > len(data) or length > MAX_IMAGE:
            raise ValueError('PNG 청크 길이가 올바르지 않습니다.')
        value = data[offset + 8:end - 4]
        if zlib.crc32(kind + value) != struct.unpack('!I', data[end - 4:end])[0]:
            raise ValueError('PNG CRC가 올바르지 않습니다.')
        if header is None and kind != b'IHDR':
            raise ValueError('PNG 헤더가 없습니다.')
        if kind == b'IHDR':
            if header is not None or length != 13:
                raise ValueError('PNG 헤더가 올바르지 않습니다.')
            width, height, depth, color, compression, filtering, interlace = struct.unpack('!IIBBBBB', value)
            dimensions(width, height)
            allowed = {0: (1, 2, 4, 8, 16), 2: (8, 16), 3: (1, 2, 4, 8), 4: (8, 16), 6: (8, 16)}
            if depth not in allowed.get(color, ()) or compression or filtering or interlace not in (0, 1):
                raise ValueError('PNG 색 형식이 올바르지 않습니다.')
            header = depth, color, interlace
        elif kind == b'PLTE':
            if palette or idat or not length or length % 3 or length > 768 or color in (0, 4):
                raise ValueError('PNG 팔레트가 올바르지 않습니다.')
            palette = True
        elif kind == b'IDAT':
            if idat_closed or (color == 3 and not palette):
                raise ValueError('PNG 이미지 청크 순서가 올바르지 않습니다.')
            compressed.extend(value)
            idat = True
        elif kind == b'IEND':
            if length or not idat or end != len(data):
                raise ValueError('PNG 끝이 올바르지 않습니다.')
            ended = True
            break
        elif kind[0] & 32 == 0:
            raise ValueError('지원하지 않는 PNG 필수 청크입니다.')
        if idat and kind != b'IDAT':
            idat_closed = True
        offset = end
    if not ended:
        raise ValueError('PNG 끝 청크가 없습니다.')
    depth, color, interlace = header
    channels = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[color]
    # Adam7 passes, including packed 1/2/4-bit and 16-bit scanlines.
    passes = [(0, 0, 1, 1)] if not interlace else [(0, 0, 8, 8), (4, 0, 8, 8), (0, 4, 4, 8), (2, 0, 4, 4), (0, 2, 2, 4), (1, 0, 2, 2), (0, 1, 1, 2)]
    rows = []
    expected = 0
    for x, y, dx, dy in passes:
        w, h = max(0, (width - x + dx - 1) // dx), max(0, (height - y + dy - 1) // dy)
        if not w or not h:
            continue
        row_size = (w * channels * depth + 7) // 8
        rows.append((row_size, h))
        expected += (row_size + 1) * h
    decoder = zlib.decompressobj()
    raw = decoder.decompress(compressed, expected + 1)
    if len(raw) != expected or not decoder.eof or decoder.unused_data or decoder.unconsumed_tail:
        raise ValueError('PNG 픽셀 데이터 길이가 올바르지 않습니다.')
    position = 0
    for size, count in rows:
        for _ in range(count):
            if raw[position] > 4:
                raise ValueError('PNG 필터가 올바르지 않습니다.')
            position += size + 1
    return data, width, height


def image_bytes(data, content_type):
    if len(data) > MAX_IMAGE:
        raise ValueError('지도 이미지는 8 MiB 이하여야 합니다.')
    try:
        if content_type == 'image/png':
            return png_image(data)
        if content_type == 'image/x-portable-graymap':
            return pgm_png(data)
    except (ValueError, OverflowError, struct.error, zlib.error) as exc:
        raise ValueError('지도 이미지 형식·치수·픽셀을 확인하세요.') from exc
    raise ValueError('PNG 또는 PGM 이미지를 올려 주세요.')


NUMBER = r'[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?'


def map_yaml(data):
    """A deliberately small ROS map YAML grammar, not a general YAML interpreter."""
    if len(data) > MAX_YAML:
        raise ValueError('지도 YAML은 16 KiB 이하여야 합니다.')
    try:
        lines = data.decode('utf-8').splitlines()
    except UnicodeError as exc:
        raise ValueError('YAML은 UTF-8이어야 합니다.') from exc
    found = {}
    allowed = {'image', 'resolution', 'origin', 'negate', 'occupied_thresh', 'free_thresh', 'mode'}
    for line in lines:
        line = line.split('#', 1)[0].rstrip()
        if not line:
            continue
        match = re.fullmatch(r'([a-z_]+):\s*(.+)', line)
        if not match or match[1] not in allowed or match[1] in found:
            raise ValueError('YAML 키·줄 형식·중복을 확인하세요.')
        key, value = match.groups()
        if key == 'origin':
            match = re.fullmatch(r'\[\s*(' + NUMBER + r')\s*,\s*(' + NUMBER + r')\s*,\s*(' + NUMBER + r')\s*\]', value)
            if not match:
                raise ValueError('YAML origin은 [x, y, yaw] 숫자 3개여야 합니다.')
            parsed = [float(v) for v in match.groups()]
        elif key in ('image', 'mode'):
            # Plain/quoted basename or mode only. Paths, tags, anchors and aliases are rejected.
            match = re.fullmatch(r"(?:([A-Za-z0-9_.-]+)|'([A-Za-z0-9_.-]+)'|\"([A-Za-z0-9_.-]+)\")", value)
            if not match:
                raise ValueError('YAML 문자열 형식이 올바르지 않습니다.')
            parsed = next(v for v in match.groups() if v is not None)
            if key == 'image' and (parsed in ('.', '..') or not parsed.lower().endswith(('.png', '.pgm'))):
                raise ValueError('YAML image는 PNG/PGM 파일 이름이어야 합니다.')
            if key == 'mode' and parsed not in ('trinary', 'scale', 'raw'):
                raise ValueError('YAML mode가 올바르지 않습니다.')
        elif key == 'negate':
            if value not in ('0', '1'):
                raise ValueError('YAML negate는 0 또는 1이어야 합니다.')
            parsed = int(value)
        else:
            if not re.fullmatch(NUMBER, value):
                raise ValueError('YAML 값은 유한한 숫자여야 합니다.')
            parsed = float(value)
        values = parsed if isinstance(parsed, list) else [parsed]
        if any(isinstance(v, float) and not math.isfinite(v) for v in values):
            raise ValueError('YAML 값은 유한한 숫자여야 합니다.')
        found[key] = parsed
    required = {'resolution', 'origin', 'negate', 'occupied_thresh', 'free_thresh'}
    if not required <= found.keys():
        raise ValueError('YAML 필수 키가 없습니다.')
    if not 0 < found['resolution'] <= 100 or found['negate'] not in (0, 1) or not 0 <= found['free_thresh'] < found['occupied_thresh'] <= 1:
        raise ValueError('YAML 해상도·반전·임계값을 확인하세요.')
    return found


def yaml_bytes(metadata, image_name):
    lines = [f'image: {image_name}']
    for key in ('resolution', 'origin', 'negate', 'occupied_thresh', 'free_thresh', 'mode'):
        if key in metadata:
            lines.append(f'{key}: {metadata[key]}')
    return ('\n'.join(lines) + '\n').encode()


def sha256(data):
    return hashlib.sha256(data).digest()
