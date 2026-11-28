"""걷기 모드 (계약 #525 AgentGait · GaitState · GaitResult): 가짜 SDK · 가짜 실행기 소켓만. 로봇 · DDS 없음.

순정 (FACTORY): classic · sport -> 순정 SDK ClassicWalk(True · False), 기존 동작 길의 관문 (정지 · 서 있음 · 조종권) 그대로.
START (LOWLEVEL): classic -> 실행기 키 START+RIGHT (멈춘 뒤 1 초 지나야 넘김), start -> 이미 그 모드.
ame2 -> GAIT_NOT_READY (student ONNX 전). 길이 없는 것은 GAIT_UNSUPPORTED (받은 척하지 않는다).
"""
import pytest

from foothold_agent.link.session import Session
from test_go2_posture import rig as posture_rig
from test_go2_actions import start_rig as actions_start_rig
from test_go2_start_input import FakeRunner, runner  # noqa: F401


def unlock(r, runner=None):
    # 서버는 잠김이면 보내지 않는다 (GAIT_LATCHED). 에이전트 시험도 잠금을 푼 뒤에서 시작한다.
    _, sink, _, _, session, _, measured, frame = r
    sink.drain()
    if runner is not None: runner.serve()
    sink.drain()
    frame('unlock', lease_id='fake-lease', stop_gen=session.core.stop_gen)
    sink.drain()
    if runner is not None: runner.serve()
    sink.drain(); measured()
    assert not session.core.latch and not sink.latched
    return r


def rig(mode=0):
    return unlock(posture_rig(mode))


def start_rig(tmp_path, monkeypatch, port=None, runner=None):
    flag, r = actions_start_rig(tmp_path, monkeypatch, port)
    return flag, unlock(r, runner)


def gait(frame, name, request_id='g1', lease_id='fake-lease'):
    frame('gait', request_id=request_id, lease_id=lease_id, gait=name)


def result(sink):
    return (sink.gait_result['status'], sink.gait_result['code'])


@pytest.mark.parametrize('name,enabled', [('classic', True), ('sport', False)])
def test_factory_classic_and_sport_use_one_classicwalk_call(name, enabled):
    _, sink, normal, _, session, _, _, frame = rig(0)
    calls = []
    normal.ClassicWalk = lambda value: calls.append(value) or 0
    gait(frame, name)
    assert sink.gait_result['status'] == 'RUNNING'
    sink.drain(); sink.drain()
    assert calls == [enabled]
    assert result(sink) == ('SUCCEEDED', 'OK')
    state = session._state()
    assert state['gait_result'] == dict(request_id='g1', gait=name, status='SUCCEEDED', code='OK', sdk_code=0)
    # 순정 SDK 는 지금 걸음을 읽어 주지 않는다: 모름 (None) 으로 보고한다
    assert state['gait'] == dict(gait=None, available=['classic', 'sport'])


@pytest.mark.parametrize('condition,code', [
    ('ame2', 'GAIT_NOT_READY'), ('start', 'GAIT_UNSUPPORTED'), ('lease', 'GAIT_LEASE_LOST'),
    ('input', 'GAIT_MOVING'), ('moving', 'GAIT_MOVING'), ('lying', 'GAIT_NOT_STANDING'), ('busy', 'GAIT_BUSY')])
def test_factory_rejections_never_reach_sdk(condition, code):
    _, sink, normal, _, session, _, measured, frame = rig(0)
    normal.ClassicWalk = lambda value: pytest.fail('must not invoke')
    name = {'ame2': 'ame2', 'start': 'start'}.get(condition, 'classic')
    if condition == 'input': session.core.intent = session.core.out = sink.pending = (.1, 0, 0)
    if condition == 'moving': measured(0, velocity=(.1, 0, 0))
    if condition == 'lying': measured(5, body_height=.1)
    if condition == 'busy': sink.actions.inflight = True   # 자세 요청은 sink 를 잠가 GAIT_LATCHED 가 먼저 난다
    gait(frame, name, lease_id='other-lease' if condition == 'lease' else 'fake-lease')
    sink.drain(); sink.drain()
    assert sink.gait_result['status'] == 'REJECTED'
    assert sink.gait_result['code'] == code
    assert session._state()['gait_result']['code'] == code


