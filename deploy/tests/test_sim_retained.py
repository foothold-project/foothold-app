"""Synthetic retained stop: never contact host units, /proc or sockets."""
import json
import os
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from deploy import sim_control as sim, rootfs_runtime as runtime, proc_proof_server
from apps.simmgr import recovery


@pytest.fixture
def retained(tmp_path, monkeypatch):
    guard = tmp_path/'guard'; (guard/'state').mkdir(parents=True)
    latch = guard/'state/unproven'; latch.write_text('retained episode'); latch.chmod(0o600)
    (guard/'deploy.lock').touch(); (tmp_path/'deploy.lock').touch()
    for key, value in dict(GUARD=guard, PACKAGE_LATCH=tmp_path/'package', DEPLOY_LOCK=tmp_path/'deploy.lock',
                           AUDITS=tmp_path).items():
        monkeypatch.setattr(sim, key, value)
    monkeypatch.setattr(sim.pwd, 'getpwnam', lambda _: SimpleNamespace(pw_uid=os.getuid()))
    monkeypatch.setattr(sim, 'recovery_module', lambda: recovery)
    monkeypatch.setattr(sim, 'rootfs_runtime', lambda: runtime)
    monkeypatch.setattr(sim, 'same_release', lambda _: True)
    monkeypatch.setattr(proc_proof_server, 'process_rows', lambda: ([], 0))
    monkeypatch.setattr(runtime, 'load', lambda: {})
    monkeypatch.setattr(runtime, 'identity', lambda _: (12345, 12345))
    monkeypatch.setattr(runtime, 'unit_state', lambda _: dict(ActiveState='active', MainPID='10'))
    monkeypatch.setattr(runtime, 'inactive_namespace', Mock())
    monkeypatch.setattr(runtime, 'no_dds_or_native', Mock())
    monkeypatch.setattr(runtime, 'dedicated_pids', lambda _: [])
    monkeypatch.setattr(runtime, 'run', Mock(return_value=''))
    monkeypatch.setattr(runtime, 'create_install_latch', Mock())
    monkeypatch.setattr(sim, 'userctl', Mock(return_value=''))
    monkeypatch.setattr(sim, 'prepare_retained', Mock())
    running = dict(LoadState='loaded', ActiveState='active', MainPID='10', ControlGroup='')
    exited = dict(LoadState='loaded', ActiveState='inactive', MainPID='0', ControlGroup='')
    monkeypatch.setattr(sim, 'state', Mock(side_effect=[running, running, exited]))
    return latch, tmp_path


def test_idle_pair_stops_through_normal_path_and_preserves_latch(retained):
    latch, folder = retained
    before = (latch.stat().st_ino, latch.read_bytes())
    sim.stop_retained()
    assert (latch.stat().st_ino, latch.read_bytes()) == before
    assert [c.args for c in sim.userctl.call_args_list if c.args[0] == 'stop'] == [('stop', sim.UNIT)]
    assert runtime.run.call_args_list[-2].args[0] == ['systemctl', 'stop', 'user@12345.service']
    runtime.create_install_latch.assert_not_called()
    audit = next(folder.glob('sim-retained-*.json'))
    assert audit.stat().st_mode & 0o777 == 0o600
    assert json.loads(audit.read_text())['complete'] is True
    assert not (folder/'guard/setup-unproven').exists()


@pytest.mark.parametrize('fault', ['live', 'denied', 'socket', 'prepare', 'changed', 'unit', 'unknown', 'lost-proof'])
def test_live_or_unknown_never_stops_manager(retained, monkeypatch, fault):
    latch, folder = retained
    if fault in ('live', 'denied'):
        row = dict(domain='93', partition='', cgroup='')
        monkeypatch.setattr(proc_proof_server, 'process_rows', lambda: ([row], 0) if fault == 'live' else ([], 1))
    elif fault == 'socket':
        runtime.run.return_value = 'tcp LISTEN 0 128 127.0.0.1:9433 0.0.0.0:*'
    elif fault == 'prepare':
        sim.prepare_retained.side_effect = ValueError('unknown slots')
    elif fault == 'changed':
        sim.prepare_retained.side_effect = lambda: latch.write_text('changed')
    elif fault == 'unit':
        sim.userctl.return_value = 'fh-simmgr-agent-x.service loaded active running'
    elif fault == 'unknown':
        runtime.run.side_effect = OSError('socket inspection unavailable')
    else:
        monkeypatch.setattr(proc_proof_server, 'process_rows', Mock(side_effect=[([], 0), ([], 0), OSError('fresh proof lost')]))
    with pytest.raises((ValueError, OSError)):
        sim.stop_retained()
    assert not any(c.args[:1] == ('stop',) for c in sim.userctl.call_args_list)
    runtime.create_install_latch.assert_not_called()
    assert latch.exists()
    assert json.loads(next(folder.glob('sim-retained-*.json')).read_text())['complete'] is False


def test_retained_exit_metadata_is_allowed_without_reset_or_kill(retained, monkeypatch):
    def ctl(*args):
        if args[0] == 'list-units':
            return 'fh-simmgr-agent-owned.service loaded active exited'
        if args[0] == 'show':
            return 'LoadState=loaded\nActiveState=active\nSubState=exited\nMainPID=0\nControlGroup=\n'
        assert args == ('stop', sim.UNIT)
        return ''
    monkeypatch.setattr(sim, 'userctl', ctl)
    sim.stop_retained()


def test_non_episode_fence_and_missing_latch_refuse(retained):
    latch, _ = retained
    latch.unlink()
    with pytest.raises(FileNotFoundError): sim.stop_retained()
    sim.prepare_retained.assert_not_called()


def test_custom_failure_fence_does_not_change_default_marker_behavior(monkeypatch):
    monkeypatch.setattr(runtime, 'load', lambda: {})
    monkeypatch.setattr(runtime, 'identity', lambda _: (123, 123))
    monkeypatch.setattr(runtime, 'unit_state', lambda _: dict(ActiveState='active'))
    monkeypatch.setattr(runtime, 'GUARD', Path('/synthetic-absent-guard'))
    marker = Mock(); monkeypatch.setattr(runtime, 'create_install_latch', marker)
    stop = Mock(side_effect=OSError('bus unknown')); fence = Mock()
    with pytest.raises(OSError): runtime.stop_pair(stop, Mock(), failure_fence=fence)
    fence.assert_called_once(); marker.assert_not_called()
    with pytest.raises(OSError): runtime.stop_pair(stop, Mock())
    marker.assert_called_once()


@pytest.mark.parametrize('before_stop', [True, False])
def test_new_marker_requires_a_started_transition_and_positive_residual(retained,monkeypatch,before_stop):
    latch,_=retained
    monkeypatch.setattr(runtime,'dedicated_pids',lambda _: [12345])
    if before_stop:
        monkeypatch.setattr(proc_proof_server,'process_rows',Mock(side_effect=[([],0),([],0),OSError('fresh proof lost')]))
    else:
        def ctl(*args):
            if args[0]=='stop': raise OSError('shutdown failed')
            return ''
        monkeypatch.setattr(sim,'userctl',ctl)
    with pytest.raises(OSError): sim.stop_retained()
    assert runtime.create_install_latch.call_count == (0 if before_stop else 1)
    assert latch.exists()


def test_oversized_latch_cannot_be_verified_with_a_truncated_hash(retained):
    latch,_=retained; latch.write_text('x'*65537)
    with pytest.raises(ValueError,match='proof bound'): sim.stop_retained()
    sim.prepare_retained.assert_not_called()
