"""Fake Nav2 and fake bridge; real unchanged Session/Core safety boundaries."""
import json
from pathlib import Path

import pytest

from foothold_agent.executor.nav2 import Binding, NavExecutor, Owner, PolicyAdapter
from foothold_agent.link.session import Session
from foothold_agent.safety.core import SCHEMA, Z

CONFIG = json.loads((Path(__file__).parents[1]/'tools/nav2/policy.json').read_text())


class Actions:
    def __init__(self, events):
        self.events = events
    def submit(self, binding, point):
        self.events.append(('goal', binding))
    def cancel(self, binding):
        self.events.append(('cancel', binding))


class Sink:
    def __init__(self, events):
        self.events = events
    def apply(self, command):
        self.events.append((command.kind, command.velocity))


class Harness:
    def __init__(self, guard=None):
        self.t = 0.
        self.events = []
        self.s = Session(lambda: self.t)
        self.sink = Sink(self.events)
        self.e = NavExecutor(PolicyAdapter(CONFIG), Actions(self.events), now=lambda: self.t)
        self.o = Owner(self.s, self.sink, self.e, now=lambda: self.t, guard=guard)
        self.o._apply(self.s.connect())
        self.o.receive({'t': 'lease', 'lease_id': 'local', 'holder_type': 'RUN:run'})
        self.state(stop_requested=True)
        self.o.receive({'t': 'unlock', 'lease_id': 'local', 'stop_gen': self.s.core.stop_gen})
        self.state()
        self.o.receive({'t': 'run.start', 'run_id': 'run', 'plan': {'segments': []}, 'missions': {}})
        self.b = Binding('run', 'goal', 1, self.s.core.stop_gen, 'world', 'floor', 'a'*64)
        self.e.begin(self.b, {'x': 1, 'y': 0, 'yaw': 0})
        self.intent(Z)
        self.intent((.6, 0, 0))

    def state(self, **changes):
        raw = {'schema': SCHEMA, 'episode': 1, 'sim_t': self.t+.01,
               'policy_running': True, 'stop_requested': False, 'reset_in_progress': False,
               'fallen': False, 'plugin_mode': 'LOCKSTEP', **changes}
        return self.o.on_state(raw)

    def intent(self, v):
        self.e.intent(self.b, v)
        self.o.tick()

    def output(self):
        return [v for k, v in self.events if k == 'apply'][-1]


def test_stop_zero_precedes_cancel_ack_and_late_feedback_ignored():
    h = Harness()
    assert h.output() == (.6, 0, 0)
    h.events.clear()
    h.o.receive({'t': 'stop'})
    assert any(e[0] == 'cancel' for e in h.events)
    cancel = next(i for i, e in enumerate(h.events) if e[0] == 'cancel')
    assert any(k == 'apply' and v == Z for k, v in h.events[:cancel])
    assert any(k == 'stop' for k, v in h.events[:cancel])
    assert h.s.core.latch and h.e.binding is None
    assert not h.e.feedback(h.b, 'SUCCEEDED')
    assert not h.e.intent(h.b, (.6, 0, 0))
    h.o.tick()
    assert h.output() == Z


def test_poll_does_not_refresh_old_intent_and_exact_deadline_is_preserved():
    h = Harness()
    h.t = .3
    h.state()
    h.o.tick()
    assert h.output() == (.6, 0, 0)
    assert h.s.executor_t == 0
    h.t = .300001
    h.state()
    h.o.tick()
    assert h.output() == Z
    assert h.s.run['status'] == 'FAILED'
    assert h.s.run['wait_reason'] == 'EXECUTOR_STALLED'
    assert h.e.binding is None


def test_late_new_intent_cannot_rescue_expired_run():
    h = Harness()
    h.t = .31
    h.state()
    h.intent((.6, 0, 0))
    assert h.output() == Z and h.s.run['status'] == 'FAILED'


def test_policy_stale_more_conservative_than_unchanged_core_one_second():
    h = Harness()
    h.t = .200001
    h.intent((.6, 0, 0))
    assert h.output() == Z and h.s.core.latch
    assert h.e.binding is None


def test_same_sim_stamp_does_not_extend_policy_progress():
    h = Harness()
    h.t = .19
    h.state(sim_t=.01)
    h.intent((.6, 0, 0))
    assert h.output() == (.6, 0, 0)
    h.t = .200001
    h.state(sim_t=.01)
    h.intent((.6, 0, 0))
    assert h.output() == Z and h.e.binding is None


@pytest.mark.parametrize('change', [dict(policy_running=False), dict(reset_in_progress=True),
    dict(stop_requested=True), dict(fallen=True), dict(episode=2), dict(sim_t=-1),
    dict(plugin_mode='ASYNC'), dict(sim_t=float('nan')), dict(sim_t=10**1000)])
def test_bad_policy_or_generation_causes_zero_and_cancel(change):
    h = Harness()
    h.t = .05
    h.state(**change)
    h.o.tick()
    assert h.output() == Z and h.e.binding is None


