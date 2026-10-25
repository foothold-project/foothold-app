"""Episode-independent journal and local, registered map evidence for the agent."""
import hashlib
import json
import math
import os
from pathlib import Path
import stat
from urllib.parse import urlsplit, urlunsplit
from uuid import UUID

from foothold_agent.phone.tickets import private_file


def scenario_origin(settings):
    value = settings.scenario_data_origin
    if value is None:
        ws = urlsplit(settings.agent_ws_url)
        value = urlunsplit(('https' if ws.scheme == 'wss' else 'http', ws.netloc, '', '', ''))
    parsed = urlsplit(value)
    if (parsed.scheme not in ('http', 'https') or not parsed.hostname
            or parsed.username is not None or parsed.password is not None
            or parsed.path or parsed.query or parsed.fragment):
        raise ValueError('scenario data requires a path-free HTTP origin')
    return value


def outbox_path(settings, slot):
    # Sibling of timestamped episodes; stable across robot generations/restarts.
    folder = Path(settings.run_dir).resolve() / 'outbox'
    folder.mkdir(mode=0o700, exist_ok=True)
    if folder.is_symlink() or stat.S_IMODE(folder.stat().st_mode) != 0o700:
        raise ValueError('run outbox directory must be private and not a symlink')
    path = folder / (slot.robot_id + '.sqlite3')
    fd = private_file(str(path), create=True)  # O_NOFOLLOW, ownership, regular file
    try:
        if stat.S_IMODE(os.fstat(fd).st_mode) != 0o600:
            raise ValueError('run outbox file must have mode 0600')
    finally:
        os.close(fd)
    return str(path)


def map_assets(native, bindings, folder):
    """Canonical top-down P5 copies; never flip rows or apply experimental v5 hashes."""
    from apps.server.fh_server.map_files import gray_pixels, map_yaml, pgm_png, yaml_bytes

    result = []
    for binding in bindings:
        if str(UUID(binding['map_version_id'])) != binding['map_version_id']:
            raise ValueError('canonical map version UUID required')
        if native.repository:
            meta = json.loads((native.root / native.entry['map_metadata']).read_text())
            source = native.map_file.parent / meta['floors'][binding['ros_floor_id']]['image']
            yaml_path = native.map_file
        else:
            yaml_path = (native.root / binding['ros_floor_id'] / 'map.yaml'
                         if native.key.startswith('v5_building/') else native.map_file)
            config = map_yaml(yaml_path.read_bytes())
            source = yaml_path.parent / config['image']
        config = map_yaml(yaml_path.read_bytes())
        source = source.resolve(strict=True)
        if not source.is_relative_to(native.root.resolve()):
            raise ValueError('run map image escapes native catalogue')
        data = source.read_bytes()
        png = data if source.suffix.lower() == '.png' else pgm_png(data)[0]
        width, height, pixels = gray_pixels(png)
        pgm = f'P5\n{width} {height}\n255\n'.encode() + pixels
        origin = config['origin']
        if (width != binding['width'] or height != binding['height']
                or config['resolution'] != binding['resolution'] or origin != binding['origin']
                or len(origin) != 3 or not all(math.isfinite(x) for x in origin)
                or config.get('negate', 0) != 0
                or config.get('mode', 'trinary') != 'trinary'
                or hashlib.sha256(pgm).hexdigest() != binding['source_pgm_sha256']):
            raise ValueError('local run map differs from registered raster/coordinates')
        target = folder / 'run-maps' / binding['map_version_id']
        target.mkdir(parents=True, exist_ok=False, mode=0o700)
        png_path, pgm_path = target / 'map.png', target / 'map.pgm'
        png_path.write_bytes(png)
        if hashlib.sha256(png_path.read_bytes()).hexdigest() != binding['sha256']:
            raise ValueError('local run PNG differs from registered image')
        pgm_path.write_bytes(pgm)
        (target / 'map.yaml').write_bytes(yaml_bytes(config, 'map.pgm'))
        result.append(dict(map_version_id=binding['map_version_id'],
                           image_path=str(png_path), pgm_path=str(pgm_path)))
    return json.dumps(result)
