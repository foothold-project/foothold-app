"""Real IPC client with private fake sockets; no ROS or simulation runtime."""
import asyncio
import json
import logging
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from apps.contracts.models import ExternalCameraViewRequest
from apps.simmgr.api import create_app
from apps.simmgr.launcher import NativeLauncher
from apps.simmgr.observer_entry import observer_request
from test_external_camera import policy
from test_manager import settings


@pytest.mark.parametrize('cancelled', [False, True])
def test_client_closes_before_delayed_ack_and_logs_cause(policy, tmp_path, caplog, cancelled):
    _, body, _ = policy
    caplog.set_level(logging.WARNING)

    async def exercise():
        path = str(tmp_path/'ipc')
        received, peer_closed = asyncio.Event(), asyncio.Event()
        commands = []

        async def serve(reader, writer):
            try:
                raw = await reader.readline()
                assert raw.endswith(b'\n') and len(raw) < 4096
                envelope = json.loads(raw)
                commands.append(envelope['op'])
                if envelope['op'] == 'discard':
                    writer.write(b'{"accepted":true}\n')
                    await writer.drain()
                else:
                    received.set()
                    # Withhold the ACK: observe EOF from the real client first.
                    assert await reader.read() == b''
                    peer_closed.set()
            finally:
                writer.close()
                await writer.wait_closed()

        server = await asyncio.start_unix_server(serve, path=path)
        launch = NativeLauncher.__new__(NativeLauncher)
        launch.sim = None
        launch.failed = launch.observer_busy = False
        launch._watching = True
        launch.observer = SimpleNamespace(socket_path=path)
        try:
            task = asyncio.create_task(launch.external_view(
                ExternalCameraViewRequest.model_validate(body), 'view'))
            await asyncio.wait_for(received.wait(), 1)
            if cancelled:
                task.cancel()
            with pytest.raises(asyncio.CancelledError if cancelled else TimeoutError):
                await task
            await asyncio.wait_for(peer_closed.wait(), 1)
            assert commands == ['view', 'discard']
            assert not launch.observer_busy
        finally:
            server.close()
            await server.wait_closed()

    asyncio.run(exercise())
    kind = 'CancelledError' if cancelled else 'TimeoutError'
    assert f'observer IPC stage=client_ack kind={kind}' in caplog.text
    assert body['robot'] not in caplog.text and body['episode_id'] not in caplog.text


@pytest.mark.parametrize('cause', [ValueError, OSError, TimeoutError, ConnectionResetError, BrokenPipeError])
def test_http_409_logs_only_exception_kind(policy, caplog, cause):
    _, body, _ = policy
    cfg = settings()
    slot = next(iter(cfg.slots.values()))
    body['robot'] = slot.robot_id
    app = create_app(cfg)
    manager = app.state.manager
    manager.robots[slot.robot_id] = SimpleNamespace(state='RUNNING', generation=1, slot=slot)

    async def relay(request, operation):
        raise cause('private request value must never be logged')

    manager.launcher.external_view = relay
    caplog.set_level(logging.WARNING)
    with TestClient(app, client=('127.0.0.1', 9610)) as client:
        response = client.post('/v1/robots/'+slot.robot_id+'/external-camera/view',
            headers={'Authorization': 'Bearer '+cfg.secret}, json=body)
        assert response.status_code == 409
        assert response.json()['error']['code'] == 'SIM_OBSERVER_UNAVAILABLE'
    records = [r.getMessage() for r in caplog.records if r.name == 'apps.simmgr.external_camera']
    assert records == [f'observer IPC stage=http_relay kind={cause.__name__}']
    assert 'private request value' not in caplog.text
    assert cfg.secret not in caplog.text


def test_real_handler_and_client_roundtrip_framing_and_close(policy, tmp_path):
    observer, body, _ = policy

    async def exercise():
        path = str(tmp_path/'ipc')
        completed = asyncio.Event()

        async def serve(reader, writer):
            try:
                await observer_request(observer, reader, writer)
            finally:
                completed.set()

        server = await asyncio.start_unix_server(serve, path=path, limit=4096)
        launch = NativeLauncher.__new__(NativeLauncher)
        launch.sim = None
        launch.failed = launch.observer_busy = False
        launch._watching = True
        launch.observer = SimpleNamespace(socket_path=path)
        try:
            for seq, op in enumerate(('view', 'reset', 'cancel')):
                completed.clear()
                result = await launch.external_view(
                    ExternalCameraViewRequest.model_validate(dict(body, seq=seq)), op)
                assert result == dict(accepted=True, shared=True, seq=seq, operation=op)
                await asyncio.wait_for(completed.wait(), 1)
            assert observer.pending is None
        finally:
            server.close()
            await server.wait_closed()

    asyncio.run(exercise())


def test_observer_peer_disconnect_logs_write_and_close_without_values(policy, caplog):
    observer, body, _ = policy

    class Reader:
        async def readline(self):
            return json.dumps(dict(op='view', request=body)).encode()+b'\n'

    class Writer:
        def write(self, data):
            assert json.loads(data)['accepted'] is True

        async def drain(self):
            raise ConnectionResetError('private transport value')

        def close(self):
            pass

        async def wait_closed(self):
            raise BrokenPipeError('private transport value')

    with caplog.at_level(logging.WARNING), pytest.raises(BrokenPipeError):
        asyncio.run(observer_request(observer, Reader(), Writer()))
    assert [r.getMessage() for r in caplog.records] == [
        'observer IPC stage=observer_write kind=ConnectionResetError',
        'observer IPC stage=observer_close kind=BrokenPipeError']


def test_diagnostic_vocabulary_does_not_log_arbitrary_class_or_stage(caplog):
    from apps.simmgr.external_camera import log_ipc_failure

    class PrivateExceptionName(ValueError):
        pass

    with caplog.at_level(logging.WARNING):
        log_ipc_failure('private stage value', PrivateExceptionName('private input'))
    assert [r.getMessage() for r in caplog.records] == [
        'observer IPC stage=unknown kind=ValueError']
