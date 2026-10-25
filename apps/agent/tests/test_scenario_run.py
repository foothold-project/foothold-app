"""scenario/1 safety acceptance with no ROS, sockets, simulator or real robot."""
from concurrent.futures import Future
from copy import deepcopy
import time
from uuid import uuid4

import pytest

from test_phone import Harness, signed
from foothold_agent.executor.nav2 import NavExecutor
from foothold_agent.executor.run_outbox import RunOutbox
from foothold_agent.phone.observer import Observer
from foothold_agent.phone.tickets import TicketError
from foothold_agent.safety.core import Z


def uid():
    return str(uuid4())


class Actions:
    available = True
    canceled = True
    def __init__(self):
        self.goals, self.cancels = [], []
    def ready(self):
        return self.available
    def submit(self, binding, point):
        self.goals.append((binding, point))
    def cancel(self, binding):
        self.cancels.append(binding)
    def cancel_confirmed(self, binding):
        return self.canceled


class Adapter:
    def adapt(self, velocity):
        return tuple(velocity), 'TESTED' if tuple(velocity) != Z else 'ZERO'


@pytest.fixture
def r():
    h = Harness()
    runs = h.hub.runs
    actions = Actions()
    runs.nav = NavExecutor(Adapter(), actions, now=h.clock)
    runs.journal = RunOutbox(':memory:')
    runs.context = lambda request, plan: True  # mock verified map binding
    h.peer, h.claim, _ = h.connect(surface='pc', exp=int(h.clock.wall())+600)
    assert h.take(h.peer)['ok']
    h.unlock(h.peer)
    h.cmd(h.peer, 0)
    h.start = dict(lease_id=h.hub.session.lease_id, run_id=uid(), screen_id=uid(),
                   scenario_id=uid(), scenario_version=1, floor_id=uid(), map_version_id=uid())
    point = dict(floor_id=h.start['floor_id'], map_version_id=h.start['map_version_id'],
                 x=0., y=0., yaw=0., waypoint_ref='p0', mission_id=uid(), mission_version=1, mission_name='표시 임무')
    h.data = dict(id=h.start['scenario_id'], number=1, waypoints=[point], finish={'mode': 'STAY'})
    class Source:
        def fetch(self, request):
            self.request = request
            future = Future()
            future.set_result(deepcopy(h.data))
            return future
    runs.source = Source()
    h.actions = actions
    h.runs = runs
    yield h
    h.hub.close()
    runs.journal.close()
    h.verifier.close()


def start(h):
    answer = h.send(h.peer, 'run.start', **h.start)
    assert answer['ok'], answer
    h.detail = answer['detail']
    deadline = time.monotonic()+2
    while h.runs.snapshot()['status'] == 'PREPARING' and time.monotonic() < deadline:
        h.hub.tick()
        time.sleep(.001)
    assert h.runs.snapshot()['status'] == 'MOVING', h.runs.snapshot()
    return h.runs.binding


def pause(h):
    answer = h.send(h.peer, 'run.control', run_id=h.start['run_id'], op='pause',
                    lease_id=h.hub.session.lease_id or h.start['lease_id'], screen_id=h.start['screen_id'])
    assert answer['ok'], answer


def resume(h, peer=None, **override):
    body = dict(run_id=h.start['run_id'], op='resume', lease_id=h.hub.session.lease_id or h.start['lease_id'],
                screen_id=h.start['screen_id'], resume_token=h.detail['resume_token'])
    body.update(override)
    return h.send(peer or h.peer, 'run.control', **body)


def test_no_nav_no_departure(r):
    r.runs.nav = None
    result = r.send(r.peer, 'run.start', **r.start)
    assert result['error']['code'] == 'NAV_UNAVAILABLE'
    assert all(c.velocity == Z for c in r.outputs)
    assert r.runs.current is None


