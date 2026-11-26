"""Read the handset packed into Go2 LowState, on the existing robot NIC."""
import math
import os
import struct
import threading

# 공식 정의 없음, 실측 근거: RS-REMOTE-STOP / RS-REMOTE-STATES.
# 2010 followed Classic; 1002 followed L2+A; 1001/2006 followed handset use.
# These are SportModeState.error_code values, NOT sport RPC API identifiers.
REMOTE_MOTION_STATES = frozenset((1001, 1002, 2006, 2010))


class RemoteActivity:
    def __init__(self, now, *, deadband, hold_s):
        if not (0 < deadband < 1 and 0 < hold_s and math.isfinite(hold_s)):
            raise ValueError('invalid Go2 remote deadband or hold duration')
        self.now, self.deadband, self.hold_s = now, deadband, hold_s
        self._lock = threading.Lock()
        self._last_sample = self._last_activity = float('-inf')
        self._state_received = float('-inf')
        self._last_state_activity = float('-inf')
        self._state_active = False

    def observe_state(self, motion_state, received):
        with self._lock:
            self._state_received = received
            self._state_active = motion_state in REMOTE_MOTION_STATES
            if self._state_active:
                self._last_state_activity = received

    @classmethod
    def configured(cls, now):
        return cls(now, deadband=float(os.getenv('FH_GO2_REMOTE_DEADBAND', '.15')),
                   hold_s=float(os.getenv('FH_GO2_REMOTE_HOLD_S', '.5')))

    def observe(self, data, received):
        # unitree_sdk2_python/example/wireless_controller/wireless_controller.py
        # Button mask at 2..3, little-endian floats lx, rx, ry, unused L2, ly.
        if not isinstance(data, (bytes, bytearray, list, tuple)) or len(data) != 40:
            return
        try:
            packet = bytes(data)
        except (TypeError, ValueError, OverflowError):
            return
        axes = struct.unpack_from('<fff4xf', packet, 4)
        if not all(math.isfinite(axis) and abs(axis) <= 1 for axis in axes):
            return
        with self._lock:
            self._last_sample = received
            if packet[2] or packet[3] or any(abs(axis) > self.deadband for axis in axes):
                self._last_activity = received

    def snapshot(self, *, include_state=True):
        """Unknown/active/idle and the most recent activity, even across a slow RPC."""
        with self._lock:
            stamp = self.now()
            active = (stamp - self._last_activity < self.hold_s
                      if 0 <= stamp - self._last_sample < self.hold_s else None)
            if include_state and self._state_active and 0 <= stamp-self._state_received < self.hold_s:
                active = True
            return active, (max(self._last_activity, self._last_state_activity)
                            if include_state else self._last_activity)

    def state_active(self):
        with self._lock:
            return self._state_active and 0 <= self.now()-self._state_received < self.hold_s
