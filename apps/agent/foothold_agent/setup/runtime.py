"""One readonly DDS subscription pair and WS; motion objects exist only in approval epochs."""
import asyncio
import os
import threading
import time

from foothold_agent.go2_direct.approval import Approval, SERVER_CLOCK_SKEW_S, validate_value
from foothold_agent.go2_direct.media import approved_publisher
from foothold_agent.go2_direct.record import Recorder
from foothold_agent.go2_direct.feedback import Feedback
from foothold_agent.go2_direct.readonly import Measurements
from foothold_agent.go2_direct.reporting import devices
from foothold_agent.go2_direct.sdk import connect_approved
from foothold_agent.go2_direct.server import DriveSession, ServerSink
from foothold_agent.go2_direct.sink import Go2Sink
from foothold_agent.go2_readonly.state import integer
from foothold_agent.link.client import Client
from foothold_agent.link.session import MotionCommand
from foothold_agent.phone.tickets import json_object
from .pairing import timestamp
from .storage import valid_serial


class SerialUnavailable(PermissionError):
    pass


class Inputs(Measurements):
    """Read-only discovery plus independent, strict motion feedback when identified."""
    def __init__(self):
        super().__init__()
        self.identity_lock = threading.Lock()
        self.serial = None
        self.conflict = False
        self.feedback = None
        self.serial_received = float('-inf')

    def lowstate(self, message):
        sn = getattr(message, 'sn', None)
        if isinstance(sn, (tuple, list)) and len(sn) == 2 and all(integer(x, 0xFFFFFFFF) for x in sn):
            serial = f'{sn[0]}-{sn[1]}'
            with self.identity_lock:
                if self.serial is not None and self.serial != serial:
                    self.conflict = True
                self.serial = serial
                self.serial_received = time.monotonic()
        super().lowstate(message)
        if self.feedback is not None:
            self.feedback.lowstate(message)

    def sportmodestate(self, message):
        super().sportmodestate(message)
        if self.feedback is not None:
            self.feedback.sportmodestate(message)

    def identity(self):
        with self.identity_lock:
            if self.serial == '0-0':
                raise SerialUnavailable('manual procedure required')
            if self.conflict or not valid_serial(self.serial) or time.monotonic()-self.serial_received > .20:
                raise PermissionError('fresh unambiguous nonzero DDS serial required')
            return self.serial


class GatedSession(DriveSession):
    def __init__(self, feedback, gate):
        self.gate = gate
        super().__init__(feedback)
        gate.session = self

    def receive(self, raw):
        try:
            frame = json_object(raw) if isinstance(raw, (str, bytes)) else raw
        except (ValueError, TypeError, UnicodeError, RecursionError):
            return self.tick()
        if isinstance(frame, dict) and frame.get('t') == 'field_approval':
            self.gate.approve(frame.get('expires_at'))
            return self.tick()
        if not self.gate.allowed():
            return super().receive(frame) if isinstance(frame, dict) and frame.get('t') == 'ping' else self.tick()
        return super().receive(frame)

    def disconnect(self):
        self.gate.revoke()
        return super().disconnect()

    def transport_closed(self, close_code, *, retry):
        self.gate.revoke()
        return super().transport_closed(close_code, retry=retry)

    def shutdown(self):
        self.gate.revoke()
        return super().shutdown()

    def _state(self):
        value = super()._state()
        if self.gate.active is None:
            value['stop_ref'] = 0
        return value


class Gate:
    def __init__(self, nic, serial, inputs, *, ready, nic_matches, wall=time.time, now=time.monotonic, last_expiry=None, remember=None):
        self.nic, self.serial, self.inputs = nic, serial, inputs
        self.ready, self.nic_matches = ready, nic_matches
        self.wall, self.now = wall, now
        self.active = self.pending = self.session = None
        self.last_expiry = float('-inf') if last_expiry is None else last_expiry
        self.remember = remember
        self.deadline = float('-inf')
        self.epoch = 0

    def approve(self, expiry):
        try:
            expiry = timestamp(expiry)
            # Duplicate delivery is harmless; it cannot extend a monotonic epoch.
            if expiry == self.last_expiry:
                return
            if expiry < self.last_expiry or self.session is None or not self.session.connected:
                raise PermissionError('fresh approval on connected transport required')
            approval = validate_value(dict(v=1, purpose='go2-field-motion', nic=self.nic.name,
                                          robot_serial=self.serial, expires_at=expiry), self.nic.name,
                                      now=self.wall(), clock_skew_s=SERVER_CLOCK_SKEW_S)
            if not self.ready or not self.nic_matches() or self.inputs.identity() != self.serial:
                raise PermissionError('preflight and current identity required')
        except (ValueError, TypeError, PermissionError, OverflowError):
            self.revoke()
            return
        if self.active is not None and self.valid():
            # A fresh bounded marker on this same healthy connection renews
            # only the deadline. NIC/serial/preflight, feedback and transport
            # checks above still apply; no lease or unlock is created here.
            if self.remember is not None:
                self.remember(expiry)
            self.last_expiry = expiry
            self.deadline = self.now()+max(0., expiry-self.wall())
            return
        self.revoke()
        self.last_expiry = expiry
        self.deadline = self.now()+max(0., expiry-self.wall())
        self.pending = approval

    def revoke(self):
        active, self.active = self.active, None
        self.pending = None
        self.epoch += 1
        if self.session is not None:
            self.session.core.st = None
            self.session.core.stop('field approval unavailable')
            self.session.lease_confirmed = False
            self.session.lease_id = self.session.holder_type = self.session.holder_run_id = None
            if self.session.core.controller is not None:
                self.session.core.drop(self.session.core.controller, 'field approval unavailable')
        try:
            if active is not None:
                # STOP/zero on the independent SDK lane before closing workers.
                try:
                    active.sink.apply(MotionCommand('stop'), source='server')
                finally:
                    active.sink.close()
        finally:
            if self.inputs.feedback is not None:
                self.inputs.feedback.sink = None

    def valid(self):
        try:
            return (self.ready and self.nic_matches() and self.now() < self.deadline
                    and self.wall() < self.last_expiry and self.inputs.identity() == self.serial
                    and not self.inputs.feedback.fault and self.session.connected
                    and not self.session.link_lost and not self.session.reconnect_required)
        except (ValueError, PermissionError):
            return False

    def allowed(self):
        if self.active is not None and not self.valid():
            self.revoke()
        return self.active is not None

    def activate(self, subscriptions, *, connect=connect_approved, sink_factory=Go2Sink):
        if self.pending is None:
            return
        if not self.valid():
            self.revoke()
            return
        feedback = self.inputs.feedback
        if feedback.sample() is None:
            return
        approval, self.pending = self.pending, None
        # SDK imports/construction occur only here, after all gates. No Move is
        # issued by the factory. The sink starts latched and has no retained lease.
        if self.remember is not None:
            self.remember(approval.expires_at)  # durable before constructing any motion client
        clients = connect(approval, self.serial, subscriptions)
        sink = sink_factory(*clients, phone_watchdog=True)
        self.active = ServerSink(sink, self.session)
        feedback.sink = sink
        sink.start_threads()
        if not self.valid():
            self.revoke()

    def apply(self, command):
        if self.allowed():
            self.active.apply(command)

    def output_safety(self):
        return self.active.output_safety() if self.allowed() else (self.epoch, True)