def test_fixed_plan_and_display_events(r):
    binding = start(r)
    r.runs.arrival = lambda b, goal: dict(binding=b, received_at=r.clock(), body_still=True,
        pose=dict(floor_id=r.start['floor_id'], map_version_id=r.start['map_version_id'], x=0., y=0., yaw=0., confidence=1.))
    assert r.runs.nav.feedback(binding, 'SUCCEEDED')
    r.hub.tick()
    assert r.runs.snapshot()['status'] == 'COMPLETED'
    assert r.runs.snapshot()['progress'] == {'done': 1, 'total': 1}
    reports = list(r.runs.journal.entries.values())
    codes = [m.get('code') for m in reports]
    assert 'RUN_STARTED' in codes and 'RUN_WAYPOINT_ARRIVED' in codes and 'RUN_WAYPOINT_RECORDED' in codes
    assert next(m for m in reports if m.get('code') == 'RUN_WAYPOINT_RECORDED')['data']['results'] == {'mode': 'DISPLAY_ONLY'}
    assert [m['report_seq'] for m in reports] == list(range(1, len(reports)+1))
    assert r.hub.owner is None and r.hub.session.holder_type is None and r.hub.session.core.latch
    assert r.outputs[-1].velocity == Z


@pytest.mark.parametrize('field,value,code', [('number', 2, 'PLAN_UNAVAILABLE'), ('floor_id', 'other', 'FLOOR_TRANSITION_UNSUPPORTED'), ('map_version_id', 'other', 'MAP_VERSION_MISMATCH')])
def test_fixed_version_single_floor_mismatch(r, field, value, code):
    if field == 'number':
        r.data[field] = value
    else:
        r.data['waypoints'][0][field] = value
    assert r.send(r.peer, 'run.start', **r.start)['ok']
    r.hub.tick()
    assert r.runs.snapshot()['fail_code'] == code
    assert not r.actions.goals and all(c.velocity == Z for c in r.outputs)


def test_link_three_seconds_and_old_success(r):
    binding = start(r)
    r.clock.t = 3.
    r.hub.tick()
    assert r.runs.snapshot()['wait_reason'] == 'LINK_LOST'
    assert r.runs.snapshot()['status'] == 'PAUSED'
    assert r.hub.session.core.latch and r.outputs[-1].velocity == Z
    assert binding in r.actions.cancels
    assert not r.runs.nav.feedback(binding, 'SUCCEEDED')
    assert r.runs.snapshot()['progress']['done'] == 0


def test_socket_close_pauses_immediately(r):
    binding = start(r)
    r.hub.disconnect(r.peer)
    assert r.runs.snapshot()['wait_reason'] == 'LINK_LOST'
    assert binding in r.actions.cancels


def test_paused_deadline_cannot_extend_and_offline_timeout(r):
    start(r)
    pause(r)
    deadline = r.runs.current['pause_deadline']
    r.clock.t = 1
    r.send(r.peer, 'ping', client_time_ms=1000)
    pause(r)
    r.send(r.peer, 'stop')
    assert r.runs.current['pause_deadline'] == deadline
    r.hub.disconnect(r.peer)
    r.clock.t = deadline
    r.hub.tick()
    assert r.runs.snapshot()['status'] == 'CANCELED'
    assert r.runs.snapshot()['fail_code'] == 'PAUSE_TIMEOUT'
    assert not r.runs.active and r.hub.session.holder_run_id is None
    assert r.outputs[-1].velocity == Z


def test_manual_nonzero_rejected_then_explicit_transition(r):
    start(r)
    result = r.cmd(r.peer)
    assert result['error']['code'] == 'RUN_ACTIVE'
    assert r.runs.snapshot()['status'] == 'MOVING'
    assert r.cmd(r.peer, 0)['applied'] == list(Z)
    pause(r)
    assert r.take(r.peer)['ok']
    r.unlock(r.peer)
    assert r.cmd(r.peer)['applied'] == list(Z)  # fresh neutral still required
    r.cmd(r.peer, 0)
    assert r.cmd(r.peer)['applied'] == [.6, 0., 0.]
    assert r.runs.snapshot()['status'] == 'PAUSED'


