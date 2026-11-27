"""Demo registration config, kept apart from the real robot setup.

Real robots pair by QR and keep one token (setup/, FOOTHOLD_AGENT_TOKEN). Demo
robots never use that path: each demo robot is registered on the server as a
demo robot (server-side demo flag, contract I) and its token sits in its own
file named here. The file must say `demo: true`, so a real robot config cannot
be pointed at this runner by mistake. Token values are never logged.

    demo: true
    url: wss://server.example/api/v1/agent/ws
    robots:
      go2-a: {token_file: /home/USER/.config/foothold-demo/go2-a.token}
    floors:            # optional: server ids for the scenario's site.floors
      f1: {floor_id: <uuid>, map_version_id: <uuid>}
"""
import os

from foothold_agent.link.client import Settings


class ConfigError(ValueError):
    pass


def load(path, robot_ids):
    import yaml
    with open(path, encoding='utf-8') as fh:
        doc = yaml.safe_load(fh)
    return parse(doc, robot_ids, base=os.path.dirname(os.path.abspath(path)))


def floors(path):
    """Scenario floor id -> {floor_id, map_version_id} from the config, or {}."""
    import yaml
    with open(path, encoding='utf-8') as fh:
        doc = yaml.safe_load(fh)
    value = doc.get('floors', {}) if isinstance(doc, dict) else {}
    if not isinstance(value, dict) or not all(
            isinstance(v, dict) and set(v) == {'floor_id', 'map_version_id'} for v in value.values()):
        raise ConfigError('floors must map scenario floor id -> {floor_id, map_version_id}')
    return value


def parse(doc, robot_ids, *, base='.'):
    if not isinstance(doc, dict) or doc.get('demo') is not True:
        raise ConfigError('demo config must contain `demo: true`')
    if os.environ.get('FOOTHOLD_AGENT_TOKEN'):
        # The real agent's token in the environment means this shell is set up
        # for a real robot; refuse instead of guessing which identity is meant.
        raise ConfigError('FOOTHOLD_AGENT_TOKEN is set; run the demo agent from a clean environment')
    robots = doc.get('robots')
    if not isinstance(robots, dict):
        raise ConfigError('robots must map scenario robot id -> {token_file}')
    missing = [r for r in robot_ids if r not in robots]
    unknown = [r for r in robots if r not in robot_ids]
    if missing or unknown:
        raise ConfigError(f'robots mismatch: missing {missing}, not in scenario {unknown}')
    settings, seen = {}, {}
    for rid in robot_ids:
        entry = robots[rid]
        token_file = entry.get('token_file') if isinstance(entry, dict) else None
        if not isinstance(token_file, str) or not token_file:
            raise ConfigError(f'{rid}: token_file required (no inline tokens)')
        token_file = os.path.join(base, os.path.expanduser(token_file))
        try:
            with open(token_file, encoding='utf-8') as fh:
                token = fh.read().strip()
        except OSError as exc:
            raise ConfigError(f'{rid}: cannot read token_file ({type(exc).__name__})') from None
        if token in seen:
            raise ConfigError(f'{rid}: same token as {seen[token]}; each demo robot needs its own')
        seen[token] = rid
        try:
            settings[rid] = Settings(url=doc.get('url', ''), token=token)
        except ValueError as exc:
            raise ConfigError(f'{rid}: {exc}') from None
    return settings