def test_factory_stop_cancels_queued_gait():
    _, sink, normal, _, _, _, _, frame = rig(0)
    normal.ClassicWalk = lambda value: pytest.fail('must not invoke after STOP')
    gait(frame, 'classic')
    frame('stop')
    sink.drain(); sink.drain()
    assert result(sink) == ('FAILED', 'GAIT_CANCELLED')


def test_malformed_gait_frame_is_ignored():
    _, sink, _, _, session, _, _, frame = rig(0)
    gait(frame, 'free_walk')
    gait(frame, 'classic', request_id='')
    assert sink.gait_result is None
    assert 'gait_result' not in session._state() or session._state()['gait_result'] is None


def test_start_classic_goes_to_runner_handover_key(tmp_path, monkeypatch, runner):
    flag, (_, sink, _, _, session, _, _, frame) = start_rig(tmp_path, monkeypatch, runner.port, runner)
    gait(frame, 'classic')
    assert result(sink) == ('RUNNING', 'RUNNER_SENT')
    runner.serve(key_result='STARTED')
    sink.drain()
    assert runner.keys[-1]['key'] == 'START+RIGHT' and runner.keys[-1]['action'] == 'ClassicWalk'
    assert result(sink) == ('RUNNING', 'RUNNER_STARTED')
    # 실행기가 순정으로 넘기면 표시 파일이 사라진다: 그때 끝
    flag.unlink()
    state = session._state()
    assert state['control'] == 'FACTORY'
    assert (state['gait_result']['status'], state['gait_result']['code']) == ('SUCCEEDED', 'OK')


@pytest.mark.parametrize('reason,code', [('not_stopped', 'GAIT_MOVING'), ('remote', 'GAIT_BUSY'),
                                         ('busy', 'GAIT_BUSY'), ('phase', 'GAIT_NOT_STANDING')])
def test_start_runner_refusal_maps_to_gait_code(tmp_path, monkeypatch, runner, reason, code):
    _, (_, sink, _, _, _, _, _, frame) = start_rig(tmp_path, monkeypatch, runner.port, runner)
    gait(frame, 'classic')
    runner.serve(key_result='IGNORED', reason=reason)
    sink.drain()
    assert result(sink) == ('REJECTED', code)


def test_start_reports_current_mode_and_rejects_what_has_no_path(tmp_path, monkeypatch, runner):
    _, (_, sink, _, _, session, _, _, frame) = start_rig(tmp_path, monkeypatch, runner.port, runner)
    sink.drain(); runner.serve(phase='policy'); sink.drain()
    assert session._state()['gait'] == dict(gait='start', available=['classic', 'start'])
    gait(frame, 'start', request_id='s')
    assert result(sink) == ('SUCCEEDED', 'OK')
    # START -> 순정 기본 (sport) 은 실행기 키가 아직 없다 (C++ 남은 일)
    gait(frame, 'sport', request_id='p')
    assert result(sink) == ('REJECTED', 'GAIT_UNSUPPORTED')
    gait(frame, 'ame2', request_id='a')
    assert result(sink) == ('REJECTED', 'GAIT_NOT_READY')
    assert not runner.keys


def test_start_without_runner_port_is_unsupported(tmp_path, monkeypatch):
    _, (_, sink, _, _, _, _, _, frame) = start_rig(tmp_path, monkeypatch)
    gait(frame, 'classic')
    assert result(sink) == ('REJECTED', 'GAIT_UNSUPPORTED')


