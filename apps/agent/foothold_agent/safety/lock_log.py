"""Bounded, diagnostic-only cause records. Never accept labels from user data."""
from concurrent.futures import Future
from functools import cache
import logging
import queue
import threading
import time

SERVER_CAUSES = frozenset({
    'unknown', 'user_stop', 'lease_release', 'lease_expired',
    'lease_take', 'lease_transfer', 'run_takeover', 'transfer_canceled',
    'screen_hidden', 'access_revoked', 'robot_changed', 'screen_auth_revoked',
    'screen_policy_stale', 'screen_disconnected', 'agent_auth_revoked', 'agent_policy_stale',
    'agent_connected', 'agent_disconnected', 'agent_silent', 'field_approval_revoked',
    'audit_unavailable', 'run_finished', 'transfer_access_lost', 'archive_blocked',
    'drive_command_rejected', 'drive_frame_invalid', 'drive_settings_changed',
})
AGENT_CAUSES = frozenset({
    'startup', 'connection_changed', 'link_grace_expired', 'output_stalled',
    'generation_exhausted', 'protocol_mismatch', 'history_blocked', 'history_unavailable',
    'transport_backpressure', 'server_auth_rejected', 'shutdown', 'invalid_lease',
    'feedback_lost', 'transport_closed', 'action_requested', 'posture_requested',
    'command_outside_table', 'other_stop', 'lease_changed', 'lock_transition',
    'episode_changed', 'robot_stop', 'reset_requested', 'reset_finished', 'sim_busy',
    'input_invalid', 'input_deadman', 'sim_unseen', 'sim_stale', 'sim_resetting',
    'policy_not_running', 'executor_stalled', 'link_lost',
    'approval_revoked', 'approval_invalid', 'approval_connection', 'approval_expired',
    'approval_replaced', 'preflight_unavailable', 'nic_mismatch', 'nic_check_failed',
    'nic_check_delayed', 'identity_changed', 'identity_unavailable', 'identity_check_failed',
    'feedback_identity_conflict', 'activation_feedback_lost', 'runtime_exit',
    'output_apply_stalled', 'output_drain_stalled', 'output_input_stale',
    'output_fault', 'output_workers_unready', 'output_source_changed',
    'output_source_invalid', 'output_command_invalid', 'output_velocity_invalid',
    'output_posture_hold', 'output_closed', 'identity_check_delayed',
})

STOP_CAUSES = {
    'startup': 'startup', 'connection/reconnection': 'connection_changed',
    'link grace expired': 'link_grace_expired', 'output stalled': 'output_stalled',
    'wire generation exhausted': 'generation_exhausted', 'protocol mismatch': 'protocol_mismatch',
    'history storage blocked': 'history_blocked', 'history storage unavailable': 'history_unavailable',
    'outgoing queue full': 'transport_backpressure', 'server authorization rejected': 'server_auth_rejected',
    'client shutdown': 'shutdown', 'invalid lease': 'invalid_lease',
    'local feedback unavailable': 'feedback_lost', 'server transport closed': 'transport_closed',
    'action requested': 'action_requested', 'posture requested': 'posture_requested',
    'outside server-drive command table': 'command_outside_table',
    'server lease': 'lease_changed', 'field approval unavailable': 'approval_revoked',
}


def server_cause(frame):
    value = frame.get('cause')
    return value if isinstance(value, str) and value in SERVER_CAUSES else 'unknown'


# One daemon for all Go2 output epochs. A stuck optional collector cannot
# accumulate threads/jobs or hold shutdown. Only locally constructed fields
# belong in its result; never pass SDK messages or exception text.
DETAIL_BUDGET_S = .002


@cache
def _detail_requests():
    requests = queue.Queue(maxsize=1)

    def collect():
        while True:
            callback, stamp, cause, evidence, future = requests.get()
            if future.set_running_or_notify_cancel():
                try:
                    future.set_result(callback(stamp, cause, evidence))
                except Exception:
                    future.set_result('')
            del callback, future, evidence

    threading.Thread(target=collect, name='go2-lock-detail', daemon=True).start()
    return requests


class LockLog:
    """One line per (kind, cause, source) per rolling second; bounded key space.

    held_ms is elapsed monotonic time since the last accepted healthy input or
    output, -1 before any such observation. It is evidence age, not a timeout.
    Callers serialize use just as they do their existing safety state.
    """
    def __init__(self, now=time.monotonic):
        self.now = now
        self.last_healthy = None
        self.last = {}
        self._details = None

    def set_details(self, evidence, callback):
        try:
            self._details = (_detail_requests(), evidence, callback)
        except Exception:
            self._details = None

    def _suffix(self, stamp, cause):
        if self._details is None:
            return ''
        requests, evidence, callback = self._details
        future = Future()
        try:
            requests.put_nowait((callback, stamp, cause, evidence.copy(), future))
            return future.result(timeout=DETAIL_BUDGET_S)
        except Exception:
            future.cancel()
            return ''

    def healthy(self, at=None):
        try:
            self.last_healthy = self.now() if at is None else at
        except Exception:
            pass

    def emit(self, kind, cause, source='agent'):
        try:
            if kind not in ('stop', 'lock', 'release'):
                return
            source = 'server' if source == 'server' else 'agent'
            allowed = SERVER_CAUSES if source == 'server' else AGENT_CAUSES
            cause = cause if isinstance(cause, str) and cause in allowed else 'unknown'
            stamp = self.now()
            key = (kind, cause, source)
            if key in self.last and stamp-self.last[key] < 1.:
                return
            self.last[key] = stamp
            held_ms = -1 if self.last_healthy is None else max(0, int((stamp-self.last_healthy)*1000))
            suffix = self._suffix(stamp, cause) if kind == 'lock' else ''
            logging.getLogger('foothold_agent.lock').warning(
                'GO2_LOCK kind=%s cause=%s source=%s held_ms=%d%s', kind, cause, source, held_ms, suffix)
        except Exception:
            pass  # Logging must never prevent STOP or release.
