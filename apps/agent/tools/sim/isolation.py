"""OS-only isolation gates and a supervisor for one newly owned simulation unit."""
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import threading
import time
import uuid

from constants import SPEC_DIRECTORY, MAP_DIRECTORY, WORLD_ID, FLOOR_ID, GT_VERSION


def stamp():
    return {'utc': datetime.now(timezone.utc).isoformat(), 'mono': time.monotonic()}


def write(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')


def command(*args):
    return subprocess.check_output(args, text=True, stderr=subprocess.STDOUT)


def processes():
    """Select only isolation keys; never record argv or unrelated environment secrets."""
    rows, denied = [], 0
    for root in Path('/proc').iterdir():
        if not root.name.isdigit():
            continue
        try:
            stat = (root / 'stat').read_text().rsplit(')', 1)[1].split()
            env = dict(item.split(b'=', 1) for item in (root / 'environ').read_bytes().split(b'\0') if b'=' in item)
            rows.append({'pid': int(root.name), 'ppid': int(stat[1]), 'start_ticks': int(stat[19]),
                         'comm': (root / 'comm').read_text().strip(),
                         'cgroup': (root / 'cgroup').read_text().strip(),
                         'domain': env.get(b'ROS_DOMAIN_ID', b'').decode(errors='replace'),
                         'partition': env.get(b'GZ_PARTITION', b'').decode(errors='replace')})
        except PermissionError:
            denied += 1
        except (FileNotFoundError, ProcessLookupError):
            pass
    return rows, denied


def domain61(rows):
    selected = {r['pid'] for r in rows if r['domain'] == '61'}
    while True:
        children = {r['pid'] for r in rows if r['ppid'] in selected}
        if children <= selected:
            break
        selected |= children
    return sorted([r for r in rows if r['pid'] in selected], key=lambda r: r['pid'])


def resources():
    mem = dict(line.split(':', 1) for line in Path('/proc/meminfo').read_text().splitlines())
    vm = dict(line.split() for line in Path('/proc/vmstat').read_text().splitlines())
    return {**stamp(), 'mem_available_mib': int(mem['MemAvailable'].split()[0]) / 1024,
            'load1': os.getloadavg()[0], 'pswpin': int(vm['pswpin'])}


def dds_ports():
    raw = command('ss', '-H', '-lun')
    used = []
    for line in raw.splitlines():
        port = int(line.split()[3].rsplit(':', 1)[1])
        if 30650 <= port <= 30899:
            used.append(port)
    return sorted(set(used)), raw


def source_hashes(source):
    return {str(p.relative_to(source)): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in sorted(source.rglob('*')) if p.is_file() and '__pycache__' not in p.parts}


def preflight(folder):
    rows, denied = processes()
    used, udp = dds_ports()
    value = {**resources(), 'domain93': [r for r in rows if r['domain'] == '93'],
             'domain61': domain61(rows), 'proc_permission_denied': denied, 'dds_ports': used}
    write(folder / 'preflight.json', value)
    (folder / 'udp-before.txt').write_text(udp)
    (folder / 'ps-before.txt').write_text(command('ps', '-eo', 'pid,ppid,lstart,comm'))
    (folder / 'free-before.txt').write_text(command('free', '-m'))
    (folder / 'vmstat-before.txt').write_text(command('vmstat', '1', '3'))
    (folder / 'gpu-before.txt').write_text(command('nvidia-smi', '--query-gpu=memory.total,memory.used,memory.free,utilization.gpu', '--format=csv'))
    if value['domain93'] or used:
        raise RuntimeError('domain 93 / candidate DDS UDP ports already in use')
    if value['mem_available_mib'] < 2500 or value['load1'] > 9:
        raise RuntimeError('preflight resource gate failed; no launch')
    return value


def abort_reason(now, last, high_since, deadline):
    rate = (now['pswpin'] - last['pswpin']) * os.sysconf('SC_PAGE_SIZE') / 1024 / (now['mono'] - last['mono'])
    high_since = (high_since if high_since is not None else last['mono']) if rate > 2000 else None
    reason = ('low_memory' if now['mem_available_mib'] < 1500 else
              'swap_in_10s' if high_since is not None and now['mono'] - high_since >= 10 else
              'runtime_limit' if now['mono'] >= deadline else None)
    return reason, high_since, rate


class Simulation:
    def __init__(self, folder, source, setup, seconds=240):
        if source.is_symlink() or source.absolute() != source.resolve():
            raise ValueError('SIM_SOURCE must be a real path without symlinks')
        self.folder, self.source, self.setup = folder, source.resolve(), setup.resolve()
        if not self.source.is_dir() or not (self.source / 'live_map.py').is_file():
            raise ValueError('SIM_SOURCE must be the existing sensor runtime source directory')
        if self.source.parent.name != 'stage' or self.source.parent.parent.name != SPEC_DIRECTORY:
            raise ValueError('unexpected sensor runtime layout')
        if not 30 <= seconds <= 240:
            raise ValueError('runtime must be 30..240 seconds')
        self.seconds = seconds
        tag = datetime.now().strftime('%Y%m%d-%H%M%S-') + uuid.uuid4().hex[:8]
        self.unit = 'fh-rb-sim-' + tag + '.service'
        self.out = self.source.parent.parent / ('rb-app-' + tag)
        self.pid = None
        self.cg = None
        self.interrupted = False
        self.signal_lock = threading.Lock()
        self.done = threading.Event()
        self.thread = None
        self.reason = None
        self.identity = None
        self.started = False

    def live_identity(self):
        """Native manifest is written at exit. Inspect only our new cgroup live."""
        rows, _ = processes()
        own = [r for r in rows if r['cgroup'].split(':', 2)[-1] == self.cg]
        gz = [r for r in own if re.fullmatch(r'fh-srv-[0-9a-f]{12}', r['partition'])]
        partitions = {r['partition'] for r in gz}
        main = next((r for r in own if r['pid'] == self.pid['pid']), None)
        if (main is None or main['start_ticks'] != self.pid['start_ticks'] or main['domain'] != '93'
                or len(partitions) != 1 or any(r['domain'] != '93' for r in gz)):
            raise RuntimeError('live simulation identity not verified')
        self.identity = {'ros_domain': '93', 'partition': next(iter(partitions)), 'cgroup': self.cg,
                         'main_pid': main['pid'], 'main_start_ticks': main['start_ticks'], 'processes': own}
        write(self.folder / 'live-identity.json', {**stamp(), **self.identity,
              'evidence': '/proc environment/cgroup; NOT the native manifest (available only after exit)'})
        return self.identity

    def show(self):
        result = subprocess.run(['systemctl', '--user', 'show', self.unit, '-p', 'MainPID', '-p', 'ControlGroup', '-p', 'ActiveState', '-p', 'MemoryPeak', '-p', 'Result'], capture_output=True, text=True)
        return dict(line.split('=', 1) for line in result.stdout.splitlines() if '=' in line)

    def interrupt(self, why):
        """At most one main-only SIGINT; verify exact recorded PID/start time/cgroup."""
        with self.signal_lock:
            if self.interrupted:
                return
            info = self.show()
            if int(info.get('MainPID', 0)) == 0:
                return
            if self.pid is None or int(info['MainPID']) != self.pid['pid'] or info.get('ControlGroup') != self.cg:
                raise RuntimeError('refusing signal: owned unit identity changed')
            stat = Path(f"/proc/{self.pid['pid']}/stat").read_text().rsplit(')', 1)[1].split()
            if int(stat[19]) != self.pid['start_ticks']:
                raise RuntimeError('refusing signal: PID reused')
            command('systemctl', '--user', 'kill', '--kill-whom=main', '--signal=SIGINT', self.unit)
            self.interrupted = True
            write(self.folder / 'sigint.json', {**stamp(), 'why': why, 'unit': self.unit, 'pid': self.pid['pid']})

    def watch(self):
        last, high = resources(), None
        deadline = last['mono'] + self.seconds - 5
        with (self.folder / 'resources.jsonl').open('a', buffering=1) as log:
            while not self.done.wait(1):
                try:
                    now = resources()
                    reason, high, rate = abort_reason(now, last, high, deadline)
                    info = self.show()
                    log.write(json.dumps({**now, 'swap_in_kib_s': rate, 'unit': info}) + '\n')
                    last = now
                    if reason:
                        self.reason = reason
                        self.interrupt(reason)
                        return
                    if info.get('ActiveState') in ('inactive', 'failed'):
                        self.reason = 'unit_exited'
                        return
                except Exception as exc:
                    self.reason = 'watcher_error:' + type(exc).__name__
                    self.interrupt(self.reason)
                    return

    def start(self):
        self.before = preflight(self.folder)
        self.hashes = source_hashes(self.source)
        write(self.folder / 'source-before.json', self.hashes)
        # No credentials are passed to this shell, its argv or journal.
        script = ('set -e; source "$1"; export ROS_DOMAIN_ID=93 ROS_AUTOMATIC_DISCOVERY_RANGE=LOCALHOST '
                  'ROS_LOCALHOST_ONLY=1 GZ_IP=127.0.0.1 PYTHONDONTWRITEBYTECODE=1 ROS_LOG_DIR="$4"; '
                  'PYTHONPATH="$5:${PYTHONPATH:-}" /usr/bin/python3 -c "from foothold_agent.ros_bridge.config import validate_isolation; validate_isolation()"; '
                  'exec /usr/bin/python3 "$2/live_map.py" --isolated-verify --sensor-profile l1-d435i-c2-min '
                  f'--purpose session --world-id {WORLD_ID} --floor-id {FLOOR_ID} --map-mode static --map-version {GT_VERSION} --out "$3"')
        args = ['systemd-run', '--user', '--unit=' + self.unit, '--collect', '--property=MemoryMax=1500M',
                '--property=MemorySwapMax=0', '--property=CPUQuota=200%', '--property=TasksMax=256',
                '--property=KillSignal=SIGINT', '--property=KillMode=process', '--property=SendSIGKILL=no',
                '--property=TimeoutStopSec=45', '--property=RuntimeMaxSec=' + str(self.seconds),
                '--working-directory=' + str(self.source.parent.parent.parent / MAP_DIRECTORY),
                '/bin/bash', '-c', script, 'rb-sim', str(self.setup), str(self.source), str(self.out), str(self.folder / 'ros'),
                str(Path(__file__).resolve().parents[2])]
        write(self.folder / 'launch.json', {**stamp(), 'argv': args, 'out': str(self.out), 'unit': self.unit})
        command(*args)
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

    def close(self):
        try:
            self.interrupt('normal_cleanup')
            deadline = time.monotonic() + 55
            while time.monotonic() < deadline and int(self.show().get('MainPID', 0)):
                time.sleep(.25)
        finally:
            self.done.set()
            if self.thread:
                self.thread.join(3)
        rows, denied = processes()
        after61 = domain61(rows)
        manifest = json.loads((self.out / 'manifest.json').read_text()) if (self.out / 'manifest.json').exists() else {}
        partition = manifest.get('partition')
        leftovers = [r for r in rows if r['domain'] == '93' or (partition and r['partition'] == partition)
                     or (self.cg and r['cgroup'].split(':', 2)[-1].startswith(self.cg))]
        hashes_same = source_hashes(self.source) == self.hashes
        ports, raw = dds_ports()
        info = self.show()
        (self.folder / 'udp-after.txt').write_text(raw)
        (self.folder / 'journal.txt').write_text(command('journalctl', '--user', '-u', self.unit, '--no-pager', '-n', '100'))
        manifest_match = bool(manifest.get('ros_domain') == '93' and re.fullmatch(r'fh-srv-[0-9a-f]{12}', partition or '')
                              and (self.identity is None or partition == self.identity['partition']))
        cleanup_complete = bool(manifest.get('cleanup', {}).get('complete') is True
                                and manifest.get('kids_stop', [{}])[-1].get('complete') is True)
        ledgers_same = (manifest.get('isolation', {}).get('ledger_sha_before') == manifest.get('isolation', {}).get('ledger_sha_after'))
        world_matches = (not hasattr(self, 'gt_world_sha') or manifest.get('live_sha256', {}).get('world_src') == self.gt_world_sha)
        identities = lambda rows: sorted((r['pid'], r['start_ticks']) for r in rows)
        result = {**stamp(), 'unit': info, 'domain61_unchanged': identities(after61) == identities(self.before['domain61']),
                  'domain61_after': after61, 'source_unchanged': hashes_same, 'leftovers': leftovers,
                  'dds_ports': ports, 'proc_permission_denied': denied, 'manifest': str(self.out / 'manifest.json'),
                  'native_manifest_matches_live': manifest_match, 'native_cleanup_complete': cleanup_complete,
                  'operating_ledgers_unchanged': ledgers_same, 'native_world_matches_clearance': world_matches}
        write(self.folder / 'cleanup.json', result)
        if leftovers or ports or not hashes_same or not result['domain61_unchanged'] or int(info.get('MainPID', 0)):
            raise RuntimeError('cleanup incomplete or protected source/processes changed; do not relaunch')
        if self.identity and (not manifest_match or not cleanup_complete or not ledgers_same or not world_matches):
            raise RuntimeError('final native manifest did not confirm live identity/cleanup/ledgers')
