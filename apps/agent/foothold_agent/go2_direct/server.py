"""Explicit server trial: one existing fh-agent/2 Client, Core and Go2Sink."""
import asyncio
import time

from foothold_agent.link.client import Client
from foothold_agent.link.session import Session, MotionCommand, Effects
from foothold_agent.phone.tickets import json_object
from . import sdk
from .feedback import Feedback
from .reporting import devices, project
from .sink import Go2Sink, server_velocity


def axes(value, *, local=False):
    try:
        return server_velocity(value)
    except ValueError:
        return None


def project_velocity(vx, vy, wz):
    return server_velocity((vx, vy, wz)), ''


class DriveSession(Session):
    def __init__(self, feedback, **kwargs):
        self.feedback = feedback
        super().__init__(identity={'robot_model': 'unitree_go2'},
                         axes_validator=axes, velocity_projection=project_velocity, **kwargs)

    def disconnect(self):
        # Socket close is an immediate local STOP, independent of link grace.
        return self.shutdown()

    def connect(self):
        self.core.st = None  # no old measurement can acknowledge this STOP epoch
        return super().connect()

    def shutdown(self):
        self.lease_confirmed = False
        return super().shutdown()

    def feedback_lost(self):
        # Keep the transport reporting the lock; recovery still needs a fresh
        # physical stop, explicit unlock and new neutral on the retained lease.
        self.core.st = None
        self.core.stop('local feedback unavailable')
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
        if isinstance(frame, dict):
            if frame.get('t') == 'cmd' and axes(frame.get('axes')) is None:
                self.core.st = None
                self.core.stop('outside server-drive command table')
                return self._finish((MotionCommand('stop'),), state=True)
            if frame.get('t') == 'stop':
                self.core.st = None
            if frame.get('t') == 'lease' and frame.get('holder_type') not in (None, 'USER'):
                return self.shutdown()
            if frame.get('t') not in ('lease', 'cmd', 'stop', 'unlock', 'ping'):
                return self.tick()
        return super().receive(frame)

    def _state(self):
        result = {**super()._state(), **project(self.feedback.telemetry(), self.now())}
        # A zero request is not a measured stop. Arbiter grants wait for DDS.
        if not (self.core.st and self.core.st.get('stop_requested') is True
                and self.feedback.sample() is not None):
            result['stop_ref'] = 0
        return result


class ServerSink:
    def __init__(self, sink, session):
        self.sink, self.session = sink, session
        sink.select_source('server')

    def apply(self, command):
        # Tick/telemetry output cannot refresh the original operator input clock.
        self.sink.apply(command, source='server', input_received_at=self.session.core.intent_t)

    def output_safety(self):
        return self.sink.output_safety()


async def run(config, env, *, stop=None, startup_timeout=5., channel_factory=None,
              connect_factory=None, client_factory=Client, media_factory=None):
    stop = stop or asyncio.Event()
    feedback = Feedback(config.approval.robot_serial)
    channel = sink = client = None
    media_task = None
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
        clients = (connect_factory or sdk.connect)(env, observed_serial=feedback.serial, channel=channel)
        sink = Go2Sink(*clients, phone_watchdog=True)
        feedback.sink = sink
        session = DriveSession(feedback)
        client = client_factory(session, ServerSink(sink, session), config.link)
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
                raise PermissionError('identity conflict or approval expired')
            if sink.error is not None:
                raise RuntimeError('Go2 output failed') from sink.error
            ready = feedback.consume(client)
            if healthy and not ready:
                client._emit(session.feedback_lost())
            healthy = ready
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
            for task in tasks:
                task.cancel()
            if media_task is not None:
                media_task.cancel()
            try:
                await asyncio.gather(*tasks, return_exceptions=True)
                if media_task is not None:
                    await asyncio.gather(media_task, return_exceptions=True)
            finally:
                try:
                    if sink is not None:
                        sink.close()
                finally:
                    if channel is not None:
                        channel.close()
