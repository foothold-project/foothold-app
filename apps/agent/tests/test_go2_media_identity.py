"""Media uses setup body evidence; all SDK, neighbor and HTTP samples are fake."""
import asyncio
import builtins
import io
import socket
import threading
import time
from dataclasses import replace
from types import SimpleNamespace as NS
from urllib.error import HTTPError

import pytest

from foothold_agent.go2_direct.approval import Approval
from foothold_agent.go2_direct.identity import neighbor_identity
from foothold_agent.go2_direct.media import Publisher, Source, approved_publisher
from foothold_agent.go2_readonly.sdk import Subscriptions
from foothold_agent.setup.identity import MacIdentity, mounted_binding
from foothold_agent.setup.runtime import Inputs
from test_go2_feedback import low
from test_go2_drive_media import cloud
from test_setup_pairing import NIC_VALUE, credentials

MAC = '02:00:00:00:00:11'


def recorder():
    return NS(start=lambda: None, rgb=lambda _: None, lidar=lambda _: None)


@pytest.mark.parametrize('failure', [None, 'different-mac', 'missing-neighbor', 'expired',
                                    'missing-identity', 'binding', 'saved-mac', 'serial-conflict'])
@pytest.mark.parametrize('serial_none', [False, True])
def test_mac_media_reuses_current_connection_identity(monkeypatch, caplog, failure, serial_none):
    import foothold_agent.go2_direct.media as media
    inputs = Inputs()
    inputs.lowstate(low(1, sn=(0, 0)))
    rows = [dict(dst='192.168.123.161', lladdr=MAC, state=['REACHABLE']),
            dict(dst='192.168.123.200', state=['FAILED'])]
    identity = inputs.mac_identity = MacIdentity(NIC_VALUE.name, MAC, inputs,
        query=lambda nic: neighbor_identity(nic, entries=rows))
    identity.check()
    # The old manual-trial policy rejects this exact snapshot.
    with pytest.raises(PermissionError):
        neighbor_identity(NIC_VALUE.name, entries=rows, exclusive=True)
    creds = replace(credentials(), robot_serial=identity.serial, robot_mac=MAC,
                    identity_source='mac', mounted_binding=mounted_binding(NIC_VALUE, MAC, computer=lambda:'a'*64))
    if serial_none:
        creds = NS(robot_id=creds.robot_id, link=creds.link, robot_serial=None,
                   robot_mac=MAC, identity_source='mac', mounted_binding=creds.mounted_binding)
    if failure in ('different-mac', 'missing-neighbor'):
        if failure == 'different-mac': rows[0]['lladdr'] = '02:00:00:00:00:22'
        else: rows.pop(0)
        with pytest.raises(PermissionError): identity.check()
    elif failure == 'expired': identity.checked = float('-inf')
    elif failure == 'missing-identity': inputs.mac_identity = None
    elif failure == 'binding': creds.mounted_binding['robot_mac'] = '02:00:00:00:00:22'
    elif failure == 'saved-mac':
        creds = NS(robot_id=creds.robot_id, link=creds.link, robot_mac='02:00:00:00:00:22',
                   identity_source='mac', mounted_binding=None)
    elif failure == 'serial-conflict': inputs.lowstate(low(2, sn=(1, 2)))
    subscriptions = Subscriptions(inputs, NIC_VALUE.name)
    subscriptions._started = True
    opened = []
    class Subscription:
        def Close(self): pass
    def subscribe(topic, callback):
        opened.append(topic)
        callback(cloud())
        return Subscription()
    subscriptions.cloud = subscribe
    subscriptions.odometry = lambda _: Subscription()
    class Camera:
        def __init__(self): opened.append('camera')
        def SetTimeout(self, _): pass
        def Init(self): pass
        def GetImageSample(self): return 0, b'fake-jpeg'
    original = builtins.__import__
    def fake_import(name, *args, **kwargs):
        if name == 'unitree_sdk2py.go2.video.video_client': return NS(VideoClient=Camera)
        assert not name.startswith(('unitree_sdk2py', 'cyclonedds'))
        return original(name, *args, **kwargs)
    monkeypatch.setattr(builtins, '__import__', fake_import)
    monkeypatch.setattr(socket, 'if_nameindex', lambda: [(7, NIC_VALUE.name)])
    monkeypatch.setattr(media, 'video', lambda _: (dict(t='media.video'), None))
    publisher = approved_publisher(creds, Approval(NIC_VALUE.name, identity.serial, time.time()+60),
                                   subscriptions, recorder(), lambda: True)
    source = publisher.source
    source.last_odom_points = float('-inf')
    try:
        if failure:
            source.camera(); source.lidar()
            assert opened == [] and source.sample('rgb') is None and source.sample('lidar') is None
            assert 'GO2_MEDIA start_failed reason=identity' in caplog.text
            assert MAC not in caplog.text and '192.168.' not in caplog.text
        else:
            source.start()
            deadline = time.monotonic()+.15
            while (source.sample('rgb') is None or source.sample('lidar') is None) and time.monotonic()<deadline:
                time.sleep(.002)
            assert source.sample('rgb')[1]['seq'] == 1
            assert source.sample('lidar')[1]['count'] == 1
            assert 'camera' in opened and 'rt/utlidar/cloud' in opened
            identity.checked = float('-inf')
            with pytest.raises(PermissionError): source.factory({}, subscriptions, identity.serial)
    finally:
        source.close()
        for thread in source.threads: thread.join(timeout=.5)
        publisher.executor.shutdown(wait=True)