def test_uncanceled_goal_blocks_manual_and_resume(r):
    start(r)
    r.actions.canceled = False
    pause(r)
    assert not r.take(r.peer)['ok']
    assert not resume(r)['ok']
    assert r.hub.session.core.latch


def test_same_screen_resume_requires_fresh_gates_rotates_token(r):
    old = start(r)
    pause(r)
    assert not resume(r)['ok']
    assert r.take(r.peer)['ok']
    r.unlock(r.peer)
    assert not resume(r)['ok']
    r.cmd(r.peer, 0)
    answer = resume(r)
    assert answer['ok'], answer
    assert answer['detail']['resume_token'] != r.detail['resume_token']
    assert r.runs.binding != old and len(r.actions.goals) == 2
    assert not r.runs.nav.feedback(old, 'SUCCEEDED')
    assert not resume(r)['ok']
    assert len(r.actions.goals) == 2


@pytest.mark.parametrize('mismatch', ['user', 'device', 'surface', 'screen', 'token'])
def test_other_screen_resume_rejected(r, mismatch):
    start(r)
    pause(r)
    if mismatch in ('screen', 'token'):
        result = resume(r, **({'screen_id': uid()} if mismatch == 'screen' else {'resume_token': 'wrong'}))
    else:
        r.hub.disconnect(r.peer)
        claims = dict(user=r.claim['sub'], device=r.claim['device'], surface='pc')
        claims[mismatch] = 'phone' if mismatch == 'surface' else uid()
        peer, _, _ = r.connect(**claims)
        result = resume(r, peer)
    assert result['error']['code'] == 'RUN_OWNER_MISMATCH'
    assert r.runs.snapshot()['status'] == 'PAUSED'


def test_ticket_expiry_pauses_new_ticket_same_screen_resumes(r):
    start(r)
    r.clock.t = 600
    r.hub.tick()
    assert r.runs.snapshot()['status'] == 'PAUSED'
    peer, _, _ = r.connect(user=r.claim['sub'], device=r.claim['device'], surface='pc')
    r.peer = peer
    assert r.take(peer)['ok']
    r.unlock(peer)
    r.cmd(peer, 0)
    assert resume(r)['ok']


@pytest.mark.parametrize('run_cancel', [False, True])
def test_signed_view_cancel_only_and_run_active_released(r, run_cancel):
    start(r)
    pause(r)
    peer, _, _ = r.connect(purpose='view', run_cancel=run_cancel)
    assert not r.take(peer)['ok']
    answer = r.send(peer, 'run.control', run_id=r.start['run_id'], op='abort')
    assert answer['ok'] is run_cancel
    if run_cancel:
        assert r.runs.snapshot()['fail_code'] == 'OPERATOR_ABORT'
        assert not r.runs.active
        assert not r.take(peer)['ok']
        assert r.take(r.peer)['ok']
        r.unlock(r.peer)
        r.cmd(r.peer, 0)
        r.start.update(run_id=uid(), lease_id=r.hub.session.lease_id)
        assert r.send(r.peer, 'run.start', **r.start)['ok']
    else:
        assert r.runs.active


def test_physical_phone_start_denied(r):
    r.hub.simulation = False
    # pc gate rejects before run gate; phone cannot bypass physical restriction.
    r.hub.peers[r.peer].surface = 'phone'
    assert r.send(r.peer, 'run.start', **r.start)['error']['code'] == 'FORBIDDEN'
    assert not r.actions.goals


