"""Local waypoint follower for the MuJoCo agent: the Nav2 action port, without ROS.

It sits where ros_bridge.run_nav.RunNav sits. ScenarioRun (the phone Hub's run
owner) submits each goal through GoalActions and NavExecutor exactly as on the
ROS path, so STOP, pause, abort, lease and arrival rules are the existing ones.
This layer only turns "go to (x, y)" into body velocity intents (vx, 0, wz):

- plan once per goal with A* on the scenario map's occupancy grid (the same
  approved map version PGM/PNG the server proves), robot radius inflated
- follow the path: turn in place when the heading error is large, otherwise
  drive forward with proportional steering
- SUCCEEDED once within `reach_m` of the goal on a fresh pose; the arrival
  proof (ScenarioRun, .5 m) is checked separately by the Hub

Velocity values stay inside SIMULATION_LIMITS (vx <= .6, |wz| <= .5). No pose
-> no intent: NavExecutor's own .3 s source deadline then fails the goal.
"""
import heapq
import math
import time

FREE, OCCUPIED = 0, 1


def wrap(angle):
    return math.atan2(math.sin(angle), math.cos(angle))


class Grid:
    """Occupancy grid in map frame. cells[row][col], row 0 = lowest y (ROS map convention)."""

    def __init__(self, cells, resolution, origin, *, inflate_m=0.3):
        self.height, self.width = len(cells), len(cells[0]) if cells else 0
        self.resolution, self.origin = float(resolution), (float(origin[0]), float(origin[1]))
        r = max(0, int(math.ceil(inflate_m / self.resolution)))
        blocked = [[c != FREE for c in row] for row in cells]
        inflated = [row[:] for row in blocked]
        offsets = [(dy, dx) for dy in range(-r, r + 1) for dx in range(-r, r + 1) if dx * dx + dy * dy <= r * r]
        for y in range(self.height):
            for x in range(self.width):
                if blocked[y][x]:
                    for dy, dx in offsets:
                        yy, xx = y + dy, x + dx
                        if 0 <= yy < self.height and 0 <= xx < self.width:
                            inflated[yy][xx] = True
        self.blocked = inflated

    @classmethod
    def from_image(cls, gray_rows, resolution, origin, *, free_thresh=.196, inflate_m=0.3, cell_m=.1):
        """gray_rows: image rows top-down, 0..255 (ROS map_server trinary, negate 0). Unknown counts as blocked.
        Planned on cell_m cells: a coarse cell is blocked if any map pixel in it is not free."""
        k = max(1, int(round(cell_m / resolution)))
        fine = [[(255 - v) / 255.0 > free_thresh for v in row] for row in reversed(gray_rows)]  # row 0 = lowest y
        height, width = (len(fine) + k - 1) // k, (len(fine[0]) + k - 1) // k
        cells = [[OCCUPIED if any(fine[y][x] for y in range(r * k, min(len(fine), r * k + k))
                                  for x in range(c * k, min(len(fine[0]), c * k + k))) else FREE
                  for c in range(width)] for r in range(height)]
        return cls(cells, resolution * k, origin, inflate_m=inflate_m)

    def cell(self, x, y):
        return (int(math.floor((y - self.origin[1]) / self.resolution)),
                int(math.floor((x - self.origin[0]) / self.resolution)))

    def center(self, row, col):
        return (self.origin[0] + (col + .5) * self.resolution, self.origin[1] + (row + .5) * self.resolution)

    def free(self, row, col):
        return 0 <= row < self.height and 0 <= col < self.width and not self.blocked[row][col]

    def nearest_free(self, row, col, limit=20):
        if self.free(row, col):
            return row, col
        for radius in range(1, limit + 1):
            for dy in range(-radius, radius + 1):
                for dx in (-radius, radius) if abs(dy) != radius else range(-radius, radius + 1):
                    if self.free(row + dy, col + dx):
                        return row + dy, col + dx
        return None

    def plan(self, start, goal):
        """A* (8-neighbour) from start (x, y) to goal (x, y). Returns [(x, y), ...] ending exactly at goal, or None."""
        s = self.nearest_free(*self.cell(*start))
        g = self.nearest_free(*self.cell(*goal))
        if s is None or g is None:
            return None
        steps = [(-1, 0, 1.), (1, 0, 1.), (0, -1, 1.), (0, 1, 1.),
                 (-1, -1, math.sqrt(2)), (-1, 1, math.sqrt(2)), (1, -1, math.sqrt(2)), (1, 1, math.sqrt(2))]
        h = lambda c: math.hypot(c[0] - g[0], c[1] - g[1])
        frontier, came, cost = [(h(s), 0., s)], {s: None}, {s: 0.}
        while frontier:
            _, spent, current = heapq.heappop(frontier)
            if current == g:
                break
            if spent > cost[current]:
                continue
            for dy, dx, step in steps:
                nxt = (current[0] + dy, current[1] + dx)
                if not self.free(*nxt) or (dy and dx and not (self.free(current[0] + dy, current[1]) and self.free(current[0], current[1] + dx))):
                    continue
                new = spent + step
                if new < cost.get(nxt, float('inf')):
                    cost[nxt], came[nxt] = new, current
                    heapq.heappush(frontier, (new + h(nxt), new, nxt))
        if g not in came:
            return None
        cells, c = [], g
        while c is not None:
            cells.append(c)
            c = came[c]
        cells.reverse()
        points = [self.center(*c) for c in self.simplify(cells)]
        points[-1] = (float(goal[0]), float(goal[1]))
        return points

    def simplify(self, cells):
        """Keep a cell only where the straight line from the last kept one would cross a blocked cell."""
        if len(cells) <= 2:
            return cells
        kept, anchor = [cells[0]], 0
        for i in range(2, len(cells)):
            if not self.line_free(cells[anchor], cells[i]):
                kept.append(cells[i - 1])
                anchor = i - 1
        kept.append(cells[-1])
        return kept

    def line_free(self, a, b):
        n = max(abs(b[0] - a[0]), abs(b[1] - a[1])) * 2 or 1
        return all(self.free(round(a[0] + (b[0] - a[0]) * k / n), round(a[1] + (b[1] - a[1]) * k / n)) for k in range(n + 1))


