"""No ROS/systemd/server launch: inspect real start/close paths with OS doubles."""
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from unittest.mock import Mock

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import app_probe
import d1
import isolation


@pytest.fixture
def simulation(tmp_path):
    source = tmp_path / 'sensor-spec-20261016/stage/sensor-runtime-r1'
    source.mkdir(parents=True)
    (source / 'live_map.py').write_text('')
    setup = tmp_path / 'setup.bash'
    setup.write_text('true\n')
    return isolation.Simulation(tmp_path, source, setup)


def captured_start(sim, monkeypatch):
    launch = Mock(return_value='')
    monkeypatch.setattr(isolation, 'command', launch)
    monkeypatch.setattr(isolation, 'preflight', lambda _: {'domain61': []})
    monkeypatch.setattr(isolation, 'source_hashes', lambda _: {})
    monkeypatch.setattr(isolation.threading, 'Thread', Mock())
    monkeypatch.setattr(sim, 'show', lambda: {'MainPID': '123', 'ControlGroup': '/owned'})
    monkeypatch.setattr(isolation, 'processes', lambda: ([dict(pid=123, start_ticks=100)], 0))
    sim.start()
    return list(launch.call_args.args)


def test_start_argv_pins_unique_owned_unit_local_domain_and_limits(simulation, monkeypatch):
    other = isolation.Simulation(simulation.folder, simulation.source, simulation.setup)
    assert re.fullmatch(r'fh-rb-sim-\d{8}-\d{6}-[0-9a-f]{8}\.service', simulation.unit)
    assert simulation.unit != other.unit
    args = captured_start(simulation, monkeypatch)
    assert args[:2] == ['systemd-run', '--user']
    assert '--unit='+simulation.unit in args
    for prop in ['MemoryMax=1500M', 'MemorySwapMax=0', 'CPUQuota=200%', 'TasksMax=256',
                 'KillSignal=SIGINT', 'KillMode=process', 'SendSIGKILL=no', 'RuntimeMaxSec=240']:
        assert '--property='+prop in args
    script = args[args.index('-c')+1]
    for expected in ['ROS_DOMAIN_ID=93', 'ROS_AUTOMATIC_DISCOVERY_RANGE=LOCALHOST',
                     'ROS_LOCALHOST_ONLY=1', 'GZ_IP=127.0.0.1', '--isolated-verify',
                     '--world-id v5_single --floor-id f1', '--map-version gt-20261012']:
        assert expected in script
    assert simulation.out.parent == simulation.source.parent.parent
    assert simulation.out.name.startswith('rb-app-') and not simulation.out.exists()


@pytest.mark.parametrize('override', ['none', 'inherited', 'sourced'])
def test_post_source_unit_environment_checked_before_fake_entry(simulation, monkeypatch, override):
    args = captured_start(simulation, monkeypatch)
    capture = simulation.folder / 'entry.json'
    (simulation.source / 'live_map.py').write_text(
        'import json,os\nfrom pathlib import Path\n'
        'Path(os.environ["TEST_CAPTURE"]).write_text(json.dumps({k:os.environ.get(k) for k in '
        '["ROS_DOMAIN_ID","ROS_AUTOMATIC_DISCOVERY_RANGE","ROS_LOCALHOST_ONLY"]}))\n')
    if override == 'sourced':
        simulation.setup.write_text('export ROS_STATIC_PEERS=forbidden-test-peer\n')
    env = {k: v for k, v in os.environ.items() if not k.startswith(('ROS_', 'RMW_', 'FAST', 'CYCLONE'))}
    env['TEST_CAPTURE'] = str(capture)
    if override == 'inherited':
        env['CYCLONEDDS_URI'] = 'forbidden-test-profile'
    # Only an empty fake setup and a fake Python entry; never systemd/live ROS.
    result = subprocess.run(args[args.index('/bin/bash'):], cwd=simulation.folder, env=env,
                            capture_output=True, text=True, timeout=5)
    if override == 'none':
        assert result.returncode == 0
        assert json.loads(capture.read_text()) == {'ROS_DOMAIN_ID': '93',
            'ROS_AUTOMATIC_DISCOVERY_RANGE': 'LOCALHOST', 'ROS_LOCALHOST_ONLY': '1'}
    else:
        assert result.returncode != 0
        assert not capture.exists()


