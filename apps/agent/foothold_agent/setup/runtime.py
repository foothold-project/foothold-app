"""One readonly DDS subscription pair and WS; motion objects exist only in approval epochs."""
import asyncio
from functools import cache
import logging
import math
import os
import queue
import threading
import time
from time import process_time

from foothold_agent.go2_direct.approval import Approval, SERVER_CLOCK_SKEW_S, validate_value
from foothold_agent.go2_direct.media import approved_publisher
from foothold_agent.slam_source import SOURCES
from foothold_agent.go2_direct.record import Recorder
from foothold_agent.go2_direct.feedback import Feedback
from foothold_agent.go2_direct.readonly import Measurements
from foothold_agent.go2_direct.reporting import devices
from foothold_agent.go2_direct.sdk import SportBoundary, connect_approved
from foothold_agent.go2_direct.identity import ResumeGate
from foothold_agent.go2_direct.server import DriveSession, ServerSink
from foothold_agent.go2_direct.sink import Go2Sink, OutputError
from foothold_agent.go2_readonly.sdk import ReceiptIntervals
from foothold_agent.go2_readonly.state import integer
from foothold_agent.link.client import Client
from foothold_agent.link.session import MotionCommand
from foothold_agent.safety.lock_log import server_cause
from foothold_agent.phone.tickets import json_object
from .pairing import timestamp
from .storage import valid_serial


class SerialUnavailable(PermissionError):
    pass


def _age_ms(stamp, at):
    return round((stamp - at) * 1000, 2) if at is not None and math.isfinite(at) else -1


def _identity_error(error, branch):
    error.lock_branch = branch
    return error


@cache
def _host_requests():
    # One optional sampler across approval epochs. A stalled OS call cannot
    # hold the control loop or shutdown, or accumulate work on repeated locks.
    requests = queue.Queue(maxsize=1)

    def collect():
        while True:
            inputs = requests.get()
            try:
                inputs.sample_host()
            except Exception:
                pass  # A previous sample carries its age; absent fields are marked.
            finally:
                del inputs

    threading.Thread(target=collect, name='go2-host-sample', daemon=True).start()
    return requests


class LockEvidence(dict):
    """Fixed set of locally published clocks, samples and decision labels."""
    def snapshot(self):
        # One shallow CPython dict copy. Writers replace entries and never
        # mutate a published feedback sample. No DDS or output lock is taken.
        return LockEvidence(self)

    def suffix(self, stamp, cause):
        if cause == 'identity_unavailable':
            branch = self.get('identity_branch')
            if branch not in ('serial_conflict', 'serial_missing', 'serial_invalid', 'serial_stale',
                              'nonzero_serial', 'body_conflict', 'body_check_failed',
                              'body_check_stale', 'body_unconfirmed'):
                branch = 'unavailable'
        elif cause.startswith('identity_') or cause == 'feedback_identity_conflict':
            branch = cause
        else:
            branch = 'none'
        for topic in ('low', 'sport'):
            sample = self.get(topic)
            self[topic + '_accepted'] = sample['received'] if sample else None
        clocks = ('low_rx', 'sport_rx', 'low_accepted', 'sport_accepted',
                  'serial_refresh', 'body_refresh', 'output_input', 'watchdog_input')
        missing = []
        parts = []
        for key in clocks:
            at = self.get(key)
            if at is None:
                missing.append(key + '_ms')
            parts.append(f'{key}_ms={_age_ms(stamp, at)}')
        try:
            latest = Feedback.journal_readiness(stamp, self)
        except Exception:
            latest = 'unavailable'
            missing.append('feedback_latest')
        failure = self.get('feedback_failed', 'unchecked')
        parts.extend((f'identity_branch={branch}', f'feedback_failed={failure}', f'feedback_latest={latest}'))
        sampled, cpu_pct, window_ms, load = self.get('host_sample', (None, None, None, None))
        for key, value in (('cpu_pct', cpu_pct), ('cpu_window_ms', window_ms), ('load1', load)):
            if value is None:
                missing.append(key)
                value = -1
            parts.append(f'{key}={value:.2f}')
        if sampled is None:
            missing.append('host_sample_age_ms')
        parts.append(f'host_sample_age_ms={_age_ms(stamp, sampled)}')
        if missing:
            parts.append('detail_missing=' + ','.join(missing))
        return ' ' + ' '.join(parts)