class Follower:
    """Pure geometry: pose + path -> (vx, 0, wz) or None when the goal is reached."""

    def __init__(self, *, vmax=.6, wmax=.5, reach_m=.25, lookahead_m=.4, turn_in_place_rad=.6, k_heading=1.5):
        self.vmax, self.wmax, self.reach, self.lookahead = vmax, wmax, reach_m, lookahead_m
        self.turn_in_place, self.k = turn_in_place_rad, k_heading

    def command(self, pose, path):
        x, y, yaw = pose
        while len(path) > 1 and math.hypot(path[0][0] - x, path[0][1] - y) <= self.lookahead:
            path.pop(0)
        tx, ty = path[0]
        distance = math.hypot(tx - x, ty - y)
        if len(path) == 1 and distance <= self.reach:
            return None
        error = wrap(math.atan2(ty - y, tx - x) - yaw)
        wz = max(-self.wmax, min(self.wmax, self.k * error))
        if abs(error) > self.turn_in_place:
            return (0., 0., wz)
        remaining = distance if len(path) == 1 else max(distance, self.lookahead)
        vx = min(self.vmax, max(.2, .8 * remaining))  # SIMULATION_LIMITS vx_min_moving .2
        return (vx * max(0., math.cos(error)), 0., wz)


class LocalNav:
    """Spins on the Hub loop (same thread as hub.tick). pose() -> (episode, x, y, yaw, received_monotonic) or None."""

    def __init__(self, nav, pose, *, grids=None, follower=None, now=time.monotonic, pose_max_age_s=.2):
        self.nav, self.actions, self.pose, self.now = nav, nav.actions, pose, now
        self.grids = grids if grids is not None else {}  # map sha256 -> Grid; no grid -> straight line
        self.follower = follower or Follower()
        self.pose_max_age_s = pose_max_age_s
        self.active = self.path = self.planning = None
        self.log = []  # (event, run_id, goal_id, detail) for validation tools
        from concurrent.futures import ThreadPoolExecutor
        self.planner = ThreadPoolExecutor(max_workers=1, thread_name_prefix='mujoco-route')

    def fresh_pose(self):
        p = self.pose()
        if p is None or not 0 <= self.now() - p[4] <= self.pose_max_age_s:
            return None
        return p

    def spin(self):
        pose = self.fresh_pose()
        self.actions.health(pose is not None)
        item, cancel = self.actions.take()
        if cancel is not None:
            if cancel == self.active:
                self.active = self.path = self.planning = None
            self.actions.complete(cancel)  # no live motion source survives a cancel: nothing to wait for
            self.log.append(('cancel', cancel.run_id, cancel.goal_id, None))
        if item is not None:
            binding, point = item
            if self.active is not None:
                self.actions.complete(self.active)
            self.active, self.path, self.planning = binding, None, None
            if pose is None:
                self._finish(binding, 'ABORTED', 'NO_POSE')
                return
            grid = self.grids.get(binding.map_sha)
            goal = (point['x'], point['y'])
            if grid is None:
                self.path = [goal]
                self.log.append(('goal', binding.run_id, binding.goal_id, dict(goal=goal, path=[goal])))
            else:  # off the Hub loop; ZERO intents keep the goal's source alive meanwhile
                self.planning = (self.planner.submit(grid.plan, pose[1:3], goal), goal)
        if self.active is None:
            return
        if self.active != self.nav.binding:
            self.active = self.path = self.planning = None
            return
        if self.planning is not None:
            future, goal = self.planning
            if not future.done():
                if pose is not None and pose[0] == self.active.episode:
                    self.nav.intent(self.active, (0., 0., 0.))
                return
            self.planning = None
            path = future.result() if future.exception() is None else None
            if path is None:
                self._finish(self.active, 'ABORTED', 'NO_PATH')
                return
            self.path = list(path)
            self.log.append(('goal', self.active.run_id, self.active.goal_id, dict(goal=goal, path=list(path))))
        if self.path is None:
            return

        if pose is None or pose[0] != self.active.episode:
            return  # no intent: NavExecutor's source deadline decides, never a cached command
        velocity = self.follower.command(pose[1:4], self.path)
        if velocity is None:
            self._finish(self.active, 'SUCCEEDED', dict(pose=pose[1:4]))
            return
        self.nav.intent(self.active, velocity)

    def _finish(self, binding, result, detail):
        self.nav.feedback(binding, result)
        self.actions.complete(binding)
        self.log.append(('result', binding.run_id, binding.goal_id, dict(result=result, detail=detail)))
        self.active = self.path = self.planning = None

    def close(self):
        self.planner.shutdown(wait=False, cancel_futures=True)


