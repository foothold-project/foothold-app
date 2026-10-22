from dataclasses import replace
from uuid import uuid4

import pytest
from starlette.websockets import WebSocketDisconnect

from apps.server.fh_server.api import Settings
from apps.server.fh_server.tunnel import tunnel_origin
from .conftest import login
from .test_realtime import rt, screen

ORIGIN = 'https://example.trycloudflare.com'


def test_tunnel_configuration_is_off_by_default_and_exact(monkeypatch, caplog):
    monkeypatch.setenv('FH_DATABASE_URL', 'unused')
    monkeypatch.setenv('FH_ORG_ID', str(uuid4()))
    monkeypatch.setenv('FH_TUNNEL_ORIGIN', ORIGIN)
    monkeypatch.delenv('FH_TUNNEL', raising=False)
    assert Settings.from_env().tunnel_origin is None
    monkeypatch.setenv('FH_TUNNEL', '1')
    assert Settings.from_env().tunnel_origin == ORIGIN
    for value in ('https://*.trycloudflare.com', 'http://example.trycloudflare.com',
                  ORIGIN + '/', ORIGIN + ':443', ORIGIN + '.evil.invalid',
                  'https://a.b.trycloudflare.com', 'https://trycloudflare.com'):
        assert tunnel_origin({'FH_TUNNEL': '1', 'FH_TUNNEL_ORIGIN': value}) is None
    assert 'tunnel origin disabled' in caplog.text


def test_tunnel_ws_requires_login_and_exact_allowed_origin(client, seeded, rt):
    for enabled in (False, True):
        rt.settings = replace(rt.settings, tunnel_origin=ORIGIN if enabled else None)
        if not enabled:
            login(client)
            with pytest.raises(WebSocketDisconnect) as error:
                with client.websocket_connect('wss://testserver/api/v1/ws', headers={'origin': ORIGIN}):
                    pass
            assert error.value.status_code == 403
            client.cookies.clear()
        else:
            with pytest.raises(WebSocketDisconnect) as error:
                with client.websocket_connect('wss://testserver/api/v1/ws', headers={'origin': ORIGIN}):
                    pass
            assert error.value.status_code == 401
            login(client)
            with screen(client, {'origin': ORIGIN}):
                pass
            with screen(client, {'origin': 'https://testserver'}):
                pass
            for other in ('https://other.trycloudflare.com', ORIGIN + '.evil.invalid', None):
                with pytest.raises(WebSocketDisconnect) as error:
                    with client.websocket_connect('wss://testserver/api/v1/ws', headers={'origin': other} if other else {}):
                        pass
                assert error.value.status_code == 403