def test_simulation_session_rejects_honestly():
    # gazebo ros_bridge · mujoco_bridge 는 기본 Session 을 쓴다: 바꿀 길이 없으니 GAIT_UNSUPPORTED.
    session = Session()
    session.connect()
    session.receive({'t': 'lease', 'lease_id': 'L', 'holder_type': 'USER'})
    session.receive({'t': 'gait', 'request_id': 'g', 'lease_id': 'L', 'gait': 'classic'})
    state = session._state()
    assert state['gait'] == dict(gait=None, available=[])
    assert state['gait_result'] == dict(request_id='g', gait='classic', status='REJECTED',
                                        code='GAIT_UNSUPPORTED', sdk_code=None)
    session.receive({'t': 'gait', 'request_id': 'h', 'lease_id': 'other', 'gait': 'sport'})
    assert session._state()['gait_result']['code'] == 'GAIT_LEASE_LOST'


@pytest.mark.parametrize('route', ['factory', 'start', 'sim'])
def test_gait_result_request_id_is_the_screen_message_id(tmp_path, monkeypatch, runner, route):
    # 웹은 gait_result 를 자기가 보낸 ScreenGait.id 로 짝짓는다 (#545 검수 G3). 서버가 AgentGait.request_id = msg.id
    # 로 넘기고 (서버 시험 test_owner_gait_relays...), 에이전트는 그 값을 그대로 결과에 쓴다.
    screen_id = 'c0ffee00-0000-4000-8000-00000000abcd'
    body = {'t': 'gait', 'request_id': screen_id, 'lease_id': 'fake-lease', 'gait': 'classic'}
    if route == 'sim':
        session = Session()
        session.connect()
        session.receive({'t': 'lease', 'lease_id': 'fake-lease', 'holder_type': 'USER'})
        session.receive(body)
        assert session._state()['gait_result']['request_id'] == screen_id
        return
    if route == 'factory':
        _, sink, normal, _, session, _, _, frame = rig(0)
        normal.ClassicWalk = lambda value: 0
    else:
        _, (_, sink, _, _, session, _, _, frame) = start_rig(tmp_path, monkeypatch, runner.port, runner)
    frame(**body)
    sink.drain(); sink.drain()
    assert session._state()['gait_result']['request_id'] == screen_id
    if route == 'start':
        assert runner.serve() and runner.keys[-1]['request_id'] == screen_id


# ---- 검수 #550 R1 · R3 (80f94ffe) ----

@pytest.mark.parametrize('name', ['classic', 'sport', 'start', 'ame2'])
def test_factory_latched_after_stop_rejects_with_no_sdk_call(name):
    # R1: STOP 으로 잠근 뒤에는 무엇도 시작하지 않는다 (SF-02: 잠금 해제는 조종권자 버튼으로만).
    _, sink, normal, _, session, _, _, frame = rig(0)
    normal.ClassicWalk = lambda value: pytest.fail('must not invoke while latched')
    frame('stop')
    assert session.core.latch
    gait(frame, name)
    sink.drain(); sink.drain()
    assert result(sink) == ('REJECTED', 'GAIT_LATCHED')
    assert ('ClassicWalk', (True,)) not in normal.calls and ('ClassicWalk', (False,)) not in normal.calls


@pytest.mark.parametrize('name', ['classic', 'start'])
def test_start_latched_after_stop_sends_no_key(tmp_path, monkeypatch, runner, name):
    # R1: 넘김 키 (앉기 · 모드 선택 · 다시 서기) 는 잠김에서 나가면 안 된다.
    _, (_, sink, _, _, session, _, _, frame) = start_rig(tmp_path, monkeypatch, runner.port, runner)
    frame('stop')
    assert session.core.latch
    gait(frame, name)
    runner.serve(wait=False); sink.drain()
    assert result(sink) == ('REJECTED', 'GAIT_LATCHED')
    assert not runner.keys


def test_start_lease_mismatch_sends_no_key(tmp_path, monkeypatch, runner):
    # R3 A2: 실행기 길에서는 이것이 에이전트의 유일한 lease 벽이다.
    _, (_, sink, _, _, _, _, _, frame) = start_rig(tmp_path, monkeypatch, runner.port, runner)
    gait(frame, 'classic', lease_id='other-lease')
    runner.serve(wait=False); sink.drain()
    assert result(sink) == ('REJECTED', 'GAIT_LEASE_LOST')
    assert not runner.keys


