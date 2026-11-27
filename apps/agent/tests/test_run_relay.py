"""Server run.start / run.control relay enters the SAME ScenarioRun.handle as the phone frame.

Fake SDK / fake Nav2 only. No robot, Jetson or network.
"""
from uuid import uuid4

import pytest

from test_scenario_run import r, start, uid  # noqa: F401  (fixture reuse)
from test_go2_server_drive import rig
from foothold_agent.executor.scenario_run import ScenarioRun
from foothold_agent.phone.observer import Observer


def relay_start(h, **kw):
    return dict(t='run.start', request_id='req-' + uid(), user_id=uid(),
                **{**h.start, 'run_id': uid(), 'assignment_id': uid()}, **kw)


def result(observer):
    return observer._state()['run_result']


@pytest.fixture
def cloud(r, monkeypatch):
    calls = []
    original = ScenarioRun.handle
    def spy(self, peer, frame):
        answer = original(self, peer, frame)
        calls.append((peer, dict(frame), answer))
        return answer
    monkeypatch.setattr(ScenarioRun, 'handle', spy)
    observer = Observer(r.hub)
    observer.connect()
    r.calls, r.observer = calls, observer
    return r


def test_server_start_reaches_phone_run_machine_and_reports_result(cloud):
    r = cloud
    body = relay_start(r)
    owner, lease = r.hub.owner, r.hub.session.lease_id
    r.observer.receive(body)
    assert len(r.calls) == 1
    peer, frame, answer = r.calls[0]
    # Phone-shape frame: request id becomes the frame id; user id stays out.
    assert frame['t'] == 'run.start' and frame['id'] == body['request_id'] and 'user_id' not in frame
    assert frame['assignment_id'] == body['assignment_id']
    # The server relay is never the Hub controller, so the existing gate refuses it.
    assert answer == ('NOT_CONTROLLER', None)
    assert result(r.observer) == dict(request_id=body['request_id'], op='start', run_id=body['run_id'],
                                      status='REJECTED', code='NOT_CONTROLLER')
    assert (r.hub.owner, r.hub.session.lease_id) == (owner, lease)
    assert not r.actions.goals and r.runs.current is None


def test_physical_hub_keeps_forbidden_gate(cloud):
    r = cloud
    r.hub.simulation = False
    body = relay_start(r)
    r.observer.receive(body)
    assert result(r.observer)['code'] == 'FORBIDDEN'
    assert not r.actions.goals


@pytest.mark.parametrize('op,code', [('pause', 'RUN_OWNER_MISMATCH'), ('resume', 'RESUME_REJECTED'),
                                     ('abort', 'FORBIDDEN')])
def test_server_control_cannot_take_over_direct_run(cloud, op, code):
    r = cloud
    binding = start(r)
    body = dict(t='run.control', request_id='req-1', user_id=r.claim['sub'], lease_id=r.hub.session.lease_id
                or r.start['lease_id'], run_id=r.start['run_id'], screen_id=r.start['screen_id'], op=op)
    r.observer.receive(body)
    assert result(r.observer) == dict(request_id='req-1', op=op, run_id=r.start['run_id'],
                                      status='REJECTED', code=code)
    assert r.runs.snapshot()['status'] == 'MOVING' and r.runs.binding == binding


def test_relayed_success_is_reported_ok(cloud, monkeypatch):
    r = cloud
    monkeypatch.setattr(ScenarioRun, 'handle', lambda self, peer, frame: (None, {'resume_token': 'secret'}))
    body = relay_start(r)
    r.observer.receive(body)
    assert result(r.observer) == dict(request_id=body['request_id'], op='start', run_id=body['run_id'],
                                      status='SUCCEEDED', code='OK')
    # The resume secret never reaches server state.
    assert 'secret' not in repr(r.observer._state())


@pytest.mark.parametrize('bad', ['no_request', 'long_request', 'bad_uuid', 'extra', 'op'])
def test_malformed_relay_never_reaches_machine(cloud, bad):
    r = cloud
    body = relay_start(r)
    if bad == 'no_request': body.pop('request_id')
    if bad == 'long_request': body['request_id'] = 'x' * 129
    if bad == 'bad_uuid': body['floor_id'] = 'not-a-uuid'
    if bad == 'extra': body['resume_token'] = 'x'
    if bad == 'op': body = dict(t='run.control', request_id='req', user_id=uid(), lease_id=uid(),
                                run_id=uid(), screen_id=uid(), op='return')
    r.observer.receive(body)
    assert r.calls == []
    if bad in ('no_request', 'long_request'):
        assert result(r.observer) is None
    else:
        assert result(r.observer)['status'] == 'REJECTED' and result(r.observer)['code'] == 'VALIDATION'


def test_disconnected_observer_ignores_relay(cloud):
    r = cloud
    r.observer.disconnect()
    r.observer.receive(relay_start(r))
    assert r.calls == []


def test_server_drive_session_without_run_machine_reports_unsupported():
    session = rig()[4]
    from foothold_agent.go2_direct.server import DriveSession
    assert isinstance(session, DriveSession)
    before = session.core.out
    session.receive(dict(t='run.start', request_id='req-9', user_id=uid(), lease_id='fake-lease',
                         run_id=(run := uid()), screen_id=uid(), scenario_id=uid(), scenario_version=1,
                         floor_id=uid(), map_version_id=uid(), assignment_id=uid()))
    assert session._state()['run_result'] == dict(request_id='req-9', op='start', run_id=run,
                                                  status='REJECTED', code='RUN_UNSUPPORTED')
    assert session.core.out == before
