"""Strict map identity comparison at the local execution boundary; no ROS imports."""
import math


def validate_proof(proof, request):
    fields = {'floor_id', 'map_version_id', 'image_sha256', 'source_pgm_sha256',
              'origin', 'resolution', 'width', 'height', 'source', 'world_id', 'ros_floor_id'}
    if not isinstance(proof, dict) or set(proof) != fields:
        raise ValueError('MAP_VERSION_MISMATCH')
    if (proof['floor_id'] != request['floor_id'] or proof['map_version_id'] != request['map_version_id']
            or proof['source'] != 'SIMULATION'
            or any(not isinstance(proof[k], str) or not proof[k] for k in ('world_id', 'ros_floor_id'))
            or any(not isinstance(proof[k], str) or len(proof[k]) != 64
                   or any(c not in '0123456789abcdef' for c in proof[k])
                   for k in ('image_sha256', 'source_pgm_sha256'))
            or not isinstance(proof['origin'], (tuple, list)) or len(proof['origin']) != 3
            or any(type(v) not in (int, float) or not math.isfinite(v) for v in proof['origin'])
            or type(proof['resolution']) not in (int, float) or not math.isfinite(proof['resolution'])
            or proof['resolution'] <= 0
            or any(type(proof[k]) is not int or not 1 <= proof[k] <= 4096 for k in ('width', 'height'))):
        raise ValueError('MAP_VERSION_MISMATCH')
    return proof


class VerifiedPlan(dict):
    """Wire plan stays a RunPlan; local evidence is not an extra wire field."""
    map_proof = None
