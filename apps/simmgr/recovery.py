"""Fail-closed retained shutdown proof; no signals, cleanup or latch release."""
import json
from pathlib import Path
import subprocess

FAMILIES = ('fh-rb-sim-', 'fh-simmgr-agent-', 'fh-simmgr-nav2-', 'fh-simmgr-observer-')
PATTERNS = tuple(prefix + '*.service' for prefix in FAMILIES)
CGROUP = Path('/sys/fs/cgroup')


def empty_cgroup(group):
    if not group:
        return
    if not group.startswith('/') or '..' in Path(group).parts:
        raise ValueError('invalid recovery cgroup')
    directory = CGROUP / group.lstrip('/')
    try:
        events = (directory / 'cgroup.events').read_text()
    except FileNotFoundError:
        try:
            directory.stat()
        except FileNotFoundError:
            return  # systemd already removed the entire cgroup
        raise ValueError('recovery cgroup events unavailable') from None
    if dict(line.split() for line in events.splitlines()).get('populated') != '0':
        raise ValueError('recovery cgroup populated or unknown')


def absence(reader, userctl, sockets):
    rows, denied = reader()
    if denied != 0 or any(row['domain'] == '93' or row['partition'].startswith('fh-srv-')
                          or any(prefix in row['cgroup'] for prefix in FAMILIES) for row in rows):
        raise ValueError('episode process absence unproven')
    units = userctl('list-units', '--all', '--plain', '--no-legend', '--no-pager', *PATTERNS)
    for line in units.splitlines():
        name = line.split()[0]
        if not name.endswith('.service') or not any(name.startswith(p) for p in FAMILIES):
            raise ValueError('unexpected recovery unit')
        data = dict(line.split('=', 1) for line in userctl('show', name,
            '--property=LoadState,ActiveState,SubState,MainPID,ControlGroup').splitlines() if '=' in line)
        if ('ControlGroup' not in data or data.get('LoadState') != 'loaded' or data.get('MainPID') != '0'
                or (data.get('ActiveState'), data.get('SubState')) not in
                {('inactive', 'dead'), ('failed', 'failed'), ('active', 'exited')}):
            raise ValueError('episode unit live or unknown')
        empty_cgroup(data.get('ControlGroup', ''))
    for line in sockets().splitlines():
        fields = line.split()
        if len(fields) != 6 or fields[0] not in ('tcp', 'udp'):
            raise ValueError('socket evidence format unknown')
        port = int(fields[4].rsplit(':', 1)[-1])
        if port == 9433 or 30650 <= port <= 30899:
            raise ValueError('episode socket remains')
    return dict(processes=0, populated_cgroups=0, domain93=0, partitions=0, dds=0, port9433=0)


def local_absence():
    from .proc_proof import processes
    def ctl(*args):
        return subprocess.run(['systemctl', '--user', *args], check=True, capture_output=True,
                              text=True, timeout=5).stdout
    return absence(processes, ctl, lambda: subprocess.run(['ss', '-H', '-lntu'], check=True,
                   capture_output=True, text=True, timeout=5).stdout)


def classify(manifest, agent, observations):
    """Explicit evidence only: missing observers/counters never mean zero."""
    counts = manifest.get('counts', {})
    target = manifest.get('native_target_publications', {})
    zero = lambda value: type(value) is int and value == 0
    partition = manifest.get('partition')
    binding = (isinstance(partition, str) and partition.startswith('fh-srv-')
               and agent.get('partition') == observations.get('partition') == partition
               and str(manifest.get('ros_domain')) == agent.get('domain') == observations.get('domain') == '93')
    base = (binding and zero(counts.get('ticks')) and zero(counts.get('policy_calls'))
            and agent.get('rosnode_created') is False and agent.get('complete') is True
            and observations.get('complete') is True and zero(observations.get('cmd'))
            and zero(observations.get('resume')))
    target_zero = (set(target) == {'complete', 'attempts', 'count', 'first_monotonic_ns', 'last_monotonic_ns'}
                   and target.get('complete') is True and zero(target.get('attempts'))
                   and zero(target.get('count')) and target.get('first_monotonic_ns') is None
                   and target.get('last_monotonic_ns') is None)
    return dict(classification='pre-start-abort' if base else 'unproven',
                stop_zero_substitute=bool(base and target_zero),
                native_target='zero' if target_zero else 'unproven-or-published')


def audit(folder, agent_path=None, observations_path=None):
    # Read-only: no mutation or operator-supplied boolean flags that bypass proof.
    folder = Path(folder)
    return classify(json.loads((folder if agent_path else folder / 'manifest.json').read_text()),
                    json.loads((Path(agent_path) if agent_path else folder / 'agent-startup.json').read_text()),
                    json.loads((Path(observations_path) if observations_path else folder / 'command-observations.json').read_text()))
