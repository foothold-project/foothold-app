"""Fixed-version scenario data and fail-closed single-floor plan validation."""
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
import math
from urllib.request import Request
from urllib.parse import urlsplit

from foothold_agent.phone.tickets import uuid


def plan_from_data(data, request):
    try:
        if data['id'] != request['scenario_id'] or type(data['number']) is not int or data['number'] != request['scenario_version']:
            raise ValueError('PLAN_UNAVAILABLE')
        points = data['waypoints']
        if not isinstance(points, list) or not 1 <= len(points) <= 200:
            raise ValueError('PLAN_UNAVAILABLE')
        finish = data['finish']
        mode = finish['mode']
        if mode not in ('STAY', 'RETURN_TO_START', 'GO_TO') or (mode == 'GO_TO') != (finish.get('target') is not None):
            raise ValueError('PLAN_UNAVAILABLE')
        all_points = points + ([finish['target']] if mode == 'GO_TO' else [])
        for p in all_points:
            if p['floor_id'] != request['floor_id']:
                raise ValueError('FLOOR_TRANSITION_UNSUPPORTED')
            if p['map_version_id'] != request['map_version_id']:
                raise ValueError('MAP_VERSION_MISMATCH')
            if not all(type(p.get(k, 0. if k == 'yaw' else None)) in (float, int) and math.isfinite(p.get(k, 0. if k == 'yaw' else None)) for k in ('x', 'y', 'yaw')):
                raise ValueError('PLAN_UNAVAILABLE')
        goals = []
        for idx, p in enumerate(points):
            if uuid(p['mission_id']) != p['mission_id'] or type(p['mission_version']) is not int or p['mission_version'] < 1 or not isinstance(p['mission_name'], str):
                raise ValueError('PLAN_UNAVAILABLE')
            goals.append({k: deepcopy(p.get(k, 0. if k == 'yaw' else None)) for k in
                          ('waypoint_ref', 'x', 'y', 'yaw', 'mission_id', 'mission_version', 'mission_name')})
            goals[-1]['idx'] = idx
        end = deepcopy(points[0] if mode == 'RETURN_TO_START' else finish.get('target'))
        return {'segments': [{'floor_id': request['floor_id'], 'map_version_id': request['map_version_id'], 'goals': goals}]}, end
    except (KeyError, TypeError, OverflowError):
        raise ValueError('PLAN_UNAVAILABLE') from None


class ScenarioSource:
    """Explicit data-only HTTPS origin. No redirects or token-bearing URL logs."""
    def __init__(self, origin, token):
        parsed = urlsplit(origin)
        if (not parsed.hostname or (parsed.scheme != 'https' and not (parsed.scheme == 'http' and parsed.hostname in ('127.0.0.1', '::1')))
                or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in ('', '/')):
            raise ValueError('invalid scenario data origin')
        self.origin, self.token = origin.rstrip('/'), token
        self.pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix='scenario-data')

    def fetch(self, request):
        def load():
            from urllib.request import build_opener, HTTPRedirectHandler
            class NoRedirect(HTTPRedirectHandler):
                def redirect_request(self, *args, **kwargs):
                    raise ValueError('PLAN_UNAVAILABLE')
            url = self.origin + '/agent/scenarios/' + uuid(request['scenario_id']) + '?version=' + str(request['scenario_version'])
            with build_opener(NoRedirect).open(Request(url, headers={'Authorization': 'Bearer ' + self.token}), timeout=3) as reply:
                raw = reply.read(1048577)
            if len(raw) > 1048576:
                raise ValueError('PLAN_UNAVAILABLE')
            from foothold_agent.phone.tickets import json_object
            return json_object(raw)
        return self.pool.submit(load)
