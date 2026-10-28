"""Private deployment catalogue, never bundled worlds, maps or credentials."""
from dataclasses import dataclass, field
import json
import logging
import ipaddress
import os
from pathlib import Path
from uuid import UUID
from urllib.parse import urlsplit

from .environment import validate_control_environment
from foothold_agent.phone.origins import with_tunnel_origin
from apps.contracts.models import SimWorld
from apps.contracts.simulation_ports import allowed_ports, extra_ports_from_env


@dataclass(frozen=True)
class World:
    id: str
    world_file: Path
    map_file: Path
    name: str | None = None
    description: str = ''
    map_bindings: tuple[dict, ...] = ()  # runtime-only, populated by the authenticated server

    def __post_init__(self):
        name = self.id if self.name is None else self.name
        SimWorld(id=self.id, name=name, description=self.description)
        if self.name is None:
            logging.getLogger(__name__).warning('Catalogue world %s has no name; using id', self.id)
            object.__setattr__(self, 'name', name)


@dataclass(frozen=True)
class Slot:
    robot_id: str
    org_id: str
    key_path: str = field(repr=False)
    replay_path: str = field(repr=False)
    port: int

    @property
    def namespace(self):
        return '/sim/r_' + self.robot_id.replace('-', '')


@dataclass(frozen=True)
class Settings:
    worlds: dict[str, World]
    slots: dict[str, Slot]
    secret: str = field(repr=False)
    agent_host: str = '127.0.0.1'
    host: str = '127.0.0.1'
    port: int = 9430
    max_robots: int = 2
    real: bool = False
    domain: int = 93
    source: str | None = None
    ros_setup: str | None = None
    run_dir: str | None = None
    agent_python: str = '/usr/bin/python3'
    agent_ws_url: str = field(default='ws://127.0.0.1:9431/api/v1/agent/ws', repr=False)
    origins: tuple[str, ...] = ()
    extra_ports: tuple[int, ...] = ()
    runtime_seconds: int = 1800
    scenario_data_origin: str | None = field(default=None, repr=False)
    arrival_pose_max_age_s: float | None = None

    @property
    def unit_runtime_seconds(self):
        # STOP/zero (15s + forced-exit attempts) and native close (55s + join)
        # must finish before the watchdog's five-second early interrupt.
        return self.runtime_seconds + 90

    def __post_init__(self):
        from .run_environment import scenario_origin
        scenario_origin(self)
        if self.arrival_pose_max_age_s is not None:
            import math
            if not math.isfinite(self.arrival_pose_max_age_s) or self.arrival_pose_max_age_s <= 0:
                raise ValueError('arrival pose maximum age must be positive and finite')
        if type(self.runtime_seconds) is not int or not 5 <= self.runtime_seconds <= 3600:
            raise ValueError('simulation runtime must be 5..3600 seconds')
        if self.real and self.runtime_seconds < 300:
            raise ValueError('native simulation runtime must be 300..3600 seconds')
        ports_allowed = allowed_ports(self.extra_ports)
        if self.domain != 93:
            raise ValueError('simulation domain must be 93')
        if self.host != '127.0.0.1' or type(self.port) is not int or self.port not in ports_allowed:
            raise ValueError('manager requires loopback and approved port range')
        if not 32 <= len(self.secret) <= 256 or not self.secret.isascii() or any(ord(c) < 33 for c in self.secret) or not 1 <= self.max_robots <= 2:
            raise ValueError('private service credential and robot cap 1..2 required')
        if not self.worlds or not self.slots or len(self.slots) > 2:
            raise ValueError('catalogue requires worlds and at most two provisioned slots')
        ports = [slot.port for slot in self.slots.values()]
        if len(set(ports)) != len(ports) or self.port in ports or any(type(p) is not int or p not in ports_allowed for p in ports):
            raise ValueError('separate agent ports in approved range required')
        for rid, slot in self.slots.items():
            if str(UUID(rid)) != rid or slot.robot_id != rid or str(UUID(slot.org_id)) != slot.org_id:
                raise ValueError('canonical slot identity required')
        address = ipaddress.ip_address(self.agent_host)
        if str(address) != '127.0.0.1':
            raise ValueError('explicit local IPv4 agent interface required')
        parsed = urlsplit(self.agent_ws_url)
        if (parsed.scheme not in ('ws', 'wss') or parsed.hostname != '127.0.0.1'
                or parsed.port not in ports_allowed or parsed.username is not None or parsed.password is not None
                or parsed.path != '/api/v1/agent/ws' or parsed.query or parsed.fragment):
            raise ValueError('agent server requires loopback URL in approved port range')
        if self.real and not all((self.source, self.ros_setup, self.run_dir)):
            raise ValueError('real launcher requires explicit source/setup/evidence paths')

    @classmethod
    def from_env(cls, env=None):
        env = os.environ if env is None else env
        # Conflicts are rejected even in fake mode; no silent replacement of 61.
        validate_control_environment(env)
        from .sysroot_environment import validate_server
        validate_server(env)
        if (env.get("FH_SIM_DEPLOY_GUARD_DIR") == "/var/lib/foothold-sim/guard"
                and env.get("FH_SIM_RUN") == "1"
                and env.get("FH_SIM_PROC_PROOF_SOCKET") != "/run/foothold-sim-proof.sock"):
            raise ValueError("server native simulation requires fixed OS proof socket")
        data = json.loads(Path(env['FH_SIM_CATALOG']).read_text())
        worlds = {w['id']: World(w['id'], Path(w['world_file']), Path(w['map_file']),
                                **{key: w[key] for key in ('name', 'description') if key in w})
                  for w in data['worlds']}
        slots = {s['robot_id']: Slot(**s) for s in data['slots']}
        if len(worlds) != len(data['worlds']) or len(slots) != len(data['slots']):
            raise ValueError('duplicate catalogue entry')
        secret = Path(env['FH_SIM_AUTH_FILE'])
        # Reuse the established no-symlink/private-file loader validation.
        from foothold_agent.phone.tickets import private_file
        with os.fdopen(private_file(str(secret)), 'rb') as stream:
            credential = stream.read(257).decode().strip()
        return cls(worlds, slots, credential, agent_host=env.get('FH_SIM_AGENT_HOST', '127.0.0.1'),
                   port=int(env.get('FH_SIM_PORT', '9430')), max_robots=int(env.get('FH_SIM_MAX_ROBOTS', '2')),
                   real=env.get('FH_SIM_RUN') == '1', domain=int(env.get('FH_SIM_DOMAIN', '93')), source=env.get('SIM_SOURCE'),
                   ros_setup=env.get('SIM_ROS_SETUP'), run_dir=env.get('SIM_RUN_DIR'),
                   agent_python=env.get('FH_SIM_AGENT_PYTHON', '/usr/bin/python3'),
                   agent_ws_url=env['FH_SIM_AGENT_WS_URL'],
                   origins=with_tunnel_origin(tuple(json.loads(env.get('FOOTHOLD_PHONE_ORIGINS', '[]'))), env),
                   extra_ports=extra_ports_from_env(env),
                   runtime_seconds=int(env.get('FH_SIM_RUNTIME_SECONDS', '1800')),
                   scenario_data_origin=env.get('FOOTHOLD_SCENARIO_DATA_ORIGIN'),
                   arrival_pose_max_age_s=(float(env['FH_RUN_ARRIVAL_POSE_MAX_AGE_S'])
                       if 'FH_RUN_ARRIVAL_POSE_MAX_AGE_S' in env else None))