def gray_png_rows(data):
    """8-bit grayscale non-interlaced PNG -> rows of ints (the server's map_files.gray_png shape)."""
    import struct
    import zlib
    if not data.startswith(b'\x89PNG\r\n\x1a\n'):
        raise ValueError('not a PNG')
    offset, idat, header = 8, [], None
    while offset < len(data):
        length, kind = struct.unpack('!I4s', data[offset:offset + 8])
        body = data[offset + 8:offset + 8 + length]
        offset += 12 + length
        if kind == b'IHDR':
            header = struct.unpack('!IIBBBBB', body)
        elif kind == b'IDAT':
            idat.append(body)
        elif kind == b'IEND':
            break
    if header is None or header[2:] != (8, 0, 0, 0, 0):
        raise ValueError('only 8-bit grayscale, non-interlaced PNG maps')
    width, height = header[:2]
    raw, rows, prev = zlib.decompress(b''.join(idat)), [], [0] * width
    for y in range(height):
        start = y * (width + 1)
        kind, line = raw[start], list(raw[start + 1:start + 1 + width])
        for x in range(width):
            a = line[x - 1] if x else 0
            b, c = prev[x], prev[x - 1] if x else 0
            if kind == 1:
                line[x] = (line[x] + a) & 255
            elif kind == 2:
                line[x] = (line[x] + b) & 255
            elif kind == 3:
                line[x] = (line[x] + (a + b) // 2) & 255
            elif kind == 4:
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                line[x] = (line[x] + (a if pa <= pb and pa <= pc else b if pb <= pc else c)) & 255
            elif kind != 0:
                raise ValueError('bad PNG filter')
        rows.append(line)
        prev = line
    return rows


class GridSource:
    """Wraps ScenarioSource.fetch: on the same worker thread, after the scenario data,
    fetch that plan's approved map image (agent endpoint), check its sha256 against the
    proof and build the planning grid. The Hub loop never blocks on HTTP."""

    def __init__(self, source, grids, *, inflate_m=.3):
        self.source, self.grids, self.inflate_m = source, grids, inflate_m
        from concurrent.futures import ThreadPoolExecutor
        self.origin, self.token = source.origin, source.token
        self.pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix='mujoco-map')  # the inner fetch has its own

    @property
    def support(self):
        return self.source.support

    @support.setter
    def support(self, value):
        self.source.support = value

    def fetch(self, request):
        inner = self.source.fetch(request)
        return self.pool.submit(self._with_grid, inner)

    def _with_grid(self, inner):
        import hashlib
        from urllib.request import Request, build_opener
        from foothold_agent.executor.photos import NoRedirect
        data = inner.result()
        proofs = data.get('map_proofs') or []
        if len(proofs) == 1 and proofs[0].get('image_sha256') not in self.grids:
            proof = proofs[0]
            url = self.origin + '/api/v1/agent/map-versions/' + str(proof['map_version_id']) + '/image'
            with build_opener(NoRedirect).open(Request(url, headers={'Authorization': 'Bearer ' + self.token}), timeout=5) as reply:
                png = reply.read(8 * 1024 * 1024 + 1)
            if hashlib.sha256(png).hexdigest() != proof['image_sha256']:
                raise ValueError('MAP_VERSION_MISMATCH')
            self.grids[proof['image_sha256']] = Grid.from_image(gray_png_rows(png), proof['resolution'],
                                                                proof['origin'], inflate_m=self.inflate_m)
        return data