class Inputs(Measurements):
    """Read-only discovery plus independent, strict motion feedback when identified."""
    def __init__(self):
        super().__init__()
        self.identity_lock = threading.Lock()
        self.serial = None
        self.conflict = False
        self.feedback = None
        self.serial_received = float('-inf')
        self.mac_identity = None
        self.lock_evidence = LockEvidence()
        self.low_receipts = ReceiptIntervals()
        self.sport_receipts = ReceiptIntervals()
        stamp = time.monotonic()
        self.report_at = stamp
        self.cpu_recent = (stamp, process_time())
        self.host_due = stamp + 1.

    def lowstate(self, message):
        self.lock_evidence['low_rx'] = self.low_receipts.record(time.monotonic())
        sn = getattr(message, 'sn', None)
        if isinstance(sn, (tuple, list)) and len(sn) == 2 and all(integer(x, 0xFFFFFFFF) for x in sn):
            serial = f'{sn[0]}-{sn[1]}'
            with self.identity_lock:
                if self.serial is not None and self.serial != serial:
                    self.conflict = True
                self.serial = serial
                self.serial_received = time.monotonic()
                self.lock_evidence['serial_refresh'] = self.serial_received
        super().lowstate(message)
        if self.feedback is not None:
            self.feedback.lowstate(message)

    def sportmodestate(self, message):
        self.lock_evidence['sport_rx'] = self.sport_receipts.record(time.monotonic())
        super().sportmodestate(message)
        if self.feedback is not None:
            self.feedback.sportmodestate(message)

    def observed_identity(self):
        with self.identity_lock:
            if (self.conflict or self.serial != '0-0' and not valid_serial(self.serial)
                    or not 0 <= time.monotonic()-self.serial_received <= .20):
                branch = ('serial_conflict' if self.conflict else 'serial_missing' if self.serial is None
                          else 'serial_invalid' if self.serial != '0-0' and not valid_serial(self.serial)
                          else 'serial_stale')
                raise _identity_error(PermissionError('fresh unambiguous nonzero DDS serial required'), branch)
            return self.serial

    def zero_identity_changed(self):
        with self.identity_lock:
            return self.conflict or self.serial not in (None, '0-0')

    def identity(self):
        serial = self.observed_identity()
        if self.mac_identity is not None:
            if serial != '0-0' or not self.mac_identity.valid():
                branch = ('nonzero_serial' if serial != '0-0' else 'body_conflict' if self.mac_identity.fault
                          else 'body_check_failed' if self.mac_identity.unavailable else 'body_check_stale')
                raise _identity_error(PermissionError('confirmed body identity unavailable'), branch)
            self.lock_evidence['body_refresh'] = self.mac_identity.checked
            return self.mac_identity.serial
        if serial == '0-0':
            raise _identity_error(SerialUnavailable('operator confirmation required'), 'body_unconfirmed')
        return serial

    def sample_host(self):
        # Only the host sampler updates the baseline and publishes a complete
        # window. Use the actual sample time, even if its request was delayed.
        stamp, cpu = time.monotonic(), process_time()
        start, previous = self.cpu_recent
        window = stamp - start
        if window < 1.:
            return
        try:
            load = os.getloadavg()[0]
        except (AttributeError, OSError):
            load = None
        self.lock_evidence['host_sample'] = (stamp, 100 * (cpu - previous) / window, window * 1000, load)
        self.cpu_recent = (stamp, cpu)

    def report_intervals(self, stamp):
        if stamp >= self.host_due:
            self.host_due = stamp + 1.
            try:
                _host_requests().put_nowait(self)
            except queue.Full:
                pass  # Read the last completed sample until the worker catches up.
        checked = self.mac_identity.checked if self.mac_identity is not None else None
        if checked is not None and math.isfinite(checked):
            self.lock_evidence['body_refresh'] = checked
        if stamp - self.report_at < 30.:
            return
        elapsed, self.report_at = stamp - self.report_at, stamp
        drops = self.feedback.take_drops()
        logging.getLogger('foothold_agent.lock').warning(
            'GO2_DDS window_s=%.2f %s %s drops=%d drop_reasons=%s', elapsed,
            self.low_receipts.summary('low'), self.sport_receipts.summary('sport'),
            sum(drops.values()), ','.join(f'{key}:{drops[key]}' for key in sorted(drops)) or 'none')


