"""Optional display metadata is bounded and excludes arbitrary diagnostic data."""
import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from apps.contracts.models import Device, UnlockRefused

REFUSAL = dict(reason='STILL_MOVING', at='2026-11-01T01:00:00Z',
               axes=[dict(axis='vz', value=.03, limit=.02, unit='m/s')])


def test_additive_schema_fields_remain_optional_and_old_devices_serialize_unchanged():
    schemas = Path(__file__).resolve().parents[1] / 'schema'
    for name, field in [('AgentState', 'unlock_refused'), ('PhoneState', 'unlock_refused'),
                        ('ScreenState', 'unlock_refused'), ('Device', 'status_code')]:
        assert field not in json.loads((schemas / f'{name}.json').read_text())['required']
    old = dict(key='sport', kind='OTHER', label='기체 상태', state='OK')
    assert Device(**old).model_dump(mode='json') == old
    assert UnlockRefused(**REFUSAL).model_dump(mode='json') == REFUSAL


@pytest.mark.parametrize('patch', [dict(reason='unbounded diagnostic text'),
    dict(at='2026-11-01T01:00:00'), dict(serial='must-not-pass'),
    dict(axes=[dict(axis='serial', value=1, limit=.02, unit='m/s')]),
    dict(axes=[dict(axis='vz', value=float('nan'), limit=.02, unit='m/s')]),
    dict(axes=[dict(axis='vz', value=.03, limit=0, unit='m/s')]), dict(axes=REFUSAL['axes'] * 20)])
def test_reject_unbounded_or_secret_refusal_metadata(patch):
    with pytest.raises(ValidationError):
        UnlockRefused(**{**REFUSAL, **patch})
