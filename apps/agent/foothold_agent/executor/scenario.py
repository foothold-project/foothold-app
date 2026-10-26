"""Fixed-version scenario data and fail-closed single-floor plan validation."""
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
import math
from urllib.request import Request
from urllib.parse import urlsplit
from urllib.error import HTTPError
import json

from foothold_agent.phone.tickets import uuid


def plan_from_data(data, request, support=None):
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
        proofs = data.get('map_proofs')
        if not isinstance(proofs, list) or len(proofs) != 1:
            raise ValueError('MAP_VERSION_MISMATCH')
        from .map_proof import validate_proof, VerifiedPlan
        validate_proof(proofs[0], request)
        executable = data.get('run_contract') == 'scenario/2'
        if 'run_contract' in data and not executable:
            raise ValueError('PLAN_UNAVAILABLE')
        revision = data.get('execution_capability_revision')
        if executable:
            if support is None:
                raise ValueError('EXECUTION_UNAVAILABLE')
            support.require([], revision)
        elif revision is not None:
            raise ValueError('PLAN_UNAVAILABLE')
        goals = []
        for idx, p in enumerate(points):
            if uuid(p['mission_id']) != p['mission_id'] or type(p['mission_version']) is not int or p['mission_version'] < 1 or not isinstance(p['mission_name'], str):
                raise ValueError('PLAN_UNAVAILABLE')
            goals.append({k: deepcopy(p.get(k, 0. if k == 'yaw' else None)) for k in
                          ('waypoint_ref', 'x', 'y', 'yaw', 'mission_id', 'mission_version', 'mission_name')})
            goals[-1]['idx'] = idx
            if executable:
                steps, required = validate_steps(p)
                support.require(required, revision)
                goals[-1].update(mission_steps=steps, required_capabilities=required)
        end = deepcopy(points[0] if mode == 'RETURN_TO_START' else finish.get('target'))
        plan = VerifiedPlan(segments=[{'floor_id': request['floor_id'], 'map_version_id': request['map_version_id'], 'goals': goals}])
        if executable:
            plan.update(run_contract='scenario/2', execution_capability_revision=revision)
        plan.map_proof = deepcopy(proofs[0])
        return plan, end
    except (KeyError, TypeError, OverflowError):
        raise ValueError('PLAN_UNAVAILABLE') from None


def validate_steps(point):
    steps, required = deepcopy(point['mission_steps']), point['required_capabilities']
    if not isinstance(steps, list) or len(steps) > 100 or not isinstance(required, list):
        raise ValueError('EXECUTION_UNAVAILABLE')
    wanted = set()
    for step in steps:
        if not isinstance(step, dict) or set(step) != {'action', 'params'} or not isinstance(step['params'], dict):
            raise ValueError('EXECUTION_UNAVAILABLE')
        params = step['params']
        if step['action'] == 'WAIT':
            seconds = params.get('seconds', 30)
            if set(params) - {'seconds'} or type(seconds) is not int or not 1 <= seconds <= 3600:
                raise ValueError('EXECUTION_UNAVAILABLE')
            step['params'] = dict(seconds=seconds)
            wanted.add('wait')
        elif step['action'] == 'PHOTO':
            camera = params.get('camera', 'rgb')
            if set(params) - {'camera'} or camera != 'rgb':
                raise ValueError('EXECUTION_UNAVAILABLE')
            step['params'] = dict(camera=camera)
            wanted.add('photo.rgb')
        else:
            raise ValueError('EXECUTION_UNAVAILABLE')
    if sorted(wanted) != sorted(required) or len(set(required)) != len(required):
        raise ValueError('EXECUTION_UNAVAILABLE')
    return steps, deepcopy(required)


def validate_origin(origin):
    parsed = urlsplit(origin)
    if (not parsed.hostname or (parsed.scheme != 'https' and not (parsed.scheme == 'http' and parsed.hostname in ('127.0.0.1', '::1')))
            or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in ('', '/')):
        raise ValueError('invalid scenario data origin')
    return origin.rstrip('/')


class ExecutionUnavailable(ValueError):
    def __init__(self, reason):
        super().__init__('EXECUTION_UNAVAILABLE')
        self.reason = reason[:512]


class ScenarioSource:
    """Explicit data-only HTTPS origin. No redirects or token-bearing URL logs."""
    def __init__(self, origin, token, *, support=None):
        self.origin, self.token = validate_origin(origin), token
        self.support = support
        self.pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix='scenario-data')

    def fetch(self, request):
        caps = deepcopy(self.support.advertised) if self.support is not None else None
        def load():
            from .photos import NoRedirect
            from urllib.request import build_opener
            url = self.origin + '/api/v1/agent/scenarios/' + uuid(request['scenario_id']) + '?version=' + str(request['scenario_version'])
            if caps is not None:
                url += '&run_contract=scenario/2&execution_capability_revision=' + str(caps['revision'])
            try:
                with build_opener(NoRedirect).open(Request(url, headers={'Authorization': 'Bearer ' + self.token}), timeout=3) as reply:
                    raw = reply.read(1048577)
            except HTTPError as error:
                if error.code == 422:
                    try:
                        body = json.loads(error.read(8193))
                        detail = body.get('error', body)
                        if detail.get('code') == 'EXECUTION_UNAVAILABLE':
                            raise ExecutionUnavailable(detail.get('message', 'Execution unavailable'))
                    except (json.JSONDecodeError, AttributeError, TypeError):
                        pass
                raise
            if len(raw) > 1048576:
                raise ValueError('PLAN_UNAVAILABLE')
            from foothold_agent.phone.tickets import json_object
            return json_object(raw)
        return self.pool.submit(load)
