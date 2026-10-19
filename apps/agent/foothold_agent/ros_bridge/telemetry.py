"""Measured values with separate simulation time, receipt time and map identity.

Snapshots are local input to Session; provenance never adds wire-contract fields.
"""

from collections import deque
from copy import deepcopy
from dataclasses import dataclass
import math
import time

from foothold_agent.safety.core import NUM, STATE_STALE, clean_state, finite


def number(value):
    try:
        return finite(value)
    except OverflowError:
        return False


class StateGate:
    """ROS-thread validator. A rewind quarantines an episode until a newer episode.

    Identical contents at equal stamps are ignored. Changed safety gates are
    conservative until source progress; receive time never replaces progress age.
    """

    def __init__(self):
        self.episode = None
        self.sim_t = None
        self.quarantined = False
        self.reason = "unseen"
        self.advanced = False
        self.progress_at = None
        self._last_input = self._conservative = None

    def accept(self, raw, received_at, now):
        self.advanced = False
        try:
            cleaned = clean_state(raw)
        except (OverflowError, TypeError):
            cleaned = None
        if (cleaned is None or not number(received_at) or not number(now)
                or not 0 <= now - received_at <= STATE_STALE):
            self.reason = "invalid_or_stale"
            return None
        if (raw["episode"] < 0 or not number(raw.get("sim_t")) or raw["sim_t"] < 0
                or any(k in raw and raw[k] is not None and not number(raw[k]) for k in NUM)
                or (raw.get("cmd_applied") is not None and cleaned["cmd_applied"] is None)):
            self.reason = "invalid_measurement"
            return None
        ep, stamp = cleaned["episode"], cleaned["sim_t"]
        if self.episode is not None and ep < self.episode:
            self.reason = "old_episode"
            return None
        if ep != self.episode:
            self.episode, self.sim_t, self.quarantined = ep, None, False
            self._last_input = self._conservative = None
        if self.quarantined:
            self.reason = "time_rewind"
            return None
        if self.sim_t is not None and stamp < self.sim_t:
            self.quarantined = True
            self.reason = "time_rewind"
            return None
        if self.sim_t is not None and stamp == self.sim_t:
            if cleaned == self._last_input:
                self.reason = "duplicate_stamp"
                return None
            self._last_input = dict(cleaned)
            # Same-clock recovery cannot erase a safety observation. Only source
            # progress may replace it; Core still requires its own resume/neutral.
            cleaned["stop_requested"] |= self._conservative["stop_requested"]
            cleaned["reset_in_progress"] |= self._conservative["reset_in_progress"]
            cleaned["policy_running"] &= self._conservative["policy_running"]
            if self._conservative.get("fallen"):
                cleaned["fallen"] = True  # show the edge once; no same-stamp recovery
            self.reason = "same_stamp_update"
        else:
            self.sim_t = stamp
            self.progress_at = received_at
            self.advanced = True
            self._last_input = dict(cleaned)
            self.reason = "reset" if cleaned["reset_in_progress"] else "accepted"
        self._conservative = dict(cleaned)
        # Preserve schema for Core.clean_state; cleaned itself intentionally omits it.
        return {"schema": raw["schema"], **cleaned}


@dataclass(frozen=True)
class MapBinding:
    """Explicitly verified map registration, never inferred from odom or a floor name."""

    world_id: str
    ros_floor_id: str
    ros_map_version: str
    floor_id: str
    map_version_id: str
    sha256: str
    episode: int
    run_id: str

    def __post_init__(self):
        from uuid import UUID
        UUID(self.floor_id)
        UUID(self.map_version_id)
        if (len(self.sha256) != 64 or any(c not in "0123456789abcdef" for c in self.sha256)
                or type(self.episode) is not int or self.episode < 0
                or not all(isinstance(x, str) and x for x in (
                    self.world_id, self.ros_floor_id, self.ros_map_version, self.run_id))):
            raise ValueError("invalid verified map binding")


