"""fh-phone/1 input validation, mirrored by apps/contracts phone models.

The robot runtime intentionally doesn't depend on Pydantic. Unknown fields,
nonfinite numbers, duplicate JSON keys and noncanonical UUIDs are rejected.
"""

import math

from .tickets import json_object, uuid

PROTO = 'fh-phone/1'
MAX_SEQ = 2**53 - 1
FIELDS = {
    'hello': {'ticket', 'device'}, 'cmd': {'lease_id', 'seq', 'vx', 'vy', 'wz'},
    'unlock': {'lease_id', 'stop_gen'}, 'ping': {'client_time_ms'},
    'stop': set(), 'lease.take': set(), 'lease.request': set(),
    'lease.release': set(), 'lease.cancel': set(), 'view': set(),
    'lease.respond': {'request_id', 'accept'},
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
    if not required <= value.keys() or value.keys() - required - {'proto'}:
        raise ValueError('VALIDATION')
    if not isinstance(value['id'], str) or not 1 <= len(value['id']) <= 128 or '\x00' in value['id']:
        raise ValueError('VALIDATION')
    if value['robot'] != uuid(value['robot']) or value['robot'] != robot:
        raise ValueError('ROBOT_MISMATCH')
    if ('proto' in value and value['proto'] != PROTO) or kind == 'hello' and value.get('proto') != PROTO:
        raise ValueError('PROTOCOL_MISMATCH')
    if kind == 'hello' and (not isinstance(value['ticket'], str) or not 1 <= len(value['ticket']) <= 2048):
        raise ValueError('VALIDATION')
    for key in ('device', 'request_id'):
        if key in value and value[key] != uuid(value[key]):
            raise ValueError('VALIDATION')
    if kind == 'lease.respond' and type(value['accept']) is not bool:
        raise ValueError('VALIDATION')
    if kind in ('cmd', 'unlock') and value['lease_id'] != uuid(value['lease_id']):
        raise ValueError('VALIDATION')
    for key in ('seq', 'stop_gen', 'client_time_ms'):
        if key in value and not sequence(value[key]):
            raise ValueError('VALIDATION')
    if kind == 'cmd' and not all(type(value[k]) in (int, float) and -1e100 < value[k] < 1e100
                               and math.isfinite(value[k]) for k in ('vx', 'vy', 'wz')):
        raise ValueError('VALIDATION')
    return value


def project_velocity(vx, vy, wz):
    """Downward-only projection onto the unchanged Core's tested SI alphabet."""
    x = .6 if vx >= .6 else 0.0
    turn = (.5 if wz >= .5 else -.5 if wz <= -.5 else 0.0) if x else 0.0
    limited = (x, 0.0, turn)
    axes = (1.0 if x else 0.0, 0.0, turn / .5)
    if not any(limited) and any((vx, vy, wz)):
        # Valid, nonneutral Core inputs that quantize to ZERO with a reason.
        # They neither create a neutral nor erase a previously confirmed one.
        axes = ((-1.0, 0.0, 0.0) if vx < 0 else
                (0.0, 1.0 if vy > 0 else -1.0, 0.0) if vy else
                (.3, 0.0, 0.0) if vx else (0.0, 0.0, 1.0 if wz > 0 else -1.0))
    return axes, limited != (vx, vy, wz)


LIMITS = {'vx_min': 0.0, 'vx_max': .6, 'vy_min': 0.0, 'vy_max': 0.0,
          'wz_min': -.5, 'wz_max': .5,
          'commands': [[0.0, 0.0, 0.0], [.6, 0.0, 0.0], [.6, 0.0, -.5], [.6, 0.0, .5]]}