def test_start_busy_action_sends_no_key(tmp_path, monkeypatch, runner):
    # R3 A5: 다른 동작 · 자세가 도는 중이면 넘김 키를 보내지 않는다.
    _, (_, sink, _, _, _, _, _, frame) = start_rig(tmp_path, monkeypatch, runner.port, runner)
    sink.actions.inflight = True
    gait(frame, 'classic')
    runner.serve(wait=False); sink.drain()
    assert result(sink) == ('REJECTED', 'GAIT_BUSY')
    assert not runner.keys


def test_start_handover_times_out_after_20_s(tmp_path, monkeypatch, runner):
    # R3 A8: 표시 파일이 안 사라지면 20 초 뒤 GAIT_TIMEOUT (끝없이 RUNNING 으로 두지 않는다).
    _, (clock, sink, _, _, _, _, _, frame) = start_rig(tmp_path, monkeypatch, runner.port, runner)
    gait(frame, 'classic')
    runner.serve(key_result='STARTED'); sink.drain()
    assert result(sink) == ('RUNNING', 'RUNNER_STARTED')
    clock.value += 19.9
    assert result(sink) == ('RUNNING', 'RUNNER_STARTED')
    clock.value += .2
    assert result(sink) == ('FAILED', 'GAIT_TIMEOUT')


def test_start_ack_for_other_request_is_ignored(tmp_path, monkeypatch, runner):
    # R3 A9: 다른 request_id 의 회신으로 결과를 바꾸지 않는다.
    _, (_, sink, _, _, _, _, _, frame) = start_rig(tmp_path, monkeypatch, runner.port, runner)
    gait(frame, 'classic')
    sink.gait.runner_ack(dict(request_id='other', result='IGNORED', reason='not_stopped', phase='policy'))
    sink.gait.runner_ack(dict(request_id='other', result='STARTED', reason=None, phase='policy'))
    assert result(sink) == ('RUNNING', 'RUNNER_SENT')


def test_start_flag_gone_without_started_ack_is_not_ok(tmp_path, monkeypatch, runner):
    # R3 A7: 실행기가 키를 받았다고 답하기 전에는 표시 파일이 사라져도 성공이라 하지 않는다.
    flag, (_, sink, _, _, _, _, _, frame) = start_rig(tmp_path, monkeypatch, runner.port, runner)
    gait(frame, 'classic')
    flag.unlink()
    assert result(sink) == ('RUNNING', 'RUNNER_SENT')


def test_start_mode_outside_policy_is_busy_not_ok(tmp_path, monkeypatch, runner):
    # R3 A13: 정책이 아직 안 돌면 start 를 이미 그 모드라고 하지 않는다.
    _, (_, sink, _, _, session, _, _, frame) = start_rig(tmp_path, monkeypatch, runner.port, runner)
    sink.drain(); runner.serve(phase='standing_up'); sink.drain()
    gait(frame, 'start')
    assert result(sink) == ('REJECTED', 'GAIT_BUSY')


def test_factory_job_holds_core_stopped():
    # R3 A4 · A12: 순정 일감이 잡히면 Core 를 정지로 묶고, 그 정지 세대를 일감에 적는다 (동작 요청과 같음).
    _, sink, normal, _, session, _, _, frame = rig(0)
    normal.ClassicWalk = lambda value: 0
    gait(frame, 'classic')
    assert session.core.latch
    assert sink.actions.job['hold_stop_generation'] == session.core.stop_gen
    frame('cmd', lease_id='fake-lease', seq=99, axes=[1.5, 0, 0])
    assert session.core.out == (0., 0., 0.)


def test_factory_overwritten_job_result_is_cancelled_not_ok():
    # R3 A11: 일감 결과를 다른 요청이 덮었으면 모름 -> GAIT_CANCELLED (OK 라고 하지 않는다).
    _, sink, normal, _, _, _, _, frame = rig(0)
    gait(frame, 'classic')
    sink.actions.job = None
    sink.actions.report('other', 'Hello', 'SUCCEEDED', 'SDK_ACCEPTED', 0)
    assert result(sink) == ('FAILED', 'GAIT_CANCELLED')
