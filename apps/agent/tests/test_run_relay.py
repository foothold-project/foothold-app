"""Server run.start / run.control: the server's USER lease is a demo-Hub controller (11/28 05:09 · 05:14).

The relay enters the SAME Hub.receive -> ScenarioRun.handle as the phone frame.
Fake SDK / fake Nav2 only. No robot, Jetson or network.
"""
import time

import pytest

from test_scenario_run import r, uid  # noqa: F401  (fixture reuse)
from test_go2_server_drive import rig
from foothold_agent.executor.scenario_run import ServerRelay
from foothold_agent.phone.observer import Observer


def result(observer):
    return observer._state()['run_result']


@pytest.fixture
def cloud(r):
    observer = Observer(r.hub)
    observer.connect()
    r.observer = observer
    r.user = uid()
    r.lease = uid()
    yield r
    observer._messages.close()


def free_phone(r):
    assert r.send(r.peer, 'lease.release')['ok']
    assert r.hub.owner is None


def server_control(r, lease=None):
    """Server lease grant + unlock, as the server forwards them after its own gates."""
    lease = lease or r.lease
    r.observer.receive({'t': 'lease', 'lease_id': lease, 'holder_type': 'USER'})
    r.state(True)
    r.observer.receive({'t': 'unlock', 'lease_id': lease, 'stop_gen': 0, 'user_id': r.user})
    r.state(False)


def send_run(r, kind, lease=None, **body):
    rid = 'req-' + uid()
    if kind == 'run.start':
        frame = {**r.start, 'run_id': r.run_id, 'assignment_id': uid()}
    else:
        frame = dict(run_id=r.run_id, screen_id=r.start['screen_id'])
    frame.update(lease_id=lease or r.lease, **body)
    r.observer.receive({'t': kind, 'request_id': rid, 'user_id': r.user, **frame})
    got = result(r.observer)
    assert got['request_id'] == rid
    return got


def started_data(r):
    return next(m for m in r.runs.journal.entries.values() if m.get('code') == 'RUN_STARTED')['data']


def wait_moving(r):
    deadline = time.monotonic() + 2
    while r.runs.snapshot()['status'] == 'PREPARING' and time.monotonic() < deadline:
        r.hub.tick()
        time.sleep(.001)
    return r.runs.snapshot()['status']


def test_server_lease_runs_demo_hub_start_pause_resume_abort(cloud):
    r = cloud
    free_phone(r)
    r.run_id = uid()
    server_control(r)
    assert isinstance(r.hub.owner, ServerRelay) and not r.hub.session.core.latch
    got = send_run(r, 'run.start')
    assert (got['status'], got['code'], got['op']) == ('SUCCEEDED', 'OK', 'start')
    assert wait_moving(r) == 'MOVING' and len(r.actions.goals) == 1
    started = started_data(r)
    assert started['surface'] == 'server' and started['user_id'] == r.user
    models = pytest.importorskip('apps.contracts.models')
    models.ProvenRunStarted.model_validate(started)  # server accepts this provenance shape
    # ScreenState.run comes from this reported_run.
    assert r.observer._state()['reported_run']['status'] == 'MOVING'
    assert 'resume_token' not in repr(r.observer._state())

    got = send_run(r, 'run.control', op='pause')
    assert (got['status'], got['code']) == ('SUCCEEDED', 'OK')
    assert r.runs.snapshot()['status'] == 'PAUSED' and r.hub.session.core.latch
    # Latched: resume is refused until a fresh unlock.
    got = send_run(r, 'run.control', op='resume')
    assert got['status'] == 'REJECTED'
    server_control(r)
    got = send_run(r, 'run.control', op='resume')
    assert (got['status'], got['code']) == ('SUCCEEDED', 'OK')
    assert r.runs.snapshot()['status'] == 'MOVING' and len(r.actions.goals) == 2

    got = send_run(r, 'run.control', op='abort')
    assert (got['status'], got['code']) == ('SUCCEEDED', 'OK')
    assert r.runs.snapshot()['status'] == 'CANCELED' and r.hub.session.core.latch


def test_current_lease_owner_other_user_may_resume(cloud):
    r = cloud
    free_phone(r)
    r.run_id = uid()
    server_control(r)
    assert send_run(r, 'run.start')['code'] == 'OK'
    wait_moving(r)
    starter = r.user
    assert send_run(r, 'run.control', op='pause')['code'] == 'OK'
    r.user = uid()  # the server now gives the robot's USER lease to another owner
    server_control(r)
    got = send_run(r, 'run.control', op='resume')
    assert (got['status'], got['code']) == ('SUCCEEDED', 'OK')
    assert started_data(r)['user_id'] == starter


def test_stale_server_lease_is_not_controller(cloud):
    r = cloud
    free_phone(r)
    r.run_id = uid()
    server_control(r)
    got = send_run(r, 'run.start', lease=uid())
    assert (got['status'], got['code']) == ('REJECTED', 'NOT_CONTROLLER')
    assert r.runs.current is None and not r.actions.goals


