"""Local, nonblocking ports. Hardware/ROS and Nav2 implementations are out of scope."""

from typing import Protocol

from .session import MotionCommand


class MotionSink(Protocol):
    def apply(self, command: MotionCommand) -> None:
        """Apply once, without blocking. An unlock is a request, not feedback.

        The bridge must subsequently feed Session.on_robot_state(). Never claim
        a successful physical stop from the returned command or network state.

        The sink MUST independently command zero / StopMove if no new `apply`
        arrives within 0.3 s, including when the owning event loop is blocked.
        `stop` / `unlock` calls must not refresh that independent apply watchdog.
        This is a required hardware-adapter contract, not implemented by Client.
        """
        ...


class Executor(Protocol):
    def poll(self, run: dict | None) -> tuple[float, float, float] | None:
        """Return normalized local axes at 20 Hz, 0 while waiting; None if silent.

        run is a copy of the session snapshot. Starting Nav2 or interpreting a
        plan belongs to the later executor implementation, never the WS client.
        """
        ...
