"""Hub scenario/2 acceptance using the existing safety harness and durable ACKs."""
from concurrent.futures import Future
from copy import deepcopy
import time

import pytest

from foothold_agent.executor.scenario import ExecutionUnavailable, plan_from_data
from foothold_agent.executor.steps import ExecutionSupport
from foothold_agent.phone.observer import Observer
from foothold_agent.safety.core import Z
from test_execution_steps import Uploads, jpeg
from foothold_agent.camera.stream import Camera
from test_scenario_run import r, start, pause, resume


def configure(h, steps):
    camera = Camera(h.robot, now=h.clock)
    camera.submit(jpeg())
    camera.sample()
    h.uploads = Uploads()
    h.camera = camera
    h.runs.support = ExecutionSupport(now=h.clock, camera=camera, uploader=h.uploads)
    caps = h.runs.support.hello()
    h.data.update(run_contract='scenario/2', execution_capability_revision=caps['revision'])
    wanted = sorted({'wait' if s['action'] == 'WAIT' else 'photo.rgb' for s in steps})
    h.data['waypoints'][0].update(mission_steps=deepcopy(steps), required_capabilities=wanted)
    return h


def wait(seconds=1):
    return dict(action='WAIT', params=dict(seconds=seconds))


def photo():
    return dict(action='PHOTO', params=dict(camera='rgb'))


def flush(h):
    deadline = time.monotonic() + 2
    while h.runs.journal.jobs and time.monotonic() < deadline:
        h.runs.journal.poll()
        time.sleep(.001)
    assert not h.runs.journal.jobs


def ack(h):
    flush(h)
    for key in list(h.runs.journal.entries):
        h.runs.journal.ack(*key)
    flush(h)


def arrive(h):
    binding = start(h)
    h.runs.arrival = lambda b, goal: dict(binding=b, received_at=h.clock(),
        pose=dict(floor_id=h.start['floor_id'], map_version_id=h.start['map_version_id'],
                  x=0., y=0., yaw=0., confidence=1.))
    assert h.runs.nav.feedback(binding, 'SUCCEEDED')
    h.hub.tick()
    assert h.runs.current['status'] == 'PERFORMING'
    return binding


def advance(h, seconds):
    target = h.clock.t + seconds
    while h.clock.t < target:
        h.clock.t = min(target, h.clock.t + .1)
        h.send(h.peer, 'ping', client_time_ms=int(h.clock.t * 1000))
        h.hub.tick()


def recorded(h):
    return [m for m in h.runs.journal.entries.values() if m.get('code') == 'RUN_WAYPOINT_RECORDED']


def restore(h):
    assert h.take(h.peer)['ok']
    h.unlock(h.peer)
    h.cmd(h.peer, 0)
    reply = resume(h)
    assert reply['ok'], reply
    h.detail = reply['detail']


def test_wait_server_ack_then_deadline_and_record_ack(r):
    configure(r, [wait(2)])
    arrive(r)
    assert r.runs.performer.state == 'READY'
    advance(r, .2)
    assert r.runs.performer.state == 'READY'  # local fsync is not server ACK
    ack(r)
    r.hub.tick()
    assert r.runs.performer.state == 'WAITING'
    advance(r, 1.9)
    assert not recorded(r)
    advance(r, .11)
    report = recorded(r)[0]
    assert report['data']['results']['steps'][0]['status'] == 'SUCCEEDED'
    assert r.runs.current['status'] == 'PERFORMING'  # no next goal before record ACK
    from apps.contracts.models import RunWaypointRecorded, ExecutableRunGoal
    result = RunWaypointRecorded.model_validate(report['data']).results
    result.validate_plan(ExecutableRunGoal.model_validate(r.runs.current['plan']['segments'][0]['goals'][0]), 1)
    ack(r)
    r.hub.tick()
    assert r.runs.current['status'] == 'COMPLETED'
    assert r.outputs[-1].velocity == Z


def test_wait_pause_freezes_remaining_and_resume_does_not_move(r):
    configure(r, [wait(10)])
    arrive(r)
    ack(r)
    r.hub.tick()
    advance(r, 2)
    pause(r)
    assert r.runs.performer.remaining == 8
    advance(r, 20)
    assert not r.runs.performer.results
    restore(r)
    assert len(r.actions.goals) == 1
    r.hub.tick()
    advance(r, 7.9)
    assert not recorded(r)
    advance(r, .11)
    assert recorded(r)[0]['data']['results']['steps'][0]['status'] == 'SUCCEEDED'


