"""Explicit development Quick Tunnel origin; no forwarded-header trust."""
import logging
import re


def tunnel_origin(env):
    if env.get('FH_TUNNEL') != '1':
        return None
    origin = env.get('FH_TUNNEL_ORIGIN', '')
    if not re.fullmatch(r'https://[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.trycloudflare\.com', origin):
        logging.getLogger(__name__).warning('Invalid FH_TUNNEL_ORIGIN; tunnel origin disabled')
        return None
    return origin