def test_start_idempotence_conflict_and_no_token_to_new_connection(r):
    start(r)
    assert r.send(r.peer, 'run.start', **r.start)['detail'] == r.detail
    assert len(r.actions.goals) == 1
    assert r.send(r.peer, 'run.start', **{**r.start, 'scenario_version': 2})['error']['code'] == 'RUN_CONFLICT'
    r.hub.disconnect(r.peer)
    peer, _, _ = r.connect(user=r.claim['sub'], device=r.claim['device'], surface='pc')
    answer = r.send(peer, 'run.start', **r.start)
    assert answer['error']['code'] == 'RUN_OWNER_MISMATCH' and 'detail' not in answer


def test_arrival_needs_measured_evidence(r):
    b = start(r)
    r.runs.nav.feedback(b, 'SUCCEEDED')
    r.hub.tick()
    assert r.runs.snapshot()['status'] == 'MOVING'
    assert r.runs.snapshot()['progress']['done'] == 0


def test_stop_release_and_unsupported_confirm(r):
    start(r)
    import json
    assert r.hub.receive(r.peer, json.dumps(dict(t='run.confirm', id='confirm', robot=r.robot, lease_id=r.start['lease_id'], run_id=r.start['run_id'], kind='OPERATOR', data={})))['error']['code'] == 'UNSUPPORTED_OPERATION'
    peer, _, _ = r.connect(purpose='view')
    assert r.send(peer, 'stop')['ok']
    assert r.runs.snapshot()['wait_reason'] == 'STOPPED_BY_USER'
    assert r.send(r.peer, 'lease.release')['ok']
    assert r.outputs[-1].velocity == Z


def test_run_recorded_ack_does_not_grant_control(r):
    start(r)
    journal = r.runs.journal
    deadline = time.monotonic()+2
    while journal.jobs and time.monotonic() < deadline:
        journal.poll()
        time.sleep(.001)
    observer = Observer(r.hub)
    hello = observer.connect()
    assert hello.messages[0]['run']['status'] == 'MOVING'
    messages = observer.tick().messages
    reports = [m for m in messages if 'report_seq' in m]
    assert reports
    first = reports[0]
    before = (r.hub.owner, r.hub.session.holder_type, r.hub.session.core.stop_gen)
    observer.receive(dict(t='run.recorded', agent_instance_id=first['agent_instance_id'], report_seq=first['report_seq']))
    while journal.jobs and time.monotonic() < deadline:
        journal.poll()
        time.sleep(.001)
    assert (first['agent_instance_id'], first['report_seq']) not in journal.entries
    assert before == (r.hub.owner, r.hub.session.holder_type, r.hub.session.core.stop_gen)


def test_journal_restart_replays_same_identity(tmp_path):
    path = str(tmp_path/'run.sqlite')
    out = RunOutbox(path)
    m = out.append(dict(t='run.update', run_id=uid(), status='PAUSED', step=0, progress={'done': 0, 'total': 1}, wait_reason='LINK_LOST', fail_code=None), 1.)
    out.close()
    out = RunOutbox(path)
    try:
        assert out.replay() == [m]
        assert out.instance != m['agent_instance_id']
    finally:
        out.close()


def test_storage_failure_zero_lock_and_blocks_start(r):
    start(r)
    r.runs.journal.error = OSError('injected disk failure')
    r.hub.tick()
    assert r.runs.snapshot()['wait_reason'] == 'RECORDING_UNAVAILABLE'
    assert r.hub.session.core.latch and r.outputs[-1].velocity == Z


def test_terminal_cancel_waits_for_cancel_ack_before_new_user_lease(r):
    start(r)
    r.actions.canceled = False
    assert r.send(r.peer, 'run.control', run_id=r.start['run_id'], op='abort')['ok']
    assert not r.runs.active
    assert not r.take(r.peer)['ok']
    assert r.hub.session.core.latch and r.outputs[-1].velocity == Z
    r.actions.canceled = True
    assert r.take(r.peer)['ok']


