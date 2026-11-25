"""Bounded ROS PointCloud2 decoding independent of SLAM provider."""
import math
import struct
MAX_INPUT_BYTES=16_000_000
FORMATS={1:'b',2:'B',3:'h',4:'H',5:'i',6:'I',7:'f',8:'d'}
class InvalidSample(ValueError): pass

def decode(message, *, max_points=8000, sample_start=0, sample_limit=None, **ignored):
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
    take = min(max_points, count)
    layout = [axes[axis] for axis in 'xyz']
    payload = bytearray()
    for sample in range(sample_start, take if sample_limit is None else min(take,sample_start+sample_limit)):
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
    return dict(count=len(payload)//12, truncated=take<count), bytes(payload)
