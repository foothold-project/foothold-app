"""Physical Go2 display data uses existing registered-agent -> web summaries."""
import time
import json

import pytest

from sqlalchemy.orm import Session as DBSession

from foothold_agent.go2_direct.reporting import project, devices
from apps.server.fh_server.models import Robot
from .test_realtime import agent, app_token, rt, state, screen, send, reply, receive


def test_go2_existing_fields_reach_web_and_expired_measurements_become_unknown(client, seeded, rt):
    rid = seeded['robots']['mine']
    with DBSession(client.app.state.engine) as db:
        db.get(Robot, rid).simulation = False
        db.commit()
    snapshot = dict(battery={'soc': 75., 'voltage': 28.}, attitude={'roll': 0., 'pitch': 0.},
                    fallen=False, error_code=0, speed_sample={'speed': .5, 'received': 100.},
                    sources={k: {'fresh': True, 'age_s': 0.} for k in ('lowstate', 'sportmodestate')})
    headers = app_token(client)
    with agent(client, seeded, direct=True, robot_model='unitree_go2') as ag:
        for expired in (False, True):
            if expired:
                for source in snapshot['sources'].values():
                    source['age_s'] = 1.01
            frame = state()
            frame.update(project(snapshot, 101.01 if expired else 100.))
            frame['devices_changed'] = [{k: v for k, v in d.items() if k != 'received_monotonic_s'}
                                        for d in devices(snapshot, 100.)]
            ag.send_json(frame)
            deadline = time.monotonic()+2
            while True:
                response = client.get(f'/api/v1/robots/{rid}', headers=headers)
                assert response.status_code == 200
                detail = response.json()
                battery_ready = detail['battery'] is None if expired else detail['battery'] is not None
                device_ready = bool(detail['devices']) and all(
                    d['state'] == ('MISSING' if expired else 'OK') for d in detail['devices'])
                if battery_ready and device_ready:
                    break
                assert time.monotonic() < deadline
                time.sleep(.01)
            assert detail['location'] is None
            assert detail['connection'] == 'ONLINE'  # agent link health is separate from sensor health
            if not expired:
                assert detail['battery']['soc'] == 75.
            assert detail['robot_info']['attitude'] == (dict(roll=None, pitch=None) if expired else dict(roll=0., pitch=0.))
            assert detail['robot_info']['error_code'] == (None if expired else 0)


@pytest.mark.parametrize('kind', ['present', 'absent', 'nan', 'out_of_range'])
def test_go2_display_values_reach_rest_and_screen_ws_without_changing_safety(client, seeded, rt, kind):
    rid = seeded['robots']['mine']
    with DBSession(client.app.state.engine) as db:
        db.get(Robot, rid).simulation = False
        db.commit()
    headers = app_token(client)
    info = dict(source='GO2_DDS', attitude=dict(roll=.1, pitch=-.2), error_code=100,
                fallen=False, fallen_source='imu_tilt_estimate')
    expected = info
    if kind in ('nan', 'out_of_range'):
        bad = float('nan') if kind == 'nan' else 4.
        info = {**info, 'attitude': dict(roll=bad, pitch=-.2),
                'error_code': bad if kind == 'nan' else 0x100000000}
        expected = {**info, 'attitude': dict(roll=None, pitch=-.2), 'error_code': None}
    if kind == 'absent':
        expected = None
    with agent(client, seeded, direct=True, robot_model='unitree_go2') as ag, screen(client, headers) as ws:
        assert reply(ws, send(ws, 'sub', robots=[str(rid)], streams=['state']))['ok']
        # A later legacy frame must also clear the previous optional readout.
        for value in (info, None) if kind == 'absent' else (info,):
            frame = state()
            if value is not None:
                frame['robot_info'] = value
            ag.send_text(json.dumps(frame))
            wanted = None if value is None else expected if kind != 'absent' else info
            receive(ws, 'state', predicate=lambda row: row.get('robot_info') == wanted)
            detail = client.get(f'/api/v1/robots/{rid}', headers=headers).json()
            assert detail['robot_info'] == wanted
            assert detail['status'] == 'STOP_LATCHED' and detail['lease'] is None
            assert detail['phone_relay'] is None
