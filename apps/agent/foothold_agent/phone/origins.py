"""Exact, opt-in development origin for the simulation preview transport."""
import logging
import re


def with_tunnel_origin(origins, env):
    if env.get('FH_TUNNEL') != '1':
        return origins
    origin = env.get('FH_TUNNEL_ORIGIN', '')
    if not re.fullmatch(r'https://[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.trycloudflare\.com', origin):
        logging.getLogger(__name__).warning('Invalid FH_TUNNEL_ORIGIN; tunnel origin disabled')
        return origins
    return origins if origin in origins else (*origins, origin)
