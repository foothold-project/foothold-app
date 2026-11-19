"""Read the handset packed into Go2 LowState, on the existing robot NIC."""
import math
import os
import struct
import threading


class RemoteActivity:
    def __init__(self, now, *, deadband, hold_s):
        if not (0 < deadband < 1 and 0 < hold_s and math.isfinite(hold_s)):
            raise ValueError('invalid Go2 remote deadband or hold duration')
        self.now, self.deadband, self.hold_s = now, deadband, hold_s
        self._lock = threading.Lock()
        self._last_sample = self._last_activity = float('-inf')

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

    def snapshot(self):
        """Unknown/active/idle and the most recent activity, even across a slow RPC."""
        with self._lock:
            stamp = self.now()
            active = (stamp - self._last_activity < self.hold_s
                      if 0 <= stamp - self._last_sample < self.hold_s else None)
            return active, self._last_activity
