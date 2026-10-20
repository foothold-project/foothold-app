"""Synthetic in-memory codec probes; no maps are checked into the repository."""
import struct
import zlib
import pytest
from apps.server.fh_server.map_files import chunk, gray_png, image_bytes, map_yaml, PNG_MAGIC
from .test_maps import YAML


def png(width, height, raw, *, depth=8, color=0, interlace=0):
    return PNG_MAGIC + chunk(b'IHDR', struct.pack('!IIBBBBB', width, height, depth, color, 0, 0, interlace)) + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b'')


@pytest.mark.parametrize('data', [
    png(0, 1, b'\0\0'), png(4097, 1, b'\0\0'), png(1, 1, b'\0'),
    png(1, 1, b'\0\0\0'), png(1, 1, b'\5\0'), png(1, 1, b'\0\0', color=3),
    png(1, 1, b'\0\0', color=7), gray_png(1, 1, b'\0') + b'junk',
    gray_png(1, 1, b'\0')[:-12], b'\x89PNG\r\n\x1a\n',
])
def test_png_structure_and_decompressed_limits(data):
    with pytest.raises(ValueError):
        image_bytes(data, 'image/png')


@pytest.mark.parametrize('data', [
    b'P2\n# synthetic\n2 1\n255\n0 255\n', b'P5\n2 1\n255\n# ',
    b'P5\r\n2 1\r\n65535\r\n\x00\x00\xff\xff',
])
def test_pgm_supported_encodings_and_raster_delimiter(data):
    converted, width, height = image_bytes(data, 'image/x-portable-graymap')
    assert (width, height) == (2, 1)
    assert image_bytes(converted, 'image/png') == (converted, width, height)


def test_png_rgb_and_adam7_single_pixel():
    for color, channels in [(0, 1), (2, 3), (4, 2), (6, 4)]:
        for interlace in (0, 1):
            data = png(1, 1, b'\0' + b'\xff' * channels, color=color, interlace=interlace)
            assert image_bytes(data, 'image/png') == (data, 1, 1)


def test_yaml_supported_comments_quotes_and_mode():
    value = map_yaml(YAML.replace(b'synthetic.pgm', b'"synthetic.pgm"') + b'\n# comment\nmode: trinary\n')
    assert value['origin'] == [0., 0., 0.] and value['mode'] == 'trinary'


@pytest.mark.parametrize('suffix', [b' 123456789012345678901234567890', b' 1', b' -1'])
def test_pgm_rejects_any_trailing_non_comment_token(suffix):
    with pytest.raises(ValueError):
        image_bytes(b'P2\n1 1\n255\n0' + suffix, 'image/x-portable-graymap')


def test_yaml_negate_stays_integer_in_stored_ros_yaml():
    from apps.server.fh_server.map_files import yaml_bytes
    metadata = map_yaml(YAML)
    assert type(metadata['negate']) is int
    assert b'negate: 0\n' in yaml_bytes(metadata, 'map.png')
    with pytest.raises(ValueError):
        map_yaml(YAML.replace(b'negate: 0', b'negate: 0.0'))
