"""Cloud facade with NO second Session, Core or robot output port.

Reuse bounded history and Client transport; only server STOP and pass revocation reach the Hub.
"""
import asyncio
from copy import deepcopy

from foothold_agent.link.session import Session, Effects, MAX_BUFFER, SAFETY_EVENTS
from foothold_agent.link.history import History
from .tickets import json_object
from .protocol import sequence


class DiscardSink:
    def apply(self, command):
        pass  # facade emits no motion, including on cloud reconnect


class Observer:
    retain = Session.retain
    pop_history = Session.pop_history
    restore = Session.restore
    _event = Session._event
    transport_retry = Session.transport_retry

    def __init__(self, phone):
        self.phone, self.now = phone, phone.now
        self._messages = History(MAX_BUFFER - 1, lambda m: m.get('code') in SAFETY_EVENTS
                                 or m.get('code', '').startswith('PHONE_LEASE_')
                                 or m.get('t') == 'run.update')
        self.history_ready = asyncio.Event()
        self.before_history = None
        self.emit_history = False
        self._retry_event = None
        self._buffer_dropped = 0
        self.connected = self.protocol_rejected = self.reconnect_required = self.link_lost = False
        self.last_report = float('-inf')
        self.last_ping = self.now()
        self._replay = []
        self.server_stop_ref = 0

    @property
    def run(self):
        return self.phone.runs.snapshot()

    @property
    def core(self):
        return self.phone.session.core  # read by Client's before-history guard

    def _state(self):
        return {**self.phone.session._state(), 'stop_ref': self.server_stop_ref}

    def _finish(self):
        messages = ()
        if self.connected and self.now() - self.last_report >= .1:
            messages = (self._state(),)
            self.last_report = self.now()
        self.link_lost = self.connected and self.now() - self.last_ping >= 3
        support = self.phone.runs.support
        if self.connected and support.advertised is not None:
            advertised_rgb = any(a['key'] == 'photo.rgb' and a['state'] == 'SUPPORTED'
                                 for a in support.advertised['actions'])
            if advertised_rgb != (support.rgb_ready() and support.uploader is not None):
                self.reconnect_required = True
        if self.link_lost or self.reconnect_required:
            self.phone.runs.execution_disconnected()
        if self.connected:
            reports, self.phone.runs.outgoing = self.phone.runs.outgoing, []
            messages = (*messages, *self._replay, *reports)
            self._replay = []
        return Effects((), messages)

    tick = _finish

    def connect(self):
        self.connected = True
        self.protocol_rejected = self.reconnect_required = self.link_lost = False
        self.last_ping = self.now()
        self.server_stop_ref = 0
        journal = self.phone.runs.journal
        if journal is not None:
            journal.poll()
            self._replay = journal.replay()
            self.phone.runs.outgoing.clear()
        hello = {**deepcopy(self.phone.session.identity), 't': 'hello', 'proto': 'fh-agent/2',
                 'latched': self.core.latch, 'stop_gen': self.phone.session._generation(),
                 'lease_id': None, 'run': self.run,
                 'devices': self.phone.session._device_snapshot(),
                 'execution_capabilities': self.phone.runs.support.hello()}
        return Effects((), (hello, self._state()))

    def disconnect(self):
        self.phone.runs.execution_disconnected()
        self.connected = False
        return Effects(())

    shutdown = disconnect

    def transport_closed(self, close_code, *, retry):
        self._event('SERVER_CLOSED', close_code=close_code, retry=retry)
        return self.disconnect()

    def protocol_mismatch(self):
        self.protocol_rejected = True
        self._event('PROTOCOL_MISMATCH')
        return Effects(())

    def storage_blocked(self, reason):
        if self.phone.runs.active:
            self.phone.runs._halt('PAUSED', 'RECORDING_UNAVAILABLE')
        self.connected = False
        return Effects(())

    def transport_overflow(self):
        self.reconnect_required = True
        return Effects(())

    def on_robot_state(self, raw, *, record_errors=True):
        return self.tick()  # bridge already updated the ONE phone Session

    def update_telemetry(self, snapshot):
        self.phone.session.update_telemetry(snapshot)

    def update_devices(self, devices):
        self.phone.session.update_devices(devices)

    def receive(self, raw):
        try:
            f = json_object(raw) if isinstance(raw, (str, bytes)) else raw
        except (ValueError, TypeError, UnicodeError, RecursionError):
            return self.tick()
        if isinstance(f, dict):
            if f.get('t') == 'stop':
                self.phone.stop()  # malformed STOP also only moves toward safety
                ref = f.get('stop_ref')
                if sequence(ref) and ref > 0 and self.core.latch and not any(self.core.out):
                    self.server_stop_ref = ref
            elif f.get('t') == 'phone.revoke' and self.connected:
                self.phone.revoke(f)
                effects = self.tick()
                return Effects((), (*effects.messages, {'t': 'phone.revoke.ack', 'seq': f['seq']}))
            elif f.get('t') == 'run.recorded' and self.connected:
                journal = self.phone.runs.journal
                if (journal is not None and set(f) == {'t', 'agent_instance_id', 'report_seq'}
                        and isinstance(f['agent_instance_id'], str) and sequence(f['report_seq'])):
                    journal.ack(f['agent_instance_id'], f['report_seq'])
            elif f.get('t') == 'run.report_rejected' and self.connected:
                self._report_rejected(f)
            elif f.get('t') == 'ping':
                self.last_ping = self.now()
        return self.tick()  # lease/cmd/unlock/run.* never reach the real Session

    def _report_rejected(self, f):
        journal, runs = self.phone.runs.journal, self.phone.runs
        required = {'t', 'agent_instance_id', 'report_seq', 'run_id', 'disposition', 'code'}
        if (journal is None or not required <= set(f) or set(f) - required - {'expected_report_seq'}
                or not isinstance(f['agent_instance_id'], str) or not sequence(f['report_seq'])):
            return
        key = (f['agent_instance_id'], f['report_seq'])
        if key not in journal.committed:
            return
        original = journal.entries[key]
        run_id = original.get('run_id') if original['t'] == 'run.update' else original.get('data', {}).get('run_id')
        if f['run_id'] != run_id:
            return
        retry = f['code'] in ('RUN_REPORT_SEQUENCE', 'RUN_REPORT_STORAGE')
        permanent = {'RUN_REPORT_OWNER', 'RUN_REPORT_MAP', 'RUN_REPORT_PLAN', 'RUN_REPORT_STATE',
                     'RUN_REPORT_STEP', 'RUN_REPORT_PROVENANCE', 'RUN_REPORT_CONFLICT',
                     'RUN_REPORT_INSTANCE', 'RUN_REPORT_ROBOT', 'RUN_REPORT_NOT_FOUND', 'RUN_REPORT_INVALID'}
        if retry and f['disposition'] == 'RETRY':
            if f['code'] == 'RUN_REPORT_SEQUENCE':
                expected = f.get('expected_report_seq')
                if not sequence(expected):
                    return
                if expected <= f['report_seq'] and (f['agent_instance_id'], expected) not in journal.committed:
                    runs.storage_failed = True
                    if runs.active:
                        runs._halt('PAUSED', 'RECORDING_UNAVAILABLE')
                    return
                # Including expected > seq: resend the identical original. Only
                # run.recorded can acknowledge an already committed report.
            elif 'expected_report_seq' in f:
                return
            self.reconnect_required = True  # Client's existing backoff, no busy replay
        elif f['code'] in permanent and f['disposition'] == 'QUARANTINE' and 'expected_report_seq' not in f:
            if journal.reject(f):
                runs.recording_rejected = True
                quarantined = key
                self._replay = [m for m in self._replay if (m.get('agent_instance_id'), m.get('report_seq')) != quarantined]
                runs.outgoing = [m for m in runs.outgoing if (m.get('agent_instance_id'), m.get('report_seq')) != quarantined]
                if runs.active:
                    runs._halt('FAILED', 'RECORDING_REJECTED')
                else:
                    self.phone.stop()
