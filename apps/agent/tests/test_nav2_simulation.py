"""Authorized SI policy through the existing Core, receipt and STOP gates."""
from copy import deepcopy
import json
from types import SimpleNamespace

import pytest

from test_phone import Harness
from test_scenario_run import r, start
from foothold_agent.executor.nav2 import Binding, NavExecutor, PolicyAdapter
from foothold_agent.executor.nav2.simulation import SimulationBinding, SimulationPolicyAdapter
from foothold_agent.phone.hub import Hub
from foothold_agent.safety.core import Z


def physical():
    return PolicyAdapter(dict(allow_curves=False, yaw_zero_threshold_rps=.04,
        commands=[dict(si=[0, 0, 0], axes=[0, 0, 0]), dict(si=[.6, 0, 0], axes=[1, 0, 0])]))


def enable(h):
    proof = SimulationBinding(h.robot, 'native-run', 1, 0,
                             (('warehouse', h.start['floor_id'], 'a'*64),))
    h.runs.nav.adapter = SimulationPolicyAdapter(physical(),
        lambda: h.hub.simulation is True and proof.matches(h.runs.binding))
    return start(h)


@pytest.mark.parametrize('velocity', [(.6, 0, -.0849), (.3, 0, .4), (.01, 0, -.5),
                                     (.6, 0, .5), (.6, 0, -.5), (0, 0, .4), (0, 0, -.5), Z])
def test_simulation_output_preserves_si(r, velocity):
    binding = enable(r)
    assert r.runs.nav.intent(binding, velocity)
    r.hub.tick()
    assert r.outputs[-1].velocity == velocity
    assert not r.runs.nav.rejected
    assert r.runs.snapshot()['status'] == 'MOVING'
    assert r.hub.session.executor_t == r.clock()
    assert not r.runs.nav.intent(Binding('old', 'old', 0, 0, '', '', ''), (.6, 0, 0))


@pytest.mark.parametrize('velocity', [(-.1, 0, 0), (0, 0, .51), (.6, .1, 0), (0, .1, 0),
    (.7, 0, 0), (.6, 0, .6), (float('nan'), 0, 0), (float('inf'), 0, 0),
    (True, 0, 0), None, (.6,), 'bad'])
def test_first_invalid_input_fails_latched_with_one_original_diagnostic(r, velocity, caplog):
    binding = enable(r)
    r.runs.nav.intent(binding, velocity)
    r.runs.nav.intent(binding, (.6, 0, 0))  # cannot hide the first rejection
    r.hub.tick()
    assert r.runs.snapshot()['status'] == 'FAILED'
    assert r.runs.snapshot()['fail_code'] == 'NAV_GOAL_REJECTED'
    assert r.hub.session.core.latch and r.outputs[-1].velocity == Z
    detail = deepcopy(r.runs.nav.first_rejection)
    assert detail['policy_version'] == 'nav2-simulation-si/2'
    assert detail['reason'] in ('INVALID_VELOCITY', 'UNSUPPORTED_VELOCITY')
    assert detail['received_at'] == 0
    assert detail['input_si'] == (None if velocity is None else
        [str(v) if isinstance(v, float) and not (-1e100 < v < 1e100) else v for v in velocity]
        if isinstance(velocity, tuple) else velocity)
    assert r.runs.current['failure_detail'] == detail
    assert r.runs.nav.reason == 'NAV_GOAL_REJECTED'  # revoke never erases evidence
    r.hub.tick()
    assert not r.runs.nav.intent(binding, (.6, 0, 0))
    logs = [rec.message for rec in caplog.records if 'NAV_FAILURE' in rec.message]
    assert len(logs) == 1 and json.loads(logs[0].split('NAV_FAILURE ', 1)[1]) == detail
    assert binding in r.actions.cancels


def test_stop_zero_before_cancel_and_no_cached_health(r):
    binding = enable(r)
    r.runs.nav.intent(binding, (.3, 0, .4))
    r.hub.tick()
    assert r.outputs[-1].velocity == (.3, 0, .4)
    r.clock.t = .1
    r.state()
    r.hub.tick()
    assert r.hub.session.executor_t == 0
    events = []
    r.hub.sink.apply = lambda command: events.append((command.kind, command.velocity))
    r.actions.cancel = lambda b: events.append(('cancel', b))
    r.send(r.peer, 'stop')
    cancel = next(i for i, item in enumerate(events) if item[0] == 'cancel')
    assert ('apply', Z) in events[:cancel] and any(k == 'stop' for k, _ in events[:cancel])
    assert not r.runs.nav.feedback(binding, 'SUCCEEDED')


