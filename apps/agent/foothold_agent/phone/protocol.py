"""fh-phone/1 input validation, mirrored by apps/contracts phone models.

The robot runtime intentionally doesn't depend on Pydantic. Unknown fields,
nonfinite numbers, duplicate JSON keys and noncanonical UUIDs are rejected.
"""

import math

from foothold_agent.safety.core import Z, PHONE_SPEEDS
from foothold_agent.policy_ranges import velocity_input
from .tickets import json_object, uuid

PROTO = 'fh-phone/1'
MAX_SEQ = 2**53 - 1
FIELDS = {
    'hello': {'ticket', 'device'}, 'cmd': {'lease_id', 'seq', 'vx', 'vy', 'wz'},
    'unlock': {'lease_id', 'stop_gen'}, 'ping': {'client_time_ms'},
    'stop': set(), 'lease.take': set(), 'lease.request': set(),
    'lease.release': set(), 'lease.cancel': set(), 'view': set(),
    'lease.respond': {'request_id', 'accept'},
    'run.start': {'lease_id', 'run_id', 'screen_id', 'scenario_id', 'scenario_version', 'floor_id', 'map_version_id'},
    'run.control': {'run_id', 'op'},
    'run.confirm': {'lease_id', 'run_id', 'kind', 'data'},
}


def sequence(value):
    return type(value) is int and 0 <= value <= MAX_SEQ


def frame(raw, robot):
    if not isinstance(raw, str):
        raise ValueError('BINARY_UNSUPPORTED')
    if len(raw.encode('utf-8')) > 4096:
        raise ValueError('FRAME_TOO_LARGE')
    value = json_object(raw)
    kind = value.get('t')
    if not isinstance(kind, str) or kind not in FIELDS:
        raise ValueError('VALIDATION')
    required = {'t', 'id', 'robot'} | FIELDS[kind]
    optional = {'proto'}
    if kind == 'stop':
        optional.add('request_id')
    if kind == 'run.start':
        optional.add('assignment_id')
    if kind == 'run.control':
        optional |= {'lease_id', 'screen_id', 'resume_token'}
    if not required <= value.keys() or value.keys() - required - optional:
        raise ValueError('VALIDATION')
    if not isinstance(value['id'], str) or not 1 <= len(value['id']) <= 128 or '\x00' in value['id']:
        raise ValueError('VALIDATION')
    if value['robot'] != uuid(value['robot']) or value['robot'] != robot:
        raise ValueError('ROBOT_MISMATCH')
    if ('proto' in value and value['proto'] != PROTO) or kind == 'hello' and value.get('proto') != PROTO:
        raise ValueError('PROTOCOL_MISMATCH')
    if kind == 'hello' and (not isinstance(value['ticket'], str) or not 1 <= len(value['ticket']) <= 2048):
        raise ValueError('VALIDATION')
    for key in ('device', 'request_id', 'run_id', 'screen_id', 'scenario_id', 'floor_id', 'map_version_id', 'assignment_id', 'lease_id'):
        if key in value and value[key] != uuid(value[key]):
            raise ValueError('VALIDATION')
    if kind == 'lease.respond' and type(value['accept']) is not bool:
        raise ValueError('VALIDATION')
    if kind == 'run.start' and (type(value['scenario_version']) is not int or value['scenario_version'] < 1):
        raise ValueError('VALIDATION')
    if kind == 'run.control':
        if value['op'] not in ('pause', 'resume', 'abort', 'return'):
            raise ValueError('VALIDATION')
        if value['op'] in ('pause', 'resume') and not {'lease_id', 'screen_id'} <= value.keys():
            raise ValueError('VALIDATION')
        if 'resume_token' in value and (not isinstance(value['resume_token'], str) or not value['resume_token']):
            raise ValueError('VALIDATION')
        if value['op'] == 'resume' and 'resume_token' not in value:
            raise ValueError('VALIDATION')
    if kind == 'run.confirm' and (value['kind'] not in ('FLOOR', 'OPERATOR') or not isinstance(value['data'], dict)):
        raise ValueError('VALIDATION')
    for key in ('seq', 'stop_gen', 'client_time_ms'):
        if key in value and not sequence(value[key]):
            raise ValueError('VALIDATION')
    if kind == 'cmd' and not all(type(value[k]) in (int, float) and -1e100 < value[k] < 1e100
                               and math.isfinite(value[k]) for k in ('vx', 'vy', 'wz')):
        raise ValueError('VALIDATION')
    return value


def simulation_velocity(vx, vy, wz):
    """Simulation SI commands: preserve accepted values; reject without clipping.

    Only exact ZERO confirms neutral. Rejected commands retain a reason.
    """
    value = velocity_input((vx, vy, wz), local=True)
    if value is None:
        return Z, 'INVALID_VELOCITY'
    if not all(SIMULATION_LIMITS[axis + '_min'] <= v <= SIMULATION_LIMITS[axis + '_max']
               for axis, v in zip(('vx', 'vy', 'wz'), value)):
        return Z, 'UNSUPPORTED_VELOCITY'
    return value, ''


def project_velocity(vx, vy, wz, *, simulation=False):
    """SI input -> Core axes; physical mode uses continuous Go2 body-frame velocities."""
    if simulation is True:
        limited, _ = simulation_velocity(vx, vy, wz)
        # Keep rejected SI intent for Core's reason and fresh-neutral gate.
        return (vx, vy, wz), limited != (vx, vy, wz)
    limited, _ = phone_velocity(vx, vy, wz)
    # SI stays SI throughout the physical Hub, avoiding axis roundtrip drift.
    return (vx, vy, wz), limited != (vx, vy, wz)


def phone_velocity(vx, vy, wz):
    """Physical SI envelope and per-axis jitter filtering; no clipping/steps.

    A nonzero held input inside the deadzone is not fresh neutral. Values
    outside the envelope reject the WHOLE command and keep a reason.
    """
    value = velocity_input((vx, vy, wz), local=True)
    if value is None:
        return Z, 'INVALID_VELOCITY'
    if any(abs(v) > maximum for v, maximum in zip(value, PHONE_SPEEDS)):
        return Z, 'UNSUPPORTED_VELOCITY'
    limited = tuple(v if abs(v) >= dead else 0.0
                    for v, dead in zip(value, (.3, .2, .8)))
    return limited, '막대 중립 구간' if limited == Z and any(value) else ''


LIMITS = {'vx_min': -1.5, 'vx_max': 1.5, 'vy_min': -1.0, 'vy_max': 1.0,
          'wz_min': -4.0, 'wz_max': 4.0, 'vx_mode': 'continuous',
          'vx_min_moving': 0.0, 'commands': [],
          'experimental': ['reverse', 'lateral', 'turn_in_place'],
          'requires_forward_motion': False}


# Explicit simulation input envelope; the learned policy ranges remain unchanged.
# These experimental commands are accepted, not validated walking capabilities.
SIMULATION_LIMITS = {**LIMITS, 'vx_mode': 'continuous', 'vx_min_moving': .2,
                     'vx_min': -.3, 'vx_max': 1.5, 'vy_min': -.3, 'vy_max': .3,
                     'wz_min': -.5, 'wz_max': .5,
                     'commands': [], 'experimental': ['reverse', 'lateral', 'turn_in_place'],
                     'policy_adapter_id': 'simulation-experimental-si/1',
                     'requires_forward_motion': False}