async def run(credentials, nic, inputs, subscriptions, *, ready, check_nic, status, stop,
              client_factory=Client, connect=connect_approved, sink_factory=Go2Sink, remember=None,
              depth_source=None, media_factory=approved_publisher, recorder_factory=Recorder):
    inputs.feedback = Feedback(credentials.robot_serial)
    nic_valid = True
    gate = Gate(nic, credentials.robot_serial, inputs, ready=ready, nic_matches=lambda: nic_valid,
                last_expiry=credentials.last_field_approval_expires_at, remember=remember)
    session = GatedSession(inputs.feedback, gate)
    client = client_factory(session, gate, credentials.link)
    network = asyncio.create_task(client.run())
    recorder = recorder_factory(os.environ, status=status)
    media = media_task = media_epoch = None
    retired_media = []
    if depth_source is not None:
        depth_source.recorder = recorder
        depth_source.recording_allowed = lambda: gate.active is not None
    nic_task = None
    next_nic = 0.
    healthy = False
    try:
        while not stop.is_set() and not network.done():
            stamp = time.monotonic()
            if nic_task is None and stamp >= next_nic:
                nic_task = asyncio.create_task(asyncio.to_thread(check_nic))
                next_nic = stamp+.1
            if nic_task is not None:
                if nic_task.done():
                    try:
                        nic_valid = nic_task.result() is True
                    except Exception:
                        nic_valid = False
                    nic_task = None
                elif stamp-next_nic > .20:
                    nic_valid = False  # hung kernel query cannot keep motion enabled
            gate.allowed()
            gate.activate(subscriptions, connect=connect, sink_factory=sink_factory)
            # Observations follow an approval epoch but are never part of the
            # control health/lifetime task set. Close signals only; no SDK join.
            if gate.active is not media_epoch:
                if media is not None:
                    media.source.close()
                    media = None
                if media_task is not None:
                    media_task.cancel()
                    retired_media.append(media_task)
                    media_task = None
                media_epoch = gate.active
                if media_epoch is not None:
                    try:
                        recorder.start()
                        approval = Approval(nic.name, credentials.robot_serial, gate.last_expiry)
                        active = media_epoch
                        media = media_factory(credentials, approval, subscriptions, recorder,
                                              lambda active=active: gate.active is active)
                        media_task = asyncio.create_task(media.run())
                    except Exception:
                        pass  # missing camera/SDK/storage cannot affect motion
            if gate.active is not None:
                if gate.active.sink.error is not None:
                    raise RuntimeError('motion output failed')
                fresh = inputs.feedback.consume(client)
                if healthy and not fresh:
                    client._emit(session.feedback_lost())
                healthy = fresh
            else:
                healthy = False
            readings = devices(inputs.feedback.telemetry(), session.now())
            readings.append(dict(key='go2-preflight', kind='OTHER', label='연결 프로그램 자동 점검',
                                 state='OK' if ready else 'ERROR', received_monotonic_s=session.now()))
            session.update_devices(readings)
            status.update(mode='승인됨 · 조종권과 잠금 해제 필요' if gate.active else '읽기 전용 · 현장 안전 확인 필요',
                          connected=session.connected, field_approval_expires_at=gate.last_expiry
                          if gate.active else None,
                          record_notice=recorder.notice if gate.active or recorder.stopped.is_set()
                          or not recorder.notice else '기록 대기: 연결 승인 필요')
            await asyncio.sleep(.02)
        if network.done():
            network.result()
    finally:
        # Local STOP precedes all network cancellation and waits.
        try:
            gate.revoke()
        finally:
            recorder.close()
            if recorder.notice.startswith('기록 저장 중:'):
                status.update(record_notice='기록 멈춤: 연결 종료')
            if media is not None:
                media.source.close()
            if media_task is not None:
                media_task.cancel()
                retired_media.append(media_task)
            network.cancel()
            if nic_task is not None:
                nic_task.cancel()
            await asyncio.gather(network, *([nic_task] if nic_task is not None else []),
                                 *retired_media, return_exceptions=True)
