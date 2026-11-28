"""Organization-wide simulation controls and merged PATCH validation."""
import importlib
from pathlib import Path

import pytest
from pydantic import ValidationError

from apps.contracts import models as C
from .test_api import csrf

P = '/api/v1/org/settings'
DEFAULTS = dict(sim_max_vx=1.5, sim_min_vx=0.2, sim_max_vy=0.5,
    sim_max_wz=1.2, sim_key_vx=1.5, stick_deadzone=0.1,
    sim_runner_vx=0.4, sim_runner_wz=0.6, lidar_view_m=12,
    real_no_fast_server_drive=False, real_max_vx=1.5, real_max_vx_back=1.5, real_max_vy=1.0, real_max_wz=2.5)
BOUNDS = dict(sim_max_vx=(0.2, 1.5), sim_min_vx=(0.0, 0.5),
    sim_max_vy=(0.0, 0.5), sim_max_wz=(0.0, 1.2), sim_key_vx=(0.1, 1.5),
    stick_deadzone=(0.0, 0.5), sim_runner_vx=(0.1, 1.5),
    sim_runner_wz=(0.1, 1.0), lidar_view_m=(1, 30),
    real_max_vx=(0, 1.5), real_max_vx_back=(0, 1.5), real_max_vy=(0, 1), real_max_wz=(0, 2.5))


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


def test_previously_saved_turn_cap_is_narrowed_on_read_and_next_write(client, seeded):
    from sqlalchemy.orm import Session
    from apps.server.fh_server.models import Organization
    with Session(client.app.state.engine) as db:
        db.get(Organization, seeded['org']).settings = {'real_max_wz': 4.0}
        db.commit()
    headers = csrf(client, 'admin')
    assert client.get(P).json()['real_max_wz'] == 2.5
    assert client.patch(P, headers=headers, json={'real_max_wz': 2.51}).status_code == 400
    assert client.patch(P, headers=headers, json={'battery_low_pct': 25}).json()['real_max_wz'] == 2.5
    with Session(client.app.state.engine) as db:
        assert db.get(Organization, seeded['org']).settings == {'real_max_wz': 2.5, 'battery_low_pct': 25}


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
    ({'sim_max_vx': 0.6, 'sim_key_vx': 0.6}, {'sim_key_vx': 0.7}, '키보드 전진 속도'),
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


def test_browser_settings_cover_but_do_not_change_agent_final_envelope(monkeypatch):
    # Read the real agent constants without changing the agent's final clamp.
    monkeypatch.syspath_prepend(str(Path(__file__).resolve().parents[2] / 'agent'))
    limits = importlib.import_module('foothold_agent.phone.protocol').SIMULATION_LIMITS
    schema = C.OrgSettings.model_json_schema()['properties']
    for setting, axis, maximum in (('sim_max_vx', 'vx_max', 1.5), ('sim_max_vy', 'vy_max', .5),
                                   ('sim_max_wz', 'wz_max', 1.2), ('sim_key_vx', 'vx_max', 1.5)):
        assert schema[setting]['maximum'] == maximum
        assert min(maximum, limits[axis]) == limits[axis]
    assert limits['vy_max'] == .3 and limits['wz_max'] == .5


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


def test_explicit_sim_choice_survives_other_patches_without_storing_defaults(client, seeded):
    from sqlalchemy.orm import Session
    from apps.server.fh_server.models import Event, Organization
    from sqlalchemy import select
    headers = csrf(client)
    assert client.patch(P, headers=headers, json={'sim_max_vy': .3}).status_code == 200
    assert client.patch(P, headers=headers, json={'lidar_view_m': 15}).status_code == 200
    response = client.get(P).json()
    assert response['sim_max_vy'] == .3
    assert response['sim_max_vx'] == 1.5 and response['sim_max_wz'] == 1.2
    with Session(client.app.state.engine) as db:
        assert db.get(Organization, seeded['org']).settings == {'sim_max_vy': .3, 'lidar_view_m': 15}
        assert list(db.scalars(select(Event.data).where(Event.code == 'ORG_SETTINGS_UPDATED')
                               .order_by(Event.id))) == [{'sim_max_vy': .3}, {'lidar_view_m': 15}]


