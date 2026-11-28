"""Explicit server trial: one existing fh-agent/2 Client, Core and Go2Sink."""
import asyncio
import time
import logging

from foothold_agent.link.client import Client
from foothold_agent.link.session import Session, MotionCommand, Effects, LINK_TIMEOUT
from foothold_agent.phone.tickets import json_object
from . import sdk
from .feedback import Feedback
from .reporting import devices, project
from .sink import Go2Sink, server_velocity
from .identity import expected_serial, verify, ResumeGate


def axes(value, *, local=False):
    try:
        return server_velocity(value)
    except ValueError:
        return None


def project_velocity(vx, vy, wz):
    return server_velocity((vx, vy, wz)), ''


class DriveSession(Session):
    def __init__(self, feedback, *, identity_gate=None, **kwargs):
        self.feedback = feedback
        self.identity_gate = identity_gate
        self.posture_sink = None
        self.posture_gate = lambda: True
        self.run_result = None
        super().__init__(identity={'robot_model': 'unitree_go2'},
                         axes_validator=axes, velocity_projection=project_velocity, **kwargs)

    def disconnect(self):
        # Socket close is an immediate local STOP, independent of link grace.
        return self.shutdown()

    def connect(self):
        self.core.st = None  # no old measurement can acknowledge this STOP epoch
        return super().connect()

    def shutdown(self):
        if self.posture_sink is not None:
            self.posture_sink.cancel_posture('DISCONNECTED')
        self.lease_confirmed = False
        return super().shutdown()

    def posture_authorized(self, lease):
        return (self.connected and not self.link_lost and not self.reconnect_required
                and self.last_server is not None and 0 <= self.now()-self.last_server < LINK_TIMEOUT
                and self.lease_confirmed and self.holder_type == 'USER'
                and self.lease_id == lease and self.posture_gate())

    def feedback_lost(self, *, cause='feedback_lost'):
        # Keep the transport reporting the lock; recovery still needs a fresh
        # physical stop, explicit unlock and new neutral on the retained lease.
        self.core.st = None
        self.core.stop('local feedback unavailable', cause=cause)
        return self._finish((MotionCommand('stop'),), state=True)

    def transport_closed(self, close_code, *, retry):
        self.core.stop('server transport closed')
        self.lease_confirmed = False
        effects = super().transport_closed(close_code, retry=retry)
        return Effects((MotionCommand('stop'),) + effects.motion, effects.messages)

    def receive(self, raw):
        try:
            frame = json_object(raw) if isinstance(raw, (str, bytes)) else raw
        except (ValueError, TypeError, UnicodeError, RecursionError):
            return self.tick()
        if isinstance(frame, dict) and frame.get('t') == 'slam' and getattr(self, 'mapping', None) is not None:
            self.mapping.command(frame)
            return Effects((), self.tick().messages)
        if isinstance(frame, dict):
            if frame.get('t') == 'action' and self.posture_sink is not None:
                super().receive({'t': 'ping'})
                trial_blocked = self.posture_sink.movement_trial_blocked(frame.get('action'))
                if self.posture_sink.actions.request(frame.get('request_id'), frame.get('action'),
                        frame.get('params', {}), frame.get('lease_id'), frame.get('confirmed', False),
                        moving=trial_blocked or self.core.intent != (0., 0., 0.) or self.core.out != (0., 0., 0.)):
                    self.core.stop('action requested')
                    self.posture_sink.actions.core_hold(self.core.stop_gen)
                return self._finish(state=True)
            if frame.get('t') == 'posture' and self.posture_sink is not None:
                super().receive({'t': 'ping'})
                action, request_id = frame.get('action'), frame.get('request_id')
                if action not in ('stand_up', 'stand_down') or not isinstance(request_id, str) or not 1 <= len(request_id) <= 128:
                    return self.tick()
                if self.core.intent != (0., 0., 0.) or self.core.out != (0., 0., 0.):
                    self.posture_sink.posture_result = dict(request_id=request_id, action=action,
                        status='REJECTED', code='MOVING', sdk_code=None)
                elif self.posture_sink.request_posture(request_id, action, frame.get('lease_id')):
                    self.core.stop('posture requested')
                return self._finish(state=True)
            if frame.get('t') in ('run.start', 'run.control'):
                # No scenario executor on this trial path: say so, never move.
                request_id = frame.get('request_id')
                if isinstance(request_id, str) and 1 <= len(request_id) <= 128 and isinstance(frame.get('run_id'), str):
                    op = 'start' if frame['t'] == 'run.start' else frame.get('op')
                    self.run_result = dict(request_id=request_id, op=op if op in ('pause', 'resume', 'abort') else 'start',
                                           run_id=frame['run_id'], status='REJECTED', code='RUN_UNSUPPORTED')
                return self._finish(state=True)
            if frame.get('t') == 'unlock' and self.posture_sink is not None and self.posture_sink.posture_busy:
                return self.tick()
            if frame.get('t') == 'unlock' and self.identity_gate is not None:
                self.identity_gate.request(frame, self)
                return self.tick()
            if frame.get('t') == 'cmd' and axes(frame.get('axes')) is None:
                self.core.st = None
                self.core.stop('outside server-drive command table')
                return self._finish((MotionCommand('stop'),), state=True)
            if frame.get('t') == 'stop':
                if self.posture_sink is not None:
                    self.posture_sink.cancel_posture()
                self.core.st = None
            if frame.get('t') == 'lease' and frame.get('lease_id') != self.lease_id and self.posture_sink is not None:
                self.posture_sink.cancel_posture('LEASE_CHANGED')
            if frame.get('t') == 'lease' and frame.get('holder_type') not in (None, 'USER'):
                return self.shutdown()
            if frame.get('t') not in ('lease', 'cmd', 'stop', 'unlock', 'ping'):
                return self.tick()
        return super().receive(frame)

    def _command_input(self, axes):
        # Posture can project a deflection to zero only after the input gate
        # has checked the original, authorized joystick sample for neutral.
        if self.posture_sink is not None and (
                not self.feedback.posture_snapshot()['walkable'] or self.posture_sink.posture_busy):
            axes = (0., 0., 0.)
        super()._command_input(axes)

    def unlock_verified(self, frame):
        return super().receive(frame)

    def _state(self):
        result = {**super()._state(), **project(self.feedback.telemetry(), self.now())}
        posture = self.feedback.posture_snapshot()
        result['posture'] = {key: posture[key] for key in ('state', 'mode')}
        if self.posture_sink is not None:
            result['response_health'] = self.posture_sink.response_health()
        result['posture_result'] = None if self.posture_sink is None else self.posture_sink.posture_result
        result['action_result'] = None if self.posture_sink is None else self.posture_sink.actions.result
        result['run_result'] = self.run_result
        if self.posture_sink is not None:
            from .sink import start_active
            result['control'] = 'LOWLEVEL' if start_active() else 'FACTORY'
        # A zero request is not a measured stop. Arbiter grants wait for DDS.
        if not (self.core.st and self.core.st.get('stop_requested') is True
                and self.feedback.sample() is not None):
            result['stop_ref'] = 0
        return result


