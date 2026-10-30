"""Only exact pre-creation resource proof releases; diagnostics never leak remote data."""
import io
import json
from contextlib import contextmanager
from types import SimpleNamespace
from urllib.error import HTTPError, URLError

import pytest

from apps.server.fh_server.simulation import Relay, RelayError
from apps.server.tests.test_simulation import (simulation_context, start_slot,
    clean_ros_environment, isolated_manager_startup)
from apps.server.tests.test_sim_recovery import snapshot
from .test_api import csrf


def failing_transport(error):
    relay = Relay.__new__(Relay)
    relay.url, relay.secret = 'http://127.0.0.1:9418', 'x' * 32
    def opened(*args, **kwargs):
        raise error
    relay.opener = SimpleNamespace(open=opened)
    return relay


@pytest.mark.parametrize('detail,expected', [
    ({'reason': 'resources_low', 'start_not_created': True, 'secret': 'private'},
     {'reason': 'resources_low', 'start_not_created': True}),
    ({'reason': 'guard_access', 'start_not_created': True, 'path': '/private', 'errno': 13},
     {'reason': 'guard_access', 'start_not_created': True}),
    ({'reason': 'slot_busy'}, {'reason': 'slot_busy', 'start_not_created': False}),
    ({'reason': 'future', 'secret': 'private'}, {'reason': 'unknown'}),
    ({'reason': 'resources_low', 'start_not_created': 'true'}, {'reason': 'unknown'}),
    (None, {}),
])
def test_relay_allowlists_diagnostics_and_preserves_status(detail, expected):
    body = {'code': 'SIM_UNAVAILABLE'}
    if detail is not None:
        body['detail'] = detail
    error = HTTPError('http://127.0.0.1:9418', 503, 'private', {},
                      io.BytesIO(json.dumps({'error': body}).encode()))
    with pytest.raises(RelayError) as caught:
        failing_transport(error).request('POST', '/v1/robots', {})
    assert (caught.value.status, caught.value.code) == (503, 'SIM_UNAVAILABLE')
    assert caught.value.detail == expected


@pytest.mark.parametrize('cause,reason', [
    (ConnectionRefusedError(), 'manager_unreachable'), (TimeoutError(), None),
])
def test_only_refused_connection_reports_manager_off(cause, reason):
    with pytest.raises(RelayError) as caught:
        failing_transport(URLError(cause)).request('GET', '/v1/worlds')
    assert (caught.value.status, caught.value.code) == (503, 'SIM_UNAVAILABLE')
    assert caught.value.detail.get('reason') == reason


@pytest.mark.parametrize('detail', [
    {'reason': 'resources_low', 'start_not_created': True},
    {'reason': 'manager_unreachable'}, {},
])
def test_start_diagnostics_release_only_proven_resource_rejection(simulation_context, detail):
    client, manager, cfg, rid, launcher = simulation_context
    original = client.app.state.simmgr.request
    def rejected(method, path, body=None):
        if method == 'POST':
            raise RelayError(detail=detail or None)
        return original(method, path, body)
    client.app.state.simmgr.request = rejected
    result, headers = start_slot(simulation_context)
    assert result.status_code == 503
    assert result.json()['error']['detail'].get('reason') == detail.get('reason')
    state, owner, generation, _ = snapshot(client, rid)
    if detail.get('start_not_created') is True:
        assert (state, owner, generation) == ('IDLE', None, 1)
        client.app.state.simmgr.request = original
        result, _ = start_slot(simulation_context)
        assert result.status_code == 201 and result.json()['generation'] == 2
        return
    assert (state, generation) == ('STARTING', 1) and owner is not None
    assert client.delete('/api/v1/simulation/robots/' + rid, headers=headers).status_code == 204
    assert snapshot(client, rid)[:3] == ('IDLE', None, 1)


def test_catalog_reports_manager_unreachable_without_reservation(simulation_context):
    client, manager, cfg, rid, launcher = simulation_context
    client.app.state.simmgr = failing_transport(URLError(ConnectionRefusedError()))
    csrf(client)
    response = client.get('/api/v1/simulation/worlds')
    assert response.status_code == 503
    assert response.json()['error']['detail']['reason'] == 'manager_unreachable'


@pytest.mark.parametrize('rejection', ['resources', 'SIM_WORLD_UNKNOWN', 'SIM_WORLD_INVALID'])
def test_manager_resource_diagnostic_crosses_real_relay_and_server(simulation_context, rejection):
    from apps.simmgr.preflight import ResourceGateError
    from apps.simmgr.native_catalogue import WorldValidationError
    client, manager, cfg, rid, launcher = simulation_context
    async def blocked(world):
        if rejection != 'resources':
            raise WorldValidationError('private diagnostic must not cross relay', rejection)
        raise ResourceGateError()
    launcher.start_world = blocked
    relay = Relay.__new__(Relay)
    relay.url, relay.secret = 'http://127.0.0.1:9418', cfg.secret
    @contextmanager
    def opened(request, **kwargs):
        response = manager.request(request.method, request.full_url.removeprefix(relay.url),
            json=json.loads(request.data) if request.data else None,
            headers={'Authorization': 'Bearer ' + relay.secret})
        if response.status_code >= 400:
            raise HTTPError(request.full_url, response.status_code, 'synthetic', {}, io.BytesIO(response.content))
        yield io.BytesIO(response.content)
    relay.opener = SimpleNamespace(open=opened)
    client.app.state.simmgr = relay
    result, headers = start_slot(simulation_context)
    assert result.status_code == (503 if rejection == 'resources' else 400)
    if rejection == 'resources':
        assert result.json()['error']['detail'] == {'reason': 'resources_low', 'start_not_created': True}
    else:
        assert result.json()['error']['code'] == rejection
        assert 'private diagnostic' not in result.text
    assert snapshot(client, rid)[:3] == ('IDLE', None, 1)
    assert not manager.app.state.manager.robots and not launcher.events
    async def ready(world):
        return None
    launcher.start_world = ready
    result, headers = start_slot(simulation_context)
    assert result.status_code == 201 and result.json()['generation'] == 2
    assert client.delete('/api/v1/simulation/robots/' + rid, headers=headers).status_code == 204


def test_guard_access_diagnostic_does_not_release_reserved_slot():
    from apps.server.fh_server.simulation import start_not_created
    error = RelayError(detail={'reason': 'guard_access', 'start_not_created': True})
    assert error.detail == {'reason': 'guard_access', 'start_not_created': True}
    assert not start_not_created(error)
