"""Desktop shell verification: fake network metadata/commands, never DDS."""
import importlib.util
import json
from pathlib import Path
import threading
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import pytest

from foothold_agent.desktop import __main__ as desktop
from foothold_agent.desktop import network
from foothold_agent.setup.view import Status, make_server

INSTALLER = Path(__file__).resolve().parents[1]/'installer'
spec = importlib.util.spec_from_file_location('installer_build', INSTALLER/'build.py')
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


def row(name='eno2', address=None):
    return dict(ifname=name, address='02:11:22:33:44:55', link_type='ether',
                operstate='UP', addr_info=[] if address is None else [dict(family='inet', local=address, prefixlen=24)])


def metadata(tmp_path, rows, routes=(), neighbors=()):
    for item in rows:
        (tmp_path/item['ifname']/'device').mkdir(parents=True, exist_ok=True)
    def query(*args):
        return list(rows if args[0] == 'address' else routes if args[0] == 'route' else neighbors)
    return query


@pytest.mark.parametrize('reason', ['default4', 'default6', 'wifi', 'virtual', 'shared', 'robot', 'orin', 'down'])
def test_network_never_offers_shared_or_nonwired_interfaces(tmp_path, reason):
    item = row(address='10.0.0.3' if reason == 'shared' else
               '192.168.123.161' if reason == 'robot' else
               '192.168.123.18' if reason == 'orin' else None)
    query = metadata(tmp_path, [item], [dict(dst='default', dev='eno2')] if reason == 'default4' else [])
    if reason == 'wifi': (tmp_path/'eno2/wireless').mkdir()
    if reason == 'virtual': (tmp_path/'eno2/device').rmdir()
    if reason == 'down': item['operstate'] = 'DOWN'
    v6 = [dict(dst='default', dev='eno2')] if reason == 'default6' else []
    assert network.available(query_fn=query, sysfs=tmp_path, ipv6_defaults=v6) == []


def test_empty_dedicated_nic_is_offered_and_known_used_addresses_are_skipped(tmp_path):
    query = metadata(tmp_path, [row(), row('eno3', '192.168.123.200')],
                     neighbors=[dict(dst='192.168.123.201'), dict(dst='192.168.123.202')])
    assert len(network.available(query_fn=query, sysfs=tmp_path, ipv6_defaults=[])) == 2
    assert network.free_address(query) == '192.168.123.203'


def test_configure_creates_only_bound_new_profile_with_dad_and_no_default(tmp_path):
    calls = []
    choice = dict(name='eno2', mac='02:11:22:33:44:55')
    address = network.configure('eno2', discover=lambda:[choice], query_fn=metadata(tmp_path, [row()]),
                                run=lambda *args:calls.append(args))
    assert address == '192.168.123.200'
    assert len(calls) == 2
    add, up = calls
    for key, value in [('ifname','eno2'), ('ipv4.dad-timeout','3000'), ('ipv4.never-default','yes'),
                       ('ipv4.gateway',''), ('ipv6.method','disabled'), ('802-3-ethernet.mac-address',choice['mac'])]:
        assert add[add.index(key)+1] == value
    assert up[0:3] == ('connection','up','uuid')
    assert up[3] == add[add.index('connection.uuid')+1]


@pytest.mark.parametrize('failure', ['duplicate', 'changed'])
def test_activation_failure_removes_only_just_created_profile(tmp_path, failure):
    calls = []
    choice = dict(name='eno2', mac='02:11:22:33:44:55')
    checks = iter([[choice], [] if failure == 'changed' else [choice]])
    def run(*args):
        calls.append(args)
        if args[:2] == ('connection','up'): raise RuntimeError('DAD detected conflict')
    with pytest.raises((RuntimeError, PermissionError)):
        network.configure('eno2', discover=lambda:next(checks), query_fn=metadata(tmp_path,[row()]), run=run)
    assert calls[-1][:3] == ('connection','delete','uuid')
    assert calls[-1][3] == calls[0][calls[0].index('connection.uuid')+1]
    assert all(c[:2] != ('connection','modify') for c in calls)


def test_autostart_optout_does_not_touch_pairing_or_legacy_config(tmp_path, monkeypatch):
    monkeypatch.setenv('XDG_CONFIG_HOME', str(tmp_path))
    private = tmp_path/'foothold'
    private.mkdir()
    for filename in ('agent.json', 'go2-agent.env'):
        (private/filename).write_text('keep this')
    assert desktop.autostart_enabled()
    desktop.set_autostart(False)
    assert not desktop.autostart_enabled()
    assert 'Hidden=true' in desktop.autostart_path().read_text()
    desktop.set_autostart(True)
    assert desktop.autostart_enabled()
    assert all(p.read_text() == 'keep this' for p in private.iterdir())


def test_network_action_cannot_change_interface_once_dds_connects():
    control = desktop.Controls()
    control.choices = [dict(name='eno2',mac='02:11:22:33:44:55')]
    control.active = True
    with pytest.raises(PermissionError): control.action(dict(action='network',nic='eno2'))


