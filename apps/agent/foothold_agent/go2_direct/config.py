"""Field configuration; validation never imports the SDK or opens a socket."""

from dataclasses import dataclass, field
import os
import re
from ipaddress import IPv4Address, IPv4Network

from foothold_agent.phone.server import Settings as PhoneSettings
from foothold_agent.phone.tickets import uuid, load_keys, Verifier
from foothold_agent.link.client import Settings as LinkSettings
from .approval import Approval, validate


@dataclass
class Config:
    approval: Approval
    robot: str
    phone: PhoneSettings | None
    verifier: Verifier | None = field(repr=False)
    link: LinkSettings | None = field(default=None, repr=False)
    server: bool = False

    @classmethod
    def from_env(cls, env=None, *, server=False):
        env = os.environ if env is None else env
        approval = validate(env)  # disabled/absent marker: zero SDK imports
        if (env.get('FH_GO2_DEDICATED_NIC') != '1' or
                not re.fullmatch(r'(0|[1-9][0-9]*)-(0|[1-9][0-9]*)', approval.robot_serial) or
                any(int(part) > 0xFFFFFFFF for part in approval.robot_serial.split('-'))):
            raise ValueError('dedicated robot NIC and canonical DDS serial required')
        robot = uuid(env.get('FOOTHOLD_ROBOT_ID'))
        if server:
            # No phone listener, credentials or second command source in this mode.
            link = LinkSettings(env.get('FOOTHOLD_AGENT_WS_URL', ''),
                                env.get('FOOTHOLD_AGENT_TOKEN', ''))
            return cls(approval, robot, None, None, link, True)
        phone = PhoneSettings.from_env(env)
        if phone is None or phone.simulation:
            raise ValueError('explicit physical phone configuration required')
        address = IPv4Address(phone.host)
        if not (address.is_loopback or address.is_link_local or any(
                address in IPv4Network(net) for net in ('10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'))):
            raise ValueError('explicit private phone LAN IPv4 required')
        # A registration token is optional. Partial cloud configuration is an
        # error, never a reason to silently disable requested reporting.
        link = None
        if env.get('FH_GO2_CLOUD_REPORTING', '0') not in ('0', '1'):
            raise ValueError('explicit cloud reporting flag required')
        if env.get('FH_GO2_CLOUD_REPORTING') == '1':
            link = LinkSettings(env.get('FOOTHOLD_AGENT_WS_URL', ''),
                                env.get('FOOTHOLD_AGENT_TOKEN', ''))
        keys = load_keys(phone.key_path)
        verifier = Verifier(robot, keys, org=phone.org, replay_path=phone.replay_path,
                            clock_trusted=phone.clock_trusted)
        return cls(approval, robot, phone, verifier, link)