class GatedSession(DriveSession):
    def __init__(self, feedback, gate):
        self.gate = gate
        super().__init__(feedback)
        gate.session = self
        if isinstance(gate.inputs, Inputs):
            feedback.attach_journal(gate.lock_evidence)
            self.core.lock_log.evidence = gate.lock_evidence

    def receive(self, raw):
        try:
            frame = json_object(raw) if isinstance(raw, (str, bytes)) else raw
        except (ValueError, TypeError, UnicodeError, RecursionError):
            return self.tick()
        if isinstance(frame, dict) and frame.get('t') == 'field_approval':
            self.gate.approve(frame.get('expires_at'))
            return self.tick()
        if not self.gate.allowed():
            if (self.connected and not self.reconnect_required and isinstance(frame, dict)
                    and frame.get('t') == 'stop' and server_cause(frame) in ('unknown', 'user_stop')):
                self.operator_stop = True  # retain priority without creating output or a STOP acknowledgement
            return super().receive(frame) if isinstance(frame, dict) and (
                frame.get('t') == 'ping' or frame.get('t') == 'slam' and frame.get('source') in SOURCES) else self.tick()
        return super().receive(frame)

    def disconnect(self):
        self.gate.revoke_with_cause("connection_changed")
        return super().disconnect()

    def unlock_verified(self, frame):
        if self.gate.allowed():
            return super().unlock_verified(frame)
        return self.feedback_lost()

    def transport_closed(self, close_code, *, retry):
        self.gate.revoke_with_cause("transport_closed")
        return super().transport_closed(close_code, retry=retry)

    def shutdown(self):
        self.gate.revoke_with_cause("shutdown")
        return super().shutdown()

    def _state(self):
        value = super()._state()
        if self.gate.active is None:
            value['stop_ref'] = 0
        return value


