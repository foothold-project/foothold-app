#!/usr/bin/env python3
"""Plan by default; install reviewed offline wheels and a manual-only user unit.

Run from the source bundle described in JETSON-ONBOARD.md. No SDK import,
network configuration, system packages, service commands or credential reads.
"""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import platform
import re
import shutil
import sys

REPO = Path(__file__).resolve().parents[3]
UNIT = 'foothold-jetson.service'
PROTECTED_PORTS = {8453, 8792, *range(5180, 5184), 5190, 5191, 5195,
                   5297, 5310, 5320, 8870, 8881, 9430, 9611, 9761}

LAUNCHER = '''"""Private Jetson entrypoint; credentials stay out of argv and logs."""
import json
import os
from pathlib import Path

root = Path(__file__).resolve().parent
config = json.loads((root/'connection.json').read_text())
python = str(root/'venv/bin/python')
args = [python, '-I', '-m', 'foothold_agent.setup', '--headless',
        '--config', str(root/'private/agent.json'), '--wheel-dir', str(root/'wheels'),
        '--port', str(config['port']), '--server', config['server']]
if config['nic'] != 'auto':
    args.extend(['--nic', config['nic']])
# Keep optional cache files in this installation; measurement sessions should
# not collect observations by default. Neither setting changes motion gates.
os.environ['XDG_CACHE_HOME'] = str(root/'cache')
os.environ['FH_MAPPING_CACHE_DIR'] = str(root/'cache/mapping')
os.environ['FH_RECORD'] = '0'
os.execv(python, args)
'''


def offline_installer():
    path = REPO/'deploy/jetson/install_offline.py'
    spec = importlib.util.spec_from_file_location('jetson_offline_installer', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def unit_text(root):
    # systemd quoting, specifier and environment expansion are independent.
    def quote(path, *, environment=False):
        value = str(path)
        if any(ord(c) < 32 or ord(c) == 127 for c in value):
            raise ValueError('control character in installation path')
        value = value.replace('\\', '\\\\').replace('"', '\\"').replace('%', '%%')
        return '"'+(value.replace('$', '$$') if environment else value)+'"'
    return ('[Unit]\nDescription=FOOTHOLD Jetson robot connection (manual start)\n\n'
            '[Service]\nType=simple\n'
            f'ExecStart={quote(root/"venv/bin/python", environment=True)} -I {quote(root/"launch.py", environment=True)}\n'
            f'WorkingDirectory={quote(root)}\n'
            'Environment=PYTHONUNBUFFERED=1\nUMask=0077\n'
            'KillSignal=SIGTERM\nTimeoutStopSec=10\nRestart=no\n')


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path.home()/'foothold-robot')
    parser.add_argument('--wheelhouse', type=Path, required=True)
    parser.add_argument('--server', required=True, help='HTTPS server origin, without secrets')
    parser.add_argument('--nic', default='enP8p1s0', help='dedicated wired NIC, or auto')
    parser.add_argument('--port', type=int, default=9468, help='loopback status port')
    parser.add_argument('--install', action='store_true')
    args = parser.parse_args(argv)
    try:
        # The bundle retains the source tree, so validate the origin without
        # installing/importing any optional package or consulting saved keys.
        from urllib.parse import urlsplit
        server = urlsplit(args.server)
        if (server.scheme != 'https' or not server.hostname or server.username or server.password
                or server.path not in ('', '/') or server.query or server.fragment):
            raise ValueError('HTTPS server origin without credentials required')
        if not re.fullmatch(r'[A-Za-z0-9_.:-]{1,15}', args.nic):
            raise ValueError('valid wired NIC name or auto required')
        if args.port in PROTECTED_PORTS or not 1024 <= args.port <= 65535:
            raise ValueError('dedicated unprivileged loopback port required')
        home = Path.home().resolve()
        root = args.root.absolute()
        if (root != root.resolve() or not root.is_relative_to(home) or root == home
                or root.exists() or root.is_symlink()):
            raise ValueError('new real directory beneath the user home required')
        unit = home/'.config/systemd/user'/UNIT
        if unit.parent.resolve() != unit.parent:
            raise ValueError('real user unit directory required')
        if unit.exists() or unit.is_symlink():
            raise ValueError('existing Jetson unit must be preserved')
        text = unit_text(root)
        offline = offline_installer()
        wheels = args.wheelhouse.absolute()
        requirements = offline.checked_inputs(wheels)
        if not any(line.startswith('qrcode==8.2 --hash=sha256:')
                   for line in requirements.read_text().splitlines()):
            raise ValueError('setup requires hashed qrcode 8.2 wheel in addition to the base bundle')
        print('Offline venv + private config + manual-only foothold-jetson.service; no start/enable or DDS.')
        if not args.install:
            print('Plan checked. ARM DDS and runtime motion approval remain blocked; see JETSON-ONBOARD.md.')
            return 0
        if platform.system() != 'Linux' or platform.machine() != 'aarch64' or sys.version_info[:2] != (3, 10):
            raise ValueError('install only on reviewed Linux aarch64 CPython 3.10')
        previous = os.umask(0o077)
        try:
            root.mkdir(mode=0o700, parents=True)
            (root/'private').mkdir(mode=0o700)
            (root/'cache').mkdir(mode=0o700)
            (root/'wheels').mkdir(mode=0o700)
            names = [line.split(maxsplit=1)[1].lstrip('*')
                     for line in (wheels/'SHA256SUMS').read_text().splitlines()]
            for name in ['SHA256SUMS', *names]:
                shutil.copyfile(wheels/name, root/'wheels'/name)
            if offline.main(['--wheelhouse', str(root/'wheels'), '--dest', str(root/'venv'), '--install']):
                raise ValueError('offline installation incomplete; new folder retained for inspection')
            (root/'connection.json').write_text(json.dumps(
                dict(server=args.server, nic=args.nic, port=args.port), indent=2)+'\n')
            (root/'launch.py').write_text(LAUNCHER)
            unit.parent.mkdir(parents=True, exist_ok=True)
            with unit.open('x') as target:
                target.write(text)  # no [Install] section: static/manual start only
        finally:
            os.umask(previous)
        print('Installed, stopped. Run user daemon-reload separately; motion validation is still blocked.')
        return 0
    except (ValueError, OSError) as error:
        print('Jetson preparation failed: '+type(error).__name__+
              '; preserve existing files, inspect any new partial folder. See JETSON-ONBOARD.md.', file=sys.stderr)
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
