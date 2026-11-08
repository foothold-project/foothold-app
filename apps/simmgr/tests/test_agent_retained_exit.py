"""Retained systemd metadata must not turn exit2 into a live STOP wait."""
import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from apps.simmgr import agent_unit
from apps.simmgr.agent_unit import AgentUnit
from apps.simmgr.launcher import NativeLauncher


def retained(tmp_path):
    child = AgentUnit.__new__(AgentUnit)
    child.unit = 'fh-simmgr-agent-synthetic.service'
    child.invocation_id = 'synthetic-invocation'
    child.private = tmp_path / 'private.json'
    child.private.touch()
    state = dict(LoadState='loaded', ActiveState='active', SubState='exited',
                 MainPID='0', Result='success', ExecMainCode='1', ExecMainStatus='2',
                 InvocationID=child.invocation_id, ControlGroup='')
    child.show = lambda: state
    return child, state


@pytest.mark.parametrize('code', ['1', '2', '3'])
def test_retained_nonzero_returns_failure_without_wait_or_signal(tmp_path, monkeypatch, code):
    child, state = retained(tmp_path)
    state['ExecMainCode'] = code
    monkeypatch.setattr(agent_unit.subprocess, 'run', lambda *a, **k: pytest.fail('no unit mutation'))
    monkeypatch.setattr(agent_unit.time, 'sleep', lambda *_: pytest.fail('already exited'))
    assert child.poll() == 1
    assert child.wait(15) == 1
    assert not child.private.exists()
    # Polling failure does not relax invocation/native/cgroup cleanup proof.
    with pytest.raises(RuntimeError, match='exit unconfirmed'):
        child.confirm_failed_exit()


@pytest.mark.parametrize('change', [dict(MainPID='123'), dict(SubState='running'),
    dict(SubState=''), dict(ExecMainStatus=''), dict(ExecMainCode='0'),
    dict(ActiveState='activating'), dict(ActiveState='deactivating')])
def test_incomplete_or_live_exit_evidence_stays_pending(tmp_path, change):
    child, state = retained(tmp_path)
    state.update(change)
    assert child.poll() is None


def test_retained_success_still_uses_normal_stop_path(tmp_path, monkeypatch):
    child, state = retained(tmp_path)
    state['ExecMainStatus'] = '0'
    calls = []
    monkeypatch.setattr(agent_unit.subprocess, 'run', lambda args, **kw: calls.append(args))
    assert child.wait(15) == 0
    assert calls == [['systemctl', '--user', 'stop', child.unit]]


def test_show_requests_substate(tmp_path, monkeypatch):
    child, _ = retained(tmp_path)
    calls = []
    def run(args, **kwargs):
        calls.append(args)
        return SimpleNamespace(stdout='LoadState=loaded\nSubState=exited\n')
    monkeypatch.setattr(agent_unit.subprocess, 'run', run)
    assert AgentUnit.show(child)['SubState'] == 'exited'
    assert 'SubState' in calls[0][-1].split('=', 1)[1].split(',')


def test_launcher_routes_retained_exit_to_failed_recovery(tmp_path):
    child, _ = retained(tmp_path)
    launch = NativeLauncher.__new__(NativeLauncher)
    launch.child = child
    launch._stop_nav2 = AsyncMock()
    launch._stop_observer = AsyncMock()
    launch._recover_failed_agent = AsyncMock()
    launch._wait = AsyncMock(side_effect=AssertionError('no STOP/zero wait'))
    launch._signal = AsyncMock(side_effect=AssertionError('no live agent signal'))
    asyncio.run(launch._stop_agent_process(None))
    launch._stop_nav2.assert_awaited_once()
    launch._stop_observer.assert_awaited_once()
    launch._recover_failed_agent.assert_awaited_once()
    launch._wait.assert_not_awaited()
    launch._signal.assert_not_awaited()