@pytest.mark.parametrize('action', [wait(30), photo()])
@pytest.mark.parametrize('interruption', ['stop', 'abort', 'disconnect'])
def test_every_step_interrupts_without_waiting_for_io(r, action, interruption):
    configure(r, [action, wait(1)])
    arrive(r)
    ack(r)
    r.hub.tick()
    if action['action'] == 'PHOTO':
        advance(r, .2)
        r.camera.submit(jpeg())
        r.camera.sample()
        r.hub.tick()
        assert r.uploads.jobs and not r.uploads.jobs[0].done()
    before = time.monotonic()
    if interruption == 'stop':
        r.send(r.peer, 'stop')
    elif interruption == 'abort':
        assert r.send(r.peer, 'run.control', run_id=r.start['run_id'], op='abort')['ok']
    else:
        r.hub.disconnect(r.peer)
    assert time.monotonic() - before < .05
    assert r.runs.current['status'] == ('CANCELED' if interruption == 'abort' else 'PAUSED')
    assert r.outputs[-1].velocity == Z and r.hub.session.core.latch
    if r.uploads.jobs:
        r.uploads.jobs[0].set_result(r.uploads.receipt())
    r.hub.tick()
    assert not recorded(r) and not r.runs.performer.results
    assert len(r.actions.goals) == 1


def test_cancel_unconfirmed_fails_step_and_never_starts_wait(r):
    configure(r, [wait(1), wait(1)])
    r.actions.canceled = False
    arrive(r)
    ack(r)
    advance(r, r.runs.arrival_wait_s)
    assert r.runs.current['status'] == 'FAILED'
    result = recorded(r)[0]['data']['results']
    assert len(result['steps']) == 1 and result['steps'][0]['status'] == 'FAILED'
    assert result['steps'][0]['failure_code'] == 'ACTION_FAILED'
    assert len(r.actions.goals) == 1 and r.outputs[-1].velocity == Z


def test_photo_fresh_receipt_reference_and_no_bytes_in_journal(r):
    configure(r, [photo()])
    arrive(r)
    ack(r)
    r.hub.tick()
    assert not r.uploads.calls
    advance(r, .2)
    r.camera.submit(jpeg())
    r.camera.sample()
    r.hub.tick()
    assert len(r.uploads.calls) == 1 and not recorded(r)
    metadata = r.uploads.calls[0][0]
    assert metadata['org_id'] == r.org and metadata['robot_id'] == r.robot
    assert metadata['run_id'] == r.start['run_id']
    receipt = r.uploads.receipt()
    r.uploads.jobs[0].set_result(receipt)
    r.hub.tick()
    report = recorded(r)[0]
    assert report['data']['results']['steps'][0]['photo']['photo_id'] == receipt['photo_id']
    import json
    assert 'jpeg' not in json.dumps(list(r.runs.journal.entries.values()))
    from apps.contracts.models import RunWaypointRecorded
    RunWaypointRecorded.model_validate(report['data'])


def test_photo_late_upload_pause_resume_reuses_same_packet(r):
    configure(r, [photo(), wait(1)])
    arrive(r)
    ack(r)
    r.hub.tick()
    advance(r, .2)
    r.camera.submit(jpeg())
    r.camera.sample()
    r.hub.tick()
    pause(r)
    r.uploads.jobs[0].set_result(r.uploads.receipt())
    r.hub.tick()
    assert not r.runs.performer.results
    restore(r)
    r.hub.tick()
    assert len(r.uploads.calls) == 2
    assert r.uploads.calls[0] == r.uploads.calls[1]
    assert not r.runs.performer.results and len(r.actions.goals) == 1
    r.uploads.jobs[1].set_result(r.uploads.receipt())
    r.hub.tick()
    assert len(r.runs.performer.results) == 1


def test_cloud_disconnect_pauses_executing_steps(r):
    configure(r, [wait(30)])
    observer = Observer(r.hub)
    observer.connect()
    arrive(r)
    ack(r)
    r.hub.tick()
    observer.disconnect()
    assert r.runs.current['status'] == 'PAUSED'
    assert r.runs.performer.state == 'SUSPENDED'
    assert r.outputs[-1].velocity == Z
    observer.connect()
    assert r.runs.current['status'] == 'PAUSED'


@pytest.mark.parametrize('with_photo', [False, True])
def test_rgb_loss_keeps_wait_and_cloud_revision_stable_until_run_ends(r, with_photo):
    configure(r, [wait(5)] + ([photo()] if with_photo else []))
    observer = Observer(r.hub)
    hello = observer.connect().messages[0]
    assert hello['execution_capabilities']['actions'][1]['state'] == 'SUPPORTED'
    arrive(r)
    ack(r)
    r.hub.tick()
    for _ in range(11):
        advance(r, .5)
        observer.receive(dict(t='ping'))  # cloud stays healthy while RGB expires
        if r.runs.active:
            assert not observer.reconnect_required
        assert r.runs.support.revision == 1
    results = recorded(r)[0]['data']['results']['steps']
    assert results[0]['action'] == 'WAIT' and results[0]['status'] == 'SUCCEEDED'
    if with_photo:
        assert results[1]['action'] == 'PHOTO' and results[1]['status'] == 'FAILED'
        assert results[1]['failure_code'] == 'DEVICE_UNAVAILABLE'
        assert r.runs.current['status'] == 'FAILED' and not r.uploads.calls
    else:
        assert len(results) == 1 and r.runs.current['status'] == 'PERFORMING'
        ack(r)
        r.hub.tick()
        assert r.runs.current['status'] == 'COMPLETED'
    observer.receive(dict(t='ping'))
    assert observer.reconnect_required  # only after completion/failure
    assert observer.connect().messages[0]['execution_capabilities']['revision'] == 2