def test_unrelated_patch_keeps_sim_defaults_inherited(client, seeded):
    from sqlalchemy.orm import Session
    from apps.server.fh_server.models import Organization
    headers = csrf(client)
    result = client.patch(P, headers=headers, json={'battery_low_pct': 25})
    assert result.status_code == 200
    assert {k: result.json()[k] for k in DEFAULTS} == DEFAULTS
    with Session(client.app.state.engine) as db:
        assert db.get(Organization, seeded['org']).settings == {'battery_low_pct': 25}


def test_inherited_key_follows_retained_forward_cap_but_explicit_conflict_rejected(client, seeded):
    from sqlalchemy.orm import Session
    from apps.server.fh_server.models import Organization
    # This sparse row results when migration retains an explicit forward cap
    # but removes the old, never-chosen key default.
    with Session(client.app.state.engine) as db:
        db.get(Organization, seeded['org']).settings = {'sim_max_vx': 1.0}
        db.commit()
    headers = csrf(client)
    assert client.get(P).json()['sim_key_vx'] == 1.0
    assert client.patch(P, headers=headers, json={'lidar_view_m': 15}).status_code == 200
    with Session(client.app.state.engine) as db:
        assert db.get(Organization, seeded['org']).settings == {'sim_max_vx': 1.0, 'lidar_view_m': 15}
    assert client.patch(P, headers=headers, json={'sim_key_vx': 1.1}).status_code == 422
    # Reducing only forward speed still validates against the current key cap.
    assert client.patch(P, headers=headers, json={'sim_max_vx': .8}).status_code == 422
    raised = client.patch(P, headers=headers, json={'sim_max_vx': 1.2})
    assert raised.status_code == 200 and raised.json()['sim_key_vx'] == 1.2
    assert raised.json() == client.get(P).json()
    with Session(client.app.state.engine) as db:
        assert db.get(Organization, seeded['org']).settings == {'sim_max_vx': 1.2, 'lidar_view_m': 15}


def test_model_merge_reset_sparse_persistence_and_audit(client, seeded):
    from sqlalchemy import select
    from sqlalchemy.orm import Session
    from apps.server.fh_server.models import Event, Organization
    headers = csrf(client)
    assert client.get(P).json()['model_overrides'] == {}
    patches = [
        {'model_overrides': {'nvidia-demo': {'sim_key_vx': .4, 'lidar_view_m': 20},
                             'start-demo': {'stick_deadzone': .2}}},
        {'model_overrides': {'nvidia-demo': {'sim_runner_vx': .6}}},
        {'model_overrides': {'nvidia-demo': {'sim_key_vx': None}}},
    ]
    for patch in patches:
        assert client.patch(P, headers=headers, json=patch).status_code == 200
    expected = {'nvidia-demo': {'lidar_view_m': 20, 'sim_runner_vx': .6},
                'start-demo': {'stick_deadzone': .2}}
    assert client.get(P).json()['model_overrides'] == expected
    with Session(client.app.state.engine) as db:
        assert db.get(Organization, seeded['org']).settings == {'model_overrides': expected}
        assert list(db.scalars(select(Event.data).where(Event.code == 'ORG_SETTINGS_UPDATED')
                               .order_by(Event.id))) == patches
    # Empty objects are no-ops, never erase a model's existing choices.
    assert client.patch(P, headers=headers, json={'model_overrides': {'nvidia-demo': {}}}).json()['model_overrides'] == expected
    result = client.patch(P, headers=headers, json={'model_overrides': {
        'nvidia-demo': {'lidar_view_m': None, 'sim_runner_vx': None},
        'start-demo': {'stick_deadzone': None}, 'ame2-demo': {'sim_key_vx': None}}})
    assert result.status_code == 200 and result.json()['model_overrides'] == {}
    with Session(client.app.state.engine) as db:
        assert db.get(Organization, seeded['org']).settings == {}


@pytest.mark.parametrize('overrides', [
    {'unknown': {'sim_key_vx': .5}}, {'foothold-v2': {'sim_key_vx': .5}},
    {'nvidia-demo': {'battery_low_pct': 30}}, {'nvidia-demo': {'unknown': None}},
    {'nvidia-demo': {'real_no_fast_server_drive': True}}, {'go2-demo': {'sim_max_vx': 1}},
    {'go2-demo': {'real_no_fast_server_drive': True}}, {'nvidia-demo': None},
    {'nvidia-demo': {'sim_key_vx': '0.5'}}, {'nvidia-demo': {'lidar_view_m': 2.5}},
])
def test_unknown_model_field_and_strict_override_validation_422(client, overrides):
    headers = csrf(client)
    before = client.get(P).json()
    result = client.patch(P, headers=headers, json={'model_overrides': overrides})
    assert result.status_code == 422
    assert result.json()['error']['code'] == 'VALIDATION'
    assert client.get(P).json() == before


