"""Bounded world-coordinate accumulation using the existing map session core."""
import math
import time

from .core import Accumulator, rotation
from .grid import OccGrid


class WorldAccumulator(Accumulator):
    def __init__(self, *, frame, mode='projection', budget_ms=30, cap=8000, **kwargs):
        super().__init__(**kwargs)
        if not 1 <= cap <= 100000 or not 1 <= budget_ms <= 100:
            raise ValueError('invalid calculation limit')
        self.mode, self.frame, self.budget_ms, self.cap = mode, frame, budget_ms, cap
        self.version = 0
        self.grid = OccGrid(mode=mode, now=self.now)
        self.added, self.removed = set(), set()
        self.truncated = False
        self.floor_z = None  # One height anchor for every report in this revision.

    def command(self, frame):
        previous = self.session_id
        accepted = super().command(frame)
        if accepted and frame['op'] == 'start' and previous != self.session_id:
            self.version = 0
            self.grid = OccGrid(mode=self.mode, now=self.now)
            self.added, self.removed = set(), set()
            self.truncated = False
            self.floor_z = None
        return accepted

    def add_world(self, xyz, position, quaternion, *, stamp, frame, replace=False, complete_chunk=False):
        import numpy as np
        if frame != self.frame or type(stamp) is not int or stamp <= 0:
            raise ValueError('invalid world frame or stamp')
        if not replace and stamp <= self.last_cloud_stamp:
            raise ValueError('non_increasing_stamp')
        cloud = np.asarray(xyz, dtype=np.float32)
        if (cloud.ndim != 2 or cloud.shape[1] != 3 or len(cloud) > 1_400_000
                or len(position) != 3 or not all(math.isfinite(v) and -10000<=v<10000 for v in position)):
            raise ValueError('invalid world input')
        r = rotation(quaternion)
        started = self.now()
        step = max(1, math.ceil(len(cloud) / self.cap))
        sample = cloud[::step]
        sample = sample[np.isfinite(sample).all(axis=1)]
        if not complete_chunk and len(sample)>64:
            passes=math.ceil(len(sample)/64)
            sample=sample[[i for p in range(passes) for i in range(p,len(sample),passes)]]
        if sample.size and (np.max(sample)>=10000 or np.min(sample)<-10000):
            raise ValueError('coordinate_out_of_range')
        old = self.cells if replace else None
        if replace:
            self.cells = {}
            # Full maps are accumulated history: never ray-clear from one pose.
            self.grid = OccGrid(mode='projection', now=self.now)
        else:
            self.grid.mode = self.mode
        added = set()
        self.truncated = self.truncated or step > 1
        processed = 0
        for i, point in enumerate(sample):
            if not complete_chunk and i % 64 == 0 and (self.now() - started) * 1000 > self.budget_ms / 2:
                self.truncated = True
                break
            key = tuple(math.floor(float(v) / .05) for v in point)
            if key not in self.cells:
                if len(self.cells) >= self.max_points:
                    self.truncated = True
                    break
                self.cells[key] = tuple((v + .5) * .05 for v in key)
                added.add(key)
            processed += 1
        self.grid.add(sample[:processed],position,cap=self.cap,budget_ms=float('inf') if complete_chunk else self.budget_ms/2)
        self.truncated |= self.grid.truncated
        self.version += 1
        self.added = added if old is None else self.cells.keys() - old.keys()
        self.removed = set() if old is None else old.keys() - self.cells.keys()
        self.robot = [float(position[0]), float(position[1]), math.atan2(r[1, 0], r[0, 0])]
        self.last_pose = tuple(position)
        if self.floor_z is None:
            self.floor_z = float(position[2]) - .3
        self.last_cloud_stamp = stamp
        return dict(version=self.version, added_count=len(self.added), removed_count=len(self.removed),
                    truncated=self.truncated, elapsed_ms=(self.now()-started)*1000)
