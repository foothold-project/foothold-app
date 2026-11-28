"""START 실행기 앱 입력 길 (runner_cpp/APP-MOVES.md): 가짜 실행기 소켓 · 가짜 SDK 만. 로봇 · DDS 없음."""
import json
import socket

import pytest

from foothold_agent.go2_direct.actions import ACTIONS, LOWLEVEL
from foothold_agent.go2_direct.feedback import Feedback
from foothold_agent.go2_direct.server import DriveSession, ServerSink
from foothold_agent.go2_direct.sink import Go2Sink, ZERO
from foothold_agent.link.client import Client, Settings
from test_go2_direct import Clock, FakeSport
from test_go2_feedback import low
from test_go2_actions import send, start_rig


class FakeRunner:
    """C++ 실행기 응답 흉내: 받은 묶음마다 {seq, result, phase, remote} 를 보낸 쪽 포트로."""
    def __init__(self):
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.sock.bind(('127.0.0.1', 0))
        self.sock.settimeout(.5)
        self.port = self.sock.getsockname()[1]
        self.velocities, self.keys, self.stops = [], [], []

    def serve(self, *, phase='policy', key_result='STARTED', reason=None, reply=True, wait=True):
        got = []
        self.sock.settimeout(.5 if wait else 0.)
        try:
            while True:
                raw, peer = self.sock.recvfrom(1024)
                got.append((json.loads(raw), peer))
                self.sock.settimeout(0.)
        except (socket.timeout, BlockingIOError):
            pass
        for msg, peer in got:
            if 'key' in msg:
                self.keys.append(msg)
                ack = dict(seq=msg['seq'], result=key_result, request_id=msg['request_id'], phase=phase, remote=False)
                if reason: ack['reason'] = reason
            elif 'stop' in msg:
                self.stops.append(msg['stop'])
                ack = dict(seq=msg['seq'], result='ACCEPTED', phase=phase, remote=False)
            else:
                self.velocities.append((msg['vx'], msg['vy'], msg['wz']))
                ack = dict(seq=msg['seq'], result='ACCEPTED', phase=phase, remote=False)
            if reply:
                self.sock.sendto(json.dumps(ack).encode(), peer)
        return got

    def close(self):
        self.sock.close()


@pytest.fixture
def runner():
    fake = FakeRunner()
    yield fake
    fake.close()


def guard(sport):
    for name in ACTIONS | {'Move'}:
        setattr(sport, name, lambda *a, name=name: pytest.fail(f'{name} must not reach the factory SDK during START'))


@pytest.mark.parametrize('key_result,reason,code,status', [
    ('STARTED', None, 'RUNNER_STARTED', 'SUCCEEDED'),
    ('IGNORED', 'phase', 'RUNNER_IGNORED_PHASE', 'REJECTED'),
    ('IGNORED', 'remote', 'RUNNER_IGNORED_REMOTE', 'REJECTED'),
    ('IGNORED', 'not_stopped', 'RUNNER_IGNORED_NOT_STOPPED', 'REJECTED'),
])
def test_runner_ack_turns_sent_into_started_or_ignored(tmp_path, monkeypatch, runner, key_result, reason, code, status):
    _, (_, sink, _, _, session, _, _, frame) = start_rig(tmp_path, monkeypatch, runner.port)
    send(frame, 'Sit', request_id='sit-1')
    assert sink.actions.result['code'] == 'RUNNER_SENT'
    runner.serve(key_result=key_result, reason=reason)
    sink.drain()
    assert (sink.actions.result['status'], sink.actions.result['code']) == (status, code)
    assert session._state()['action_result']['code'] == code


def test_no_ack_keeps_runner_sent_and_foreign_ack_is_ignored(tmp_path, monkeypatch, runner):
    _, (_, sink, _, _, _, _, _, frame) = start_rig(tmp_path, monkeypatch, runner.port)
    send(frame, 'Heart', request_id='h')
    runner.serve(reply=False)
    sink.drain(); sink.drain()
    assert (sink.actions.result['status'], sink.actions.result['code']) == ('SUCCEEDED', 'RUNNER_SENT')
    # 다른 요청 번호 · 보낸 적 없는 seq 의 응답은 결과를 바꾸지 않는다
    msg = runner.keys[-1]
    peer = ('127.0.0.1', sink.runner.sock.getsockname()[1])
    for ack in (dict(seq=msg['seq'], result='STARTED', request_id='other', phase='policy', remote=False),
                dict(seq=msg['seq'] + 10**12, result='STARTED', request_id='h', phase='policy', remote=False),
                dict(seq=msg['seq'], result='MAYBE', request_id='h', phase='policy', remote=False)):
        runner.sock.sendto(json.dumps(ack).encode(), peer)
    sink.drain()
    assert sink.actions.result['code'] == 'RUNNER_SENT'