@pytest.mark.parametrize('field', [key for key in BOUNDS if key in C.SIM_SETTING_FIELDS])
def test_model_ranges_match_common_ranges(client, field):
    headers = csrf(client)
    low, high = BOUNDS[field]
    for value in (low, high):
        fields = {'sim_min_vx': 0, 'sim_key_vx': .1, field: value}
        patch = {'model_overrides': {'nvidia-demo': fields}}
        result = client.patch(P, headers=headers, json=patch)
        assert result.status_code == 200, result.json()
        assert result.json()['model_overrides']['nvidia-demo'][field] == value
    before = client.get(P).json()
    for value in (low - 1, high + 1, True, '0.2'):
        result = client.patch(P, headers=headers, json={'model_overrides': {'nvidia-demo': {field: value}}})
        assert result.status_code == 422
        assert client.get(P).json() == before


def test_model_cross_validation_common_changes_and_reset_are_atomic(client):
    headers = csrf(client)
    initial = {'model_overrides': {'nvidia-demo': {'sim_key_vx': .6, 'sim_max_vx': .7},
                                  'start-demo': {'sim_min_vx': .5}}}
    assert client.patch(P, headers=headers, json=initial).status_code == 200
    before = client.get(P).json()
    for patch, model in [
        ({'model_overrides': {'nvidia-demo': {'sim_min_vx': .5, 'sim_max_vx': .4}}}, 'nvidia-demo'),
        ({'model_overrides': {'nvidia-demo': {'sim_key_vx': None}}}, 'nvidia-demo'),
        ({'sim_key_vx': .3, 'sim_max_vx': .4}, 'start-demo'),
        ({'sim_key_vx': .8, 'model_overrides': {'nvidia-demo': {'sim_key_vx': None}}}, 'nvidia-demo'),
    ]:
        result = client.patch(P, headers=headers, json=patch)
        assert result.status_code == 422, result.json()
        assert model in result.json()['error']['message']
        assert client.get(P).json() == before
    # One model's settings cannot satisfy another model's cross-field order.
    result = client.patch(P, headers=headers, json={'model_overrides': {
        'ame2-demo': {'sim_max_vx': .4}, 'start-demo': {'sim_key_vx': .3}}})
    assert result.status_code == 422 and 'ame2-demo' in result.json()['error']['message']
    assert client.get(P).json() == before
    # Simultaneously restoring both related fields can return to common values.
    assert client.patch(P, headers=headers, json={'model_overrides': {
        'nvidia-demo': {'sim_key_vx': None, 'sim_max_vx': None}}}).status_code == 200


def test_only_admin_updates_model_overrides_and_orgs_remain_isolated(client, seeded):
    from sqlalchemy import select
    from sqlalchemy.orm import Session
    from apps.server.fh_server.models import Organization
    patch = {'model_overrides': {'start-demo': {'sim_runner_vx': .5}}}
    for role in ('one', 'two'):
        assert client.patch(P, headers=csrf(client, role), json=patch).status_code == 403
    assert client.patch(P, headers=csrf(client), json=patch).status_code == 200
    assert client.get(P).json()['real_no_fast_server_drive'] is False
    # This server admits only its configured organization at login.
    with Session(client.app.state.engine) as db:
        others = list(db.scalars(select(Organization).where(Organization.id != seeded['org'])))
        assert others and all(org.settings == {} for org in others)


def test_contract_model_ids_and_kinds_match_policy_registry():
    import json
    import subprocess
    root = Path(__file__).resolve().parents[3]
    result = subprocess.run(['node', '--input-type=module', '-e',
        "import { POLICY_MODES } from './mobile/sim/policy-modes.js'; "
        "console.log(JSON.stringify(Object.values(POLICY_MODES).map(m => [m.id, m.command.kind])));"],
        cwd=root, check=True, capture_output=True, text=True)
    registry = dict(json.loads(result.stdout))
    assert set(registry) == set(C.MODEL_SETTING_FIELDS)
    for model, kind in registry.items():
        assert C.MODEL_SETTING_FIELDS[model] == (frozenset()
            if kind == 'none' else C.SIM_SETTING_FIELDS)


