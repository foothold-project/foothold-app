from sqlalchemy import func, select
from sqlalchemy.orm import Session as DBSession

from apps.contracts import models as C
from apps.server.fh_server.models import Event
from .test_realtime import agent, app_token, drain_audit, hello, receive, reply, rt, screen, send  # noqa: F401


def stop_events(client):
    with DBSession(client.app.state.engine) as db:
        return db.scalar(select(func.count()).select_from(Event).where(Event.code == 'STOP'))


def test_stop_reports_delivered_when_agent_connected(client, seeded, rt):
    headers = app_token(client)
    rid = seeded['robots']['mine']
    with agent(client, seeded) as ag, screen(client, headers) as ws:
        response = client.post(f'/api/v1/robots/{rid}/stop', headers=headers)
        assert response.status_code == 202
        assert response.json() == {'requested': True, 'delivered': True}
        C.StopAccepted.model_validate(response.json())
        receive(ag, 'stop')
        ident = send(ws, 'stop', rid)
        result = reply(ws, ident)
        assert result['ok'] and result['delivered'] is True
        receive(ag, 'stop')


def test_stop_reports_not_delivered_when_agent_offline_and_reconnect_stops_first(client, seeded, rt):
    headers = app_token(client)
    rid = seeded['robots']['mine']
    drain_audit(client, rt)
    before = stop_events(client)
    with screen(client, headers) as ws:
        response = client.post(f'/api/v1/robots/{rid}/stop', headers=headers)
        assert response.status_code == 202
        assert response.json() == {'requested': True, 'delivered': False}
        ident = send(ws, 'stop', rid)
        result = reply(ws, ident)
        assert result['ok'] and result['delivered'] is False
        # Other replies keep their old shape.
        ident = send(ws, 'ping')
        assert 'delivered' not in reply(ws, ident)
    drain_audit(client, rt)
    # The audit record of each STOP request stays even with no agent link.
    assert stop_events(client) >= before + 2
    # agent() asserts the first frames on reconnect are lease-null then stop.
    with agent(client, seeded):
        pass


def test_stop_not_delivered_when_connected_agent_cannot_take_it(client, seeded, rt, monkeypatch):
    # A connected peer is not enough: a closing queue or a blocked control path
    # must report delivered=false (review #536, peer-presence mutation).
    headers = app_token(client)
    rid = seeded['robots']['mine']
    with agent(client, seeded):
        peer = rt.agents[str(rid)]
        peer.closing = True
        try:
            response = client.post(f'/api/v1/robots/{rid}/stop', headers=headers)
            assert response.status_code == 202
            assert response.json() == {'requested': True, 'delivered': False}
        finally:
            peer.closing = False
        monkeypatch.setattr(rt, 'blocked_agent_control', lambda peer, body: body.get('t') == 'stop')
        response = client.post(f'/api/v1/robots/{rid}/stop', headers=headers)
        assert response.status_code == 202
        assert response.json() == {'requested': True, 'delivered': False}


def test_reconnect_stop_cannot_reach_real_agent_with_server_drive_off(client, seeded, rt):
    # Review #536 M2: with the server drive switch off, a physical Go2 agent's
    # reconnect STOP is filtered by blocked_agent_control like any server STOP.
    # The phone link or the remote stops that robot, not a reconnect. The HTTP
    # STOP itself is refused there (PHONE_DIRECT_REQUIRED), so only a STOP made
    # while the switch was on can be waiting when the agent reconnects.
    from apps.server.fh_server.models import Robot
    headers = app_token(client)
    rid = seeded['robots']['mine']
    with DBSession(client.app.state.engine) as db:
        db.get(Robot, rid).simulation = False
        db.commit()
    assert not rt.settings.drive_enabled(rid)
    response = client.post(f'/api/v1/robots/{rid}/stop', headers=headers)
    assert response.status_code == 403
    assert response.json()['error']['code'] == 'PHONE_DIRECT_REQUIRED'
    # Same handshake as test_realtime.agent(direct=True), but every frame up to
    # the first ping is kept: the reconnect STOP would be queued before it.
    with client.websocket_connect('wss://testserver/api/v1/agent/ws', headers={
            'authorization': 'Bearer fake-test-' + str(rid)}) as ag:
        ag.send_json(hello())
        seen = []
        receive(ag, predicate=lambda body: seen.append(body.get('t')) or body.get('t') == 'ping')
        peer = rt.agents[str(rid)]
        assert not peer.simulation and not peer.server_drive
        assert rt.blocked_agent_control(peer, {'t': 'stop', 'cause': 'agent_connected'})
        assert 'stop' not in seen, seen
