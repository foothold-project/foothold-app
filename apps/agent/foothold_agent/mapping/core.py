"""Bounded, synthetic-testable point accumulation. NumPy is optional/lazy."""
from collections import deque
import json
import math
import struct
import time
from uuid import UUID

MAX_POINTS = 2_000_000
MAX_PREVIEW = 65536


def rotation(quaternion):
    import numpy as np
    q = np.asarray(quaternion, dtype=float)
    if q.shape != (4,) or not np.isfinite(q).all() or not .9 <= float(np.linalg.norm(q)) <= 1.1:
        raise ValueError('invalid orientation')
    w, x, y, z = q / np.linalg.norm(q)
    return np.array([[1-2*(y*y+z*z), 2*(x*y-z*w), 2*(x*z+y*w)],
                     [2*(x*y+z*w), 1-2*(x*x+z*z), 2*(y*z-x*w)],
                     [2*(x*z-y*w), 2*(y*z+x*w), 1-2*(x*x+y*y)]])


class Accumulator:
    def __init__(self, *, now=time.monotonic, max_points=MAX_POINTS, extrinsic=(0.,)*6):
        self.now, self.max_points = now, max_points
        self.extrinsic = extrinsic
        self.session_id = self.floor_id = None
        self.status = 'CANCELLED'
        self.error_code = self.reason = None
        self.cells = {}
        self.path = deque(maxlen=4096)
        self.robot = None
        self.distance = 0.
        self.started = self.now()
        self.last_cloud_stamp = -1
        self.last_pose = None

    def command(self, frame):
        if set(frame) != {'t', 'op', 'session_id', 'floor_id'} or frame['t'] != 'slam':
            return False
        try:
            sid, fid = str(UUID(frame['session_id'])), str(UUID(frame['floor_id']))
        except (TypeError, ValueError, AttributeError):
            return False
        op = frame['op']
        if op == 'start':
            if self.session_id == sid:
                return self.floor_id == fid  # idempotent; never reset a live cloud
            if self.status in ('RUNNING', 'SAVING', 'FAILED'):
                return False
            self.session_id, self.floor_id = sid, fid
            self.cells.clear()
            self.path.clear()
            self.distance, self.robot, self.last_pose = 0., None, None
            self.last_cloud_stamp = -1
            self.started, self.status = self.now(), 'RUNNING'
        elif self.session_id == sid and self.floor_id == fid and op == 'save':
            if self.status not in ('RUNNING', 'FAILED', 'SAVING'):
                return False
            self.status = 'SAVING'
        elif self.session_id == sid and self.floor_id == fid and op == 'cancel':
            if self.status == 'SAVED':
                return False
            self.status = 'CANCELLED'
            self.cells.clear()
            self.path.clear()
        else:
            return False
        self.error_code = self.reason = None
        return True

    def fail(self, code, reason):
        if self.status not in ('SAVED', 'CANCELLED'):
            self.status, self.error_code, self.reason = 'FAILED', code, reason

    def add(self, xyz, position, quaternion, *, stamp, frame='lidar_link'):
        import numpy as np
        if self.status != 'RUNNING' or stamp <= self.last_cloud_stamp:
            return
        cloud = np.asarray(xyz, dtype=float)
        position = np.asarray(position, dtype=float)
        if (cloud.ndim != 2 or cloud.shape[1] != 3 or len(cloud) > 100000 or
                position.shape != (3,) or not np.isfinite(position).all() or np.max(np.abs(position)) > 10000):
            raise ValueError('invalid cloud or pose')
        pos = tuple(map(float, position))
        if self.last_pose is not None and math.dist(pos[:2], self.last_pose[:2]) > 2:
            self.fail('ODOMETRY_JUMP', '로봇 위치가 크게 바뀌었습니다. 만든 지도를 확인한 뒤 저장하거나 취소해 주세요.')
            return
        r = rotation(quaternion)
        if frame not in ('lidar_link', 'odom'):
            raise ValueError('invalid accumulation frame')
        x, y, z, roll, pitch, yaw = self.extrinsic
        # Euler XYZ mount calibration, explicit meters/radians.
        cr, sr, cp, sp, cy, sy = math.cos(roll), math.sin(roll), math.cos(pitch), math.sin(pitch), math.cos(yaw), math.sin(yaw)
        mount = np.array([[cy*cp, cy*sp*sr-sy*cr, cy*sp*cr+sy*sr],
                          [sy*cp, sy*sp*sr+cy*cr, sy*sp*cr-cy*sr], [-sp, cp*sr, cp*cr]])
        cloud = cloud[np.isfinite(cloud).all(axis=1)]
        # Preserve floor points, but omit returns inside the robot's envelope.
        ranges = np.linalg.norm(cloud-position if frame == 'odom' else cloud, axis=1)
        cloud = cloud[(ranges >= .3) & (ranges <= 40)]
        world = cloud if frame == 'odom' else (cloud @ mount.T + np.array([x, y, z])) @ r.T + position
        if not np.isfinite(world).all() or (world.size and np.max(np.abs(world)) > 10000):
            raise ValueError('point range exceeded')
        keys = np.floor(world / .05).astype('int64')
        _, indices = np.unique(keys, axis=0, return_index=True)
        for index in indices:
            key = tuple(map(int, keys[index]))
            if key not in self.cells:
                if len(self.cells) >= self.max_points:
                    self.fail('MAPPING_LIMIT', '지도 크기 한도에 도달했습니다. 지금까지 만든 지도를 저장해 주세요.')
                    break
                self.cells[key] = tuple(map(float, world[index]))
        pos = tuple(map(float, position))
        if self.last_pose is not None:
            delta = math.dist(pos[:2], self.last_pose[:2])
            self.distance += delta
        self.last_pose = pos
        self.robot = [pos[0], pos[1], math.atan2(r[1, 0], r[0, 0])]
        if not self.path or math.dist(pos[:2], self.path[-1]) >= .05:
            self.path.append(pos[:2])
        self.last_cloud_stamp = stamp

    def preview(self):
        resolution = .1
        values = list(self.cells.values())
        floor = min((p[2] for p in values), default=0.)
        # Only a bounded subsample is projected; memory/work remains bounded.
        values = values[::max(1, math.ceil(len(values)/20000))]
        for _ in range(11):
            cells = {(math.floor(p[0]/resolution), math.floor(p[1]/resolution)) for p in values if p[2] > floor+.15}
            if len(cells) <= 2000:
                break
            resolution = min(100., resolution * 2)
        path = list(self.path)
        if len(path) > 256:
            path = [path[round(i*(len(path)-1)/255)] for i in range(256)]
        return dict(resolution=min(resolution, 100.), cells=sorted(cells)[:2000],
                    robot=self.robot, path=path)

    def report(self):
        if self.session_id is None:
            return None
        body = dict(t='slam.update', session_id=self.session_id, floor_id=self.floor_id,
            status=self.status, distance_m=self.distance, point_count=len(self.cells),
            elapsed_s=max(0., self.now()-self.started), error_code=self.error_code, reason=self.reason,
            preview=self.preview())
        while len(json.dumps(body, ensure_ascii=False, allow_nan=False).encode()) > MAX_PREVIEW:
            body['preview']['cells'] = body['preview']['cells'][::2]
            body['preview']['path'] = body['preview']['path'][::2]
        return body

    def pcd(self):
        if not self.cells:
            raise ValueError('empty cloud')
        count = len(self.cells)
        header = (f'VERSION .7\nFIELDS x y z\nSIZE 4 4 4\nTYPE F F F\nCOUNT 1 1 1\n'
                  f'WIDTH {count}\nHEIGHT 1\nPOINTS {count}\nDATA binary\n').encode()
        return header + b''.join(struct.pack('<fff', *p) for p in self.cells.values())
