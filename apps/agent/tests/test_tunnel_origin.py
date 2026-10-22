import asyncio
import json

import pytest

from foothold_agent.phone.origins import with_tunnel_origin
from foothold_agent.phone.server import Settings
from test_phone import h
from test_phone_review import running, hello

ORIGIN = 'https://example.trycloudflare.com'


def test_tunnel_origin_is_exact_opt_in_and_does_not_modify_defaults(caplog):
    old = ('http://localhost:5190',)
    assert with_tunnel_origin(old, {'FH_TUNNEL_ORIGIN': ORIGIN}) is old
    assert with_tunnel_origin(old, {'FH_TUNNEL': '0', 'FH_TUNNEL_ORIGIN': ORIGIN}) is old
    assert with_tunnel_origin(old, {'FH_TUNNEL': '1', 'FH_TUNNEL_ORIGIN': ORIGIN}) == (*old, ORIGIN)
    for value in ('*', 'https://*.trycloudflare.com', ORIGIN + '/', ORIGIN + ':443',
                  ORIGIN + '.evil.invalid', 'http://example.trycloudflare.com', 'https://a.b.trycloudflare.com'):
        assert with_tunnel_origin(old, {'FH_TUNNEL': '1', 'FH_TUNNEL_ORIGIN': value}) is old
    assert 'tunnel origin disabled' in caplog.text


def test_agent_env_adds_tunnel_only_for_simulation(h):
    env = {'FOOTHOLD_PHONE_HOST': '127.0.0.1', 'FOOTHOLD_PHONE_PORT': '9481',
           'FOOTHOLD_PHONE_KEY_PATH': 'unused', 'FOOTHOLD_PHONE_POLICY_NAME': 'test',
           'FOOTHOLD_PHONE_POLICY_VERSION': '1', 'FOOTHOLD_PHONE_ORG_ID': h.org,
           'FOOTHOLD_PHONE_REPLAY_DB': 'unused.sqlite', 'FOOTHOLD_PHONE_CLOCK_TRUSTED': '1',
           'FOOTHOLD_PHONE_SIMULATION': '1', 'FOOTHOLD_PHONE_ORIGINS': json.dumps(['http://localhost:5190']),
           'FH_TUNNEL_ORIGIN': ORIGIN}
    assert Settings.from_env(env).origins == ('http://localhost:5190',)
    assert Settings.from_env({**env, 'FH_TUNNEL': '1'}).origins == ('http://localhost:5190', ORIGIN)
    assert Settings.from_env({**env, 'FH_TUNNEL': '1', 'FOOTHOLD_PHONE_SIMULATION': '0'}).origins == ('http://localhost:5190',)


def test_tunnel_handshake_keeps_ticket_requirement_and_rejects_other_origins(h):
    from websockets.asyncio.client import connect
    from websockets.exceptions import InvalidStatus
    async def run():
        origins = with_tunnel_origin((), {'FH_TUNNEL': '1', 'FH_TUNNEL_ORIGIN': ORIGIN})
        async with running(h, origins=origins) as (_, uri, _):
            for other in ('https://other.trycloudflare.com', ORIGIN + '.evil.invalid'):
                with pytest.raises(InvalidStatus) as error:
                    async with connect(uri, proxy=None, origin=other):
                        pass
                assert error.value.response.status_code == 403
            async with connect(uri, proxy=None, origin=ORIGIN) as ws:
                await hello(h, ws, purpose='view')
                assert h.hub.owner is None
            # Correct Origin alone never acquires a lease or unlocks the robot.
            async with connect(uri, proxy=None, origin=ORIGIN) as ws:
                await ws.send(json.dumps({'t': 'hello', 'id': 'bad', 'robot': h.robot,
                    'proto': 'fh-phone/1', 'device': 'fake', 'ticket': 'invalid'}))
                from websockets.exceptions import ConnectionClosed
                with pytest.raises(ConnectionClosed):
                    await ws.recv()
                assert h.hub.owner is None and h.hub.session.core.latch
    asyncio.run(run())
