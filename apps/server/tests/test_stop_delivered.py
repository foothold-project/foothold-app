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


import pytest  # noqa: E402
from datetime import timedelta  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import create_engine  # noqa: E402
from apps.server.fh_server.api import Settings, create_app  # noqa: E402
from apps.server.fh_server.models import Robot, now  # noqa: E402
from apps.server.fh_server.security import digest  # noqa: E402
from .test_realtime import hello  # noqa: E402


@pytest.fixture
def switch_off(seeded):
    # 실기 · 현장 승인 있음 · 서버 시험 스위치 꺼짐 (server_drive_robots 비움).
    engine = create_engine(seeded['urls']['migrate'])
    with DBSession(engine) as db:
        for index, rid in enumerate(seeded['robots'].values()):
            row = db.get(Robot, rid)
            row.simulation = False
            row.serial = f'1234-{index}'
            row.field_approval_expires_at = now() + timedelta(minutes=30)
            row.agent_token_hash = digest('fake-test-' + str(rid))
        db.commit()
    engine.dispose()
    app = create_app(Settings(seeded['urls']['app'], seeded['org'], server_drive_robots=frozenset()))
    with TestClient(app, base_url='https://testserver') as client:
        yield client
    app.state.engine.dispose()


def test_switch_off_real_robot_stop_is_refused_not_silently_ok(switch_off, seeded):
    # 11/28 앱 STOP 조사: 실기 시험 스위치가 꺼져 있으면 서버는 정지를 에이전트로 보내지 않는다.
    # 그때 화면이 ok 를 받으면 안 된다. WS · HTTP 둘 다 PHONE_DIRECT_REQUIRED (403) 로 거절한다.
    client = switch_off
    headers = app_token(client)
    rid = seeded['robots']['mine']
    with client.websocket_connect('/api/v1/agent/ws', headers={'authorization': 'Bearer fake-test-' + str(rid)}) as ag:
        ag.send_json(hello())
        with screen(client, headers) as ws:
            result = reply(ws, send(ws, 'stop', rid))
            assert result['ok'] is False and 'delivered' not in result
            assert result['error']['code'] == 'PHONE_DIRECT_REQUIRED'
            response = client.post(f'/api/v1/robots/{rid}/stop', headers=headers)
            assert response.status_code == 403
            assert response.json()['error']['code'] == 'PHONE_DIRECT_REQUIRED'


@pytest.mark.parametrize('username', ['one', 'admin'])
def test_codex_pr529_all_stop_with_phone_direct_lease_and_switch_off_is_not_ok(switch_off, seeded, username):
    # Codex pr529 지적 1 재현: 서버 경유 조종 시험이 꺼진 실기 Go2 를 운영자 폰이 직결로 조종 중
    # (에이전트 hello 에 직결 lease 가 살아 있음), 같은 로봇이 ONLINE 인 PC 관제에서 STOP (rt.stop = WS stop,
    # 실패 시 HTTP). 서버가 에이전트로 stop 을 못 보내는 이 구성에서 화면이 ok 를 받으면 안 된다.
    client = switch_off
    headers = app_token(client, username)
    rid = seeded['robots']['mine']
    rt = client.app.state.realtime
    from uuid import uuid4
    with client.websocket_connect('/api/v1/agent/ws', headers={'authorization': 'Bearer fake-test-' + str(rid)}) as ag:
        ag.send_json({**hello(), 'lease_id': str(uuid4()), 'latched': False})
        with screen(client, headers) as ws:
            # 같은 로봇이 화면에 ONLINE 으로 보이는 상태: 에이전트가 붙어 있고 서버 시험 스위치는 꺼짐
            import time
            for _ in range(100):
                if str(rid) in rt.agents:
                    break
                time.sleep(.02)
            assert rt.agents[str(rid)].server_drive is False and not rt.agents[str(rid)].simulation
            result = reply(ws, send(ws, 'stop', rid))
            assert result['ok'] is False and 'delivered' not in result, result
            # 운영자는 PHONE_DIRECT_REQUIRED. 총괄은 이 base 에서 ADMIN_NO_REAL_CONTROL, #544 뒤에도 relay_authorize 의
            # PHONE_DIRECT_REQUIRED 가 남는다 (#544 diff 확인).
            assert result['error']['code'] in ('PHONE_DIRECT_REQUIRED', 'ADMIN_NO_REAL_CONTROL')
            response = client.post(f'/api/v1/robots/{rid}/stop', headers=headers)
            assert response.status_code == 403
            assert response.json()['error']['code'] == result['error']['code']