class Telemetry:
    """Owning-loop cache; speed is measured body COM horizontal speed in m/s."""

    def __init__(self, *, now=time.monotonic, binding=None):
        self.now = now
        self.binding = binding
        self.state = None
        self.location = None
        self.odom_reason = "unseen"
        self.odom = None  # base-origin observation, NEVER a substitute for map pose or COM speed
        self.events = deque(maxlen=30)
        self._reason = None
        self._gate = StateGate()
        self._epoch = None
        self._map_stamp = self._odom_stamp = None
        self._map_rewound = self._odom_rewound = False

    def invalidate(self, reason):
        self.state = self.location = self.odom = None
        if reason != self._reason:
            self.events.append({"reason": reason, "received_monotonic_s": self.now()})
        self._reason = reason

    def update_state(self, raw, received_at, *, progress_at=None):
        raw = self._gate.accept(raw, received_at, self.now())
        if raw is None:
            if self._gate.reason == "duplicate_stamp":
                return
            self.invalidate(self._gate.reason)
            return
        if self._epoch != raw["episode"]:
            self._epoch = raw["episode"]
            self._map_stamp = self._odom_stamp = None
            self._map_rewound = self._odom_rewound = False
        if raw["reset_in_progress"]:
            self.invalidate("reset")
            return
        if self.state and self.state["episode"] != raw["episode"]:
            self.invalidate("episode_changed")
        self._reason = None
        self.state = {"episode": raw["episode"], "sim_t": raw["sim_t"],
                      "received_monotonic_s": received_at,
                      "progress_monotonic_s": self._gate.progress_at if progress_at is None else progress_at,
                      "vx": raw.get("vx"),
                      "vy": raw.get("vy"), "source": raw.get("source"), "clock": "simulation"}

    def update_odom(self, sample):
        # No episode field exists on ROS Odometry. Associate only with current
        # accepted state, a coherent sim stamp, and the same receipt freshness.
        s = self.state
        if sample.get("clock") != "simulation":
            self.odom = None
            self.odom_reason = "clock_unverified"
            return
        self.odom_reason = "invalid_or_stale"
        if (s is None or sample.get("frame_id") != "odom" or sample.get("child_frame_id") != "base"
                or not self._coherent(sample.get("sim_t"), sample.get("received_monotonic_s"))
                or not all(number(sample.get(k)) for k in ("x", "y", "vx", "vy", "wz"))):
            self.odom = None
            return
        stamp = sample["sim_t"]
        if self._odom_stamp is not None and stamp < self._odom_stamp:
            self._odom_rewound = True
        if self._odom_rewound:
            self.odom = None
            return
        self._odom_stamp = stamp
        self.odom_reason = None
        self.odom = {**deepcopy(sample), "episode": s["episode"], "source": "odom_base"}

    def _coherent(self, stamp, receipt):
        s = self.state
        return (s is not None and number(stamp) and number(receipt)
                and 0 <= self.now() - receipt <= STATE_STALE
                and 0 <= self.now() - s["received_monotonic_s"] <= STATE_STALE
                and 0 <= self.now() - s["progress_monotonic_s"] <= STATE_STALE
                and 0 <= s["sim_t"] - stamp <= STATE_STALE)

    def update_map(self, status, received_at):
        self.location = None
        b, s = self.binding, self.state
        if not isinstance(status, dict) or b is None or s is None:
            return
        p = status.get("pose_map")
        if (status.get("schema") != "v2_map_status/1" or status.get("map_frame") != "map"
                or type(status.get("epoch")) is not int
                or status["epoch"] != s["episode"] or status["epoch"] != b.episode
                or status.get("world_id") != b.world_id or status.get("floor_id") != b.ros_floor_id
                or status.get("map_version") != b.ros_map_version or status.get("run_id") != b.run_id
                or status.get("map_accepting") is not True or status.get("map_error")
                or status.get("pose_map_null_reason") or not isinstance(p, dict)
                or p.get("source") not in ("slam_tf", "gt_identity")
                or not self._coherent(status.get("sim_t"), received_at)
                or not self._coherent(p.get("stamp_sim"), received_at)
                or not all(number(p.get(k)) for k in ("x", "y", "yaw"))):
            return
        stamp = (status["sim_t"], p["stamp_sim"])
        if self._map_stamp is not None and any(a < b for a, b in zip(stamp, self._map_stamp)):
            self._map_rewound = True
        if self._map_rewound:
            return
        self._map_stamp = stamp
        self.location = {"floor_id": b.floor_id, "map_version_id": b.map_version_id,
                         "sha256": b.sha256, "x": p["x"], "y": p["y"], "yaw": p["yaw"],
                         "confidence": None, "episode": b.episode, "source": p["source"],
                         "clock": "simulation", "progress_monotonic_s": s["progress_monotonic_s"],
                         "sim_t": p["stamp_sim"], "received_monotonic_s": received_at}

    def snapshot(self):
        if self.state and not self._coherent(self.state["sim_t"], self.state["received_monotonic_s"]):
            self.invalidate("stale")
        s = self.state
        speed = math.hypot(s["vx"], s["vy"]) if s and all(number(s[k]) for k in ("vx", "vy")) else None
        if speed is not None and not math.isfinite(speed):
            speed = None
        if self.location and not self._coherent(self.location["sim_t"], self.location["received_monotonic_s"]):
            self.location = None
        return deepcopy({"speed": speed, "speed_source": "state_com" if speed is not None else None,
                         "battery": {"soc": None}, "location": self.location,
                         "observation": s})