def test_source_timeout_cannot_be_revived(r):
    binding = enable(r)
    r.runs.nav.intent(binding, (.3, 0, .4))
    r.hub.tick()
    r.clock.t = .300001
    r.state()
    assert not r.runs.nav.intent(binding, (.6, 0, 0))
    r.hub.tick()
    assert r.outputs[-1].velocity == Z
    assert r.runs.snapshot()['fail_code'] == 'NAV_TIMEOUT'


def test_ten_seconds_of_fresh_stationary_rotation_does_not_trigger_executor_stall(r):
    binding = enable(r)
    for step in range(201):
        r.clock.t = step*.05
        r.send(r.peer, 'ping', client_time_ms=int(r.clock.t*1000))
        # Translation remains zero; fresh source time/commands establish health.
        r.state(vx=0., vy=0., wz=.4, body_still=False)
        assert r.runs.nav.intent(binding, (0., 0., .4))
        r.hub.tick()
        assert r.runs.snapshot()['status'] == 'MOVING'
        assert r.outputs[-1].velocity == (0., 0., .4)
        assert not r.hub.session.core.latch
    r.clock.t += .300001
    r.state(vx=0., vy=0., wz=.4, body_still=False)
    r.hub.tick()
    assert r.runs.snapshot()['status'] == 'FAILED'
    assert r.runs.snapshot()['fail_code'] == 'NAV_TIMEOUT'
    assert r.outputs[-1].velocity == Z


def test_first_rejection_cannot_be_hidden_by_action_success_or_poll_delay(r):
    binding = enable(r)
    r.runs.nav.intent(binding, (.7, 0, 0))
    assert r.runs.nav.rejected and r.runs.nav.first_rejection['input_si'] == [.7, 0, 0]
    assert not r.runs.nav.feedback(binding, 'SUCCEEDED')
    r.clock.t = .300001
    r.hub.tick()
    assert r.runs.snapshot()['status'] == 'FAILED'
    assert r.runs.snapshot()['fail_code'] == 'NAV_GOAL_REJECTED'
    assert r.outputs[-1].velocity == Z


@pytest.mark.parametrize('simulation,bound', [(False, True), (True, False), (1, True)])
def test_hub_requires_exact_simulation_and_simmgr_binding(simulation, bound):
    h = Harness(simulation=simulation)
    nav = NavExecutor(physical(), SimpleNamespace())
    proof = SimulationBinding(h.robot, 'native', 1, 0, (('warehouse', 'floor', 'a'*64),)) if bound else None
    hub = Hub(h.verifier, h.sink, policy_name='test', policy_version='1', simulation=simulation,
              nav=nav, simulation_binding=proof, now=h.clock)
    hub.runs.binding = Binding('run', 'goal', 0, 0, 'warehouse', 'floor', 'a'*64)
    assert nav.adapter.adapt((.6, 0, -.0849)) == (Z, 'UNSUPPORTED_VELOCITY')
    assert nav.adapter.adapt((0, 0, .3)) == (Z, 'UNSUPPORTED_VELOCITY')
    assert nav.adapter.adapt((.6, 0, .04)) == ((1, 0, 0), 'TESTED_YAW_REDUCED')
    hub.session.holder_type = 'RUN'
    assert hub.session.core.velocity_projection(1, 0, 0)[0] == (.6, 0, 0)
    h.verifier.close()


def test_hub_pairs_adapter_and_projection_and_retains_manual_policy():
    h = Harness()
    nav = NavExecutor(physical(), SimpleNamespace())
    proof = SimulationBinding(h.robot, 'native', 1, 0, (('warehouse', 'floor', 'a'*64),))
    hub = Hub(h.verifier, h.sink, policy_name='test', policy_version='1', simulation=True,
              nav=nav, simulation_binding=proof, now=h.clock)
    hub.runs.binding = Binding('run', 'goal', 0, 0, 'warehouse', 'floor', 'a'*64)
    hub.session.holder_type = 'RUN'
    assert nav.adapter.adapt((.3, 0, .4)) == ((.3, 0, .4), 'TESTED')
    assert hub.session.core.velocity_projection(.3, 0, .4) == ((.3, 0, .4), '')
    hub.runs.binding = Binding('run', 'goal', 0, 0, 'other', 'floor', 'a'*64)
    assert nav.adapter.adapt((.6, 0, -.0849))[0] == Z
    assert hub.session.core.velocity_projection(.6, 0, -.0849)[0] == Z
    hub.session.holder_type = 'USER'
    assert hub.session.core.velocity_projection(1, 0, 0)[0] == (1, 0, 0)
    h.verifier.close()


