"""Bounded episode Observer cgroup; never adopt or kill a unit by a name pattern."""
import json
import os
from pathlib import Path
import re
import subprocess

from .agent_unit import AgentUnit
from .environment import child_environment


class ObserverUnit(AgentUnit):
    def __init__(self, folder, settings, root, identity, robot, episode):
        suffix = Path(folder).name
        if not re.fullmatch(r'[a-zA-Z0-9_-]{1,64}', suffix):
            raise ValueError('invalid Observer episode name')
        if (identity.get('ros_domain') != '93'
                or not re.fullmatch(r'fh-srv-[0-9a-f]{12}', identity.get('partition', ''))):
            raise ValueError('Observer requires verified native domain/partition')
        self.unit = 'fh-simmgr-observer-' + suffix + '.service'
        self.invocation_id = None
        self.cgroup = None
        self.attempted = False
        self.not_created = False
        self.folder, self.settings, self.root = folder, settings, root
        if self.show().get('LoadState') != 'not-found':
            raise RuntimeError('Observer unit already exists; use a new episode')
        self.env = {**child_environment(settings.domain), 'GZ_PARTITION': identity['partition'],
                    'ROS_LOG_DIR': str(folder / 'observer-ros'),
                    'OPENBLAS_NUM_THREADS': '1', 'OMP_NUM_THREADS': '1'}
        from uuid import UUID
        episode = str(UUID(episode))
        runtime = Path(self.env['XDG_RUNTIME_DIR'])
        info = runtime.stat()
        if runtime != Path('/run/user') / str(os.getuid()) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise ValueError('observer requires private user runtime directory')
        self.socket_path = str(runtime / ('fh-observer-' + episode + '.sock'))
        if Path(self.socket_path).exists():
            raise RuntimeError('observer socket already exists')
        self.private = folder / 'observer-env.json'
        fd = os.open(self.private, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'w') as output:
            json.dump(dict(env=self.env, setup=settings.ros_setup, root=str(root),
                python=settings.agent_python, robot=robot, episode=episode, socket=self.socket_path), output)

    def start(self):
        args = ['systemd-run', '--user', '--quiet', '--unit=' + self.unit,
                '--property=RuntimeMaxSec=' + str(self.settings.unit_runtime_seconds),
                '--property=RemainAfterExit=yes', '--property=KillMode=control-group',
                '--property=KillSignal=SIGINT', '--property=SendSIGKILL=yes',
                '--property=TimeoutStopSec=15', '--property=MemoryMax=256M',
                '--property=MemorySwapMax=0', '--property=CPUQuota=50%',
                '--property=TasksMax=64', '--property=WorkingDirectory=' + str(self.root),
                '--property=StandardOutput=append:' + str(self.folder / 'observer.log'),
                '--property=StandardError=append:' + str(self.folder / 'observer.log'),
                '/usr/bin/env', '-i', '/usr/bin/python3',
                str(self.root / 'apps/simmgr/observer_entry.py'), str(self.private)]
        self.attempted = True
        creation_rejected = False
        try:
            subprocess.run(args, env={k: v for k, v in self.env.items() if k in
                ('PATH', 'HOME', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS')},
                check=True, capture_output=True, timeout=10)
        except subprocess.CalledProcessError:
            creation_rejected = True
            raise
        finally:
            state = self.show()
            self.invocation_id = state.get('InvocationID')
            self.cgroup = state.get('ControlGroup')
            # Only a definite rejection plus absence proves no unit was created.
            # Timeout and unavailable status retain the handle for manual recovery.
            self.not_created = (creation_rejected and state.get('LoadState') == 'not-found'
                                and not self.invocation_id)
        if not self.invocation_id or not self.cgroup or not self.cgroup.startswith('/'):
            raise RuntimeError('Observer invocation ownership unavailable')
        (self.folder / 'observer-unit.json').write_text(json.dumps(dict(
            unit=self.unit, invocation_id=self.invocation_id, domain=93,
            partition=self.env['GZ_PARTITION'], memory_mib=None, cpu_percent=None)))

    def stop(self):
        if not self.attempted or self.not_created:
            self.private.unlink(missing_ok=True)
            return
        state = self.show()
        if not self.invocation_id or state.get('InvocationID') != self.invocation_id:
            raise RuntimeError('Observer invocation identity changed; cleanup refused')
        group = self.cgroup
        if state.get('ControlGroup') not in ('', None, group):
            raise RuntimeError('Observer cgroup identity changed')
        subprocess.run(['systemctl', '--user', 'stop', self.unit],
                       check=True, capture_output=True, timeout=25)
        state = self.show()
        if (state.get('InvocationID') not in (None, '', self.invocation_id)
                or (state.get('LoadState') != 'not-found' and (
                    state.get('MainPID') != '0' or state.get('ActiveState') not in ('inactive', 'failed')))):
            raise RuntimeError('Observer unit exit unconfirmed')
        if group:
            if not group.startswith('/') or '..' in Path(group).parts:
                raise RuntimeError('invalid Observer cgroup')
            try:
                events = (Path('/sys/fs/cgroup') / group.lstrip('/') / 'cgroup.events').read_text()
            except FileNotFoundError:
                pass
            else:
                if dict(line.split() for line in events.splitlines()).get('populated') != '0':
                    raise RuntimeError('Observer cgroup remains populated')
        (self.folder / 'observer-cleanup.json').write_text(json.dumps(dict(
            unit=self.unit, invocation_id=self.invocation_id, complete=True, state=state)))
        if state.get('ActiveState') == 'failed':
            subprocess.run(['systemctl', '--user', 'reset-failed', self.unit],
                           check=True, capture_output=True, timeout=5)
        self.private.unlink(missing_ok=True)
        Path(self.socket_path).unlink(missing_ok=True)
