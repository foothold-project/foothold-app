"""UI diagnostics keep robot isolation, freshness and inventory persistence."""
from uuid import UUID

from sqlalchemy import select, create_engine
from sqlalchemy.orm import sessionmaker

from apps.contracts import models as C
from apps.server.fh_server.realtime import Realtime
from apps.server.fh_server.robots import attention, device_error, save_inventory
from apps.server.fh_server.models import RobotDevice
from .test_screen_safety_reason import runtime
from .test_realtime import agent, app_token, receive, reply, rt, screen, send, state

REFUSED = dict(reason='STILL_MOVING', at='2026-11-01T01:00:00Z',
    axes=[dict(axis='vz', value=.04, limit=.02, unit='m/s')])
CODE = dict(raw=100, level='ACCEPTED', reason='EXPLICIT_SERVER_ALLOWLIST')
DEVICE = dict(key='go2-sport', kind='OTHER', label='기체 기본 보행 상태', state='OK', status_code=CODE)


def test_refusal_freshness_isolation_and_legacy_clear(runtime):
    realtime, rid, other = runtime
    peer = realtime.agents[rid]
    def accept(**fields):
        return Realtime.accept_state(realtime, rid, peer, C.AgentState.model_validate(state(**fields)))
    assert accept(unlock_refused=REFUSED)
    assert Realtime.screen_state(realtime, rid)['unlock_refused'] == REFUSED
    assert Realtime.screen_state(realtime, other)['unlock_refused'] is None
    realtime.clock.step(3.001)
    assert Realtime.screen_state(realtime, rid)['unlock_refused'] is None
    realtime.clock.at = 0
    assert accept()
    assert Realtime.screen_state(realtime, rid)['unlock_refused'] is None
    assert accept(unlock_refused=REFUSED)
    peer.closing = True
    assert Realtime.screen_state(realtime, rid)['unlock_refused'] is None


def test_real_websocket_delivers_refusal_and_device_code(client, seeded, rt):
    rid = str(seeded['robots']['mine'])
    with agent(client, seeded) as ag, screen(client, app_token(client)) as ws:
        assert reply(ws, send(ws, 'sub', robots=[rid], streams=['state']))['ok']
        receive(ws, 'state')
        ag.send_json(state(2, unlock_refused=REFUSED, devices_changed=[DEVICE]))
        body = receive(ws, 'state', predicate=lambda b: b['stop_gen'] == 2)
        assert body['unlock_refused'] == REFUSED
        assert body['devices'] == [DEVICE]
        assert not device_error(rt, rid, True)
        assert 'DEVICE_ERROR' not in attention(True, dict(status='IDLE'), device_error(rt, rid, True), C.OrgSettings())
        ag.send_json(state(3, devices_changed=[{**DEVICE, 'state': 'ERROR',
            'status_code': dict(raw=101, level='ERROR', reason=None)}]))
        body = receive(ws, 'state', predicate=lambda b: b['stop_gen'] == 3)
        assert body['unlock_refused'] is None
        assert device_error(rt, rid, False)
        assert 'DEVICE_ERROR' in attention(True, dict(status='IDLE'), device_error(rt, rid, False), C.OrgSettings())


def test_inventory_stores_code_in_existing_info_and_clears_legacy(client, seeded):
    engine = create_engine(seeded['urls']['migrate'])
    factory = sessionmaker(engine)
    rid = seeded['robots']['mine']
    for device, expected in ((DEVICE, CODE), ({k:v for k,v in DEVICE.items() if k != 'status_code'}, None)):
        save_inventory(factory, seeded['org'], str(rid), [device])
        with factory() as db:
            row = db.scalar(select(RobotDevice).where(RobotDevice.robot_id == rid))
            assert row.state == 'OK' and row.info.get('status_code') == expected
    engine.dispose()