class Gate:
    def __init__(self, nic, serial, inputs, *, ready, nic_matches, wall=time.time, now=time.monotonic, last_expiry=None, remember=None, nic_cause=lambda: "nic_mismatch"):
        self.nic, self.serial, self.inputs = nic, serial, inputs
        self.ready, self.nic_matches = ready, nic_matches
        self.nic_cause = nic_cause
        self.invalid_cause = "approval_revoked"
        self.lock_evidence = getattr(inputs, 'lock_evidence', {})
        self.wall, self.now = wall, now
        self.active = self.pending = self.session = None
        self.last_expiry = float('-inf') if last_expiry is None else last_expiry
        self.remember = remember
        self.deadline = float('-inf')
        self.epoch = 0
        # Even a failed unlock query followed by a successful background check
        # between loop ticks must revoke the old motion approval and lease.
        self.identity_epoch = 0 if getattr(inputs, 'mac_identity', None) is None else inputs.mac_identity.failure_epoch

    def approve(self, expiry):
        cause = "approval_revoked" if expiry is None else "approval_invalid"
        try:
            expiry = timestamp(expiry)
            # Duplicate delivery is harmless; it cannot extend a monotonic epoch.
            if expiry == self.last_expiry:
                return
            if expiry < self.last_expiry or self.session is None or not self.session.connected:
                cause = "approval_connection"
                raise PermissionError('fresh approval on connected transport required')
            approval = validate_value(dict(v=1, purpose='go2-field-motion', nic=self.nic.name,
                                          robot_serial=self.serial, expires_at=expiry), self.nic.name,
                                      now=self.wall(), clock_skew_s=SERVER_CLOCK_SKEW_S)
            cause = "identity_unavailable"
            if (not self._check(self.ready, "preflight_unavailable")
                    or not self._check(self.nic_matches(), self.nic_cause)
                    or not self._check(self.inputs.identity() == self.serial, "identity_changed")):
                cause = self.invalid_cause
                raise PermissionError('preflight and current identity required')
        except (ValueError, TypeError, PermissionError, OverflowError) as error:
            self.lock_evidence['identity_branch'] = getattr(error, 'lock_branch', 'unavailable')
            self.revoke_with_cause(cause)
            return
        if self.active is not None and self.valid():
            # A fresh bounded marker on this same healthy connection renews
            # only the deadline. NIC/serial/preflight, feedback and transport
            # checks above still apply; no lease or unlock is created here.
            if self.remember is not None:
                self.remember(expiry)
            self.last_expiry = expiry
            self.deadline = self.now()+max(0., expiry-self.wall())
            for boundary in (self.active.sink.client, self.active.sink.emergency_client):
                if isinstance(boundary, SportBoundary):
                    boundary.renew(approval, deadline=self.deadline)
            return
        self.revoke_with_cause(self.invalid_cause if self.active is not None else "approval_replaced")
        self.last_expiry = expiry
        self.deadline = self.now()+max(0., expiry-self.wall())
        self.pending = approval

    def revoke_with_cause(self, cause):
        # Keep the existing no-argument cleanup hook (including failure hooks).
        self.revoke_cause = cause
        return self.revoke()

    def revoke(self):
        cause = getattr(self, 'revoke_cause', 'approval_revoked')
        self.revoke_cause = 'approval_revoked'
        active, self.active = self.active, None
        self.pending = None
        self.epoch += 1
        if getattr(self.inputs, 'mac_identity', None) is not None:
            self.identity_epoch = self.inputs.mac_identity.failure_epoch
        if self.session is not None:
            self.session.movement_gate = None
            self.session.posture_sink = None
            if self.session.identity_gate is not None:
                self.session.identity_gate.close()
            self.session.core.st = None
            self.session.core.stop('field approval unavailable', cause=cause)
            self.session.lease_confirmed = False
            self.session.lease_id = self.session.holder_type = self.session.holder_run_id = None
            if self.session.core.controller is not None:
                self.session.core.drop(self.session.core.controller, 'field approval unavailable', cause=cause)
        try:
            if active is not None:
                for boundary in (active.sink.client, active.sink.emergency_client):
                    if isinstance(boundary, SportBoundary):
                        boundary.revoke()
                # STOP/zero on the independent SDK lane before closing workers.
                try:
                    active.sink.apply(MotionCommand('stop'), source='server')
                finally:
                    active.sink.close()
        finally:
            if self.inputs.feedback is not None:
                self.inputs.feedback.sink = None
                self.lock_evidence['server_source'] = False

    def _check(self, value, cause):
        if not value:
            self.invalid_cause = cause() if callable(cause) else cause
        return value

    def valid(self):
        try:
            return (self._check(self.ready, 'preflight_unavailable')
                    and self._check(self.nic_matches(), self.nic_cause)
                    and self._check(self.now() < self.deadline, 'approval_expired')
                    and self._check((getattr(self.inputs, 'mac_identity', None) is None
                         or self.identity_epoch == self.inputs.mac_identity.failure_epoch),
                        lambda: getattr(self.inputs.mac_identity, 'failure_cause', 'identity_check_failed'))
                    and self._check(self.wall() < self.last_expiry, 'approval_expired')
                    and self._check(self.inputs.identity() == self.serial, 'identity_changed')
                    and self._check(not self.inputs.feedback.fault, 'feedback_identity_conflict')
                    and self._check(self.session.connected, 'connection_changed')
                    and self._check(not self.session.link_lost, 'link_lost')
                    and self._check(not self.session.reconnect_required, 'connection_changed'))
        except (ValueError, PermissionError) as error:
            self.lock_evidence['identity_branch'] = getattr(error, 'lock_branch', 'unavailable')
            self.invalid_cause = 'identity_unavailable'
            return False

    def allowed(self):
        if self.active is not None and not self.valid():
            self.revoke_with_cause(self.invalid_cause)
        return self.active is not None

    def prepare_activation(self):
        if self.pending is None:
            return
        if not self.valid():
            self.revoke_with_cause(self.invalid_cause)
            return
        feedback = self.inputs.feedback
        if feedback.sample() is None:
            return
        approval, self.pending = self.pending, None
        # Consume the epoch durably before any SDK construction. The factory
        # issues no Move; output will start latched with no retained lease.
        if self.remember is not None:
            self.remember(approval.expires_at)  # durable before constructing any motion client
        return approval

    def finish_activation(self, clients, *, epoch, sink_factory=Go2Sink):
        # SDK initialization may be slow. No output object/workers may be
        # installed after an intervening revocation, reconnect or ID change.
        if epoch != self.epoch:
            return
        if not self.valid():
            self.revoke_with_cause(self.invalid_cause)
            return
        if self.inputs.feedback.sample() is None:
            self.revoke_with_cause("activation_feedback_lost")
            return
        feedback = self.inputs.feedback
        sink = sink_factory(*clients, phone_watchdog=True)
        if isinstance(self.inputs, Inputs):
            self.lock_evidence.update(output_input=None, watchdog_input=None, server_source=False)
            sink.lock_evidence = self.lock_evidence
            sink.lock_log.evidence = self.lock_evidence
        sink.posture_feedback = feedback.posture_snapshot
        for boundary in clients:
            if isinstance(boundary, SportBoundary):
                boundary.renew(Approval(self.nic.name, self.serial, self.last_expiry), deadline=self.deadline)
        self.active = ServerSink(sink, self.session)
        self.session.posture_gate = lambda: self.active is not None and self.active.sink is sink and self.valid()
        feedback.sink = sink
        sink.start_threads()
        if not self.valid():
            self.revoke_with_cause(self.invalid_cause)

    def activate(self, subscriptions, *, connect=connect_approved, sink_factory=Go2Sink):
        approval = self.prepare_activation()
        if approval is not None:
            epoch = self.epoch
            clients = connect(approval, self.serial, subscriptions)
            self.finish_activation(clients, epoch=epoch, sink_factory=sink_factory)

    def apply(self, command):
        if self.allowed():
            active = self.active
            try:
                active.apply(command)
            except Exception as error:
                # A failed worker's generic "adapter closed" exception must not
                # hide the original SDK fault from the setup diagnostic.
                if active.sink.error is not None and active.sink.error is not error:
                    raise error from active.sink.error
                raise

    def output_safety(self):
        return self.active.output_safety() if self.allowed() else (self.epoch, True)


