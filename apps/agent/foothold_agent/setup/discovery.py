"""Kernel metadata queries only: no interface changes, ARP, ping or port scans."""
from dataclasses import dataclass
from ipaddress import IPv4Interface, IPv4Network
import json
import os
from pathlib import Path
import re
import subprocess

ROBOT_NETWORK = IPv4Network('192.168.123.0/24')


@dataclass(frozen=True)
class NIC:
    name: str
    index: int
    mac: str
    addresses: tuple
    dds_name: str | None = None  # Windows FriendlyName; name stays socket.if_nameindex identity


def query(*args):
    # A family filter drops link_type/MAC and interfaces without that family.
    # Address consumers select inet entries after retaining full link metadata.
    family = [] if args and args[0] == 'address' else ['-4']
    result = subprocess.run(['ip', '-j', *family, *args], check=True,
                            capture_output=True, text=True, timeout=.15)
    if len(result.stdout) > 65536:
        raise ValueError('network metadata exceeds limit')
    return json.loads(result.stdout)


def candidates(*, query_fn=query, sysfs=Path('/sys/class/net')):
    if os.name == 'nt':
        from foothold_agent.desktop.windows import candidates as windows_candidates
        return windows_candidates()
    rows = query_fn('address', 'show')
    routes = query_fn('route', 'show', 'table', 'all')
    if not isinstance(rows, list) or not isinstance(routes, list):
        raise ValueError('invalid network metadata')
    defaults = {row.get('dev') for row in routes if row.get('dst') == 'default'}
    found = []
    for row in rows:
        name = row.get('ifname', '')
        if (not re.fullmatch(r'[A-Za-z0-9_.:-]{1,15}', name) or name in defaults
                or row.get('link_type') != 'ether' or row.get('operstate') != 'UP'
                or not (sysfs/name/'device').exists() or (sysfs/name/'wireless').exists()):
            continue
        addresses = tuple(sorted((a['local'], a['prefixlen']) for a in row.get('addr_info', [])
                                 if a.get('family') == 'inet'))
        if not addresses or any(IPv4Interface(f'{a}/{p}').network != ROBOT_NETWORK
                                or a in ('192.168.123.161', '192.168.123.18') for a, p in addresses):
            continue
        index, mac = row.get('ifindex'), row.get('address')
        if type(index) is not int or not isinstance(mac, str):
            continue
        found.append(NIC(name, index, mac, addresses))
    return found


def select(found, name=None):
    choices = [nic for nic in found if name is None or nic.name == name]
    if len(choices) != 1:
        raise PermissionError('one dedicated wired robot NIC required')
    return choices[0]
