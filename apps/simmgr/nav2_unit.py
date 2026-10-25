"""Bounded episode Nav2 cgroup; never adopt or kill a unit by a name pattern."""
import json
import os
from pathlib import Path
import re
import subprocess

from .agent_unit import AgentUnit
from .environment import child_environment


class Nav2Unit(AgentUnit):
    def __init__(self, folder, settings, root, identity):
        episode = Path(folder).name
        if not re.fullmatch(r'[a-zA-Z0-9_-]{1,64}', episode):
            raise ValueError('invalid Nav2 episode name')
        if (identity.get('ros_domain') != '93'
                or not re.fullmatch(r'fh-srv-[0-9a-f]{12}', identity.get('partition', ''))):
            raise ValueError('Nav2 requires verified native domain/partition')
        self.unit = 'fh-simmgr-nav2-' + episode + '.service'
        self.invocation_id = None
        self.attempted = False
        self.folder, self.settings, self.root = folder, settings, root
        if self.show().get('LoadState') != 'not-found':
            raise RuntimeError('Nav2 unit already exists; use a new episode')
        self.env = {**child_environment(settings.domain), 'GZ_PARTITION': identity['partition'],
                    'FH_NAV2_EXECUTE': '1', 'ROS_LOG_DIR': str(folder / 'nav2-ros')}
        self.private = folder / 'nav2-env.json'
        fd = os.open(self.private, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'w') as output:
            json.dump(dict(env=self.env, setup=settings.ros_setup, root=str(root)), output)

    def start(self):
        args = ['systemd-run', '--user', '--quiet', '--unit=' + self.unit,
                '--property=RuntimeMaxSec=' + str(self.settings.unit_runtime_seconds),
                '--property=RemainAfterExit=yes', '--property=KillMode=control-group',
                '--property=KillSignal=SIGINT', '--property=SendSIGKILL=yes',
                '--property=TimeoutStopSec=15', '--property=MemoryMax=768M',
                '--property=MemorySwapMax=0', '--property=CPUQuota=150%',
                '--property=TasksMax=128', '--property=WorkingDirectory=' + str(self.root),
                '--property=StandardOutput=append:' + str(self.folder / 'nav2.log'),
                '--property=StandardError=append:' + str(self.folder / 'nav2.log'),
                '/usr/bin/env', '-i', '/usr/bin/python3',
                str(self.root / 'apps/simmgr/nav2_entry.py'), str(self.private)]
        self.attempted = True
        try:
            subprocess.run(args, env={k: v for k, v in self.env.items() if k in
                ('PATH', 'HOME', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS')},
                check=True, capture_output=True, timeout=10)
        finally:
            # Keep the handle even on an ambiguous systemd-run failure.
            self.invocation_id = self.show().get('InvocationID')
        if not self.invocation_id:
            raise RuntimeError('Nav2 invocation ownership unavailable')
        (self.folder / 'nav2-unit.json').write_text(json.dumps(dict(
            unit=self.unit, invocation_id=self.invocation_id, domain=93,
            partition=self.env['GZ_PARTITION'], memory_mib=None, cpu_percent=None)))

    def stop(self):
        if not self.attempted:
            self.private.unlink(missing_ok=True)
            return
        state = self.show()
        if not self.invocation_id or state.get('InvocationID') != self.invocation_id:
            raise RuntimeError('Nav2 invocation identity changed; cleanup refused')
        group = state.get('ControlGroup')
        subprocess.run(['systemctl', '--user', 'stop', self.unit],
                       check=True, capture_output=True, timeout=25)
        state = self.show()
        if (state.get('InvocationID') not in (None, '', self.invocation_id)
                or (state.get('LoadState') != 'not-found' and (
                    state.get('MainPID') != '0' or state.get('ActiveState') not in ('inactive', 'failed')))):
            raise RuntimeError('Nav2 unit exit unconfirmed')
        if group:
            if not group.startswith('/') or '..' in Path(group).parts:
                raise RuntimeError('invalid Nav2 cgroup')
            try:
                events = (Path('/sys/fs/cgroup') / group.lstrip('/') / 'cgroup.events').read_text()
            except FileNotFoundError:
                pass
            else:
                if dict(line.split() for line in events.splitlines()).get('populated') != '0':
                    raise RuntimeError('Nav2 cgroup remains populated')
        (self.folder / 'nav2-cleanup.json').write_text(json.dumps(dict(
            unit=self.unit, invocation_id=self.invocation_id, complete=True, state=state)))
        if state.get('ActiveState') == 'failed':
            subprocess.run(['systemctl', '--user', 'reset-failed', self.unit],
                           check=True, capture_output=True, timeout=5)
        self.private.unlink(missing_ok=True)
