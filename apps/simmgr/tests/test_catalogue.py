"""Catalogue metadata and explicitly configured loopback ports; no listeners."""
from dataclasses import replace
import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from apps.contracts.models import SimWorld
from apps.contracts.simulation_ports import allowed_ports, extra_ports_from_env
from apps.simmgr.config import Settings, World
from test_manager import settings


@pytest.fixture
def catalogue_env(tmp_path):
    cfg = settings()
    data = {'worlds': [dict(id='practice', name='연습장', description='빈 공간',
                           world_file='/private/world.sdf', map_file='/private/map.pgm')],
            'slots': [dict(robot_id=s.robot_id, org_id=s.org_id, key_path=s.key_path,
                           replay_path=s.replay_path, port=s.port) for s in cfg.slots.values()]}
    catalog = tmp_path / 'catalog.json'
    catalog.write_text(json.dumps(data))
    secret = tmp_path / 'secret'
    secret.write_text('x' * 32)
    secret.chmod(0o600)
    return data, catalog, {'FH_SIM_CATALOG': str(catalog), 'FH_SIM_AUTH_FILE': str(secret),
                          'FH_SIM_AGENT_WS_URL': 'ws://127.0.0.1:9431/api/v1/agent/ws'}


def test_catalogue_metadata_and_legacy_fallback(catalogue_env, caplog):
    data, catalog, env = catalogue_env
    world = Settings.from_env(env).worlds['practice']
    assert (world.name, world.description) == ('연습장', '빈 공간')
    del data['worlds'][0]['name']
    del data['worlds'][0]['description']
    catalog.write_text(json.dumps(data))
    caplog.clear()
    world = Settings.from_env(env).worlds['practice']
    assert (world.name, world.description) == ('practice', '')
    assert len(caplog.records) == 1 and 'using id' in caplog.text


@pytest.mark.parametrize('field,value', [('name', ''), ('name', '가' * 41), ('description', '가' * 201)])
def test_catalogue_rejects_invalid_metadata(catalogue_env, field, value):
    data, catalog, env = catalogue_env
    data['worlds'][0][field] = value
    catalog.write_text(json.dumps(data))
    with pytest.raises(ValidationError):
        Settings.from_env(env)


def test_world_contract_required_name_and_boundaries():
    with pytest.raises(ValidationError):
        SimWorld(id='practice')
    assert SimWorld(id='practice', name='가' * 40, description='가' * 200).description == '가' * 200
    assert SimWorld(id='practice', name='연습장').description == ''
    with pytest.raises(ValidationError):
        World('practice', Path('world'), Path('map'), name='x' * 41)


def test_default_ports_and_explicit_extra_port(catalogue_env):
    _, _, env = catalogue_env
    cfg = Settings.from_env(env)
    assert cfg.port == 9430 and cfg.extra_ports == ()
    assert allowed_ports() == frozenset(range(9430, 9450))
    with pytest.raises(ValueError):
        replace(cfg, agent_ws_url='ws://127.0.0.1:8870/api/v1/agent/ws')
    extra = Settings.from_env({**env, 'FH_SIM_EXTRA_PORTS': '8870',
                              'FH_SIM_AGENT_WS_URL': 'ws://127.0.0.1:8870/api/v1/agent/ws'})
    assert extra.extra_ports == (8870,)
    assert replace(extra, port=8870).port == 8870
    slots = list(extra.slots.values())
    extra = replace(extra, slots={s.robot_id: replace(s, port=8870) if i == 0 else s
                                  for i, s in enumerate(slots)})
    assert 8870 in [s.port for s in extra.slots.values()]


@pytest.mark.parametrize('value', ['8453', '8792', '8870,8453', '0', '65536', '8870,', '8870-8880'])
def test_extra_ports_rejects_protected_and_invalid_values(value):
    with pytest.raises(ValueError):
        extra_ports_from_env({'FH_SIM_EXTRA_PORTS': value})


@pytest.mark.parametrize('url', ['ws://localhost:8870/api/v1/agent/ws',
    'ws://127.0.0.1:8870/wrong', 'ws://user:secret@127.0.0.1:8870/api/v1/agent/ws',
    'ws://@127.0.0.1:8870/api/v1/agent/ws', 'ws://127.0.0.1:8870/api/v1/agent/ws?x=1'])
def test_extra_ports_preserves_url_constraints(url):
    with pytest.raises(ValueError):
        replace(settings(), extra_ports=(8870,), agent_ws_url=url)