def test_posture_lie_down_ack(tmp_path, monkeypatch, runner):
    _, (_, sink, _, _, _, _, _, frame) = start_rig(tmp_path, monkeypatch, runner.port)
    frame('posture', request_id='down', lease_id='fake-lease', action='stand_down')
    assert sink.posture_result['code'] == 'RUNNER_SENT'
    runner.serve(key_result='STARTED')
    sink.drain()
    assert (sink.posture_result['status'], sink.posture_result['code']) == ('SUCCEEDED', 'RUNNER_STARTED')
    assert runner.keys[-1]['key'] == LOWLEVEL['StandDown']


def start_drive_rig(tmp_path, monkeypatch, runner):
    from foothold_agent.policy import trace
    flag = tmp_path / 'foothold-start-active'
    monkeypatch.setattr(trace, 'START_FLAG', flag)
    monkeypatch.setenv('FH_START_MOVE_PORT', str(runner.port))
    now, normal, emergency = Clock(), FakeSport(), FakeSport()
    guard(normal); guard(emergency)
    sink = Go2Sink(normal, emergency, now=now, offline_test_mode=True, phone_watchdog=True)
    feedback = Feedback('1234-5678', now=now)
    feedback.sink = sink
    session = DriveSession(feedback, now=now)
    client = Client(session, ServerSink(sink, session), Settings('ws://127.0.0.1/ws', 'fake-token'))
    flag.touch()
    client._emit(session.connect())
    count = 0

    def measured(phase='policy', reply=True):
        nonlocal count
        count += 1
        sink.drain()
        runner.serve(phase=phase, reply=reply)
        sink.drain()   # 응답을 읽어 실행기 상태를 새로 한다
        feedback.lowstate(low(count))
        return feedback.consume(client)

    def frame(t, **kw):
        client._emit(session.receive({'t': t, **kw}))
    return now, sink, session, feedback, measured, frame


def test_keyboard_drive_under_start_goes_to_runner_not_factory(tmp_path, monkeypatch, runner):
    now, sink, session, feedback, measured, frame = start_drive_rig(tmp_path, monkeypatch, runner)
    assert '응답이 없어' in sink.movement_reason(neutral=True)
    sink.check_watchdog()
    assert measured()   # 실행기 policy · LowState 정지 = 서서 걷기 가능
    assert sink.movement_reason(neutral=True) is None
    assert feedback.posture_snapshot()['state'] == 'STANDING' and feedback.posture_snapshot()['walkable']
    frame('lease', lease_id='fake-lease', holder_type='USER')
    frame('unlock', lease_id='fake-lease', stop_gen=session.core.stop_gen)
    measured()
    frame('cmd', lease_id='fake-lease', seq=0, axes=[0, 0, 0])
    sink.drain()
    assert not sink.latched
    runner.velocities.clear()
    for i in range(40):   # 2 초 동안 앞으로 (서버 표 1.5 m/s · 2 초 가속)
        now.value += .05
        measured()
        frame('cmd', lease_id='fake-lease', seq=session.last_seq + 1, axes=[1.5, 0, 0])
        sink.drain()
        assert not sink.check_watchdog()
    runner.serve()
    assert max(v[0] for v in runner.velocities) > 1.4   # 순정 길과 같은 서버 가속 (2 초에 1.4625)
    assert all(v[1] == 0 and v[2] == 0 for v in runner.velocities)
    # STOP: 실행기에 정지 묶음 (순정 StopMove 없음 · guard 가 막음). cause 없는 옛 STOP 도 operator stop 이다.
    frame('stop', stop_ref=1)
    sink.drain()
    runner.serve()
    assert runner.stops == [1] and runner.velocities[-1] != ZERO   # 속도 대신 정지 묶음


def test_drive_under_start_stops_when_runner_goes_quiet_or_leaves_policy(tmp_path, monkeypatch, runner):
    now, sink, session, feedback, measured, frame = start_drive_rig(tmp_path, monkeypatch, runner)
    sink.check_watchdog()
    measured()
    frame('lease', lease_id='fake-lease', holder_type='USER')
    frame('unlock', lease_id='fake-lease', stop_gen=session.core.stop_gen)
    measured()
    frame('cmd', lease_id='fake-lease', seq=0, axes=[0, 0, 0])
    sink.drain()
    for _ in range(10):
        now.value += .05
        measured()
        frame('cmd', lease_id='fake-lease', seq=session.last_seq + 1, axes=[1.5, 0, 0])
        sink.drain()
    runner.serve(reply=False)
    assert runner.velocities[-1][0] > 0
    # 실행기 응답이 0.2 초 끊김 → 실행기 상태 없음 → 화면 조종 막힘 · 실행기에는 0
    now.value += .25
    assert not measured(reply=False)
    assert '응답이 없어' in sink.movement_reason(neutral=True)
    frame('cmd', lease_id='fake-lease', seq=session.last_seq + 1, axes=[1.5, 0, 0])
    sink.drain()
    runner.serve(reply=False)
    assert runner.velocities[-1] == ZERO
    # 실행기가 정책을 벗어남 (엎드림) → 걷기 불가 · 0
    now.value += .05
    assert not measured(phase='damping')
    assert feedback.posture_snapshot()['state'] == 'LYING' and not feedback.posture_snapshot()['walkable']
    frame('cmd', lease_id='fake-lease', seq=session.last_seq + 1, axes=[1.5, 0, 0])
    sink.drain()
    runner.serve()
    assert runner.velocities[-1] == ZERO


