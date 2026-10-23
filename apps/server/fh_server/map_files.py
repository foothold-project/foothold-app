"""Bounded map codecs. No user filename/path is ever used as a storage path."""
import hashlib
import math
import re
import struct
import zlib

MAX_IMAGE = 8 * 1024 * 1024
MAX_YAML = 16 * 1024
MAX_DIMENSION = 4096
MAX_DECODED = 32 * 1024 * 1024
DECODE_CHUNK = 64 * 1024
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
        values = (item[0] for item in struct.iter_unpack('!H', raster)) if maximum > 255 else iter(raster)
    else:
        values = (int(token()) for _ in range(count))
    pixels = bytearray()
    for value in values:
        if not 0 <= value <= maximum:
            raise ValueError('PGM 픽셀 값이 범위를 벗어났습니다.')
        pixels.append(round(value * 255 / maximum))
    if magic == b'P2':
        remaining = re.sub(rb'#[^\r\n]*', b'', data[position:])
        if remaining.strip():
            raise ValueError('PGM 픽셀이 너무 많습니다.')
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
        if end > len(data):
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
    if expected > MAX_DECODED:
        raise ValueError('PNG 해제 데이터는 32 MiB 이하여야 합니다.')
    decoder = zlib.decompressobj()
    pending = bytes(compressed)
    total, pass_index, rows_left, row_size, row_offset = 0, 0, rows[0][1], rows[0][0], 0
    while True:
        raw = decoder.decompress(pending, DECODE_CHUNK)
        if len(raw) > DECODE_CHUNK:
            raise ValueError('PNG 해제 조각이 상한을 넘었습니다.')
        total += len(raw)
        if total > expected:
            raise ValueError('PNG 픽셀 데이터가 치수를 넘었습니다.')
        position = 0
        while position < len(raw):
            if row_offset == 0 and raw[position] > 4:
                raise ValueError('PNG 필터가 올바르지 않습니다.')
            count = min(len(raw) - position, row_size + 1 - row_offset)
            row_offset += count
            position += count
            if row_offset == row_size + 1:
                row_offset = 0
                rows_left -= 1
                if rows_left == 0:
                    pass_index += 1
                    if pass_index < len(rows):
                        row_size, rows_left = rows[pass_index]
        pending = decoder.unconsumed_tail
        if decoder.eof:
            break
        if not pending and not raw:
            break
    if total != expected or not decoder.eof or decoder.unused_data or decoder.unconsumed_tail:
        raise ValueError('PNG 픽셀 데이터 길이가 올바르지 않습니다.')
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


def gray_pixels(data):
    """Decode only the generator's bounded noninterlaced 8-bit grayscale PNG."""
    _, width, height = png_image(data)
    if struct.unpack('!IIBBBBB', data[16:29])[2:] != (8, 0, 0, 0, 0):
        raise ValueError('Static maps require 8-bit grayscale noninterlaced PNG')
    offset, compressed = 8, bytearray()
    while offset < len(data):
        size = struct.unpack('!I', data[offset:offset + 4])[0]
        if data[offset + 4:offset + 8] == b'IDAT':
            compressed.extend(data[offset + 8:offset + 8 + size])
        offset += size + 12
    raw = zlib.decompress(compressed)  # png_image already checked decoded size.
    pixels, prior = bytearray(), bytearray(width)
    for y in range(height):
        start = y * (width + 1)
        filtering, row = raw[start], bytearray(raw[start + 1:start + width + 1])
        for x in range(width):
            a, b, c = row[x - 1] if x else 0, prior[x], prior[x - 1] if x else 0
            if filtering == 0:
                predictor = 0
            elif filtering == 1:
                predictor = a
            elif filtering == 2:
                predictor = b
            elif filtering == 3:
                predictor = (a + b) // 2
            elif filtering == 4:
                p = a + b - c
                predictor = min(((abs(p - a), 0, a), (abs(p - b), 1, b), (abs(p - c), 2, c)))[2]
            else:
                raise ValueError('Invalid PNG filter')
            row[x] = (row[x] + predictor) % 256
        pixels.extend(row)
        prior = row
    return width, height, pixels