def test_phone_controller_wins(cloud):
    r = cloud
    r.run_id = uid()
    owner = r.hub.owner
    server_control(r)  # phone still holds the Hub: no relay take, no unlock
    assert r.hub.owner is owner
    got = send_run(r, 'run.start')
    assert (got['status'], got['code']) == ('REJECTED', 'LEASE_HELD')
    assert r.runs.current is None


@pytest.mark.parametrize('op,code', [('pause', 'LEASE_HELD'), ('resume', 'LEASE_HELD'), ('abort', 'FORBIDDEN')])
def test_server_control_cannot_take_over_phone_run(cloud, op, code):
    from test_scenario_run import start
    r = cloud
    binding = start(r)
    r.run_id = r.start['run_id']
    r.observer.receive({'t': 'lease', 'lease_id': r.lease, 'holder_type': 'USER'})
    got = send_run(r, 'run.control', op=op)
    assert (got['status'], got['code']) == ('REJECTED', code)
    assert r.runs.snapshot()['status'] == 'MOVING' and r.runs.binding == binding


def test_physical_hub_keeps_forbidden_and_no_unlock_bridge(cloud):
    r = cloud
    free_phone(r)
    r.hub.simulation = False
    r.run_id = uid()
    server_control(r)
    assert r.hub.owner is None and r.hub.session.core.latch
    got = send_run(r, 'run.start')
    assert (got['status'], got['code']) == ('REJECTED', 'FORBIDDEN')
    assert not r.actions.goals


@pytest.mark.parametrize('loss', ['lease_null', 'lease_other', 'disconnect', 'silent'])
def test_server_authority_loss_pauses_relay_run(cloud, loss):
    r = cloud
    free_phone(r)
    r.run_id = uid()
    server_control(r)
    assert send_run(r, 'run.start')['code'] == 'OK'
    assert wait_moving(r) == 'MOVING'
    if loss == 'lease_null':
        r.observer.receive({'t': 'lease', 'lease_id': None, 'holder_type': None})
    elif loss == 'lease_other':
        r.observer.receive({'t': 'lease', 'lease_id': uid(), 'holder_type': 'USER'})
    elif loss == 'disconnect':
        r.observer.disconnect()
    else:
        r.clock.t += 3.1  # no server ping reached the relay
        r.hub.tick()
    snap = r.runs.snapshot()
    assert (snap['status'], snap['wait_reason']) == ('PAUSED', 'LINK_LOST')
    assert r.hub.session.core.latch and r.hub.owner is None


def test_server_stop_pauses_relay_run(cloud):
    r = cloud
    free_phone(r)
    r.run_id = uid()
    server_control(r)
    assert send_run(r, 'run.start')['code'] == 'OK'
    wait_moving(r)
    r.observer.receive({'t': 'stop', 'stop_ref': 5})
    assert r.runs.snapshot()['wait_reason'] == 'STOPPED_BY_USER' and r.hub.session.core.latch


@pytest.mark.parametrize('bad', ['no_request', 'long_request', 'bad_uuid', 'extra', 'op', 'user'])
def test_malformed_relay_never_reaches_machine(cloud, bad):
    r = cloud
    free_phone(r)
    server_control(r)
    body = dict(t='run.start', request_id='req', user_id=uid(), **{**r.start, 'run_id': uid(),
                'assignment_id': uid(), 'lease_id': r.lease})
    if bad == 'no_request': body.pop('request_id')
    if bad == 'long_request': body['request_id'] = 'x' * 129
    if bad == 'bad_uuid': body['floor_id'] = 'not-a-uuid'
    if bad == 'extra': body['resume_token'] = 'x'
    if bad == 'user': body['user_id'] = 'nobody'
    if bad == 'op': body = dict(t='run.control', request_id='req', user_id=uid(), lease_id=r.lease,
                                run_id=uid(), screen_id=uid(), op='return')
    r.observer.receive(body)
    assert r.runs.current is None
    if bad in ('no_request', 'long_request'):
        assert result(r.observer) is None
    else:
        assert (result(r.observer)['status'], result(r.observer)['code']) == ('REJECTED', 'VALIDATION')


def test_unlock_without_server_user_or_lease_does_nothing(cloud):
    r = cloud
    free_phone(r)
    r.observer.receive({'t': 'lease', 'lease_id': r.lease, 'holder_type': 'USER'})
    r.observer.receive({'t': 'unlock', 'lease_id': r.lease, 'stop_gen': 0})
    r.observer.receive({'t': 'unlock', 'lease_id': uid(), 'stop_gen': 0, 'user_id': r.user})
    assert r.hub.owner is None and r.hub.session.core.latch


def test_server_drive_session_without_run_machine_reports_unsupported():
    session = rig()[4]
    before = session.core.out
    session.receive(dict(t='run.start', request_id='req-9', user_id=uid(), lease_id='fake-lease',
                         run_id=(run := uid()), screen_id=uid(), scenario_id=uid(), scenario_version=1,
                         floor_id=uid(), map_version_id=uid(), assignment_id=uid()))
    assert session._state()['run_result'] == dict(request_id='req-9', op='start', run_id=run,
                                                  status='REJECTED', code='RUN_UNSUPPORTED')
    assert session.core.out == before
