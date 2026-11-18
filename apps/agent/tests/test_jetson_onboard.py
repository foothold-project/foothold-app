"""Jetson preparation with fake metadata/install commands; no real DDS/services."""
import hashlib
import importlib.util
import json
from pathlib import Path

import pytest

from foothold_agent.desktop import network
from foothold_agent.go2_direct import identity, preflight
from foothold_agent.setup import __main__ as setup
from foothold_agent.setup.discovery import ROBOT_NETWORK, candidates, select
from foothold_agent.setup.view import PAGE, Status

SPEC = importlib.util.spec_from_file_location(
    'jetson_onboard', Path(__file__).resolve().parents[1]/'installer/jetson_onboard.py')
installer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(installer)


def nic(name='enP8p1s0', host=200):
    return dict(ifname=name, ifindex=7, address='02:00:00:00:00:01',
                operstate='UP', link_type='ether', addr_info=[dict(
                    family='inet', local=str(ROBOT_NETWORK.network_address+host), prefixlen=24)])


def test_jetson_nic_automatic_and_explicit_selection_use_existing_wired_rules(tmp_path):
    rows = [nic(), nic('wlan0')]
    for row in rows:
        (tmp_path/row['ifname']/'device').mkdir(parents=True)
    (tmp_path/'wlan0/wireless').mkdir()
    calls = []
    def query(*args):
        calls.append(args)
        return rows if args[0] == 'address' else [dict(dst='default', dev='wlan0')]
    found = candidates(query_fn=query, sysfs=tmp_path)
    assert select(found).name == select(found, 'enP8p1s0').name == 'enP8p1s0'
    assert network.available(query_fn=query, sysfs=tmp_path, ipv6_defaults=[]) == [
        dict(name='enP8p1s0', mac=rows[0]['address'])]
    assert set(calls) == {('address', 'show'), ('route', 'show', 'table', 'all')}
    entries = [dict(dst=identity.GO2, dev='enP8p1s0', lladdr='02:00:00:00:00:02', state=['STALE'])]
    assert identity.neighbor_identity('enP8p1s0', entries=entries)[0] == entries[0]['lladdr']
    with pytest.raises(PermissionError):
        select(found+found)  # ambiguity still refuses; no first-NIC shortcut


@pytest.mark.parametrize('reason', ['reserved-extension-address', 'default-route', 'down', 'shared'])
def test_jetson_does_not_bypass_existing_nic_rejections(tmp_path, reason):
    row = nic(host=18 if reason == 'reserved-extension-address' else 200)
    (tmp_path/'enP8p1s0/device').mkdir(parents=True)
    if reason == 'down':
        row['operstate'] = 'DOWN'
    if reason == 'shared':
        row['addr_info'].append(dict(family='inet', local='198.51.100.2', prefixlen=24))
    def query(*args):
        return [row] if args[0] == 'address' else (
            [dict(dst='default', dev=row['ifname'])] if reason == 'default-route' else [])
    assert candidates(query_fn=query, sysfs=tmp_path) == []


@pytest.mark.parametrize('option', ['--headless', '--no-browser'])
def test_headless_without_display_keeps_confirmation_view_without_loading_browser(tmp_path, monkeypatch, option):
    monkeypatch.delenv('DISPLAY', raising=False)
    monkeypatch.delenv('WAYLAND_DISPLAY', raising=False)
    from foothold_agent.desktop import browser
    monkeypatch.setattr(browser, 'open_window', lambda *_: pytest.fail('must not open a GUI'))
    seen = []
    async def serve(args, status):
        seen.append(args)
        assert status.snapshot()['preflight_message'] == '자동 점검 중'
        return True
    monkeypatch.setattr(setup, 'serve', serve)
    # A temporary loopback port only; actual connect()/SDK is never called.
    assert setup.main([option, '--port', '0', '--nic', 'enP8p1s0',
                       '--config', str(tmp_path/'private/agent.json')]) == 0
    assert seen[0].no_browser and seen[0].nic == 'enP8p1s0'
    assert not (tmp_path/'private').exists()


def test_arm_preflight_remains_blocked_and_status_explains_it(tmp_path, monkeypatch):
    monkeypatch.setattr(preflight.platform, 'machine', lambda: 'aarch64')
    report = preflight.inspect(tmp_path)  # package/ELF metadata only, never DDS import
    assert report['installation_ready'] is False
    assert 'requires-x86_64-cpython-3.10-official-wheel' in report['issues']
    status = Status()
    status.update(preflight=dict(installation_ready=False, issues=report['issues']))
    snapshot = status.snapshot()
    assert snapshot['preflight']['installation_ready'] is False
    assert '조종 차단' in snapshot['preflight_message']
    assert '아직 검증되지 않았습니다' in snapshot['preflight_message']
    assert 'Jetson' in snapshot['preflight_message']
    assert 'p.textContent=s.preflight_message' in PAGE


