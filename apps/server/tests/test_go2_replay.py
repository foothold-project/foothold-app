"""Reuse existing cookie robot-detail permission and in-memory live-state path."""
import time
from uuid import uuid4

from apps.contracts.tests.test_go2_replay_contract import replay_info
from .test_realtime import agent, app_token, rt, state


def test_replay_received_forwarded_expired_and_legacy_clears(client, seeded, rt):
    rid = seeded['robots']['mine']
    headers = app_token(client)
    path = f'/api/v1/robots/{rid}'
    info = replay_info()
    with agent(client, seeded, direct=True, robot_model='unitree_go2') as ag:
        frame = state()
        frame['robot_info'] = info
        ag.send_json(frame)
        deadline = time.monotonic() + 2
        while not (client.get(path, headers=headers).json().get('robot_info') or {}).get('joints'):
            assert time.monotonic() < deadline
            time.sleep(.01)
        detail = client.get(path, headers=headers).json()
        for key in ('joints', 'quaternion', 'position'):
            sample = detail['robot_info'][key]
            assert 0 <= sample['age_s'] < 1
            assert {k: v for k, v in sample.items() if k != 'age_s'} == {k: v for k, v in info[key].items() if k != 'age_s'}
            assert rt.agents[str(rid)].state['robot_info'][key]['age_s'] == 0  # cache not mutated by GET
        assert detail['lease'] is None and detail['status'] == 'STOP_LATCHED'
        rt.agents[str(rid)].state_received_at -= 1.1
        assert client.get(path, headers=headers).json()['robot_info']['joints']['age_s'] >= 1.1
        rt.agents[str(rid)].state_received_at -= 4
        assert client.get(path, headers=headers).json()['robot_info'] is None
        ag.send_json(state())  # old agents still work and clear all optional samples
        deadline = time.monotonic() + 2
        while client.get(path, headers=headers).json()['status'] is None:
            assert time.monotonic() < deadline
            time.sleep(.01)
        assert client.get(path, headers=headers).json()['robot_info'] is None


def test_existing_cookie_permission_unknown_and_foreign_robot(client, seeded):
    rid = seeded['robots']['mine']
    assert client.get(f'/api/v1/robots/{rid}').status_code == 401
    headers = app_token(client)
    assert client.get(f'/api/v1/robots/{rid}', headers=headers).status_code == 200
    for robot in (seeded['robots']['foreign'], uuid4()):
        assert client.get(f'/api/v1/robots/{robot}', headers=headers).status_code == 404
