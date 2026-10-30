"""Existing state schema, optional cloud link and strictly phone-owned outputs."""
import asyncio
import json
import time
import threading
from types import SimpleNamespace as NS

from foothold_agent.go2_direct.feedback import Feedback
from foothold_agent.go2_direct.reporting import ReadOnlyObserver, Reporting, project, devices
from foothold_agent.link.client import Settings
from test_go2_feedback import low, sport
from test_go2_feedback import CallbackGate
from test_phone import Harness
from test_go2_runtime import free_port


def populated(now, wall):
    feedback = Feedback('1234-5678', now=now, wall=wall)
    feedback.lowstate(low())
    feedback.sportmodestate(sport(velocity=(.3, .4, 0.)))
    return feedback


def test_existing_agent_state_schema_accepts_physical_measurements_and_unknown_pose():
    from apps.contracts.models import AgentState
    h = Harness(simulation=False)
    try:
        feedback = populated(h.clock, h.clock.wall)
        observer = ReadOnlyObserver(h.hub, feedback)
        h.hub.session.update_devices(devices(feedback.telemetry(), h.clock()))
        frame = observer._state()
        AgentState.model_validate(frame)
        assert frame['speed'] == .5 and frame['battery'] == {'soc': 75, 'voltage': 28.}
        assert all(value is None for value in frame['pose'].values())
        h.clock.t += 1.001
        stale = observer._state()
        AgentState.model_validate(stale)
        assert stale['speed'] is None and stale['battery']['soc'] is None
        assert all(d['state'] == 'MISSING' for d in stale['devices_changed'])
    finally:
        h.hub.close()
        h.verifier.close()


def test_server_motion_stop_and_run_frames_cannot_touch_phone_core_or_sink():
    h = Harness(simulation=False)
    try:
        h.moving()
        feedback = populated(h.clock, h.clock.wall)
        observer = ReadOnlyObserver(h.hub, feedback)
        observer.connect()
        before = (h.hub.session.lease_id, h.hub.session.core.stop_gen,
                  h.hub.session.core.intent, list(h.outputs))
        for kind in ('stop', 'lease', 'cmd', 'unlock', 'reset', 'run.start', 'run.control', 'run.recorded'):
            observer.receive({'t': kind, 'lease_id': 'remote', 'stop_gen': 999,
                              'axes': [1, 0, 0], 'stop_ref': 10})
        observer.receive('malformed')
        assert before == (h.hub.session.lease_id, h.hub.session.core.stop_gen,
                          h.hub.session.core.intent, h.outputs)
        assert not h.hub.session.core.latch
        assert observer.core is h.hub.session.core
    finally:
        h.hub.close()
        h.verifier.close()


def test_errors_and_tilt_use_existing_device_states_without_numeric_label_hacks():
    h = Harness(simulation=False)
    try:
        feedback = populated(h.clock, h.clock.wall)
        tilted = low(2)
        tilted.imu_state.rpy = [1.2, 0., 0.]
        feedback.lowstate(tilted)
        feedback.sportmodestate(sport(2, error_code=123))
        states = devices(feedback.telemetry(), h.clock())
        assert [d['state'] for d in states] == ['OK', 'ERROR', 'ERROR']
        assert all('123' not in d['label'] for d in states)
        feedback.lowstate(low(3, sn=(9999, 9999)))
        assert project(feedback.telemetry(), h.clock())['battery']['soc'] is None
    finally:
        h.hub.close()
        h.verifier.close()


def test_phone_display_keeps_callback_entry_age_after_a_short_cache_lock_wait():
    h = Harness(simulation=False)
    try:
        feedback = populated(h.clock, h.clock.wall)
        gate = CallbackGate()
        feedback._lock = gate
        errors = []
        def callback():
            try:
                feedback.lowstate(low(2))
            except BaseException as error:
                errors.append(error)
        worker = threading.Thread(target=callback, name='delayed-dds')
        worker.start()
        try:
            assert gate.waiting.wait(1)
            h.clock.t += .15
        finally:
            gate.release.set()
            worker.join(2)
        assert not worker.is_alive() and not errors
        snapshot = feedback.telemetry()
        assert snapshot['sources']['lowstate']['age_s'] == .15
        original = devices(snapshot, h.clock())[0]['received_monotonic_s']
        assert original == 0.
    finally:
        h.hub.close()
        h.verifier.close()


def test_real_client_bearer_hello_state_while_remote_stop_is_ignored():
    from websockets.asyncio.server import serve
    from apps.contracts.models import AgentHello, AgentState
    h = Harness(simulation=False)
    async def scenario():
        h.moving()
        feedback = populated(h.clock, h.clock.wall)
        received = []
        done = asyncio.Event()
        async def cloud(ws):
            assert ws.request.headers['Authorization'] == 'Bearer fake-registration-token'
            hello = json.loads(await ws.recv())
            AgentHello.model_validate(hello)
            assert hello['robot_model'] == 'unitree_go2'
            await ws.send(json.dumps({'t': 'stop', 'stop_ref': 99}))
            while True:
                raw = json.loads(await ws.recv())
                if raw['t'] == 'state':
                    AgentState.model_validate(raw)
                    received.append(raw)
                    if raw['battery']['soc'] == 75:
                        done.set()
                        return
        port = free_port()
        async with serve(cloud, '127.0.0.1', port):
            report = Reporting(h.hub, feedback, Settings(f'ws://127.0.0.1:{port}/agent',
                                                       'fake-registration-token'))
            before = h.hub.session.core.stop_gen
            task = asyncio.create_task(report.run())
            try:
                await asyncio.wait_for(done.wait(), 3)
                assert received[-1]['speed'] == .5
                assert h.hub.session.core.stop_gen == before and not h.hub.session.core.latch
            finally:
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
    try:
        asyncio.run(scenario())
    finally:
        h.hub.close()
        h.verifier.close()
