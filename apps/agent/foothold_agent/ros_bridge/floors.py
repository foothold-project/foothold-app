"""Verified connected-building observations, independent of all motion gates."""
from copy import deepcopy
import json
import math
from uuid import UUID


def finite(value):
    return type(value) in (int, float) and math.isfinite(value)


def digest(value):
    return isinstance(value, str) and len(value) == 64 and all(c in '0123456789abcdef' for c in value)


class FloorBindings:
    """Immutable launch registrations; no discovery from an odom frame/floor name."""
    def __init__(self, robot_id, generation, run_id, epoch, spawn_floor_id, bindings):
        self.robot_id = str(UUID(robot_id))
        if (type(generation) is not int or generation < 1 or type(epoch) is not int or epoch < 0
                or not isinstance(run_id, str) or not 1 <= len(run_id) <= 128
                or spawn_floor_id not in ('l1', 'l2')):
            raise ValueError('invalid floor launch identity')
        self.generation, self.run_id, self.epoch, self.spawn = generation, run_id, epoch, spawn_floor_id
        self.bindings = {}
        for b in deepcopy(bindings):
            f = b['ros_floor_id']
            if (f not in ('l1', 'l2') or f in self.bindings or b['world_id'] != 'v5_building'
                    or b['source'] != 'SIMULATION' or not b['ros_building_id'] or not b['ros_map_version']
                    or not digest(b['sha256']) or not digest(b['source_pgm_sha256'])
                    or not finite(b['resolution']) or b['resolution'] <= 0
                    or len(b['origin']) != 3 or not all(finite(v) for v in b['origin'])
                    or any(type(b[k]) is not int or not 1 <= b[k] <= 4096 for k in ('width', 'height'))):
                raise ValueError('invalid floor map binding')
            for key in ('floor_id', 'map_version_id', 'building_id'):
                b[key] = str(UUID(b[key]))
            self.bindings[f] = b
        if (set(self.bindings) != {'l1', 'l2'}
                or len({b['building_id'] for b in self.bindings.values()}) != 1
                or len({b['ros_building_id'] for b in self.bindings.values()}) != 1
                or len({b['floor_id'] for b in self.bindings.values()}) != 2
                or len({b['map_version_id'] for b in self.bindings.values()}) != 2):
            raise ValueError('both distinct floors in one building are required')
        self.building = self.bindings['l1']['building_id']

    @classmethod
    def from_env(cls, env):
        raw = env.get('FOOTHOLD_FLOOR_BINDINGS')
        if not raw:
            return None
        if len(raw) > 16384:
            raise ValueError('floor bindings too large')
        data = json.loads(raw)
        return cls(**data)

    def context(self, status):
        """Return only a fresh run/epoch/rev context, including transit/error reasons."""
        rev = status.get('floor_rev')
        state, cur = status.get('floor_state'), status.get('current_floor')
        stamp, confirmed = status.get('sim_t'), status.get('floor_confirm_sim_t')
        if (status.get('world_id') != 'v5_building' or status.get('run_id') != self.run_id
                or type(status.get('epoch')) is not int or status['epoch'] < self.epoch
                or type(rev) is not int or rev < 0 or state not in ('on_floor', 'transit', 'unknown')
                or status.get('spawn_floor') != self.spawn
                or (cur is not None and cur not in ('l1', 'l2'))
                or (state == 'on_floor') != (cur in ('l1', 'l2'))
                or not finite(stamp) or (confirmed is not None and (not finite(confirmed) or confirmed > stamp))):
            return None
        b = self.bindings.get(cur)
        reason = status.get('floor_reason')
        if not isinstance(reason, str) or not 1 <= len(reason) <= 128:
            return None
        context = dict(robot_id=self.robot_id, generation=self.generation, run_id=self.run_id,
            epoch=status['epoch'], floor_rev=rev, world_id='v5_building', building_id=self.building,
            spawn_floor_id=self.spawn, current_floor_id=cur, floor_id=None, map_version_id=None,
            sha256=None, source_pgm_sha256=None, source='gt_geometry', floor_state=state,
            reason=reason, confirmed_sim_t=confirmed)
        if b:
            m = status.get('map') or {}
            valid = (status.get('floor_id') == cur and status.get('building_id') == b['ros_building_id']
                and status.get('floor_src') == 'gt_geometry' and status.get('map_source') == 'gt_raster'
                and status.get('map_version') == b['ros_map_version']
                and status.get('source_pgm_sha256') == b['source_pgm_sha256']
                and status.get('map_origin') == list(b['origin'])
                and (m.get('width'), m.get('height'), m.get('resolution')) == (b['width'], b['height'], b['resolution'])
                and (m.get('floor_id'), m.get('floor_rev'), m.get('epoch')) == (cur, rev, status['epoch'])
                and finite(confirmed) and not status.get('map_error') and not status.get('map_null_reason'))
            if valid:
                context.update({k: b[k] for k in ('floor_id', 'map_version_id', 'sha256', 'source_pgm_sha256')})
            else:
                context['reason'] = 'binding_mismatch'
        return context