def test_source_deadman_and_nav_timeout_zero_lock(r):
    binding = start(r)
    r.runs.nav.intent(binding, (.6, 0., 0.))
    r.hub.tick()
    assert r.outputs[-1].velocity == (.6, 0., 0.)
    r.clock.t = .300001
    r.hub.tick()
    assert r.runs.snapshot()['status'] == 'FAILED'
    assert r.hub.session.core.latch and r.outputs[-1].velocity == Z
    assert not r.runs.nav.intent(binding, (.6, 0., 0.))


def test_foreign_ping_cannot_refresh_run_owner_watch(r):
    start(r)
    other, _, _ = r.connect(purpose='view')
    for n in range(1, 30):
        r.clock.t = n / 10
        r.runs.nav.intent(r.runs.binding, Z)
        r.state(False)
        r.send(other, 'ping', client_time_ms=n*100)
        r.hub.tick()
    r.clock.t = 3.
    r.hub.tick()
    assert r.runs.snapshot()['wait_reason'] == 'LINK_LOST'


def test_map_context_invalid_never_submits_goal(r):
    r.runs.context = lambda request, plan: False
    assert r.send(r.peer, 'run.start', **r.start)['ok']
    r.hub.tick()
    assert r.runs.snapshot()['fail_code'] == 'MAP_VERSION_MISMATCH'
    assert not r.actions.goals


def test_goal_success_with_stale_pose_or_moving_body_is_not_arrival(r):
    binding = start(r)
    r.runs.nav.feedback(binding, 'SUCCEEDED')
    pose = dict(floor_id=r.start['floor_id'], map_version_id=r.start['map_version_id'], x=0., y=0., yaw=0., confidence=1.)
    for evidence in (dict(binding=binding, received_at=-2., body_still=True, pose=pose),
                     dict(binding=binding, received_at=0., body_still=False, pose=pose),
                     dict(binding=binding, received_at=0., body_still=True, pose={**pose, 'floor_id': uid()})):
        r.runs.arrival = lambda b, g: evidence
        r.hub.tick()
        assert r.runs.snapshot()['progress']['done'] == 0


@pytest.mark.parametrize('mode', ['RETURN_TO_START', 'GO_TO'])
def test_finish_movement_is_not_an_extra_mission(r, mode):
    r.data['finish'] = {'mode': mode}
    if mode == 'GO_TO':
        r.data['finish']['target'] = {k: r.data['waypoints'][0][k] for k in ('floor_id', 'map_version_id', 'x', 'y', 'yaw')}
    binding = start(r)
    r.runs.arrival = lambda b, goal: dict(binding=b, received_at=r.clock(), body_still=True,
        pose=dict(floor_id=r.start['floor_id'], map_version_id=r.start['map_version_id'], x=0., y=0., yaw=0., confidence=1.))
    r.runs.nav.feedback(binding, 'SUCCEEDED')
    r.hub.tick()
    assert r.runs.snapshot()['status'] == 'MOVING'
    assert len(r.actions.goals) == 2
    r.runs.nav.feedback(r.runs.binding, 'SUCCEEDED')
    r.hub.tick()
    assert r.runs.snapshot()['status'] == 'COMPLETED'
    assert r.runs.snapshot()['progress'] == {'done': 1, 'total': 1}
    assert sum(m.get('code') == 'RUN_WAYPOINT_ARRIVED' for m in r.runs.journal.entries.values()) == 1


@pytest.mark.parametrize('bad', [1, 'true', None, [], {}])
def test_run_cancel_claim_is_strict_boolean(r, bad):
    claims = r.claims(run_cancel=bad)
    with pytest.raises(TicketError):
        r.verifier.verify(signed(r.key, claims))


def test_run_reports_and_screen_snapshots_match_contract_models(r):
    models = pytest.importorskip('apps.contracts.models')
    start(r)
    models.PhoneState.model_validate(r.hub.state(r.peer))
    models.PhoneRunUpdate.model_validate({'t': 'run.update', **r.runs.snapshot()})
    for message in r.runs.journal.entries.values():
        (models.AgentRunUpdate if message['t'] == 'run.update' else models.AgentEvent).model_validate(message)