@pytest.fixture
def bundle(tmp_path, monkeypatch):
    home = tmp_path/'home'
    home.mkdir()
    monkeypatch.setattr(Path, 'home', lambda: home)
    offline = installer.offline_installer()
    wheelhouse = tmp_path/'wheelhouse'
    wheelhouse.mkdir()
    pins = dict(offline.REQUIRED, qrcode='8.2')
    locks = []
    for name, version in pins.items():
        wheel = wheelhouse/f'{name}-{version}-py3-none-any.whl'
        wheel.write_bytes(b'fake test wheel; never installed')
        locks.append(f'{name}=={version} --hash=sha256:{hashlib.sha256(wheel.read_bytes()).hexdigest()}')
    (wheelhouse/'requirements.txt').write_text('\n'.join(locks)+'\n')
    (wheelhouse/'SHA256SUMS').write_text(''.join(
        f'{hashlib.sha256(p.read_bytes()).hexdigest()}  {p.name}\n' for p in sorted(wheelhouse.iterdir())))
    monkeypatch.setattr(installer, 'offline_installer', lambda: offline)
    args = ['--wheelhouse', str(wheelhouse), '--server', 'https://example.invalid']
    return home, wheelhouse, offline, args


def test_install_plan_is_readonly_and_never_reads_local_credentials(bundle, monkeypatch):
    home, _, offline, args = bundle
    private = home/'.config/foothold'
    private.mkdir(parents=True)
    (private/'agent.json').write_text('must never be read')
    original_open = Path.open
    def guarded_open(path, *args, **kwargs):
        assert path != private/'agent.json', 'installer must never read existing credentials'
        return original_open(path, *args, **kwargs)
    monkeypatch.setattr(Path, 'open', guarded_open)
    def forbidden(*args, **kwargs):
        pytest.fail('plan must not execute subprocesses')
    monkeypatch.setattr(offline.subprocess, 'run', forbidden)
    assert installer.main(args) == 0
    assert not (home/'foothold-robot').exists()
    assert not (home/'.config/systemd').exists()
    assert (private/'agent.json').is_file()


def test_install_writes_only_new_home_files_and_static_unit_with_fake_pip(bundle, monkeypatch):
    home, wheels, offline, args = bundle
    calls = []
    monkeypatch.setattr(offline.subprocess, 'run', lambda argv, **kw: calls.append((argv, kw)))
    monkeypatch.setattr(installer.platform, 'system', lambda: 'Linux')
    monkeypatch.setattr(installer.platform, 'machine', lambda: 'aarch64')
    monkeypatch.setattr(installer.sys, 'version_info', (3, 10))
    # Unlisted files must not become part of the installed wheelhouse.
    (wheels/'unrelated-private-file').write_text('exclude this')
    assert installer.main([*args, '--install']) == 0
    root = home/'foothold-robot'
    assert len(calls) == 3  # venv, offline hashed pip install, pip check
    assert '--no-index' in calls[1][0] and '--require-hashes' in calls[1][0]
    assert not any('systemctl' in arg or 'sudo' in arg for call, _ in calls for arg in call)
    unit = (home/'.config/systemd/user'/installer.UNIT).read_text()
    assert '[Install]' not in unit and 'WantedBy' not in unit and 'Restart=no' in unit
    assert 'graphical-session' not in unit and 'foothold-robot.service' not in unit
    config = json.loads((root/'connection.json').read_text())
    assert config == dict(server='https://example.invalid', nic='enP8p1s0', port=9468)
    assert (root/'private').stat().st_mode & 0o777 == 0o700
    assert (root/'connection.json').stat().st_mode & 0o777 == 0o600
    assert not (root/'private/agent.json').exists()
    assert not (root/'wheels/unrelated-private-file').exists()
    assert "'--headless'" in (root/'launch.py').read_text()
    assert "os.environ['FH_RECORD'] = '0'" in (root/'launch.py').read_text()
    compile((root/'launch.py').read_text(), 'launch.py', 'exec')


