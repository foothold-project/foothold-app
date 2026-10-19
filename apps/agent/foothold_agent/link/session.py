"""Serialized, sans-I/O server session; all deadlines use the injected clock.

Core safety decisions are inherited unchanged. Only its wall-clock/print event
observer is replaced with an in-memory observer. Local state is never invented:
on_robot_state() must receive real bridge feedback before Core can allow motion.
"""

from copy import deepcopy
from dataclasses import dataclass
import json
import time
from typing import Callable

from foothold_agent.safety.core import Core, DEAD, Z, valid_axes

LINK_TIMEOUT = 3.0
REPORT_INTERVAL = 0.1
TERMINAL = {"COMPLETED", "ABORTED", "FAILED"}


def _bounded_number(value, low, high):
    # Compare integers before any float conversion. NaN/inf also fail the range.
    return type(value) in (int, float) and low <= value <= high


def _axes(value, *, local=False):
    types = (list, tuple) if local else (list,)
    if (not isinstance(value, types) or len(value) != 3
            or not all(_bounded_number(x, -1, 1) for x in value)):
        return None
    return valid_axes(dict(zip(("fx", "fy", "fw"), value)))


@dataclass(frozen=True)
class MotionCommand:
    """A bridge action, not a hardware acknowledgement. apply is 20 Hz velocity."""

    kind: str = "apply"  # apply | stop | unlock (one-shot Core-approved request)
    velocity: tuple[float, float, float] = Z


@dataclass(frozen=True)
class Effects:
    motion: tuple[MotionCommand, ...]
    messages: tuple[dict, ...] = ()


class _MemoryCore(Core):
    def ev(self, level, text):
        self.events.appendleft({"t": self.now(), "st": level, "text": text})