def test_journal_crash_recovery_closes_active_without_goal(r, tmp_path):
    from foothold_agent.executor.scenario_run import ScenarioRun
    journal = RunOutbox(str(tmp_path/'durable.sqlite'))
    run_id = uid()
    journal.append(dict(t='run.update', run_id=run_id, status='MOVING', step=0,
                        progress={'done': 0, 'total': 1}, wait_reason=None, fail_code=None), 1.)
    journal.close()
    journal = RunOutbox(str(tmp_path/'durable.sqlite'))
    try:
        recovered = ScenarioRun(r.hub, journal=journal)
        assert not recovered.active and recovered.current is None
        assert run_id in recovered.starts
        last = list(journal.entries.values())[-1]
        assert last['status'] == 'FAILED' and last['fail_code'] == 'AGENT_RESTARTED'
        assert not r.actions.goals
    finally:
        journal.close()


def test_stop_does_not_poll_pending_nonzero_nav_intent(r):
    b = start(r)
    r.runs.nav.intent(b, (.6, 0., 0.))
    before = len(r.outputs)
    assert r.send(r.peer, 'stop')['ok']
    assert all(c.velocity == Z for c in r.outputs[before:])
    assert b in r.actions.cancels


def test_pause_does_not_record_pending_arrival(r):
    b = start(r)
    r.runs.nav.feedback(b, 'SUCCEEDED')
    r.runs.arrival = lambda b, goal: dict(binding=b, received_at=r.clock(), body_still=True,
        pose=dict(floor_id=r.start['floor_id'], map_version_id=r.start['map_version_id'], x=0., y=0., yaw=0., confidence=1.))
    pause(r)
    assert r.runs.snapshot()['progress']['done'] == 0
    assert not r.runs.nav.feedback(b, 'SUCCEEDED')


def test_cloud_cannot_control_running_direct_run(r):
    b = start(r)
    observer = Observer(r.hub)
    observer.connect()
    observer.receive(dict(t='run.control', run_id=r.start['run_id'], op='abort'))
    observer.disconnect()
    assert r.runs.snapshot()['status'] == 'MOVING'
    assert r.runs.binding == b
    assert r.hub.session.holder_type == 'RUN'


def test_resume_secret_never_reaches_recording_or_public_snapshot(r):
    import json
    start(r)
    assert r.detail['resume_token'] not in json.dumps(list(r.runs.journal.entries.values()))
    assert 'resume_token' not in json.dumps(r.hub.state(r.peer))
    assert 'token_hash' not in json.dumps(r.hub.state(r.peer))


def test_completed_events_validate_against_contracts(r):
    models = pytest.importorskip('apps.contracts.models')
    models.AgentScenario.model_validate(r.data)
    b = start(r)
    models.RunPlan.model_validate(r.runs.current['plan'])
    r.runs.arrival = lambda b, goal: dict(binding=b, received_at=r.clock(), body_still=True,
        pose=dict(floor_id=r.start['floor_id'], map_version_id=r.start['map_version_id'], x=0., y=0., yaw=0., confidence=1.))
    r.runs.nav.feedback(b, 'SUCCEEDED')
    r.hub.tick()
    for message in r.runs.journal.entries.values():
        (models.AgentRunUpdate if message['t'] == 'run.update' else models.AgentEvent).model_validate(message)


def test_missing_coordinate_refuses_plan(r):
    del r.data['waypoints'][0]['x']
    assert r.send(r.peer, 'run.start', **r.start)['ok']
    r.hub.tick()
    assert r.runs.snapshot()['fail_code'] == 'PLAN_UNAVAILABLE'
    assert not r.actions.goals


