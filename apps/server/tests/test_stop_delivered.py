from sqlalchemy import func, select
from sqlalchemy.orm import Session as DBSession

from apps.contracts import models as C
from apps.server.fh_server.models import Event
from .test_realtime import agent, app_token, drain_audit, receive, reply, rt, screen, send  # noqa: F401


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
