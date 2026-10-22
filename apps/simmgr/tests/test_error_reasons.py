"""Failure diagnostics exercise real gates with synthetic OS/launcher only."""
from uuid import uuid4

from fastapi.testclient import TestClient
import pytest

from apps.simmgr.api import create_app
from apps.simmgr import launcher
from apps.simmgr.launcher import NativeLauncher
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
        assert not app.state.manager.robots and app.state.manager.failed
        assert 'world_start' not in state.events
        assert not state.units
        # Existing native failure latch requires operator review at shutdown;
        # teardown must not turn that pre-existing policy into an OS operation.
        async def no_runtime():
            pass
        monkeypatch.setattr(app.state.manager.launcher, 'close_world', no_runtime)


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