def test_failed_commit_cannot_replay_uncommitted_message(r):
    out = r.runs.journal
    failed = Future()
    failed.set_exception(OSError('injected failure'))
    key = (out.instance, 1)
    out.entries[key] = dict(t='run.update')
    out.jobs = [(failed, key, out.entries[key])]
    assert out.poll() == []
    assert out.replay() == []
    assert not out.ack(*key) and not out.available


def test_invalid_report_does_not_consume_sequence(r):
    out = r.runs.journal
    with pytest.raises(ValueError):
        out.append(dict(t='event', data={'invalid': float('nan')}), 0.)
    assert out.seq == 0 and out.entries == {} and out.jobs == []


def test_source_deadman_blocks_robot_feedback_before_watchdog(r):
    binding = start(r)
    assert r.runs.nav.intent(binding, (.6, 0., 0.))  # original receipt t=0
    r.clock.t = .25
    r.state(False)
    r.hub.tick()  # consume at .25; Core's own deadline would be .55
    assert r.outputs[-1].velocity == (.6, 0., 0.)
    assert r.hub.session.core.intent_t == .25
    r.clock.t = .300001
    assert r.runs.nav.source_expired()
    before = len(r.outputs)
    r.state(False)  # no watchdog tick
    assert r.outputs[before:] and all(c.velocity == Z for c in r.outputs[before:])
    assert r.outputs[-1].velocity == Z and r.hub.session.core.latch
    assert r.runs.snapshot()['fail_code'] == 'NAV_TIMEOUT'
    assert binding in r.actions.cancels


def test_run_entry_cancels_pending_user_handover(r):
    other, _, _ = r.connect()
    request = r.send(other, 'lease.request')['request_id']
    assert request is not None and r.hub.pending is not None
    start(r)
    assert r.hub.pending is None
    for peer in (r.peer, other):
        assert any(m['t'] == 'lease.result' and m['request_id'] == request
                   and m['result'] == 'CANCELED' for m in r.hub.drain(peer))
    reply = r.send(r.peer, 'lease.respond', request_id=request, accept=True)
    assert not reply['ok'] and reply['error']['code'] == 'RUN_ACTIVE'
    assert r.hub.owner is r.peer and r.hub.owner is not other
    assert r.hub.session.holder_type == 'RUN'
    before = len(r.outputs)
    assert not r.cmd(other)['ok']
    assert all(c.velocity == Z for c in r.outputs[before:])
    assert r.runs.snapshot()['status'] == 'MOVING'


@pytest.mark.parametrize('paused', [False, True])
def test_lease_response_defends_run_owner_even_with_pending_request(r, paused):
    other, _, _ = r.connect()
    request = r.send(other, 'lease.request')['request_id']
    pending = dict(r.hub.pending)
    start(r)
    if paused:
        pause(r)
        assert r.take(r.peer)['ok']
    r.hub.pending = pending  # exercise the response gate independently of cancellation
    reply = r.send(r.peer, 'lease.respond', request_id=request, accept=True)
    assert not reply['ok']
    assert reply['error']['code'] == ('RUN_OWNER_MISMATCH' if paused else 'RUN_ACTIVE')
    assert r.hub.owner is r.peer and r.hub.owner is not other


def test_stop_emits_session_stop_when_action_cancel_raises(r, monkeypatch):
    start(r)
    def fail_cancel(binding):
        raise RuntimeError('cancel failed')
    before, stop_ref = len(r.outputs), r.hub.stop_ref
    with monkeypatch.context() as patch:
        patch.setattr(r.actions, 'cancel', fail_cancel)
        with pytest.raises(RuntimeError, match='cancel failed'):
            r.hub.stop()
    emitted = r.outputs[before:]
    assert any(c.kind == 'stop' for c in emitted)
    assert emitted[-1].velocity == Z and r.hub.session.core.latch
    assert r.hub.stop_ref == stop_ref + 1
