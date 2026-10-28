"""Catalogue-aware launch arguments; D1 ownership/watch/close methods are inherited.

Only start's entrypoint/target differs from apps/agent/tools/sim/isolation.py.
Keep its preflight -> hashes -> unit -> identity/watch ordering and unit limits.
The legacy v5_single/f1 caller continues to use the original class directly.
"""
from pathlib import Path
import subprocess
import threading
import time

from isolation import Simulation as D1Simulation, preflight, source_hashes, write, stamp, command, processes
from constants import MAP_DIRECTORY


class CataloguedSimulation(D1Simulation):
    def __init__(self, *args, native, configured_world, **kwargs):
        super().__init__(*args, **kwargs)
        self.native = native
        self.configured_world = configured_world

    def start(self):
        self.before = preflight(self.folder)
        # Resolve again after the resource gate, before source hashing/unit creation.
        self.native.resolve_again(self.configured_world)
        target_manifest = self.folder / 'catalogue-target-manifest.json'
        hashes = self.native.hashes(self.source)
        write(target_manifest, {'key': self.native.key, 'root': str(self.native.root),
                               'roots': [str(r) for r in self.native.roots],
                               'world_file': str(self.native.world_file), 'map_file': str(self.native.map_file),
                               'helper_source': str(self.source / 'sensor_isolation.py'),
                               'target': self.native.target, 'hashes': hashes,
                               'map_bindings': list(self.configured_world.map_bindings)})
        self.gt_world_sha = hashes['world']
        self.hashes = source_hashes(self.source)
        write(self.folder / 'source-before.json', self.hashes)
        # No credentials are passed to this shell, its argv or journal.
        script = ('set -e; source "$1"; export ROS_DOMAIN_ID=93 ROS_AUTOMATIC_DISCOVERY_RANGE=LOCALHOST '
                  'ROS_LOCALHOST_ONLY=1 GZ_IP=127.0.0.1 PYTHONDONTWRITEBYTECODE=1 ROS_LOG_DIR="$4"; '
                  'PYTHONPATH="$5:${PYTHONPATH:-}" /usr/bin/python3 -c "from foothold_agent.ros_bridge.config import validate_isolation; validate_isolation()"; '
                  'exec /usr/bin/python3 "$6" "$2" "$7" --isolated-verify --sensor-profile l1-d435i-c2-min '
                  '--purpose session --world-id "$8" --floor-id "$9" --map-mode static --map-version gt-20261012 --out "$3"')
        args = ['systemd-run', '--user', '--unit=' + self.unit, '--collect', '--property=Slice=foothold-sim.slice', '--property=MemoryMax=1500M',
                '--property=MemorySwapMax=0', '--property=CPUQuota=200%', '--property=TasksMax=256',
                '--property=KillSignal=SIGINT', '--property=KillMode=process', '--property=SendSIGKILL=no',
                '--property=TimeoutStopSec=45', '--property=RuntimeMaxSec=' + str(self.seconds),
                '--working-directory=' + str(self.source.parent.parent.parent / MAP_DIRECTORY),
                '/bin/bash', '-c', script, 'rb-sim', str(self.setup), str(self.source), str(self.out), str(self.folder / 'ros'),
                str(Path(__file__).resolve().parents[1] / 'agent'),
                str(Path(__file__).with_name('native_entrypoint.py')), str(target_manifest),
                self.native.target['world_id'], self.native.target['floor_id']]
        if self.launch_env is not None:
            # Clear user-manager inheritance inside the unit, before ROS setup.
            index = args.index('/bin/bash')
            args[index:index] = ['/usr/bin/env', '-i', *[f'{key}={value}' for key, value in sorted(self.launch_env.items())]]
        write(self.folder / 'launch.json', {**stamp(), 'argv': args, 'out': str(self.out), 'unit': self.unit})
        if self.launch_env is None:
            command(*args)  # preserve the existing D1 caller exactly
        else:
            subprocess.check_output(args, env=self.launch_env, text=True, stderr=subprocess.STDOUT)
        self.started = True
        for _ in range(30):
            info = self.show()
            if int(info.get('MainPID', 0)):
                rows, _ = processes()
                self.pid = next(r for r in rows if r['pid'] == int(info['MainPID']))
                self.cg = info['ControlGroup']
                break
            time.sleep(.1)
        if self.pid is None:
            raise RuntimeError('new unit exited before ownership could be captured')
        write(self.folder / 'unit.json', {'unit': self.unit, 'pid': self.pid, 'cgroup': self.cg})
        self.thread = threading.Thread(target=self.watch, daemon=True)
        self.thread.start()
