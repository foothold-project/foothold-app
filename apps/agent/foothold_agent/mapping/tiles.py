"""Oldest-first 64-cell world tiles; retries retain the latest pending version."""
from collections import OrderedDict

TILE_SIZE = 64


class Tiles:
    def __init__(self):
        self.pending = OrderedDict()
        self.versions = {}

    def changed(self, grid):
        keys = set()
        for index in grid.dirty:
            r, c = divmod(index, grid.size)
            keys.add(((grid.c0+c)//TILE_SIZE, (grid.r0+r)//TILE_SIZE))
        grid.dirty.clear()
        for key in sorted(keys):
            version = self.versions.get(key, 0) + 1
            self.versions[key] = version
            self.pending[key] = version  # updating an existing key preserves its place

    def take(self, grid, limit=4):
        if not self.pending:
            return []
        import numpy as np
        bodies = []
        for (tx, ty), version in list(self.pending.items())[:limit]:
            cells = np.zeros((TILE_SIZE, TILE_SIZE), dtype='uint8')
            c, r = tx*TILE_SIZE-grid.c0, ty*TILE_SIZE-grid.r0
            lo_c, lo_r = max(0,c), max(0,r)
            hi_c, hi_r = min(grid.size,c+TILE_SIZE), min(grid.size,r+TILE_SIZE)
            if lo_c < hi_c and lo_r < hi_r:
                values = grid.L.reshape(grid.size, grid.size)[lo_r:hi_r,lo_c:hi_c]
                cells[lo_r-r:hi_r-r,lo_c-c:hi_c-c] = np.where(values < -10, 1, np.where(values > 15, 2, 0))
            bodies.append(dict(tx=tx, ty=ty, version=version, cells=cells.ravel().tolist()))
        return bodies

    def acknowledge(self, bodies):
        for body in bodies:
            key = body['tx'], body['ty']
            if self.pending.get(key) == body['version']:
                del self.pending[key]