@pytest.fixture
def launch_proof(monkeypatch):
    from foothold_agent.executor.nav2 import simulation
    floors = SimpleNamespace(robot_id='robot', run_id='native', generation=1, epoch=1,
        bindings={'f1': dict(world_id='warehouse', floor_id='floor', sha256='a'*64)})
    config = SimpleNamespace(robot_id='robot', floor_bindings=floors)
    identity = dict(main_pid=123, main_start_ticks=99, cgroup='/synthetic',
        ros_domain='93', partition='fh-srv-012345abcdef',
        processes=[dict(pid=124, start_ticks=100, partition='fh-srv-012345abcdef')])
    proof = dict(identity=identity, registration=dict(robot_id='robot', run_id='native', generation=1))
    env = dict(ROS_DOMAIN_ID='93', GZ_PARTITION=identity['partition'])
    files = {f'/proc/{pid}/{name}': value for pid, ticks in ((123, 99), (124, 100)) for name, value in
        [('stat', '123 (synthetic) '+' '.join(['0']*19+[str(ticks)])), ('cgroup', '0::/synthetic\n'),
         ('environ', b'ROS_DOMAIN_ID=93\0'+(b'GZ_PARTITION=fh-srv-012345abcdef\0' if pid == 124 else b''))]}
    monkeypatch.setattr(simulation, 'Path', lambda path: SyntheticPath(path, files))
    return proof, config, env, files


class SyntheticPath:
    def __init__(self, path, files):
        self.path, self.files = str(path), files
    def __truediv__(self, name):
        return SyntheticPath(self.path+'/'+name, self.files)
    def read_text(self):
        return self.files[self.path]
    def read_bytes(self):
        return self.files[self.path]


def test_simmgr_binding_requires_live_native_proof(launch_proof):
    proof, config, env, _ = launch_proof
    assert SimulationBinding.from_launch(proof, config, env) is not None
    assert SimulationBinding.from_launch(None, config, env) is None
    assert SimulationBinding.from_launch(proof, config, {**env, 'GZ_PARTITION': 'other'}) is None


@pytest.mark.parametrize('failure', ['pid_reuse', 'child_pid_reuse', 'cgroup', 'domain', 'partition', 'robot', 'run', 'generation'])
def test_simmgr_binding_fails_closed_on_wrong_identity(launch_proof, failure):
    proof, config, env, files = launch_proof
    if failure == 'pid_reuse': proof['identity']['main_start_ticks'] += 1
    elif failure == 'child_pid_reuse': proof['identity']['processes'][0]['start_ticks'] += 1
    elif failure == 'cgroup': files['/proc/124/cgroup'] = '0::/other'
    elif failure == 'domain': files['/proc/124/environ'] = b'ROS_DOMAIN_ID=61\0GZ_PARTITION=fh-srv-012345abcdef\0'
    elif failure == 'partition': files['/proc/124/environ'] = b'ROS_DOMAIN_ID=93\0GZ_PARTITION=other\0'
    elif failure == 'robot': proof['registration']['robot_id'] = 'other'
    elif failure == 'run': proof['registration']['run_id'] = 'other'
    elif failure == 'generation': proof['registration']['generation'] += 1
    assert SimulationBinding.from_launch(proof, config, env) is None


def test_action_failure_has_a_separate_diagnostic(r, caplog):
    binding = enable(r)
    r.runs.nav.feedback(binding, 'ABORTED')
    r.hub.tick()
    assert r.runs.current['failure_detail'] == dict(kind='ACTION_RESULT', result='ABORTED')
    assert r.runs.nav.first_rejection is None
    assert 'kind=ACTION_RESULT' in caplog.text


def test_begin_exception_has_a_separate_diagnostic(r, caplog):
    def fail(*args):
        raise RuntimeError('synthetic')
    r.actions.submit = fail
    assert r.send(r.peer, 'run.start', **r.start)['ok']
    import time
    until = time.monotonic()+2
    while r.runs.snapshot()['status'] == 'PREPARING' and time.monotonic() < until:
        r.hub.tick()
        time.sleep(.001)
    assert r.runs.current['failure_detail'] == dict(kind='BEGIN_EXCEPTION', exception_type='RuntimeError')
    assert r.runs.nav.first_rejection is None
    assert 'kind=BEGIN_EXCEPTION' in caplog.text
