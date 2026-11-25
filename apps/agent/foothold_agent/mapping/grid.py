"""Python port of web/occgrid.ts; no transport or motion interfaces.

The conservative default projects obstacles only. Ray clearing requires an
explicitly verified current scan and a matching sensor origin.
"""
import math
import time

GRID_RES, GRID_N, RANGE_M, GRID_PTS = .05, 2000, 10, 8000
FLOOR_DZ, OBST_DZ, TOP_DZ = -.3, .15, 1.
L_FREE, L_OCC, L_LIM, SHOW_FREE, SHOW_OCC = -4, 22, 40, -10, 15


def cell_state(value):
    return 1 if value < SHOW_FREE else 2 if value > SHOW_OCC else 0


class OccGrid:
    def __init__(self, size=GRID_N, *, mode='projection', now=time.monotonic):
        if mode not in ('projection', 'scan') or not 1 <= size <= GRID_N:
            raise ValueError('invalid grid configuration')
        self.size, self.mode, self.now = size, mode, now
        self._L = None
        self.c0 = self.r0 = 0
        self.ready = False
        self.cursor = 0
        self.truncated = False
        self.dirty = set()

    @property
    def L(self):
        if self._L is None:
            import numpy as np
            self._L=np.zeros(self.size*self.size,dtype=np.int8)
        return self._L

    def at(self, x, y):
        c, r = math.floor(x / GRID_RES) - self.c0, math.floor(y / GRID_RES) - self.r0
        return r * self.size + c if self.ready and 0 <= c < self.size and 0 <= r < self.size else -1

    def add(self, points, pose, cap=GRID_PTS, budget_ms=20):
        import numpy as np
        L=self.L
        if cap < 1 or budget_ms <= 0:
            raise ValueError('invalid grid budget')
        points = np.asarray(points, dtype=np.float32)
        px, py, pz = pose
        if not self.ready:
            self.c0, self.r0 = math.floor(px / GRID_RES) - self.size // 2, math.floor(py / GRID_RES) - self.size // 2
            self.ready = True
        sc, sr = math.floor(px / GRID_RES) - self.c0, math.floor(py / GRID_RES) - self.r0
        if not 0 <= sc < self.size or not 0 <= sr < self.size:
            self.truncated=True
            return 0
        step = max(1, math.ceil(len(points) / cap))
        m = math.ceil(len(points) / step)
        passes = math.ceil(m / 64)
        q = self.cursor % m if m else 0
        ps = q % passes if passes else 0
        start, touched, processed = self.now(), {}, 0
        clipped=False
        hit_z = float(np.float32(pz + FLOOR_DZ + OBST_DZ))
        for j in range(m):
            if j & 7 == 7 and (self.now() - start) * 1000 > budget_ms:
                self.cursor = q
                break
            x, y, z = map(float, points[q * step])
            q += passes
            if q >= m:
                ps = ps + 1 if ps + 1 < passes else 0
                q = ps
            processed += 1
            if (not all(map(math.isfinite, (x, y, z))) or z > pz + TOP_DZ
                    or self.mode == 'scan' and (x-px)**2 + (y-py)**2 > RANGE_M**2):
                continue
            ec, er = math.floor(x / GRID_RES) - self.c0, math.floor(y / GRID_RES) - self.r0
            clipped |= not (0<=ec<self.size and 0<=er<self.size)
            hit = 2 if z >= hit_z else 1
            if self.mode == 'projection':
                if hit == 2 and 0 <= ec < self.size and 0 <= er < self.size:
                    index = er * self.size + ec
                    if index not in touched:
                        touched[index] = True
                        old_state = cell_state(int(L[index]))
                        L[index] = min(L_LIM, int(L[index]) + L_OCC)
                        if cell_state(int(L[index])) != old_state:
                            self.dirty.add(index)
                continue
            c, r = sc, sr
            dc, dr, ic, ir = abs(ec-sc), -abs(er-sr), 1 if sc < ec else -1, 1 if sr < er else -1
            e = dc + dr
            while 0 <= c < self.size and 0 <= r < self.size:
                last = c == ec and r == er
                index = r * self.size + c
                value = hit if last else 1
                previous = touched.get(index)
                old_state = cell_state(int(L[index]))
                if previous is None:
                    old = int(L[index])
                    touched[index] = old, value
                    L[index] = max(-L_LIM, min(L_LIM, old + (L_OCC if value == 2 else L_FREE)))
                elif value > previous[1]:
                    touched[index] = previous[0], value
                    L[index] = min(L_LIM, previous[0] + L_OCC)
                if cell_state(int(L[index])) != old_state:
                    self.dirty.add(index)
                if last:
                    break
                e2 = 2 * e
                if e2 >= dr:
                    e += dr
                    c += ic
                if e2 <= dc:
                    e += dc
                    r += ir
        self.truncated = processed < m or step > 1 or clipped
        return processed

    def metadata(self):
        return dict(resolution=GRID_RES, width=self.size, height=self.size,
                    origin=[self.c0 * GRID_RES, self.r0 * GRID_RES], mode=self.mode)
