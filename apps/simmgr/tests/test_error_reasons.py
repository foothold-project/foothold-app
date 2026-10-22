"""Failure diagnostics exercise real gates with synthetic OS/launcher only."""
from uuid import uuid4

from fastapi.testclient import TestClient
import pytest

from apps.simmgr.api import create_app
from apps.simmgr import launcher
from apps.simmgr.launcher import NativeLauncher
from apps.simmgr.preflight import ResourceGateError, startup_preflight
from test_episode_reuse import native_episode
from test_manager import settings


@pytest.mark.parametrize('gate', ['episode', 'supervisor'])
def test_resource_gate_reports_not_created_without_launch(native_episode, monkeypatch, gate):
    cfg, state = native_episode
    if gate == 'episode':
        state.memory = 2499
    else:
        original = launcher.startup_preflight
        def passed(*args):
            value = original(*args)
            state.memory = 2499
            return value
        monkeypatch.setattr(launcher, 'startup_preflight', passed)
    app = create_app(cfg, NativeLauncher(cfg))
    slot = next(iter(cfg.slots.values()))
    with TestClient(app, client=('127.0.0.1', 9418)) as client:
        response = client.post('/v1/robots', headers={'Authorization': 'Bearer ' + cfg.secret},
            json=dict(world_id='v5_single/f1', robot_id=slot.robot_id, owner_id=str(uuid4()),
                      org_id=slot.org_id, agent_token='x' * 32, generation=1))
        assert response.status_code == 503
        assert response.json()['error'] == {'code': 'SIM_UNAVAILABLE',
            'detail': {'reason': 'resources_low', 'start_not_created': True}}
        assert not app.state.manager.robots and not app.state.manager.failed
        assert 'world_start' not in state.events
        assert not state.units
        assert not app.state.manager.launcher.failed
        state.memory = 8000
        monkeypatch.setattr(launcher, 'startup_preflight', startup_preflight)
        response = client.post('/v1/robots', headers={'Authorization': 'Bearer ' + cfg.secret},
            json=dict(world_id='v5_single/f1', robot_id=slot.robot_id, owner_id=str(uuid4()),
                      org_id=slot.org_id, agent_token='x' * 32, generation=2))
        assert response.status_code == 200, response.text
        assert len(app.state.manager.robots) == 1


@pytest.mark.parametrize('artifact', ['launch.json', 'source-before.json', 'native-output'])
def test_resource_error_with_launch_artifacts_stays_failed(native_episode, monkeypatch, artifact):
    cfg, state = native_episode
    from test_review_environment import isolation
    original = isolation.Simulation.start
    def uncertain(sim):
        if artifact == 'native-output':
            sim.out.mkdir()
        else:
            (sim.folder / artifact).write_text('synthetic launch evidence')
        raise ResourceGateError()
    monkeypatch.setattr(isolation.Simulation, 'start', uncertain)
    launch = NativeLauncher(cfg)
    app = create_app(cfg, launch)
    slot = next(iter(cfg.slots.values()))
    body = dict(world_id='v5_single/f1', robot_id=slot.robot_id, owner_id=str(uuid4()),
                org_id=slot.org_id, agent_token='x' * 32, generation=1)
    headers = {'Authorization': 'Bearer ' + cfg.secret}
    with TestClient(app, client=('127.0.0.1', 9418), raise_server_exceptions=False) as client:
        response = client.post('/v1/robots', headers=headers, json=body)
        assert response.status_code == 503
        assert response.json()['error']['detail'].get('start_not_created') is not True
        assert app.state.manager.failed and launch.failed
        monkeypatch.setattr(isolation.Simulation, 'start', original)
        assert client.post('/v1/robots', headers=headers, json=body).status_code == 503
        async def preserve():
            pass
        monkeypatch.setattr(launch, 'close_world', preserve)


def test_slot_busy_reports_reason_without_releasing_robot():
    cfg = settings()
    slot = next(iter(cfg.slots.values()))
    with TestClient(create_app(cfg), client=('127.0.0.1', 9418)) as client:
        headers = {'Authorization': 'Bearer ' + cfg.secret}
        body = dict(world_id='a', robot_id=slot.robot_id, owner_id=str(uuid4()),
                    org_id=slot.org_id, agent_token='x' * 32, generation=1)
        assert client.post('/v1/robots', json=body, headers=headers).status_code == 200
        body['owner_id'] = str(uuid4())
        response = client.post('/v1/robots', json=body, headers=headers)
        assert response.status_code == 409
        assert response.json()['error']['detail'] == {'reason': 'slot_busy'}
        assert slot.robot_id in client.app.state.manager.robots