def test_desktop_actions_require_exact_loopback_origin_and_json(tmp_path, monkeypatch):
    monkeypatch.setenv('XDG_CONFIG_HOME', str(tmp_path))
    control = desktop.Controls()
    server = make_server(Status(), 0, controls=control)
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    url = f'http://127.0.0.1:{server.server_port}'
    try:
        for origin, content in [(None, 'application/json'), ('https://evil.invalid','application/json'),
                                (url,'text/plain')]:
            headers = {'Content-Type':content}
            if origin: headers['Origin'] = origin
            request = Request(url+'/action', data=b'{"action":"autostart","enabled":false}', headers=headers)
            with pytest.raises(HTTPError) as result: urlopen(request)
            assert result.value.code == 403
            assert desktop.autostart_enabled()
        request = Request(url+'/action', data=b'{"action":"autostart","enabled":false}',
                          headers={'Content-Type':'application/json','Origin':url})
        with urlopen(request) as result: assert result.status == 204
        with urlopen(url+'/desktop') as result: assert json.load(result)['autostart'] is False
    finally:
        server.shutdown(); server.server_close(); worker.join()


def test_reviewed_download_lock_has_hashes_and_all_original_runtime_wheels():
    lock = json.loads((INSTALLER/'inputs.lock.json').read_text())
    assert all(len(a['sha256']) == 64 and a['url'].startswith('https://') for a in lock)
    names = {a['name'].split('-')[0] for a in lock}
    assert {'qrcode','websockets','cyclonedds','numpy','opencv_python','zeroconf'} <= names


@pytest.mark.parametrize('server', ['http://example.invalid', 'https://x.invalid/private',
                                   'https://token@x.invalid', 'https://x.invalid/?secret=1'])
def test_invalid_build_origins_rejected_before_download(tmp_path, server):
    with pytest.raises(ValueError, match='HTTPS origin'):
        builder.build(server, tmp_path, '0.2.0-1')


def test_extras_read_pins_allow_optional_slam_and_refuse_unpinned_dependencies():
    assert builder.group_pins({'setup':['qrcode==8.2']}) == {'qrcode':'8.2'}
    assert builder.group_pins({'slam':['scipy==1.15.3']}) == {'scipy':'1.15.3'}
    assert builder.group_pins({'go2-readonly':[
        'unitree_sdk2py @ git+https://github.com/unitreerobotics/unitree_sdk2_python.git@'+builder.SDK_COMMIT]}) == {}
    with pytest.raises(ValueError): builder.group_pins({'slam':['scipy>=1']})
    with pytest.raises(ValueError): builder.group_pins({'setup':['x==1'], 'slam':['x==2']})


def test_missing_requested_nic_never_enters_existing_dds_runtime(monkeypatch):
    import asyncio
    from types import SimpleNamespace
    from foothold_agent.setup.discovery import NIC
    monkeypatch.setattr(desktop, 'candidates', lambda:[NIC('real-robot-nic',1,'02:11:22:33:44:55',(('192.168.123.200',24),))])
    monkeypatch.setattr(network, 'available', lambda:[])
    async def forbidden(*args): raise AssertionError('must not enter DDS')
    monkeypatch.setattr(desktop.setup, 'serve', forbidden)
    status = Status()
    async def scenario():
        with pytest.raises(asyncio.TimeoutError):
            await asyncio.wait_for(desktop.connect_when_ready(SimpleNamespace(nic='fh-missing'),status,desktop.Controls()),.1)
    asyncio.run(scenario())
    assert '로봇을 찾지 못했습니다' in status.snapshot()['mode']


@pytest.mark.parametrize('active,remote,should_start', [('yes','no',True),('no','no',False),('yes','yes',False)])
def test_maintainer_hooks_use_only_active_local_user_manager(tmp_path, active, remote, should_start):
    import os
    import socket
    import subprocess
    fake = tmp_path/'bin'
    fake.mkdir()
    runtime = tmp_path/'runtime/1000'
    runtime.mkdir(parents=True)
    log = tmp_path/'commands'
    scripts = {
        'loginctl': f'''#!/bin/sh
case "$1" in
list-sessions) echo "3 1000 operator seat0";;
show-session) case "$4" in Active) echo {active};; Remote) echo {remote};; Type) echo wayland;; User) echo 1000;; esac;;
list-users) echo "1000 operator";;
esac
''',
        'getent': '#!/bin/sh\necho "operator:x:1000:1000:Operator:/tmp/operator:/bin/sh"\n',
        'runuser': '#!/bin/sh\nprintf "%s\\n" "$*" >> "$MAINTAINER_TEST_LOG"\n',
    }
    for name, text in scripts.items():
        path = fake/name
        path.write_text(text)
        path.chmod(0o755)
    env = dict(os.environ, PATH=str(fake)+':/usr/bin:/bin', MAINTAINER_TEST_LOG=str(log))
    # Relocate only the fixed runtime bus path into the fixture; no real session,
    # user service, package install, sudo, or host configuration is contacted.
    with socket.socket(socket.AF_UNIX) as bus:
        bus.bind(str(runtime/'bus'))
        for name, action in [('postinst','configure'),('prerm','remove')]:
            fixture = tmp_path/name
            fixture.write_text((INSTALLER/name).read_text().replace('/run/user/',str(tmp_path/'runtime')+'/'))
            subprocess.run(['sh',str(fixture),action],env=env,check=True)
    calls = log.read_text()
    assert ('daemon-reload' in calls) is should_start
    assert ('/launch --autostart --no-browser' in calls) is should_start
    assert 'stop foothold-robot.service' in calls
    assert 'agent.json' not in calls and 'go2-agent.env' not in calls


