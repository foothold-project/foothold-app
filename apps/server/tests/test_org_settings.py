"""Organization-wide simulation controls and merged PATCH validation."""
import importlib
from pathlib import Path

import pytest
from pydantic import ValidationError

from apps.contracts import models as C
from .test_api import csrf

P = '/api/v1/org/settings'
DEFAULTS = dict(sim_max_vx=1.0, sim_min_vx=0.2, sim_max_vy=0.3,
    sim_max_wz=0.5, sim_key_vx=0.6, stick_deadzone=0.1,
    sim_runner_vx=0.4, sim_runner_wz=0.6, lidar_view_m=12,
    real_no_fast_server_drive=False)
BOUNDS = dict(sim_max_vx=(0.2, 1.5), sim_min_vx=(0.0, 0.5),
    sim_max_vy=(0.0, 0.3), sim_max_wz=(0.0, 0.5), sim_key_vx=(0.1, 1.5),
    stick_deadzone=(0.0, 0.5), sim_runner_vx=(0.1, 1.5),
    sim_runner_wz=(0.1, 1.0), lidar_view_m=(1, 30))


def test_old_json_defaults_and_all_roles_read_only_admin_writes(client):
    for role in ('one', 'admin'):
        headers = csrf(client, role)
        assert client.get(P).status_code == 200
        assert {k: client.get(P).json()[k] for k in DEFAULTS} == DEFAULTS
        result = client.patch(P, headers=headers,
            json={'sim_runner_vx': 0.7, 'real_no_fast_server_drive': True})
        assert result.status_code == (200 if role == 'admin' else 403)
    csrf(client, 'two')
    saved = client.get(P).json()
    assert saved['sim_runner_vx'] == 0.7 and saved['real_no_fast_server_drive'] is True
    assert saved['battery_low_pct'] == 20


@pytest.mark.parametrize('field', BOUNDS)
def test_new_numeric_ranges_strict_types_and_optional_patch(field):
    low, high = BOUNDS[field]
    for value in (low, high):
        assert C.OrgSettingsPatch(**{field: value}).model_dump(exclude_unset=True) == {field: value}
        # Full model boundaries with compatible cross-field values.
        C.OrgSettings(**{'sim_max_vx': 1.5, 'sim_min_vx': 0, 'sim_key_vx': 0.1, field: value})
    for value in (low - 1, high + 1, True, None, '0.2', float('inf'), float('nan')):
        for model in (C.OrgSettingsPatch, C.OrgSettings):
            with pytest.raises(ValidationError):
                model(**{field: value})
    assert C.OrgSettingsPatch().model_dump(exclude_unset=True) == {}


@pytest.mark.parametrize('value', (None, 0, 1, 'false'))
def test_fast_drive_flag_is_strict_boolean(value):
    for model in (C.OrgSettingsPatch, C.OrgSettings):
        with pytest.raises(ValidationError):
            model(real_no_fast_server_drive=value)


@pytest.mark.parametrize('initial,patch,message', [
    ({'sim_key_vx': 0.2}, {'sim_min_vx': 0.5, 'sim_max_vx': 0.3}, '최소 전진 속도'),
    ({}, {'sim_max_vx': 0.4}, '키보드 전진 속도'),
    ({'sim_max_vx': 0.6}, {'sim_key_vx': 0.7}, '키보드 전진 속도'),
    ({'sim_min_vx': 0.5}, {'sim_max_vx': 0.3, 'sim_key_vx': 0.2}, '최소 전진 속도'),
])
def test_cross_validation_uses_stored_and_patch_values_and_rolls_back(client, initial, patch, message):
    headers = csrf(client)
    assert client.patch(P, headers=headers, json=initial).status_code == 200
    before = client.get(P).json()
    result = client.patch(P, headers=headers, json=patch)
    assert result.status_code == 422
    assert result.json()['error']['code'] == 'VALIDATION'
    assert message in result.json()['error']['message']
    assert client.get(P).json() == before
    assert client.patch(P, headers=headers,
        json={'sim_max_vx': 0.5, 'sim_min_vx': 0.5, 'sim_key_vx': 0.5}).status_code == 200


def test_simulation_si_caps_match_agent_final_envelope(monkeypatch):
    # Read the real agent constants without changing the agent's final clamp.
    monkeypatch.syspath_prepend(str(Path(__file__).resolve().parents[2] / 'agent'))
    limits = importlib.import_module('foothold_agent.phone.protocol').SIMULATION_LIMITS
    schema = C.OrgSettings.model_json_schema()['properties']
    for setting, axis in (('sim_max_vx', 'vx_max'), ('sim_max_vy', 'vy_max'),
                          ('sim_max_wz', 'wz_max'), ('sim_key_vx', 'vx_max')):
        assert schema[setting]['maximum'] == limits[axis]


@pytest.mark.parametrize('field', ['sim_max_vx', 'sim_key_vx', 'sim_runner_vx'])
def test_forward_ceiling_boundary_persists_and_rejects_overflow(client, field):
    headers = csrf(client)
    patch = {'sim_max_vx': 1.5, field: 1.5}
    response = client.patch(P, headers=headers, json=patch)
    assert response.status_code == 200 and response.json()[field] == 1.5
    assert client.get(P).json()[field] == 1.5
    for model in (C.OrgSettings, C.OrgSettingsPatch):
        with pytest.raises(ValidationError):
            model(**{field: 1.51})
    before = client.get(P).json()
    rejected = client.patch(P, headers=headers, json={field: 1.51})
    assert rejected.status_code == 400
    assert rejected.json()['error']['code'] == 'VALIDATION'
    assert client.get(P).json() == before