def test_idle_rgb_loss_requires_three_continuous_seconds_before_reconnect(r):
    configure(r, [wait(30)])
    observer = Observer(r.hub)
    observer.connect()
    r.clock.t = 1.1
    observer.receive(dict(t='ping'))
    r.clock.t = 2.5
    observer.receive(dict(t='ping'))
    assert not observer.reconnect_required
    r.clock.t = 2.6
    assert r.camera.submit(jpeg())
    r.camera.sample()
    observer.receive(dict(t='ping'))
    assert observer._rgb_unavailable_since is None
    r.clock.t = 3.7
    observer.receive(dict(t='ping'))
    r.clock.t = 5.7
    observer.receive(dict(t='ping'))
    assert not observer.reconnect_required
    r.clock.t = 6.71
    observer.receive(dict(t='ping'))
    assert observer.reconnect_required
    caps = observer.connect().messages[0]['execution_capabilities']
    assert caps['revision'] == 2 and caps['actions'][1]['state'] == 'UNAVAILABLE'


def test_422_does_not_start_or_move_and_reports_reason(r):
    configure(r, [wait()])
    def unavailable(request):
        future = Future()
        future.set_exception(ExecutionUnavailable('capability revision mismatch'))
        return future
    r.runs.source.fetch = unavailable
    assert r.send(r.peer, 'run.start', **r.start)['ok']
    r.hub.tick()
    assert r.runs.current['status'] == 'FAILED' and not r.actions.goals
    reports = list(r.runs.journal.entries.values())
    assert len(reports) == 1 and reports[0]['code'] == 'EXECUTION_UNAVAILABLE'
    assert reports[0]['data']['reason'] == 'capability revision mismatch'
    assert 'run_id' not in reports[0]['data']  # no nonexistent server Run ownership


@pytest.mark.parametrize('mutation', ['revision', 'required', 'seconds', 'action', 'source'])
def test_bad_executable_plan_cannot_become_display_only(r, mutation):
    configure(r, [wait()])
    point = r.data['waypoints'][0]
    if mutation == 'revision': r.data['execution_capability_revision'] = 2
    elif mutation == 'required': point['required_capabilities'] = []
    elif mutation == 'seconds': point['mission_steps'][0]['params']['seconds'] = True
    elif mutation == 'action': point['mission_steps'][0]['action'] = 'OPERATOR_CONFIRM'
    elif mutation == 'source': point.update(mission_steps=[dict(action='PHOTO', params=dict(camera='depth'))], required_capabilities=['photo.depth'])
    assert r.send(r.peer, 'run.start', **r.start)['ok']
    r.hub.tick()
    assert r.runs.current['status'] == 'FAILED' and not r.actions.goals


def test_scenario1_response_even_with_steps_remains_display_only(r):
    configure(r, [wait(3600)])
    r.data.pop('run_contract')
    r.data.pop('execution_capability_revision')
    binding = start(r)
    r.runs.arrival = lambda b, goal: dict(binding=b, received_at=r.clock(),
        pose=dict(floor_id=r.start['floor_id'], map_version_id=r.start['map_version_id'],
                  x=0., y=0., yaw=0., confidence=1.))
    r.runs.nav.feedback(binding, 'SUCCEEDED')
    r.hub.tick()
    assert r.runs.current['status'] == 'COMPLETED'
    assert recorded(r)[0]['data']['results'] == {'mode': 'DISPLAY_ONLY'}


def test_resume_with_changed_capability_revision_records_failed_step(r):
    configure(r, [wait(30)])
    arrive(r)
    ack(r)
    r.hub.tick()
    pause(r)
    r.runs.support.camera = None
    r.runs.support.hello()
    restore(r)
    r.hub.tick()
    result = recorded(r)[0]['data']['results']['steps'][0]
    assert result['status'] == 'FAILED' and result['failure_code'] == 'CAPABILITY_CHANGED'
    assert r.runs.current['status'] == 'FAILED' and len(r.actions.goals) == 1


def test_zero_unconfirmed_blocks_step_and_records_failed(r, monkeypatch):
    configure(r, [wait(1)])
    arrive(r)
    ack(r)
    from foothold_agent.link.session import Effects
    def unconfirmed(*args):
        r.hub.session.core.out = (.1, 0, 0)
        return Effects(())  # fake an unconfirmed output port; no nonzero is sent
    monkeypatch.setattr(r.hub.session, 'executor_command', unconfirmed)
    advance(r, r.runs.arrival_wait_s)
    result = recorded(r)[0]['data']['results']['steps'][0]
    assert result['status'] == 'FAILED'
    assert 'zero output unconfirmed' in result['failure_reason']
    assert r.runs.current['status'] == 'FAILED' and len(r.actions.goals) == 1
    assert r.outputs[-1].velocity == Z