def test_start_failure_logs_only_reason_and_state_changes(caplog):
    source = Source(NS(approval=NS(robot_serial='fake')), {}, None,
                    recorder=recorder(), include_depth=False)
    for _ in range(2): source.start_failed('rgb', PermissionError('private-mac-token'))
    source.start_ready('rgb')
    source.start_failed('rgb', PermissionError('private-mac-token'))
    assert caplog.text.count('GO2_MEDIA start_failed reason=identity channel=rgb') == 2
    assert 'private-mac-token' not in caplog.text


def test_publisher_start_failure_is_reported_and_cleaned_up(caplog):
    closed = []
    def fail(): raise PermissionError('private start failure')
    source = NS(start=fail, close=lambda: closed.append(True))
    publisher = Publisher(NS(), {}, None, source_factory=lambda *args: source)
    with pytest.raises(PermissionError): asyncio.run(publisher.run())
    assert closed == [True]
    assert caplog.text.count('GO2_MEDIA start_failed reason=identity') == 1
    assert 'private start failure' not in caplog.text
    with pytest.raises(RuntimeError): publisher.executor.submit(lambda: None)


@pytest.mark.parametrize('failure', ['read-timeout', 'rejected-status', 'http-error', 'open-timeout', 'success'])
def test_upload_closes_responses_on_success_and_failure(failure):
    publisher = Publisher(NS(link=credentials().link), {}, None, source_factory=lambda *args: None)
    closed = []
    class Response:
        status = 409 if failure == 'rejected-status' else 202
        def read(self, _):
            if failure == 'read-timeout': raise TimeoutError('fake timeout')
        def close(self): closed.append(True)
    fp = io.BytesIO(b'fake response')
    error = HTTPError('https://example.invalid', 409, 'fake rejection', {}, fp)
    def open_response(request, timeout):
        assert timeout == .5 and request.get_header('Connection') == 'close'
        if failure == 'http-error': raise error
        if failure == 'open-timeout': raise TimeoutError('fake timeout before response')
        return Response()
    publisher.opener = NS(open=open_response)
    try:
        if failure == 'success': publisher.upload('rgb', {}, None)
        else:
            with pytest.raises((TimeoutError, ValueError, HTTPError)):
                publisher.upload('rgb', {}, None)
        assert closed == ([] if failure in ('http-error', 'open-timeout') else [True])
        if failure == 'http-error': assert fp.closed
    finally: publisher.executor.shutdown(wait=True)


def test_cancelled_upload_worker_eventually_closes_response():
    publisher = Publisher(NS(link=credentials().link), {}, None, source_factory=lambda *args: None)
    entered, release, closed = threading.Event(), threading.Event(), threading.Event()
    class Response:
        status = 202
        def read(self, _):
            entered.set()
            assert release.wait(1)
            raise TimeoutError('fake socket timeout after caller cancellation')
        def close(self): closed.set()
    publisher.opener = NS(open=lambda *args, **kwargs: Response())
    async def scenario():
        future = asyncio.get_running_loop().run_in_executor(publisher.executor, publisher.upload, 'rgb', {}, None)
        while not entered.is_set(): await asyncio.sleep(.001)
        with pytest.raises(TimeoutError): await asyncio.wait_for(future, .01)
        assert not closed.is_set()
        release.set()
        while not closed.is_set(): await asyncio.sleep(.001)
    try: asyncio.run(asyncio.wait_for(scenario(), 2))
    finally:
        release.set()
        publisher.executor.shutdown(wait=True)
    assert closed.is_set()
