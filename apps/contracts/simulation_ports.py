"""Shared loopback simulation port allowlist; no network access."""
import os


def extra_ports_from_env(env=None):
    env = os.environ if env is None else env
    raw = env.get('FH_SIM_EXTRA_PORTS', '')
    if not raw.strip():
        return ()
    parts = [part.strip() for part in raw.split(',')]
    if any(not part.isascii() or not part.isdecimal() for part in parts):
        raise ValueError('FH_SIM_EXTRA_PORTS requires comma-separated port numbers')
    ports = tuple(int(part) for part in parts)
    allowed_ports(ports)
    return ports


def allowed_ports(extra_ports=()):
    if any(type(port) is not int or not 1 <= port <= 65535 or port in (8453, 8792)
           for port in extra_ports):
        raise ValueError('invalid or protected simulation port')
    return frozenset(range(9430, 9450)).union(extra_ports)
