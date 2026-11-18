"""Shared display telemetry through real sessions, with fake DDS samples only."""
from copy import deepcopy

import pytest

from apps.contracts.models import AgentState
from foothold_agent.go2_direct.feedback import Feedback
from foothold_agent.go2_direct.readonly import Measurements, Observer
from foothold_agent.go2_direct.reporting import Reporting, project
from foothold_agent.go2_direct.server import DriveSession
from foothold_agent.go2_readonly.state import SDK_JOINTS, STALE_S
from foothold_agent.link.client import Settings
from test_go2_feedback import low, sport
from test_go2_server_drive import rig
from test_phone import Harness

FIELDS = {'joints', 'quaternion', 'position'}


def samples(tick=1):
    message = low(tick)
    for i, motor in enumerate(message.motor_state):
        motor.q = i / 10
    message.imu_state.quaternion = [1., 0., 0., 0.]
    return message, sport(tick, position=[1., 2., .3])


@pytest.fixture(params=['drive', 'phone-reporting', 'readonly'])
def display(request):
    h = Harness(simulation=False)
    if request.param == 'readonly':
        cache = Measurements(now=h.clock, wall=h.clock.wall)
        session = Observer(cache)
        session.now = h.clock
    else:
        cache = Feedback('1234-5678', now=h.clock, wall=h.clock.wall)
        session = (DriveSession(cache, now=h.clock) if request.param == 'drive' else
                   Reporting(h.hub, cache, Settings('ws://127.0.0.1/ws', 'fake-token')).observer)
    try:
        yield h, cache, session
    finally:
        h.hub.close()
        h.verifier.close()


def test_fresh_fields_use_existing_shapes_and_readonly_lifetime(display):
    h, cache, session = display
    a, b = samples()
    cache.lowstate(a)
    cache.sportmodestate(b)
    initial = cache.telemetry()
    before = session._state()
    for age in (0., 1.001, STALE_S):
        h.clock.t = age
        frame = session._state()
        AgentState.model_validate(frame)
        info = frame['robot_info']
        assert FIELDS <= info.keys()
        assert info['joints']['names'] == list(SDK_JOINTS)
        assert info['joints']['positions'] == [i / 10 for i in range(12)]
        assert info['quaternion']['wxyz'] == [1., 0., 0., 0.]
        assert info['position']['xyz'] == [1., 2., .3]
        assert info['position']['origin'] == 'BOOT_ORIGIN_UNVERIFIED'
        for field in FIELDS:
            assert info[field] == cache.telemetry()[field]
            assert info[field]['received_at'] == initial[field]['received_at']
            assert info[field]['age_s'] == age
        assert (frame['stop_ref'], frame['stop_gen'], frame['latched'], frame['applied']) == (
            before['stop_ref'], before['stop_gen'], before['latched'], before['applied'])
    h.clock.t = STALE_S + .001
    stale = session._state()
    AgentState.model_validate(stale)
    assert not FIELDS & stale['robot_info'].keys()


def test_sources_expire_independently_and_duplicate_ticks_do_not_refresh(display):
    h, cache, session = display
    a, b = samples()
    cache.lowstate(a)
    cache.sportmodestate(b)
    h.clock.t = .1
    cache.lowstate(a)  # frozen lowstate tick
    cache.sportmodestate(samples(2)[1])
    h.clock.t = STALE_S + .01
    assert FIELDS & session._state()['robot_info'].keys() == {'position'}
    cache.lowstate(samples(2)[0])
    h.clock.t = STALE_S + .11
    assert FIELDS & session._state()['robot_info'].keys() == {'joints', 'quaternion'}


def test_missing_and_invalid_measurements_are_omitted(display):
    _, cache, session = display
    assert not FIELDS & session._state()['robot_info'].keys()
    a, b = samples()
    a.motor_state[0].q = float('nan')
    a.imu_state.quaternion = [0., 0., 0., 0.]
    b.position = [float('inf'), 0., 0.]
    cache.lowstate(a)
    cache.sportmodestate(b)
    assert not FIELDS & session._state()['robot_info'].keys()


@pytest.mark.parametrize('age,fresh', [(2.001, True), (-.01, True), (0., False)])
def test_projection_rejects_stale_or_untrusted_source_even_if_fields_remain(age, fresh):
    h = Harness(simulation=False)
    try:
        cache = Feedback('1234-5678', now=h.clock, wall=h.clock.wall)
        a, b = samples()
        cache.lowstate(a)
        cache.sportmodestate(b)
        snapshot = cache.telemetry()
        for source in snapshot['sources'].values():
            source.update(age_s=age, fresh=fresh)
        assert not FIELDS & project(snapshot, h.clock())['robot_info'].keys()
    finally:
        h.hub.close()
        h.verifier.close()


def test_identity_conflict_hides_replay_from_drive_and_phone_reporting():
    h = Harness(simulation=False)
    try:
        cache = Feedback('1234-5678', now=h.clock, wall=h.clock.wall)
        a, b = samples()
        cache.lowstate(a)
        cache.sportmodestate(b)
        cache.lowstate(low(2, sn=(9999, 9999)))
        sessions = (DriveSession(cache, now=h.clock),
                    Reporting(h.hub, cache, Settings('ws://127.0.0.1/ws', 'fake-token')).observer)
        assert FIELDS <= cache.telemetry().keys()  # raw cache still has old values
        for session in sessions:
            assert not FIELDS & session._state()['robot_info'].keys()
    finally:
        h.hub.close()
        h.verifier.close()


def test_replay_cannot_change_stop_confirmation_or_control_state(monkeypatch):
    now, sink, normal, emergency, session, client, _, frame = rig()
    frame('stop', stop_ref=42)
    original = session.feedback.telemetry

    def without_replay():
        return {k: v for k, v in original().items() if k not in FIELDS}

    def controls():
        core = session.core
        return deepcopy((core.latch, core.stop_gen, core.st, core.intent, core.intent_t,
                         core.out, core.need_neutral, session.lease_id, session.holder_type,
                         sink.pending, normal.calls, emergency.calls))

    def compare(expected_ref):
        before = controls()
        full = session._state()
        assert full['stop_ref'] == expected_ref
        assert FIELDS <= full['robot_info'].keys()
        with monkeypatch.context() as patch:
            patch.setattr(session.feedback, 'telemetry', without_replay)
            plain = session._state()
        for field in FIELDS:
            del full['robot_info'][field]
        assert full == plain  # includes posture, STOP, authority and applied velocity
        assert before == controls()

    a, b = samples(1000)
    session.feedback.lowstate(a)
    session.feedback.sportmodestate(b)
    compare(0)  # display data alone cannot acknowledge STOP
    assert session.feedback.consume(client)
    compare(42)  # physical evidence still owns acknowledgement
    now.value += 1.001  # display survives while physical STOP evidence expires
    compare(0)
