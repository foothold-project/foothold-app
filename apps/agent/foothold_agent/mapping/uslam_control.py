"""Single outstanding String command, no retries and no inferred acknowledgments."""
import logging
import time
from datetime import datetime, timezone
from foothold_agent.go2_direct.uslam_source import ALLOWED

LOG = logging.getLogger(__name__)


class Control:
    def __init__(self, publish, *, enabled=lambda: False, now=time.monotonic, timeout=10., acknowledgments=None):
        self.publish, self.enabled, self.now, self.timeout = publish, enabled, now, timeout
        self.acknowledgments = acknowledgments or {}
        self.seen = set()
        self.pending = None
        self.status = 'IDLE'
        self.published_at = self.ack_at = None

    def request(self, command, identity):
        LOG.warning('USLAM command_received op=%s monotonic=%.6f utc=%s', command if command in ALLOWED else 'invalid', self.now(), datetime.now(timezone.utc).isoformat())
        if command not in ALLOWED or identity in self.seen or self.pending is not None:
            return False
        if len(self.seen) >= 4096:
            self.status = 'UNKNOWN'
            return False
        self.seen.add(identity)  # denied/failed requests are never replayed either
        if not self.enabled():
            self.status = 'DISABLED'
            return False
        self.pending = command
        self.status, self.published_at, self.ack_at = 'WAITING', self.now(), None
        try:
            self.publish(command)
        except Exception:
            self.pending, self.status = None, 'UNKNOWN'
            return False
        LOG.warning('USLAM published op=%s monotonic=%.6f utc=%s', command, self.published_at, datetime.now(timezone.utc).isoformat())
        return True

    def on_log(self, value, received):
        # No regex/substring success guess. Firmware-specific exact replies
        # require an explicit verified configuration. Unrelated logs do nothing.
        if (self.pending is not None and self.published_at < received <= self.now()
                and self.now()-self.published_at <= self.timeout
                and self.acknowledgments.get(self.pending) == value):
            self.ack_at, self.pending, self.status = received, None, 'ACKNOWLEDGED'
            LOG.warning('USLAM response monotonic=%.6f utc=%s', received, datetime.now(timezone.utc).isoformat())

    def tick(self):
        if self.pending is not None and self.now()-self.published_at >= self.timeout:
            self.pending, self.status = None, 'UNKNOWN'
        return self.status

    def disconnect(self):
        if self.pending is not None or self.status == 'ACKNOWLEDGED':
            self.status = 'UNKNOWN'
        self.pending = None