async def run(credentials, nic, inputs, subscriptions, *, ready, check_nic, status, stop,
              client_factory=Client, connect=connect_approved, sink_factory=Go2Sink, remember=None,
              depth_source=None, media_factory=approved_publisher, recorder_factory=Recorder,
              mapping_factory=None):
    builtin_mapping = mapping_factory is None
    if mapping_factory is None:
        from foothold_agent.mapping.runtime import attach as mapping_factory
    identity = inputs.mac_identity
    if identity is not None:
        try:
            await identity.refresh()
        except Exception:
            pass  # keep transport/status alive while the background check retries
    # Installation trials allow only the approved Agile state. Feedback still
    # requires a server-selected sink; no inherited environment can widen this.
    inputs.feedback = Feedback('0-0' if identity is not None else credentials.robot_serial,
                               accept_error_codes=(100,))
    logging.getLogger(__name__).warning('서버 시험 운동 상태 허용: 100(Agile)')
    nic_valid = True
    nic_cause = "nic_mismatch"
    gate = Gate(nic, credentials.robot_serial, inputs, ready=ready, nic_matches=lambda: nic_valid,
                last_expiry=credentials.last_field_approval_expires_at, remember=remember,
                nic_cause=lambda: nic_cause)
    session = GatedSession(inputs.feedback, gate)
    if identity is not None:
        session.identity_gate = ResumeGate(None, inputs.feedback, check=identity.verify_resume)
    client = client_factory(session, gate, credentials.link)
    network = asyncio.create_task(client.run())
    recorder = recorder_factory(os.environ, status=status)
    media = media_task = media_epoch = None
    mapping_task = None
    retired_media = []
    if depth_source is not None:
        depth_source.recorder = recorder
        depth_source.recording_allowed = lambda: gate.active is not None
    nic_task = None
    identity_task = None
    activation_task = None
    activation_epoch = None
    next_identity = 0.
    next_nic = 0.
    healthy = False
    failure = None
    observed_serial = identity.serial if identity is not None else credentials.robot_serial

    def observation_enabled():
        # Fresh confirmed body and authenticated connection; no movement lease,
        # output client, unlock or field-motion approval is created by this path.
        try:
            return bool(ready and nic_valid and inputs.identity() == observed_serial
                        and session.connected and not session.link_lost and not session.reconnect_required)
        except (ValueError, PermissionError):
            return False
    try:
        while not stop.is_set() and not network.done():
            stamp = time.monotonic()
            if identity is not None:
                if identity_task is not None and identity_task.done():
                    try:
                        identity_task.result()
                    except Exception:
                        pass  # MacIdentity distinguishes transient loss from conflict
                    identity_task = None
                if identity_task is None and stamp >= next_identity and not identity.fault:
                    identity_task = asyncio.create_task(identity.refresh())
                    next_identity = stamp+.05
            if nic_task is None and stamp >= next_nic:
                nic_task = asyncio.create_task(asyncio.to_thread(check_nic))
                next_nic = stamp+.1
            if nic_task is not None:
                if nic_task.done():
                    try:
                        nic_valid = nic_task.result() is True
                        nic_cause = "nic_mismatch"
                    except Exception:
                        nic_valid = False
                        nic_cause = "nic_check_failed"
                    nic_task = None
                elif stamp-next_nic > .20:
                    nic_valid = False  # hung kernel query cannot keep motion enabled
                    nic_cause = "nic_check_delayed"
            gate.allowed()
            if identity is None:
                gate.activate(subscriptions, connect=connect, sink_factory=sink_factory)
            elif activation_task is not None:
                if activation_epoch == gate.epoch and not gate.valid():
                    gate.revoke_with_cause(gate.invalid_cause)
                if activation_task.done():
                    clients = activation_task.result()
                    activation_task = None
                    gate.finish_activation(clients, epoch=activation_epoch, sink_factory=sink_factory)
            if identity is not None and activation_task is None:
                approval = gate.prepare_activation()
                if approval is not None:
                    activation_epoch = gate.epoch
                    # Imports and SportClient.Init must not starve the MAC
                    # refresh, transport watchdog or readonly DDS evidence.
                    # Only construction runs here; Core/sink stay on this loop.
                    activation_task = asyncio.create_task(asyncio.to_thread(
                        connect, approval, credentials.robot_serial, subscriptions))
            if session.identity_gate is not None:
                session.identity_gate.poll(client)
            if mapping_task is None and observation_enabled() and (builtin_mapping or gate.active is not None):
                try:
                    options = dict(enabled=observation_enabled if builtin_mapping else lambda: gate.active is not None)
                    if builtin_mapping:
                        options['command_allowed'] = lambda: gate.active is not None and gate.valid()
                    mapping_task = mapping_factory(session, subscriptions, credentials.link,
                        credentials.robot_id, os.environ, **options)
                except Exception:
                    pass
            # Observations follow an approval epoch but are never part of the
            # control health/lifetime task set. Close signals only; no SDK join.
            if gate.active is not media_epoch:
                mapper = getattr(session, 'mapping', None)
                if mapper is not None and media_epoch is not None:
                    # Existing legacy scans retain their approval lifetime;
                    # onboard observations keep the confirmed-body scope.
                    suspend = getattr(mapper, 'suspend_motion', None) or mapper.suspend
                    suspend()
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
                        approval = Approval(nic.name, identity.serial if identity is not None
                                            else credentials.robot_serial, gate.last_expiry)
                        active = media_epoch
                        media = media_factory(credentials, approval, subscriptions, recorder,
                                              lambda active=active: gate.active is active and gate.valid())
                        media_task = asyncio.create_task(media.run())
                    except Exception as error:
                        reason = 'identity' if isinstance(error, PermissionError) else 'source'
                        logging.getLogger(__name__).warning('GO2_MEDIA start_failed reason=%s', reason)
            if gate.active is not None:
                if gate.active.sink.error is not None:
                    raise RuntimeError('motion output failed') from gate.active.sink.error
                fresh = inputs.feedback.consume(client)
                if healthy and not inputs.feedback.healthy():
                    client._emit(session.feedback_lost())
                healthy = inputs.feedback.healthy()
            else:
                healthy = False
            try:
                inputs.report_intervals(stamp)
            except Exception:
                pass  # Optional journal output must not end the motion session.
            readings = devices(inputs.feedback.telemetry(), session.now())
            readings.append(dict(key='go2-preflight', kind='OTHER', label='연결 프로그램 자동 점검',
                                 state='OK' if ready else 'ERROR', received_monotonic_s=session.now()))
            if identity is not None:
                identity_ready = identity.valid()
                readings.append(dict(key='go2-identity', kind='OTHER',
                    label='로봇 확인' if identity_ready else '로봇 연결 정보 변경 · 이동 잠김'
                    if identity.fault else '로봇 확인 잠시 안 됨 · 이동 잠김',
                    state='OK' if identity_ready else 'ERROR', received_monotonic_s=session.now()))
            session.update_devices(readings)
            mode = '승인됨 · 조종권과 잠금 해제 필요' if gate.active else '읽기 전용 · 현장 안전 확인 필요'
            if identity is not None and identity.fault:
                mode = '로봇의 연결 정보가 바뀌어 조종을 잠갔습니다. 랜선을 확인한 뒤 프로그램을 다시 실행해 주세요.'
            elif identity is not None and not identity.valid():
                mode = '로봇 확인 잠시 안 됨 · 이동 잠김'
            elif gate.active is not None:
                mode = gate.active.sink.movement_reason() or mode
            status.update(mode=mode,
                          connected=session.connected, field_approval_expires_at=gate.last_expiry
                          if gate.active else None,
                          record_notice=recorder.notice if gate.active or recorder.stopped.is_set()
                          or not recorder.notice else '기록 대기: 연결 승인 필요')
            await asyncio.sleep(.02)
        if network.done():
            network.result()
    except BaseException as error:
        failure = error
        raise
    finally:
        # Local STOP precedes all network cancellation and waits.
        failed_sink = None if gate.active is None else gate.active.sink
        try:
            try:
                gate.revoke_with_cause("runtime_exit")
            except BaseException as cleanup_error:
                if not (failure is not None and failed_sink is not None
                        and failed_sink.error is not None
                        and isinstance(cleanup_error, OutputError)
                        and str(cleanup_error) == 'adapter closed or failed'):
                    raise
                # Only duplicate apply-on-failed-sink errors preserve the cause.
                # A fresh emergency submission failure must remain visible.
                logging.getLogger(__name__).warning('GO2_CLEANUP_STOP_FAILED original_failure_preserved')
        finally:
            recorder.close()
            if recorder.notice.startswith('기록 저장 중:'):
                status.update(record_notice='기록 멈춤: 연결 종료')
            if media is not None:
                media.source.close()
            mapper = getattr(session, 'mapping', None)
            if mapper is not None:
                mapper.close()
            if mapping_task is not None:
                mapping_task.cancel()
                retired_media.append(mapping_task)
            if media_task is not None:
                media_task.cancel()
                retired_media.append(media_task)
            network.cancel()
            if nic_task is not None:
                nic_task.cancel()
            if identity_task is not None:
                identity_task.cancel()
            if activation_task is not None:
                activation_task.cancel()
            await asyncio.gather(network, *([nic_task] if nic_task is not None else []),
                                 *([identity_task] if identity_task is not None else []),
                                 *([activation_task] if activation_task is not None else []),
                                 *retired_media, return_exceptions=True)