@pytest.mark.parametrize('field', ('real_max_vx', 'real_max_vx_back', 'real_max_vy', 'real_max_wz'))
def test_real_caps_only_admin_patch_persist_zero_and_reject_overflow(client, field):
    operator = csrf(client, 'one')
    before = client.get(P).json()
    assert client.patch(P, headers=operator, json={field: 0}).status_code == 403
    assert client.get(P).json() == before
    assert client.patch(P, headers=csrf(client, 'admin'), json={field: 0}).status_code == 200
    assert client.get(P).json()[field] == 0
    assert client.patch(P, headers=csrf(client, 'admin'), json={field: BOUNDS[field][1] + .01}).status_code == 400
    assert client.get(P).json()[field] == 0


# u9_6 데모 표시 · u9_8 혼잡 시간 · 중복 점검 기준 (팀장 11/28 20:23)
BUSY = [{'day': 'mon', 'start': '08:30', 'end': '09:12', 'label': '출근'},
        {'day': 'wed', 'start': '14:00', 'end': '15:00', 'label': '설비 반입'}]


def test_site_settings_defaults_admin_write_operator_read_and_audit(client, seeded):
    from sqlalchemy import select
    from sqlalchemy.orm import Session
    from apps.server.fh_server.models import Event
    operator = csrf(client, 'one')
    got = client.get(P).json()
    assert (got['show_demo_label'], got['busy_hours'], got['dup_inspect_min']) == (True, [], 240)
    change = {'show_demo_label': False, 'busy_hours': BUSY, 'dup_inspect_min': 180}
    for key, value in change.items():
        assert client.patch(P, headers=operator, json={key: value}).status_code == 403
    assert client.get(P).json() == got
    admin = csrf(client, 'admin')
    result = client.patch(P, headers=admin, json=change)
    assert result.status_code == 200, result.text
    assert {k: result.json()[k] for k in change} == change
    csrf(client, 'one')
    assert {k: client.get(P).json()[k] for k in change} == change
    with Session(client.app.state.engine) as db:
        row = db.scalars(select(Event).where(Event.code == 'ORG_SETTINGS_UPDATED')).one()
        assert row.data == change and row.user_id == seeded['users']['admin'] and row.at


@pytest.mark.parametrize('patch', [
    {'show_demo_label': 1}, {'show_demo_label': None}, {'show_demo_label': 'false'},
    {'dup_inspect_min': 29}, {'dup_inspect_min': 1441}, {'dup_inspect_min': 240.0}, {'dup_inspect_min': True},
    {'busy_hours': None},
    {'busy_hours': [{**BUSY[0], 'day': 'MON'}]},
    {'busy_hours': [{**BUSY[0], 'start': '8:30'}]},
    {'busy_hours': [{**BUSY[0], 'end': '24:00'}]},
    {'busy_hours': [{**BUSY[0], 'start': '09:12', 'end': '09:12'}]},
    {'busy_hours': [{**BUSY[0], 'start': '10:00', 'end': '09:00'}]},
    {'busy_hours': [{**BUSY[0], 'label': ''}]},
    {'busy_hours': [{**BUSY[0], 'label': 'x' * 33}]},
    {'busy_hours': [{**BUSY[0], 'extra': 1}]},
    {'busy_hours': [BUSY[0]] * 65},
])
def test_site_settings_reject_bad_values_without_saving(client, patch):
    headers = csrf(client)
    before = client.get(P).json()
    assert client.patch(P, headers=headers, json=patch).status_code in (400, 422)
    assert client.get(P).json() == before


def test_busy_hours_patch_replaces_whole_list(client):
    headers = csrf(client)
    assert client.patch(P, headers=headers, json={'busy_hours': BUSY}).status_code == 200
    assert client.patch(P, headers=headers, json={'busy_hours': BUSY[1:]}).json()['busy_hours'] == BUSY[1:]
    assert client.patch(P, headers=headers, json={'busy_hours': []}).json()['busy_hours'] == []

