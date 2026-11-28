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


def ws_origin_allowed(settings, ws):
    """Exact Origin match for cookie WebSockets (screen and drive-media viewer).

    FH_WS_ORIGIN is a comma separated list of exact origins; entries are
    trimmed and empty ones dropped. No wildcard, prefix, case or slash
    folding: the whole header must equal one entry. An empty list keeps the
    same-origin default. The validated tunnel origin is always allowed too.
    """
    origin = ws.headers.get('origin')
    allowed = tuple(value.strip() for value in (settings.ws_origin or '').split(',') if value.strip())
    if not allowed:
        allowed = (str(ws.base_url).rstrip('/').replace('wss:', 'https:').replace('ws:', 'http:'),)
    return bool(origin) and (origin in allowed or origin == settings.tunnel_origin)
