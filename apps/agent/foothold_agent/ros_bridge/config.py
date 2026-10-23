"""Explicit, fail-closed simulation configuration; no discovery or credentials defaults."""

from dataclasses import dataclass, field
import os
import sqlite3
from pathlib import Path
from uuid import UUID

from .floors import FloorBindings
from foothold_agent.link.client import Settings
from foothold_agent.phone.server import Settings as PhoneSettings
from foothold_agent.phone.tickets import load_keys, Verifier

REQUIRED_ENV = {
    "ROS_DOMAIN_ID": "93",
    "ROS_AUTOMATIC_DISCOVERY_RANGE": "LOCALHOST",
    "ROS_LOCALHOST_ONLY": "1",
}
# These can override DDS discovery/interface isolation outside rclpy's context.
DDS_OVERRIDES = (
    "ROS_STATIC_PEERS", "ROS_DISCOVERY_SERVER", "CYCLONEDDS_URI",
    "FASTRTPS_DEFAULT_PROFILES_FILE", "FASTDDS_DEFAULT_PROFILES_FILE",
    "RMW_FASTRTPS_USE_QOS_FROM_XML", "FASTDDS_ENVIRONMENT_FILE",
)


def validate_isolation(env=None):
    env = os.environ if env is None else env
    for name, value in REQUIRED_ENV.items():
        if env.get(name) != value:
            raise ValueError(f"simulation requires {name}={value}")
    if any(env.get(name) for name in DDS_OVERRIDES):
        raise ValueError("custom DDS discovery/profile overrides are forbidden")
    if any(Path(name).exists() for name in ("DEFAULT_FASTDDS_PROFILES.xml", "DEFAULT_FASTRTPS_PROFILES.xml")):
        raise ValueError("automatic DDS profiles in the working directory are forbidden")
    if env.get("RMW_IMPLEMENTATION", "rmw_fastrtps_cpp") not in {
        "rmw_fastrtps_cpp", "rmw_cyclonedds_cpp",
    }:
        raise ValueError("unsupported simulation RMW implementation")


@dataclass(frozen=True)
class Config:
    robot_id: str
    settings: Settings = field(repr=False)
    phone: PhoneSettings | None = field(default=None, repr=False)
    phone_verifier: Verifier | None = field(default=None, repr=False)

    floor_bindings: FloorBindings | None = field(default=None, repr=False)

    @classmethod
    def from_env(cls, env=None):
        env = os.environ if env is None else env
        validate_isolation(env)
        try:
            robot_id = str(UUID(env["FOOTHOLD_ROBOT_ID"]))
            settings = Settings(url=env["FOOTHOLD_AGENT_WS_URL"],
                                token=env["FOOTHOLD_AGENT_TOKEN"])
        except (KeyError, ValueError, AttributeError):
            # Never echo a URL/token (even invalid user input) to logs.
            raise ValueError("set a robot UUID and valid agent WS URL/token in the environment") from None
        phone = PhoneSettings.from_env(env)
        # Validate the key file before any DDS participant or listener exists.
        try:
            keys = load_keys(phone.key_path) if phone is not None else None
            verifier = (Verifier(robot_id, keys, org=phone.org, replay_path=phone.replay_path,
                                 clock_trusted=phone.clock_trusted) if phone is not None else None)
        except (OSError, ValueError, TypeError, sqlite3.Error):
            raise ValueError('invalid phone key configuration') from None
        floors = FloorBindings.from_env(env)
        if floors is not None and floors.robot_id != robot_id:
            raise ValueError('floor bindings robot does not match agent')
        return cls(robot_id, settings, phone, verifier, floors)