def test_factory_path_unchanged_without_start_flag(tmp_path, monkeypatch, runner):
    # 포트를 정해도 START 표시 파일이 없으면 순정 SportClient 길 그대로 (실행기에 아무것도 안 보냄)
    from foothold_agent.policy import trace
    monkeypatch.setattr(trace, 'START_FLAG', tmp_path / 'foothold-start-active')
    monkeypatch.setenv('FH_START_MOVE_PORT', str(runner.port))
    from test_go2_server_drive import rig, hold_for
    now, sink, normal, _, session, _, measured, frame = rig()
    actual = hold_for(now, sink, session, measured, frame, (1.5, 0., 0.))
    assert actual[0] > 1.4 and sink.client.calls[-1][0] == 'Move'
    assert runner.serve(wait=False) == []


class HeldRemote:
    """핸드셋 막대를 쥔 채 (리모컨 쓰는 중)."""
    def __init__(self, clock): self.clock = clock
    def snapshot(self, include_state=True): return (True, self.clock())
    def state_active(self): return False


def drive_forward(now, sink, session, measured, frame):
    sink.check_watchdog()
    measured()
    frame('lease', lease_id='fake-lease', holder_type='USER')
    frame('unlock', lease_id='fake-lease', stop_gen=session.core.stop_gen)
    measured()
    frame('cmd', lease_id='fake-lease', seq=0, axes=[0, 0, 0])
    sink.drain()
    for _ in range(10):
        now.value += .05
        measured()
        frame('cmd', lease_id='fake-lease', seq=session.last_seq + 1, axes=[1.5, 0, 0])
        sink.drain()


@pytest.mark.parametrize('handset', [False, True])
def test_app_stop_under_start_sends_runner_stop_over_handset_until_unlock(tmp_path, monkeypatch, runner, handset):
    # 팀장 11/28: 키보드 전진이든 조이스틱 전진이든 앱 STOP 이 먹어야 한다. 실행기는 앱 속도 0 을
    # 리모컨 막대 때문에 버리므로, 리모컨보다 먼저 받는 정지 묶음 {stop: 1} 을 보낸다 (APP-MOVES.md).
    now, sink, session, feedback, measured, frame = start_drive_rig(tmp_path, monkeypatch, runner)
    drive_forward(now, sink, session, measured, frame)
    runner.serve(reply=False)
    assert runner.velocities[-1][0] > 0 and not runner.stops
    if handset:
        sink.remote = HeldRemote(now)
    frame('stop', cause='user_stop', stop_ref=1)
    sink.check_watchdog()
    for _ in range(3):
        now.value += .05
        sink.drain()
    runner.serve()
    assert runner.stops and set(runner.stops) == {1}, '앱 STOP 은 실행기 정지 묶음으로 계속 나간다'
    # 리모컨 막대를 놓아도 풀리지 않는다 (해제는 앱 잠금 풀기만)
    sink.remote = None
    runner.stops.clear()
    for _ in range(3):
        now.value += .05
        measured()
        sink.drain()
    runner.serve()
    assert runner.stops and set(runner.stops) == {1}
    # 앱 잠금 풀기 -> 해제 묶음 {stop: 0}
    runner.stops.clear()
    frame('unlock', lease_id='fake-lease', stop_gen=session.core.stop_gen)
    measured()
    sink.drain()
    runner.serve()
    assert not sink.latched
    assert 0 in runner.stops and 1 not in runner.stops[runner.stops.index(0):]


def test_routine_stop_under_start_stays_velocity_zero_without_runner_stop(tmp_path, monkeypatch, runner):
    # 일반 정지 (화면 숨김 등) 는 지금처럼 속도 0 만. 리모컨 우선 규칙은 앱 STOP 에만 예외.
    now, sink, session, feedback, measured, frame = start_drive_rig(tmp_path, monkeypatch, runner)
    drive_forward(now, sink, session, measured, frame)
    frame('stop', cause='screen_hidden', stop_ref=1)
    sink.drain()
    runner.serve()
    assert runner.velocities[-1] == ZERO and not runner.stops
