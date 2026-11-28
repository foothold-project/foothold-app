"""FH_WS_ORIGIN: comma separated list of exact origins, shared by both WS checks."""
from dataclasses import replace
from types import SimpleNamespace

import pytest
from starlette.websockets import WebSocketDisconnect

from apps.server.fh_server import drive_media, realtime
from .conftest import login
from .test_drive_media import trial  # noqa: F401  (fixture)
from .test_server_drive import trial as drive_trial  # noqa: F401  (fixture)
from .test_realtime import rt, screen  # noqa: F401  (fixture)

A, B = 'http://localhost:5195', 'http://localhost:5196'
LIST = f' {A} , ,{B},'


def ws(origin, base='ws://testserver/'):
    return SimpleNamespace(headers={'origin': origin} if origin is not None else {}, base_url=base)


def allowed(configured, origin, tunnel=None, base='ws://testserver/'):
    from apps.server.fh_server.tunnel import ws_origin_allowed
    return ws_origin_allowed(SimpleNamespace(ws_origin=configured, tunnel_origin=tunnel), ws(origin, base))


@pytest.mark.parametrize('origin,ok', [
    (A, True), (B, True),                       # both list entries
    ('http://localhost:5197', False),            # outside the list
    ('*', False), ('http://localhost:519', False),  # wildcard / prefix
    ('HTTP://LOCALHOST:5195', False),            # case differs
    (A + '/', False),                            # trailing slash
    ('http://localhost:5190', False),            # port differs
    ('https://localhost:5195', False),           # scheme differs
    (' ' + A, False), (A + ' ', False),          # header whitespace is not trimmed
    ('', False), (None, False),                  # no origin header
    ('http://testserver', False),                # same-origin default is replaced by the list
])
def test_list_is_exact(origin, ok):
    assert allowed(LIST, origin) is ok


@pytest.mark.parametrize('configured', ['*', 'http://localhost:519'])
def test_wildcard_or_prefix_config_matches_only_itself(configured):
    assert not allowed(configured, A)
    assert not allowed(configured, 'http://testserver')


def test_single_value_unchanged():
    assert allowed(A, A)
    for other in (B, 'http://testserver', A + '/', None):
        assert not allowed(A, other)


@pytest.mark.parametrize('configured', [None, '', ',', ' , '])
def test_empty_list_falls_back_to_same_origin(configured):
    assert allowed(configured, 'http://testserver')
    assert allowed(configured, 'https://testserver', base='wss://testserver/')
    assert not allowed(configured, A)
    assert not allowed(configured, None)


def test_tunnel_origin_still_allowed_alongside_list():
    tunnel = 'https://example.trycloudflare.com'
    assert allowed(LIST, tunnel, tunnel=tunnel)
    assert allowed(LIST, A, tunnel=tunnel)


def test_both_checks_share_one_function():
    from apps.server.fh_server.tunnel import ws_origin_allowed
    assert realtime.ws_origin_allowed is ws_origin_allowed
    assert drive_media.ws_origin_allowed is ws_origin_allowed


def test_screen_ws_accepts_listed_origins(client, seeded, rt):
    rt.settings = replace(rt.settings, ws_origin=LIST)
    login(client)
    for origin in (A, B):
        with screen(client, {'origin': origin}):
            pass
    for origin in ('http://localhost:5197', '*', 'http://localhost:519', None):
        with pytest.raises(WebSocketDisconnect) as error:
            with client.websocket_connect('wss://testserver/api/v1/ws',
                                          headers={'origin': origin} if origin else {}):
                pass
        assert error.value.status_code == 403


def test_drive_media_viewer_uses_same_list(trial, seeded):
    realtime_ = trial.app.state.realtime
    realtime_.settings = replace(realtime_.settings, ws_origin=LIST)
    login(trial)
    path = f"wss://testserver/api/v1/robots/{seeded['robots']['mine']}/drive-media/rgb"
    for origin in (A, B):
        with trial.websocket_connect(path, headers={'origin': origin}):
            pass
    for origin in ('http://localhost:5197', '*', 'http://localhost:519', None):
        with pytest.raises(WebSocketDisconnect):
            with trial.websocket_connect(path, headers={'origin': origin} if origin else {}):
                pass