class Session:
    """One robot, one serialized caller; no sockets, prints or ROS I/O.

    Frames use the flat {t, ...body} form. Unsupported map/media/SLAM operations
    are ignored: this link cannot download files, execute plans or enable streams.
    The executor and bridge feed their observations through the local methods.
    """

    def __init__(self, now: Callable[[], float] = time.monotonic, *, identity: dict | None = None):
        self.now = now
        self.core = _MemoryCore(now=now)
        self.core.stop("startup")
        self.identity = {
            "agent_version": "0.2.0", "robot_model": None, "firmware": None,
            "devices": [], "map_versions": [], "last_floor_id": None,
            **deepcopy(identity or {}),
        }
        self.lease_id = None
        self.holder_type = None
        self.holder_run_id = None
        self._run_server_cmd_reported = False
        self.lease_confirmed = False
        self.last_seq = -1
        self.connected = False
        self.reconnect_required = False
        self.last_server = None
        self.link_lost = False
        self.run = None
        self.link_loss_wait_s = 30.0
        self.executor_t = None
        self.last_report = float("-inf")
        self.ack_pending = False
        self._messages = []

    def _event(self, code):
        self._messages.append({"t": "event", "code": code, "severity": "warn",
                               "robot_at": None, "data": {"monotonic_s": self.now()}})

    def _run_status(self, status, reason=None):
        if self.run is None or self.run["status"] in TERMINAL:
            return
        self.run.update(status=status, wait_reason=reason)
        self._messages.append({"t": "run.update", "run_id": self.run["run_id"],
                               "status": status, "step": self.run["step"],
                               "progress": None,
                               **({"fail_code": reason} if status == "FAILED" else {})})

    def _pause(self, reason):
        self.core._void()
        self._run_status("PAUSED", reason)

    def _advance(self):
        # Evaluate before handling a new frame: fresh input cannot resurrect an
        # expired intent or cancel an elapsed grace deadline.
        if self.last_server is not None and self.now() - self.last_server >= LINK_TIMEOUT:
            if not self.link_lost:
                self.link_lost = True
                self._event("SERVER_LINK_LOST")
            if (self.holder_type == "RUN" and self.run is not None
                    and self.run["status"] == "RUNNING"
                    and self.now() - self.last_server >= self.link_loss_wait_s):
                self.core.stop("link grace expired")
                self._pause("LINK_LOSS_TIMEOUT")
                self._event("LINK_LOSS_TIMEOUT")
        if (self.holder_type == "RUN" and self.run is not None
                and self.run["status"] not in TERMINAL and self.executor_t is not None
                and self.now() - self.executor_t > DEAD):
            self.core._void()
            self._run_status("FAILED", "EXECUTOR_STALLED")
            self._event("EXECUTOR_STALLED")
        if self.holder_type == "RUN" and (self.run is None or self.run["status"] != "RUNNING"):
            self.core._void()
        self.core.out = self.core.applied()

    def _state(self):
        # Unavailable telemetry stays unknown; it is never reported as measured 0.
        return {"t": "state", "pose": {"floor_id": self.identity["last_floor_id"],
                "x": None, "y": None, "yaw": None, "confidence": None},
                "speed": None, "battery": {"soc": None},
                "latched": self.core.latch, "stop_gen": self.core.stop_gen,
                "applied": list(self.core.out), "mode": self.holder_type or "FREE"}

    def _finish(self, actions=(), *, state=False):
        self._advance()
        messages = []
        if self.connected:
            messages, self._messages = self._messages, []
            if state or self.now() - self.last_report >= REPORT_INTERVAL:
                messages.append(self._state())
                if self.ack_pending:
                    messages.append({"t": "cmd.ack", "seq": self.last_seq,
                                     "applied": list(self.core.out), "reason": self.core.reason})
                    self.ack_pending = False
                self.last_report = self.now()
        # Preserve Core's existing safe STOP publication request; unlock is never retried.
        if self.core.want_stop_pub() and not any(a.kind == "stop" for a in actions):
            actions = tuple(actions) + (MotionCommand("stop"),)
        return Effects(tuple(actions) + (MotionCommand(velocity=self.core.out),),
                       tuple(deepcopy(messages)))

    def connect(self):
        """Stop locally before the adapter sends hello, on *every* connection."""
        self._advance()
        self.core.stop("connection/reconnection")
        if self.run is not None and self.run["status"] not in TERMINAL:
            self._pause("RECONNECTED")
        self.lease_confirmed = False  # hello carries a copy, never authority
        self.connected = True
        self.reconnect_required = False
        self.last_server = self.now()
        self.link_lost = False
        hello = {**deepcopy(self.identity), "t": "hello", "proto": "fh-agent/1", "latched": self.core.latch,
                 "stop_gen": self.core.stop_gen, "lease_id": self.lease_id,
                 "run": deepcopy(self.run)}
        effects = self._finish((MotionCommand("stop"),), state=True)
        return Effects(effects.motion, (hello,) + effects.messages)

    def protocol_mismatch(self):
        self.core.stop("protocol mismatch")
        self._pause("PROTOCOL_MISMATCH")
        self.lease_confirmed = False
        self.reconnect_required = True
        self._event("PROTOCOL_MISMATCH")
        return self._finish((MotionCommand("stop"),), state=True)

    def transport_overflow(self):
        """Drop this transport, retain a stopped snapshot for the next hello."""
        self.connected = False
        self.core.stop("outgoing queue full")
        self._pause("TRANSPORT_BACKPRESSURE")
        self.lease_confirmed = False
        self.reconnect_required = True
        self._event("TRANSPORT_BACKPRESSURE")
        return self._finish((MotionCommand("stop"),))

    def disconnect(self):
        # A socket close doesn't restart the last-frame grace clock. The caller
        # must continue tick() while connecting/backing off.
        self.connected = False
        return self._finish()

    def tick(self):
        return self._finish()

    def shutdown(self):
        self.connected = False
        self.core.stop("client shutdown")
        self._pause("CLIENT_SHUTDOWN")
        return self._finish((MotionCommand("stop"),))

    def on_robot_state(self, raw):
        self._advance()
        self.core.on_state(raw)
        return self._finish()

    def _lease(self, frame):
        lease = frame.get("lease_id")
        holder = frame.get("holder_type")
        run_id = None
        # Architecture names a run owner RUN:<id>; API calls its type RUN.
        # Preserve the qualifier so changing only the owner is still a handoff.
        if isinstance(holder, str) and holder.startswith("RUN:"):
            run_id = holder[4:]
            holder = "RUN" if run_id.strip() else None
        invalid = "lease_id" not in frame or (lease is not None and (
            not isinstance(lease, str) or not lease.strip()
            or holder not in ("USER", "RUN")))
        if invalid:
            self._event("LEASE_INVALID")
        if invalid or lease is None:
            lease, holder, run_id = None, None, None
        changed = lease != self.lease_id or holder != self.holder_type or run_id != self.holder_run_id
        if lease is None or changed:
            if self.core.controller is not None:
                self.core.drop(self.core.controller, "server lease")
            elif invalid:
                self.core.stop("invalid lease")
            else:
                self.core._void()
            if self.holder_type == "RUN":
                self._pause("LEASE_CHANGED")
            self.last_seq = -1
            self.ack_pending = False
            self._run_server_cmd_reported = False
        self.lease_id = lease
        self.holder_type = holder
        self.holder_run_id = run_id
        self.lease_confirmed = lease is not None
        if lease is not None:
            self.core.take(lease)
            if changed and holder == "RUN":
                self.executor_t = self.now()

    def receive(self, frame):
        received_at = self.now()
        self._advance()
        if not self.connected or self.reconnect_required:
            return self._finish()
        if isinstance(frame, (str, bytes)):
            try:
                frame = json.loads(frame)
            except (ValueError, UnicodeError, RecursionError):
                return self._finish()
        if isinstance(frame, dict) and "proto" in frame and frame["proto"] != "fh-agent/1":
            return self.protocol_mismatch()
        if (not isinstance(frame, dict) or not isinstance(frame.get("t"), str)
                or not frame["t"]):
            return self._finish()
        # Coordinator decision: only a parseable application envelope is liveness
        # evidence. Unknown nonempty t is allowed; malformed bodies never gain
        # command authority. Keep receipt time, not the time parsing finished.
        was_lost = self.link_lost
        self.last_server = received_at
        if was_lost:
            return self.connect()
        kind = frame["t"]
        actions = ()
        if kind == "lease":
            self._lease(frame)
        elif kind == "stop":
            self.core.stop("server STOP")  # no lease or user check on STOP
            self._pause("STOP")
            actions = (MotionCommand("stop"),)
        elif kind == "unlock":
            gen = frame.get("stop_gen")
            if (self.lease_confirmed and frame.get("lease_id") == self.lease_id
                    and type(gen) is int and gen >= 0
                    and self.core.resume(self.lease_id, gen)):
                actions = (MotionCommand("unlock"),)
        elif kind == "cmd":
            seq = frame.get("seq")
            if (self.lease_confirmed and self.holder_type == "USER"
                    and frame.get("lease_id") == self.lease_id
                    and type(seq) is int and seq >= 0 and seq > self.last_seq):
                self.last_seq = seq
                self.ack_pending = True
                self.core.cmd(self.lease_id, _axes(frame.get("axes")))
            elif self.holder_type == "RUN":
                # The server cannot overwrite *or invalidate* local executor intent.
                if not self._run_server_cmd_reported:
                    self._event("RUN_SERVER_CMD_IGNORED")
                    self._run_server_cmd_reported = True
            else:
                self.core._void()
        elif kind == "run.start":
            policy = frame.get("policy", {})
            wait = policy.get("link_loss_wait_s", 30) if isinstance(policy, dict) else None
            if (self.lease_confirmed and self.holder_type == "RUN"
                    and isinstance(frame.get("run_id"), str) and frame["run_id"]
                    and self.holder_run_id in (None, frame["run_id"])
                    and (self.run is None or self.run["status"] in TERMINAL)
                    and isinstance(frame.get("plan"), dict)
                    and isinstance(frame["plan"].get("segments"), list)
                    and isinstance(frame.get("missions"), dict)
                    and _bounded_number(wait, 0, 30)):
                self.core._void()
                self.link_loss_wait_s = float(wait)
                self.run = {"run_id": frame["run_id"], "status": "RUNNING", "step": 0}
                self.executor_t = self.now()
                self._run_status("RUNNING")
        elif kind == "run.control" and self.run is not None:
            if frame.get("run_id") == self.run["run_id"] and self.run["status"] not in TERMINAL:
                op = frame.get("op")
                if op in ("pause", "abort"):
                    self._pause("OPERATOR")
                    if op == "abort":
                        self._run_status("ABORTED")
                elif (op == "resume" and self.lease_confirmed and self.holder_type == "RUN"
                      and self.holder_run_id in (None, self.run["run_id"])):
                    self.core._void()
                    self._run_status("RUNNING")
                # return needs a planner: unsupported, never creates motion.
        # ping and unsupported operations have no effect on command authority.
        return self._finish(actions, state=kind in {"lease", "stop", "unlock"})

    def executor_command(self, run_id, axes):
        """Local normalized axes (including 0 at 20 Hz); never a server cmd."""
        self._advance()
        if (self.run is not None and self.run["run_id"] == run_id
                and self.run["status"] not in TERMINAL):
            valid = _axes(axes, local=True)
            if valid is not None:
                self.executor_t = self.now()
            # Executor health is independent of command authority: while waiting
            # for lease reconciliation it must still emit 0, without moving.
            if (self.lease_confirmed and self.holder_type == "RUN"
                    and self.holder_run_id in (None, run_id)):
                self.core.cmd(self.lease_id, valid if self.run["status"] == "RUNNING" else Z)
        return self._finish()

    def waypoint_reached(self, run_id):
        self._advance()
        if (self.link_lost and self.run is not None and self.run["run_id"] == run_id
                and self.run["status"] == "RUNNING"):
            self._pause("LINK_LOSS_WAYPOINT")
        return self._finish()
