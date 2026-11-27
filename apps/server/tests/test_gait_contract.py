"""걷기 모드 계약만 먼저 (11/28): 서버는 에이전트 전달이 붙기 전까지 gait 를 받은 척하지 않는다."""

import pytest

from .test_server_drive import trial  # noqa: F401
from .test_realtime import app_token, hello, receive, reply, screen, send, take


def test_screen_gait_is_refused_until_agent_relay_exists(trial, seeded):
    rid = seeded['robots']['mine']
    owner = app_token(trial)
    with trial.websocket_connect('/api/v1/agent/ws', headers={
            'authorization': 'Bearer fake-test-' + str(rid)}) as ag:
        ag.send_json(hello())
        receive(ag, 'lease'); receive(ag, 'stop'); receive(ag, 'field_approval')
        with screen(trial, owner) as ws:
            lease = take(ws, ag, rid)
            answer = reply(ws, send(ws, 'gait', rid, lease_id=lease, gait='sport'))
            assert not answer['ok'] and answer['error']['code'] == 'GAIT_UNSUPPORTED'
            # 에이전트로는 아무것도 나가지 않는다
            with pytest.raises(pytest.fail.Exception, match='Expected gait'):
                receive(ag, 'gait', timeout=0.5)
        with screen(trial, owner) as other:
            # lease 를 쥐지 않은 화면도 받은 척하지 않는다
            answer = reply(other, send(other, 'gait', rid, lease_id=lease, gait='classic'))
            assert not answer['ok']
