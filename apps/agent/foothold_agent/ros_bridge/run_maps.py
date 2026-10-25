"""Local PNG/PGM byte and raster evidence loaded once, outside the safety loop."""
import hashlib
import json
import math
from pathlib import Path
import re
import struct
import zlib


def raster(png):
    if png[:8] != b'\x89PNG\r\n\x1a\n':
        raise ValueError('invalid map PNG')
    offset, compressed, dimensions = 8, bytearray(), None
    while offset < len(png):
        size, = struct.unpack('!I', png[offset:offset+4])
        kind, value = png[offset+4:offset+8], png[offset+8:offset+8+size]
        crc, = struct.unpack('!I', png[offset+8+size:offset+12+size])
        if zlib.crc32(kind+value) != crc:
            raise ValueError('map PNG CRC')
        if kind == b'IHDR':
            w, h, depth, color, compression, filtering, interlace = struct.unpack('!IIBBBBB', value)
            if not 1 <= w <= 4096 or not 1 <= h <= 4096 or (depth, color, compression, filtering, interlace) != (8,0,0,0,0):
                raise ValueError('map must be grayscale8 PNG')
            dimensions = (w,h)
        elif kind == b'IDAT':
            compressed.extend(value)
        offset += size+12
    if dimensions is None:
        raise ValueError('missing map dimensions')
    w,h = dimensions
    decoder = zlib.decompressobj()
    raw = decoder.decompress(compressed, (w+1)*h+1)
    if len(raw) != (w+1)*h or not decoder.eof or decoder.unused_data:
        raise ValueError('map raster size')
    pixels, prior = bytearray(), bytearray(w)
    for y in range(h):
        start = y*(w+1)
        filtering, row = raw[start], bytearray(raw[start+1:start+w+1])
        for x in range(w):
            a,b,c = row[x-1] if x else 0, prior[x], prior[x-1] if x else 0
            if filtering == 0: predictor = 0
            elif filtering == 1: predictor = a
            elif filtering == 2: predictor = b
            elif filtering == 3: predictor = (a+b)//2
            elif filtering == 4:
                p = a+b-c
                predictor = min(((abs(p-a),0,a),(abs(p-b),1,b),(abs(p-c),2,c)))[2]
            else: raise ValueError('map PNG filter')
            row[x] = (row[x]+predictor)%256
        pixels.extend(row)
        prior = row
    return w,h,bytes(pixels)


class RunMaps:
    def __init__(self, floors, assets):
        self.floors, self.assets = floors, {}
        if floors is None:
            return
        for asset in assets:
            version = asset['map_version_id']
            if version in self.assets:
                raise ValueError('duplicate local map asset')
            png = self._read(asset['image_path'])
            pgm = self._read(asset['pgm_path'])
            w,h,pixels = raster(png)
            header = re.match(rb'P5\s+(\d+)\s+(\d+)\s+255\r?\n', pgm)
            if header is None or (int(header[1]),int(header[2])) != (w,h) or pgm[header.end():] != pixels:
                raise ValueError('PNG/PGM raster mismatch')
            table = bytes(100 if i == 0 else 0 if i == 254 else 255 for i in range(256))
            # Native GT raster uses exactly these values. Unknown never becomes free.
            if set(pixels) - {0,205,254}:
                raise ValueError('unsupported occupancy encoding')
            occupancy = b''.join(pixels[y*w:(y+1)*w] for y in range(h-1,-1,-1)).translate(table)
            self.assets[version] = dict(image_sha256=hashlib.sha256(png).hexdigest(),
                source_pgm_sha256=hashlib.sha256(pgm).hexdigest(), width=w,height=h,
                occupancy_sha256=hashlib.sha256(occupancy).hexdigest())

    @staticmethod
    def _read(path):
        with Path(path).open('rb') as source:
            data = source.read(20*1024*1024+1)
        if len(data) > 20*1024*1024:
            raise ValueError('map asset too large')
        return data

    @classmethod
    def from_env(cls, floors, env):
        raw = env.get('FOOTHOLD_RUN_MAP_ASSETS_JSON', '[]')
        if len(raw) > 65536:
            raise ValueError('map assets configuration too large')
        return cls(floors, json.loads(raw))

    def matches(self, request, plan, snapshot, grid):
        p = getattr(plan, 'map_proof', None)
        c = snapshot.get('floor_context')
        if not p or not c or not self.floors or c.get('current_floor_id') not in self.floors.bindings:
            return False
        b = self.floors.bindings[c['current_floor_id']]
        asset = self.assets.get(request['map_version_id'])
        expected = {k:b[k] for k in ('floor_id','map_version_id','source_pgm_sha256','origin','resolution','width','height','source','world_id','ros_floor_id')}
        expected['image_sha256'] = b['sha256']
        return (p == expected and asset is not None
                and all(p[k] == asset[k] for k in ('image_sha256','source_pgm_sha256','width','height'))
                and c.get('run_id') == self.floors.run_id and c.get('epoch') == (snapshot.get('observation') or {}).get('episode')
                and c.get('floor_state') == 'on_floor'
                and all(c.get(k) == p[k] for k in ('floor_id','map_version_id','source_pgm_sha256','world_id'))
                and c.get('sha256') == p['image_sha256']
                and grid is not None and grid.get('sha256') == asset['occupancy_sha256']
                and (grid['width'],grid['height']) == (p['width'],p['height'])
                and abs(grid['resolution']-p['resolution']) <= 1e-7
                and all(abs(a-b) <= 1e-7 for a,b in zip(grid['origin'],p['origin'])))