@pytest.mark.parametrize('wrong', ['main_domain', 'gz_domain', 'cgroup', 'start_ticks'])
def test_live_identity_rejects_wrong_domain_or_ownership(simulation, monkeypatch, wrong):
    simulation.pid = {'pid': 123, 'start_ticks': 100}
    simulation.cg = '/owned'
    main = dict(pid=123, start_ticks=100, cgroup='0::/owned', domain='93', partition='')
    gz = dict(pid=124, start_ticks=200, cgroup='0::/owned', domain='93', partition='fh-srv-012345abcdef')
    if wrong == 'main_domain':
        main['domain'] = '61'
    elif wrong == 'gz_domain':
        gz['domain'] = '61'
    elif wrong == 'cgroup':
        main['cgroup'] = '0::/other'
    else:
        main['start_ticks'] += 1
    monkeypatch.setattr(isolation, 'processes', lambda: ([main, gz], 0))
    with pytest.raises(RuntimeError, match='live simulation identity'):
        simulation.live_identity()


@pytest.mark.parametrize('restarted', [False, True])
def test_close_preserves_domain61_pid_start_ticks_but_allows_metadata_change(simulation, monkeypatch, restarted):
    before = dict(pid=61, ppid=0, start_ticks=100, domain='61', comm='before', cgroup='0::/other', partition='old')
    after = {**before, 'comm': 'after', 'partition': 'new', 'start_ticks': 101 if restarted else 100}
    simulation.before = {'domain61': [before]}
    simulation.hashes = {}
    simulation.out.mkdir()
    (simulation.out / 'manifest.json').write_text(json.dumps({'ros_domain': '93',
        'partition': 'fh-srv-012345abcdef', 'cleanup': {'complete': True}, 'kids_stop': [{'complete': True}],
        'isolation': {'ledger_sha_before': {}, 'ledger_sha_after': {}}}))
    monkeypatch.setattr(simulation, 'interrupt', lambda _: None)
    monkeypatch.setattr(simulation, 'show', lambda: {'MainPID': '0'})
    monkeypatch.setattr(isolation, 'processes', lambda: ([after], 0))
    monkeypatch.setattr(isolation, 'source_hashes', lambda _: {})
    monkeypatch.setattr(isolation, 'dds_ports', lambda: ([], ''))
    monkeypatch.setattr(isolation, 'command', lambda *_: '')
    if restarted:
        with pytest.raises(RuntimeError, match='protected source/processes changed'):
            simulation.close()
    else:
        simulation.close()
        assert json.loads((simulation.folder / 'cleanup.json').read_text())['domain61_unchanged'] is True


def test_source_symlink_rejected_before_resolve(simulation, tmp_path):
    link = tmp_path / 'alias'
    link.symlink_to(simulation.source, target_is_directory=True)
    with pytest.raises(ValueError, match='without symlinks'):
        isolation.Simulation(tmp_path, link, simulation.setup)


def test_run_directory_cannot_escape_own_worktree(tmp_path, monkeypatch):
    outside = tmp_path / 'another-worktree/record'
    monkeypatch.setattr(d1, 'ROOT', tmp_path / 'own-worktree')
    monkeypatch.setenv('FH_SIM_D1_RUN', '1')
    monkeypatch.setenv('SIM_RUN_DIR', str(outside))
    monkeypatch.setenv('SIM_SOURCE', '/fake/source')
    monkeypatch.setenv('SIM_ROS_SETUP', '/fake/setup')
    monkeypatch.setattr(d1, 'ros_env', lambda: {})
    monkeypatch.setattr(d1, 'Simulation', lambda *_: pytest.fail('outside run directory reached launch'))
    with pytest.raises(ValueError, match='below this worktree'):
        d1.main()
    assert not outside.exists()


@pytest.mark.parametrize('all_busy', [False, True])
def test_server_socket_tries_only_authorized_loopback_ports(monkeypatch, all_busy):
    sock = Mock()
    tried = []
    def bind(address):
        tried.append(address)
        if all_busy or len(tried) == 1:
            raise OSError('test address busy')
    sock.bind.side_effect = bind
    monkeypatch.setattr(app_probe.socket, 'socket', lambda: sock)
    if all_busy:
        with pytest.raises(RuntimeError, match='authorized development port'):
            app_probe.bind_server_socket()
        assert tried == [('127.0.0.1', p) for p in range(9020, 9040)]
        sock.close.assert_called_once()
    else:
        try:
            bound = app_probe.bind_server_socket()
        except RuntimeError:
            bound = None
        assert bound is sock
        assert tried == [('127.0.0.1', 9020), ('127.0.0.1', 9021)]