class ServerSink:
    def __init__(self, sink, session):
        self.sink, self.session = sink, session
        sink.select_source('server')
        session.movement_gate = sink.movement_reason
        session.automatic_stop_gate = lambda: sink.automatic_stop_allowed(session)
        sink.automatic_stop_allowed(session)
        if session.operator_stop:
            sink.apply(MotionCommand('stop'), source='server', operator_stop=True)
        session.posture_sink = sink
        sink.posture_feedback = session.feedback.posture_snapshot
        sink.posture_authorized = self.posture_authorized

    def posture_authorized(self, lease):
        # The action worker rechecks this after SDK method lookup and on every
        # poll. A queued trial cannot outlive a handset takeover.
        job = self.sink.actions.job or self.sink.actions.executing
        return (self.session.posture_authorized(lease)
                and not (job and self.sink.movement_trial_blocked(job['action'])))

    def apply(self, command):
        # Tick/telemetry output cannot refresh the original operator input clock.
        self.sink.apply(command, source='server', input_received_at=self.session.core.intent_t,
                        operator_stop=self.session.operator_stop)

    def output_safety(self):
        return self.sink.output_safety()


async def run(config, env, *, stop=None, startup_timeout=5., channel_factory=None,
              connect_factory=None, client_factory=Client, media_factory=None, identity_check=None):
    stop = stop or asyncio.Event()
    codes = getattr(config.approval, 'accept_error_codes', frozenset())
    feedback = Feedback(expected_serial(config.approval), accept_error_codes=codes)
    if codes:
        labels = ', '.join('100(Agile)' if code == 100 else str(code) for code in sorted(codes))
        logging.getLogger(__name__).warning('서버 시험 운동 상태 허용: %s', labels)
    gate = None
    identity_check = identity_check or verify
    channel = sink = client = None
    media_task = None
    mapping_task = None
    tasks = []
    deadline = time.monotonic()+max(0, config.approval.expires_at-time.time())
    try:
        channel = (channel_factory or sdk.open_channel)(env)
        channel.subscribe(feedback)
        until = min(time.monotonic()+startup_timeout, deadline)
        while feedback.sample() is None:
            if feedback.fault:
                raise PermissionError('robot identity conflict')
            if stop.is_set():
                return
            if time.monotonic() >= until:
                raise TimeoutError('fresh matching telemetry required')
            await asyncio.sleep(.02)
        if getattr(config.approval, 'serial_unavailable', False):
            await asyncio.to_thread(identity_check, config.approval, feedback.serial)
        clients = (connect_factory or sdk.connect)(env, observed_serial=feedback.serial, channel=channel)
        sink = Go2Sink(*clients, phone_watchdog=True)
        sink.posture_feedback = feedback.posture_snapshot
        feedback.sink = sink
        if getattr(config.approval, 'serial_unavailable', False):
            gate = ResumeGate(config.approval, feedback, check=identity_check)
        session = DriveSession(feedback, identity_gate=gate)
        client = client_factory(session, ServerSink(sink, session), config.link)
        from foothold_agent.mapping.runtime import attach
        mapping_task = attach(session, channel, config.link, getattr(config, 'robot', None), env)
        sink.start_threads()
        tasks = [asyncio.create_task(client.run()), asyncio.create_task(stop.wait())]
        # Observations own independent SDK workers and sockets. Their failure is
        # intentionally excluded from the control lifetime/health task set.
        if media_factory is not None:
            try:
                media = media_factory(config, env, channel)
                media_task = asyncio.create_task(media.run())
            except Exception:
                pass
        healthy = False
        while not any(task.done() for task in tasks):
            if feedback.fault or time.monotonic() >= deadline:
                cause = 'feedback_identity_conflict' if feedback.fault else 'approval_expired'
                session.core.lock_log.emit('stop', cause)
                session.core.lock_log.emit('lock', cause)
                raise PermissionError('identity conflict or approval expired')
            if sink.error is not None:
                raise RuntimeError('Go2 output failed') from sink.error
            ready = feedback.consume(client)
            if gate is not None:
                gate.poll(client)
            if healthy and not feedback.healthy():
                client._emit(session.feedback_lost())
            healthy = feedback.healthy()
            session.update_devices(devices(feedback.telemetry(), session.now()))
            await asyncio.sleep(.02)
        for task in tasks:
            if task.done():
                task.result()
    finally:
        # STOP is submitted before any network cancellation/close can await.
        try:
            if client is not None:
                client.sink.apply(MotionCommand('stop'))
        finally:
            if gate is not None:
                gate.close()
            for task in tasks:
                task.cancel()
            if media_task is not None:
                media_task.cancel()
            if mapping_task is not None:
                mapping_task.cancel()
            try:
                await asyncio.gather(*tasks, return_exceptions=True)
                if media_task is not None:
                    await asyncio.gather(media_task, return_exceptions=True)
                if mapping_task is not None:
                    await asyncio.gather(mapping_task, return_exceptions=True)
            finally:
                try:
                    if sink is not None:
                        sink.close()
                finally:
                    if channel is not None:
                        channel.close()
