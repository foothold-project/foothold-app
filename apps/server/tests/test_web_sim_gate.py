"""PC passes cannot target hardware; phone and admin boundaries stay intact."""
import base64
import json
from uuid import uuid4

import pytest
from sqlalchemy.orm import Session

from apps.server.fh_server.api import ADMIN_NO_REAL_CONTROL
from apps.server.fh_server.models import PhonePass, Robot
from .test_api import csrf
from .test_phone_pass import pc, rows


@pytest.mark.parametrize('purpose', ['control', 'view'])
@pytest.mark.parametrize('simulation', [False, True])
@pytest.mark.parametrize('surface', [None, 'phone', 'pc'])
def test_surface_issuance(pc, seeded, purpose, simulation, surface):
    with Session(pc.app.state.engine) as db:
        db.get(Robot, seeded['robots']['mine']).simulation = simulation
        db.commit()
    body = dict(device=str(uuid4()), purpose=purpose)
    if surface is not None:
        body['surface'] = surface
    result = pc.post(f"/api/v1/robots/{seeded['robots']['mine']}/phone-pass",
                     headers=pc.pass_headers, json=body)
    if surface == 'pc' and not simulation:
        assert result.status_code == 403
        assert result.json()['error']['code'] == 'WEB_SIM_ONLY'
        assert not rows(seeded, PhonePass)
    else:
        assert result.status_code == 200, result.text
        claims = json.loads(base64.urlsafe_b64decode(result.json()['token'].split('.')[1] + '=='))
        assert claims['surface'] == (surface or 'phone')


@pytest.mark.parametrize('surface', ['', 'PC', 'tablet', None, True, 1])
def test_invalid_surface_fails_closed(pc, seeded, surface):
    result = pc.post(f"/api/v1/robots/{seeded['robots']['mine']}/phone-pass",
                     headers=pc.pass_headers,
                     json=dict(device=str(uuid4()), purpose='control', surface=surface))
    assert result.status_code == 400


@pytest.mark.parametrize('purpose', ['control', 'view'])
def test_agent_does_not_trust_server_simulation_flag(pc, seeded, tmp_path, purpose):
    from foothold_agent.phone.hub import Hub, PhoneError
    from foothold_agent.phone.tickets import Verifier
    with Session(pc.app.state.engine) as db:
        db.get(Robot, seeded['robots']['mine']).simulation = True
        db.commit()
    device = str(uuid4())
    robot = str(seeded['robots']['mine'])
    issued = pc.post(f'/api/v1/robots/{robot}/phone-pass', headers=pc.pass_headers,
                     json=dict(device=device, purpose=purpose, surface='pc'))
    assert issued.status_code == 200
    verifier = Verifier(robot, pc.keys[robot][1], org=str(seeded['org']),
                        replay_path=str(tmp_path / 'replay.sqlite'), clock_trusted=True)
    sink = type('Sink', (), {'apply': lambda *_: None})()
    hub = Hub(verifier, sink, policy_name='test', policy_version='1', simulation=False)
    try:
        with pytest.raises(PhoneError) as exc:
            hub.receive(object(), json.dumps(dict(t='hello', id='1', robot=robot,
                        proto='fh-phone/1', device=device, ticket=issued.json()['token'])))
        assert exc.value.code == 'WEB_SIM_ONLY'
    finally:
        hub.close()
        verifier.close()


def test_admin_pc_physical_denial_precedes_surface_gate(pc, seeded):
    with Session(pc.app.state.engine) as db:
        db.get(Robot, seeded['robots']['mine']).simulation = False
        db.commit()
    result = pc.post(f"/api/v1/robots/{seeded['robots']['mine']}/phone-pass",
                     headers=csrf(pc, 'admin'),
                     json=dict(device=str(uuid4()), purpose='control', surface='pc'))
    assert result.status_code == 403
    assert result.json()['error'] == dict(
        code='ADMIN_NO_REAL_CONTROL', message=ADMIN_NO_REAL_CONTROL, detail={})
    assert not rows(seeded, PhonePass)
