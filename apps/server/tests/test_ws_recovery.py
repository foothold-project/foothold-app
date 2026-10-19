import json

import pytest
from websockets.exceptions import ConnectionClosed
from websockets.sync.client import connect

from .ws_process import server_process


@pytest.mark.parametrize('path', ['/api/v1/ws', '/api/v1/agent/ws'])
def test_n1_busy_is_retryable_1013_over_real_uvicorn(seeded, tmp_path, path):
    with server_process(seeded, tmp_path, hold_owner=True) as server:
        # The actual upgrade must succeed; a pre-accept close raises InvalidStatus(403).
        with connect(server['base'] + path, proxy=None) as ws:
            assert ws.response.status_code == 101
            with pytest.raises(ConnectionClosed) as error:
                ws.recv(timeout=2)
            assert error.value.rcvd.code == 1013


def test_true_agent_auth_denial_stays_forbidden(seeded, tmp_path):
    from websockets.exceptions import InvalidStatus
    with server_process(seeded, tmp_path) as server:
        with pytest.raises(InvalidStatus) as error:
            with connect(server['base'] + '/api/v1/agent/ws', proxy=None,
                         additional_headers={'authorization': 'Bearer fake-wrong-agent-token'}):
                pass
        assert error.value.response.status_code == 403