@pytest.mark.parametrize('frame', [dict(t='lease', lease_id=None),
    dict(t='lease', lease_id='manual', holder_type='USER'),
    dict(t='run.control', run_id='run', op='pause'), dict(t='run.control', run_id='run', op='abort')])
def test_authority_changes_zero_before_cancel(frame):
    h = Harness()
    h.events.clear()
    h.o.receive(frame)
    assert any(kind == 'cancel' for kind, _ in h.events)
    idx = next(i for i, (kind, _) in enumerate(h.events) if kind == 'cancel')
    assert any(kind == 'apply' and v == Z for kind, v in h.events[:idx])
    assert h.e.binding is None
    assert h.s.core.need_neutral


def test_close_revokes_fixture_and_zero_before_cancel():
    h = Harness()
    h.events.clear()
    h.o.close()
    assert h.output() == Z
    assert h.events[-1][0] == 'cancel'
    assert h.s.core.latch and not h.s.connected


@pytest.mark.parametrize('v,expected', [((0, 0, 0), Z), ((.6, 0, 0), (1, 0, 0)),
    ((.599999999, 0, 0), Z), ((.600000001, 0, 0), Z), ((.1, 0, 0), Z),
    ((0, 0, .5), Z), ((-.6, 0, 0), Z), ((.6, .0001, 0), Z),
    ((.6, 0, .49), Z), ((.6, 0, .5), Z), ((.6, 0, -.5), Z),
    ((float('nan'), 0, 0), Z), ((float('inf'), 0, 0), Z), ((True, 0, 0), Z),
    ((10**1000, 0, 0), Z), (None, Z), ((.6,), Z)])
def test_adapter_boundary_no_amplification(v, expected):
    assert PolicyAdapter(CONFIG).adapt(v)[0] == expected


def test_config_alphabet_must_match_core_not_silently_change_speed():
    changed = json.loads(json.dumps(CONFIG))
    changed['commands'][1]['si'][0] = .2
    with pytest.raises(ValueError):
        PolicyAdapter(changed)


def test_curve_alphabet_available_only_with_explicit_reviewed_configuration():
    changed = {**CONFIG, 'allow_curves': True}
    assert PolicyAdapter(changed).adapt((.6, 0, .5))[0] == (1, 0, 1)


def test_stale_mailbox_cannot_count_as_new_executor_health():
    h = Harness()
    h.t = .01
    h.e.intent(h.b, (.6, 0, 0))
    h.t = .32
    assert h.e.poll(h.s.run) is None
    assert h.e.reason == 'INTENT_STALE'


def test_mailbox_is_latest_one_and_old_binding_does_not_poison_it():
    h = Harness()
    h.e.intent(h.b, (.6, 0, 0))
    h.e.intent(h.b, Z)
    other = Binding('old', 'goal', 1, h.b.stop_gen, 'world', 'floor', 'a'*64)
    assert not h.e.intent(other, (.6, 0, 0))
    assert h.e.poll(h.s.run) == Z
    assert h.e.poll(h.s.run) is None


def test_proof_pending_holds_zero_and_rejected_proof_stops_and_cancels():
    verdict = [None]
    h = Harness(guard=lambda: (verdict[0], 'GT_REFUSED'))
    assert h.output() == Z
    verdict[0] = True
    h.intent((.6, 0, 0))
    assert h.output() == (.6, 0, 0)
    verdict[0] = False
    h.intent((.6, 0, 0))
    assert h.output() == Z and h.e.binding is None


def test_delayed_bridge_mailbox_cannot_rejuvenate_policy_receipt():
    h = Harness()
    h.t = .21
    raw = {'schema': SCHEMA, 'episode': 1, 'sim_t': .1, 'policy_running': True,
           'stop_requested': False, 'reset_in_progress': False, 'fallen': False,
           'plugin_mode': 'LOCKSTEP'}
    h.o.on_state(raw, received_at=0, progress_at=0)
    assert h.output() == Z and h.e.binding is None


def test_offline_explicit_stop_never_applies_one_last_nonzero():
    h = Harness()
    h.s.connected = False  # local STOP must work even in server-loss grace
    h.events.clear()
    h.o.stop()
    assert all(v == Z for k, v in h.events if k == 'apply')
    assert h.output() == Z and h.e.binding is None


def test_output_error_attempts_independent_stop_zero_and_cancels():
    h = Harness()
    class Failed:
        def apply(self, command):
            h.events.append((command.kind, command.velocity))
            if command.kind == 'apply' and command.velocity != Z or command.kind == 'stop':
                raise RuntimeError('output failed')
    h.o.sink = Failed()
    h.events.clear()
    with pytest.raises(RuntimeError, match='output failed'):
        h.intent((.6, 0, 0))
    assert ('apply', Z) in h.events
    assert h.e.binding is None and h.events[-1][0] == 'cancel'
