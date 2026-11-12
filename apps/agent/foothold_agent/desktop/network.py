"""Opt-in NetworkManager shell; never relax setup.discovery's DDS NIC rules.

Only metadata is read here. NetworkManager's single-address IPv4 DAD, enabled
on the new profile, must succeed before an address is used (no subnet scans).
"""
from ipaddress import IPv4Interface
from pathlib import Path
import re
import subprocess
import uuid

from foothold_agent.setup.discovery import query, ROBOT_NETWORK


def available(*, query_fn=query, sysfs=Path('/sys/class/net'), ipv6_defaults=None):
    rows = query_fn('address', 'show')
    routes = query_fn('route', 'show', 'table', 'all')
    if ipv6_defaults is None:
        import json
        result = subprocess.run(['ip', '-j', '-6', 'route', 'show', 'table', 'all'],
                                check=True, capture_output=True, text=True, timeout=2)
        ipv6_defaults = json.loads(result.stdout)
    defaults = {r.get('dev') for r in routes+ipv6_defaults if r.get('dst') == 'default'}
    choices = []
    for row in rows:
        name = row.get('ifname', '')
        # No shared network, default route, virtual NIC, Wi-Fi, down cable, or
        # robot address. Configuration is offered only before any DDS session.
        if (not re.fullmatch(r'[A-Za-z0-9_.:-]{1,15}', name) or name in defaults
                or row.get('link_type') != 'ether' or row.get('operstate') != 'UP'
                or not (sysfs/name/'device').exists() or (sysfs/name/'wireless').exists()):
            continue
        addresses = [a for a in row.get('addr_info', []) if a.get('family') == 'inet']
        if any(IPv4Interface(f"{a['local']}/{a['prefixlen']}").network != ROBOT_NETWORK
               or a['local'] in ('192.168.123.161', '192.168.123.18') for a in addresses):
            continue
        mac = row.get('address', '')
        if re.fullmatch(r'(?:[0-9a-f]{2}:){5}[0-9a-f]{2}', mac):
            choices.append({'name':name, 'mac':mac})
    return choices


def free_address(query_fn=query):
    # Avoid known local/neighbor addresses. An unknown occupied address is
    # caught by NM's duplicate-address detection before activation succeeds.
    used = {'192.168.123.161', '192.168.123.18'}
    for row in query_fn('address', 'show'):
        used.update(a['local'] for a in row.get('addr_info', []) if a.get('family') == 'inet')
    used.update(row.get('dst') for row in query_fn('neigh', 'show'))
    for host in range(200, 255):
        address = f'192.168.123.{host}'
        if address not in used:
            return address
    raise ValueError('no unused address in the reserved laptop range')


def command(*args):
    # The running graphical session's Polkit agent supplies a password dialog;
    # never --ask (which prompts on a terminal), sudo, a shell, or saved password.
    return subprocess.run(['nmcli', '--wait', '15', *args], check=True,
                          capture_output=True, text=True, timeout=25)


def configure(name, *, discover=available, query_fn=query, run=command):
    choices = [c for c in discover() if c['name'] == name]
    if len(choices) != 1:
        raise PermissionError('wired connection is no longer eligible')
    target = choices[0]
    address = free_address(query_fn)
    ident = str(uuid.uuid4())
    run('connection', 'add', 'type', 'ethernet', 'con-name', 'FOOTHOLD 로봇 '+name,
        'ifname', name, 'connection.uuid', ident,
        '802-3-ethernet.mac-address', target['mac'],
        'connection.autoconnect', 'yes', 'connection.autoconnect-priority', '100',
        'ipv4.method', 'manual', 'ipv4.addresses', address+'/24',
        'ipv4.gateway', '', 'ipv4.never-default', 'yes',
        'ipv4.ignore-auto-routes', 'yes', 'ipv4.ignore-auto-dns', 'yes',
        'ipv4.dad-timeout', '3000', 'ipv6.method', 'disabled', 'ipv6.never-default', 'yes')
    try:
        # Re-read immediately before activation: refuse if Wi-Fi/default/shared
        # addressing appeared while the privilege dialog was open.
        if target not in discover():
            raise PermissionError('wired connection changed during authorization')
        run('connection', 'up', 'uuid', ident, 'ifname', name)
    except Exception:
        # Delete only the profile created by this call, never an existing one.
        try:
            run('connection', 'delete', 'uuid', ident)
        except Exception:
            pass
        raise
    return address