@pytest.mark.parametrize('has_ipv4', [False, True])
def test_real_iproute_address_shapes_offer_wired_nic_without_family_filter(tmp_path, monkeypatch, has_ipv4):
    from types import SimpleNamespace
    from foothold_agent.setup import discovery
    # iproute2 6.1's observed key sets, with host identifiers anonymized.
    # -4 omits MAC/link_type and drops interfaces that have no IPv4 address.
    base = dict(ifindex=7, ifname='eno2', flags=['BROADCAST','MULTICAST','UP','LOWER_UP'],
                mtu=1500, qdisc='fq_codel', operstate='UP', group='default', txqlen=1000)
    inet = [dict(family='inet', local='192.168.123.200', prefixlen=24,
                 broadcast='192.168.123.255', scope='global', label='eno2')] if has_ipv4 else []
    inet6 = [dict(family='inet6', local='fe80::1234', prefixlen=64, scope='link')]
    v4_rows = [dict(base, addr_info=inet)] if has_ipv4 else []
    full_rows = [dict(base, link_type='ether', address='02:11:22:33:44:55',
                      broadcast='ff:ff:ff:ff:ff:ff', addr_info=inet+inet6)]
    (tmp_path/'eno2/device').mkdir(parents=True)
    calls = []
    def run(argv, **kwargs):
        calls.append(argv)
        if argv[-2:] == ['address','show']:
            return SimpleNamespace(stdout=json.dumps(v4_rows if '-4' in argv else full_rows))
        assert argv == ['ip','-j','-4','route','show','table','all']
        return SimpleNamespace(stdout='[]')
    monkeypatch.setattr(discovery.subprocess, 'run', run)
    assert network.available(query_fn=discovery.query, sysfs=tmp_path, ipv6_defaults=[]) == [
        dict(name='eno2',mac='02:11:22:33:44:55')]
    assert ['ip','-j','address','show'] in calls


def test_real_iproute_link_metadata_and_inet_only_addresses_find_robot_nic(tmp_path, monkeypatch):
    from types import SimpleNamespace
    from foothold_agent.setup import discovery
    base = dict(ifindex=7, ifname='eno2', flags=['BROADCAST','MULTICAST','UP','LOWER_UP'],
                mtu=1500, qdisc='fq_codel', operstate='UP', group='default', txqlen=1000)
    inet = dict(family='inet', local='192.168.123.200', prefixlen=24,
                broadcast='192.168.123.255', scope='global', label='eno2')
    full = dict(base, link_type='ether', address='02:11:22:33:44:55',
                broadcast='ff:ff:ff:ff:ff:ff', addr_info=[inet,dict(
                    family='inet6',local='fe80::1234',prefixlen=64,scope='link')])
    (tmp_path/'eno2/device').mkdir(parents=True)
    def run(argv, **kwargs):
        if argv[-2:] == ['address','show']:
            return SimpleNamespace(stdout=json.dumps([dict(base, addr_info=[inet])] if '-4' in argv else [full]))
        assert argv == ['ip','-j','-4','route','show','table','all']
        return SimpleNamespace(stdout='[]')
    monkeypatch.setattr(discovery.subprocess, 'run', run)
    assert discovery.candidates(query_fn=discovery.query, sysfs=tmp_path) == [
        discovery.NIC('eno2',7,'02:11:22:33:44:55',(('192.168.123.200',24),))]


def test_cached_inputs_are_reverified_without_download_and_corruption_fails(tmp_path, monkeypatch):
    import hashlib
    path = tmp_path/'sdk.tar.gz'
    path.write_bytes(b'verified SDK archive fixture')
    asset = dict(name=path.name,url='https://archive.invalid/fixed-commit',
                 sha256=hashlib.sha256(path.read_bytes()).hexdigest())
    def forbidden(*args, **kwargs): raise AssertionError('cached inputs must not be downloaded again')
    monkeypatch.setattr(builder,'urlopen',forbidden)
    assert builder.fetch(asset,tmp_path) == path
    path.write_bytes(b'corrupted cached archive')
    with pytest.raises(ValueError,match='input hash mismatch'):
        builder.fetch(asset,tmp_path)