@pytest.mark.parametrize('damage', ['root', 'unit', 'outside-home', 'protected-port', 'server-secret', 'missing-qr'])
def test_installer_rejects_without_overwriting(bundle, damage):
    home, wheels, _, args = bundle
    if damage == 'root':
        (home/'foothold-robot').mkdir()
        (home/'foothold-robot/keep').write_text('keep')
    elif damage == 'unit':
        unit = home/'.config/systemd/user'/installer.UNIT
        unit.parent.mkdir(parents=True)
        unit.write_text('keep')
    elif damage == 'outside-home':
        args.extend(['--root', str(home.parent/'outside')])
    elif damage == 'protected-port':
        args.extend(['--port', '9611'])
    elif damage == 'server-secret':
        args[-1] = 'https://example.invalid?token=not-a-real-secret'
    else:
        requirements = wheels/'requirements.txt'
        requirements.write_text('\n'.join(x for x in requirements.read_text().splitlines()
                                          if not x.startswith('qrcode'))+'\n')
        (wheels/'SHA256SUMS').write_text(''.join(
            f'{hashlib.sha256(p.read_bytes()).hexdigest()}  {p.name}\n'
            for p in sorted(wheels.iterdir()) if p.name != 'SHA256SUMS'))
    assert installer.main(args) == 2
    if damage == 'root':
        assert (home/'foothold-robot/keep').read_text() == 'keep'
    if damage == 'unit':
        assert unit.read_text() == 'keep'


def test_launcher_preserves_manual_nic_selection_and_never_copies_credentials(tmp_path, monkeypatch):
    root = tmp_path/'installation'
    root.mkdir()
    (root/'connection.json').write_text(json.dumps(dict(server='https://example.invalid', nic='auto', port=9468)))
    calls = []
    monkeypatch.setenv('FH_RECORD', '1')
    monkeypatch.setenv('XDG_CACHE_HOME', str(tmp_path/'previous-cache'))
    monkeypatch.setenv('FH_MAPPING_CACHE_DIR', str(tmp_path/'previous-mapping'))
    monkeypatch.setattr(installer.os, 'execv', lambda executable, argv: calls.append((executable, argv)))
    exec(compile(installer.LAUNCHER, str(root/'launch.py'), 'exec'), {'__file__':str(root/'launch.py')})
    argv = calls[0][1]
    assert '--nic' not in argv and '--headless' in argv
    assert argv[argv.index('--config')+1] == str(root/'private/agent.json')
    assert not (root/'private').exists()
    assert installer.os.environ['FH_MAPPING_CACHE_DIR'] == str(root/'cache/mapping')


@pytest.mark.parametrize('failure', ['wrong-architecture', 'offline-install'])
def test_failed_install_never_registers_unit_or_creates_credentials(bundle, monkeypatch, failure):
    home, _, offline, args = bundle
    monkeypatch.setattr(installer.platform, 'system', lambda: 'Linux')
    monkeypatch.setattr(installer.platform, 'machine', lambda: 'x86_64' if failure == 'wrong-architecture' else 'aarch64')
    monkeypatch.setattr(installer.sys, 'version_info', (3, 10))
    monkeypatch.setattr(offline, 'main', lambda _: 2)
    assert installer.main([*args, '--install']) == 2
    assert not (home/'.config/systemd/user'/installer.UNIT).exists()
    assert not (home/'foothold-robot/private/agent.json').exists()
    assert (home/'foothold-robot').exists() is (failure == 'offline-install')


def test_setup_wheelhouse_wrapper_adds_qrcode_without_executing_builder(tmp_path, monkeypatch):
    import sys
    from types import SimpleNamespace
    path = Path(__file__).resolve().parents[1]/'installer/build_jetson_wheelhouse.py'
    spec = importlib.util.spec_from_file_location('jetson_setup_bundle', path)
    wrapper = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(wrapper)
    seen = []
    fake = SimpleNamespace(PINS=['cyclonedds==0.10.2'])
    fake.main = lambda argv: seen.append((list(fake.PINS), argv)) or 0
    loader = SimpleNamespace(exec_module=lambda module: None)
    monkeypatch.setattr(wrapper.importlib.util, 'spec_from_file_location', lambda *args: SimpleNamespace(loader=loader))
    monkeypatch.setattr(wrapper.importlib.util, 'module_from_spec', lambda _: fake)
    previous = list(sys.path)
    assert wrapper.main(['--output', str(tmp_path/'runs/bundle')]) == 0
    assert seen == [(['cyclonedds==0.10.2', 'qrcode==8.2'], ['--output', str(tmp_path/'runs/bundle')])]
    assert sys.path == previous
