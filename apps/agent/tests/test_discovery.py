"""DNS-SD contract and isolation tests. No multicast sockets or robot services."""

import sys
import threading
from types import SimpleNamespace
from uuid import uuid4

import pytest

from foothold_agent.discovery import Advertisement, Advertiser, SERVICE_TYPE


def test_txt_contract_is_utf8_and_contains_no_environment_credentials():
    rid = str(uuid4())
    ad = Advertisement.from_env('0.0.0.0', 9610, rid=rid, env={
        'FOOTHOLD_MDNS_ADDRESS': '192.0.2.8', 'FOOTHOLD_MDNS_NAME': '연결 시험',
        'FOOTHOLD_AGENT_TOKEN': 'must-not-be-advertised', 'UNRELATED': 'private'})
    assert ad.properties == {b'v': b'1', b'name': '연결 시험'.encode(), b'model': b'Go2 EDU',
                             b'agent': b'ws://192.0.2.8:9610/phone/ws', b'rid': rid.encode()}


def test_rid_optional_and_discovery_only_explicit():
    ad = Advertisement('192.0.2.8', 9610, discovery_only=True)
    assert b'rid' not in ad.properties
    assert ad.properties[b'mode'] == b'discovery-only'


def test_disable_precedes_validation_and_never_starts_thread(monkeypatch):
    def forbidden(*args, **kwargs):
        pytest.fail('disabled advertisement must not create a thread')
    monkeypatch.setattr(threading, 'Thread', forbidden)
    ad = Advertiser.for_listener('bad', -1, rid='bad', env={'FOOTHOLD_MDNS_ENABLED': '0'})
    assert ad.advertisement is None
    ad.start()
    ad.close()


@pytest.mark.parametrize('host', ['127.0.0.1', 'localhost', '::1'])
def test_private_listener_never_advertised(host):
    assert Advertisement.from_env(host, 9610, env={'FOOTHOLD_MDNS_ADDRESS': '192.0.2.8'}) is None


@pytest.mark.parametrize('env', [
    {'FOOTHOLD_MDNS_ENABLED': 'yes'}, {}, {'FOOTHOLD_MDNS_ADDRESS': '0.0.0.0'},
    {'FOOTHOLD_MDNS_ADDRESS': '224.0.0.251'}, {'FOOTHOLD_MDNS_ADDRESS': '::1'},
    {'FOOTHOLD_MDNS_ADDRESS': '192.0.2.8', 'FOOTHOLD_MDNS_NAME': 'a' * 101},
    {'FOOTHOLD_MDNS_ADDRESS': '192.0.2.8', 'FOOTHOLD_MDNS_MODEL': 'Go2\nEDU'},
])
def test_bad_configuration_disables_only_advertisement(env, caplog):
    advertiser = Advertiser.for_listener('0.0.0.0', 9610, env=env)
    assert advertiser.advertisement is None
    assert 'mDNS disabled' in caplog.text


def fake_zeroconf(monkeypatch, *, fail_register=False, fail_unregister=False):
    calls = []
    class Info:
        def __init__(self, kind, name, **kwargs):
            self.kind, self.name, self.kwargs = kind, name, kwargs
            calls.append(('info', self))
    class ZC:
        def __init__(self, **kwargs):
            calls.append(('open', kwargs))
        def register_service(self, info, **kwargs):
            calls.append(('register', kwargs))
            if fail_register:
                raise OSError('secret-address-and-token')
        def unregister_service(self, info):
            calls.append(('unregister', info))
            if fail_unregister:
                raise OSError('secret-address-and-token')
        def close(self):
            calls.append(('close', None))
    monkeypatch.setitem(sys.modules, 'zeroconf', SimpleNamespace(
        ServiceInfo=Info, Zeroconf=ZC, IPVersion=SimpleNamespace(V4Only=4)))
    return calls


def test_registration_withdrawal_and_interface_binding(monkeypatch):
    calls = fake_zeroconf(monkeypatch)
    advertiser = Advertiser(Advertisement('192.0.2.8', 9610))
    advertiser.start()
    try:
        assert advertiser.ready.wait(2)
        advertiser.start()  # no second registration
    finally:
        advertiser.close()
        advertiser.thread.join(2)
    assert not advertiser.thread.is_alive()
    assert [call[0] for call in calls] == ['info', 'open', 'register', 'unregister', 'close']
    info = calls[0][1]
    assert info.kind == SERVICE_TYPE and info.name.endswith('.' + SERVICE_TYPE)
    assert info.kwargs['port'] == 9610
    assert info.kwargs['addresses'] == [b'\xc0\x00\x02\x08']
    assert calls[1][1] == dict(interfaces=['192.0.2.8'], ip_version=4)


@pytest.mark.parametrize('failure', ['register', 'unregister'])
def test_network_errors_close_resources_without_leaking_values(monkeypatch, caplog, failure):
    calls = fake_zeroconf(monkeypatch, fail_register=failure == 'register',
                          fail_unregister=failure == 'unregister')
    advertiser = Advertiser(Advertisement('192.0.2.8', 9610))
    advertiser.start()
    try:
        assert (advertiser.failed if failure == 'register' else advertiser.ready).wait(2)
    finally:
        advertiser.close()
        advertiser.thread.join(2)
    assert calls[-1][0] == 'close'
    assert 'secret-address-and-token' not in caplog.text


def test_missing_extra_is_nonfatal_and_does_not_import_ros(monkeypatch):
    monkeypatch.setitem(sys.modules, 'zeroconf', None)
    advertiser = Advertiser(Advertisement('192.0.2.8', 9610))
    advertiser.start()
    assert advertiser.failed.wait(2)
    advertiser.close()
    advertiser.thread.join(2)
    assert 'rclpy' not in sys.modules


def test_close_never_waits_for_registration(monkeypatch):
    entered, release = threading.Event(), threading.Event()
    calls = fake_zeroconf(monkeypatch)
    zc = sys.modules['zeroconf'].Zeroconf
    original = zc.register_service
    def blocked(self, *args, **kwargs):
        entered.set()
        release.wait(3)
        original(self, *args, **kwargs)
    monkeypatch.setattr(zc, 'register_service', blocked)
    advertiser = Advertiser(Advertisement('192.0.2.8', 9610))
    advertiser.start()
    try:
        assert entered.wait(2)
        advertiser.close()  # returns while the worker remains blocked
        assert advertiser.thread.is_alive()
    finally:
        release.set()
        advertiser.thread.join(2)
    assert calls[-1][0] == 'close'


def test_phone_listener_stays_ready_when_discovery_extra_missing(monkeypatch):
    import asyncio
    from test_phone import Harness, phone_socket
    from foothold_agent.phone.server import Server, Settings
    monkeypatch.setitem(sys.modules, 'zeroconf', None)
    advertiser = Advertiser(Advertisement('192.0.2.8', 9610))
    monkeypatch.setattr(Advertiser, 'for_listener', lambda *args, **kwargs: advertiser)
    async def run():
        h = Harness()
        with phone_socket() as sock:
            settings = Settings('127.0.0.1', sock.getsockname()[1], 'unused', 'test', '1',
                                h.org, 'unused-replay.sqlite', True, True)
            server = Server(h.hub, settings, sock=sock)
            task = asyncio.create_task(server.run())
            try:
                await asyncio.wait_for(server.ready.wait(), 2)
                assert await asyncio.to_thread(advertiser.failed.wait, 2)
                assert not task.done() and server.failure is None
            finally:
                server.stopping.set()
                await asyncio.wait_for(task, 2)
                h.verifier.close()
        assert advertiser.stopped.is_set()
    asyncio.run(run())
