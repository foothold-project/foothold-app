"""Private bootstrap proof transport, without starting systemd, ROS or Nav2."""
import json
import runpy
import sys
from types import SimpleNamespace

import pytest

from apps.simmgr import agent_entry, agent_unit


@pytest.mark.parametrize('identity_present', [False, True])
def test_agent_unit_carries_proof_only_from_owned_native_record(tmp_path, monkeypatch, identity_present):
    folder = tmp_path/'synthetic'
    folder.mkdir()
    identity = dict(main_pid=123, main_start_ticks=100, ros_domain='93',
                    cgroup='/synthetic', partition='fh-srv-012345abcdef', processes=[])
    if identity_present:
        (folder/'live-identity.json').write_text(json.dumps(identity))
    floors = dict(robot_id='robot', run_id='native', generation=1)
    env = dict(FOOTHOLD_FLOOR_BINDINGS=json.dumps(floors), FOOTHOLD_PHONE_SIMULATION='1',
               FOOTHOLD_AGENT_TOKEN='synthetic-private-token')
    commands = []
    def run(args, **kwargs):
        commands.append((args, kwargs))
        return SimpleNamespace(stdout='LoadState=not-found\n')
    monkeypatch.setattr(agent_unit.subprocess, 'run', run)
    settings = SimpleNamespace(ros_setup='synthetic', agent_python=sys.executable, unit_runtime_seconds=30)
    child = agent_unit.AgentUnit(folder, settings, env, tmp_path)
    private = json.loads(child.private.read_text())
    assert private['simulation_binding'] == (dict(identity=identity, registration=floors) if identity_present else None)
    assert 'synthetic-private-token' not in str(commands)
    assert child.private.stat().st_mode & 0o777 == 0o600


def test_entry_passes_proof_outside_environment_and_unlinks_first(tmp_path, monkeypatch):
    proof = dict(identity={'synthetic': True}, registration={'run_id': 'native'})
    private = tmp_path/'private.json'
    private.write_text(json.dumps(dict(env={'SYNTHETIC': '1'}, setup='setup', python='python',
                                     root='root', simulation_binding=proof)))
    monkeypatch.setattr(agent_entry.sys, 'argv', ['entry', str(private)])
    captured = []
    def execute(path, argv, env):
        assert not private.exists()
        captured.append((path, argv, env))
    monkeypatch.setattr(agent_entry.os, 'execve', execute)
    agent_entry.main()
    _, argv, env = captured[0]
    assert json.loads(argv[-1]) == proof
    assert env == {'SYNTHETIC': '1'}


def test_bootstrap_injects_private_proof_into_module_globals(monkeypatch):
    proof = dict(identity={'synthetic': True}, registration={'run_id': 'native'})
    monkeypatch.setattr(sys, 'argv', ['bootstrap', '/synthetic', json.dumps(proof)])
    monkeypatch.setattr(sys, 'path', sys.path.copy())
    monkeypatch.setenv('FH_AGENT_ROS_PATH', '')
    calls = []
    monkeypatch.setattr(runpy, 'run_module', lambda *args, **kwargs: calls.append((args, kwargs)))
    exec(agent_entry.BOOTSTRAP, {})
    assert calls == [(('foothold_agent.ros_bridge',),
                      dict(run_name='__main__', init_globals={'_simmgr_launch_proof': proof}))]
