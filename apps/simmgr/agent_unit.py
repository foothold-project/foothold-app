"""Own bounded transient user unit. No manager-parent/thread lifetime dependency."""
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import time


class AgentUnit:
    def __init__(self, folder, settings, env, root):
        episode = Path(settings.run_dir).parent.name
        if not re.fullmatch(r'[a-zA-Z0-9_-]{1,64}', episode):
            raise ValueError('invalid agent unit episode name')
        self.unit = 'fh-simmgr-agent-' + episode + '.service'
        # Reusing a name cannot adopt/kill an older or unrelated running unit.
        state = self.show()
        if state.get('LoadState') != 'not-found':
            raise RuntimeError('agent unit already exists; use a new episode')
        private = folder / 'agent-env.json'
        fd = os.open(private, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'w') as output:
            json.dump(dict(env=env, setup=settings.ros_setup, python=settings.agent_python, root=str(root)), output)
        self.private = private
        args = ['systemd-run', '--user', '--quiet', '--unit=' + self.unit,
                '--property=RuntimeMaxSec=240', '--property=RemainAfterExit=yes',
                '--property=WorkingDirectory=' + str(root), '--property=KillMode=control-group',
                '--property=KillSignal=SIGINT', '--property=SendSIGKILL=yes',
                '--property=TimeoutStopSec=15', '--property=MemoryMax=512M',
                '--property=MemorySwapMax=0', '--property=TasksMax=128',
                '--property=StandardOutput=append:' + str(folder / 'agent.log'),
                '--property=StandardError=append:' + str(folder / 'agent.log'),
                '/usr/bin/env', '-i', settings.agent_python, str(root / 'apps/simmgr/agent_entry.py'), str(private)]
        try:
            # No credentials in argv or inherited env; only the private file carries them.
            subprocess.run(args, env={k: v for k, v in env.items() if k in ('PATH','HOME','XDG_RUNTIME_DIR','DBUS_SESSION_BUS_ADDRESS')},
                           check=True, capture_output=True, timeout=10)
        except BaseException:
            private.unlink(missing_ok=True)
            raise

    def show(self):
        result = subprocess.run(['systemctl', '--user', 'show', self.unit,
            '--property=LoadState,ActiveState,Result,ExecMainCode,ExecMainStatus'],
            text=True, capture_output=True, timeout=5, check=False)
        state = dict(line.split('=', 1) for line in result.stdout.splitlines() if '=' in line)
        if 'LoadState' not in state:
            raise RuntimeError('agent user bus unavailable: no unit status')
        return state

    def poll(self):
        state = self.show()
        if state.get('Result') == 'success' and state.get('ExecMainCode') == '1' and state.get('ExecMainStatus') == '0':
            return 0
        if state.get('ActiveState') in ('active', 'activating', 'deactivating'):
            return None
        return 1  # missing/failed/expired is never STOP/zero confirmation

    def send_signal(self, sig):
        subprocess.run(['systemctl', '--user', 'kill', '--kill-whom=all',
                        '--signal=' + signal.Signals(sig).name, self.unit],
                       check=True, capture_output=True, timeout=5)

    def wait(self, timeout):
        end = time.monotonic() + timeout
        while True:
            code = self.poll()
            if code is not None:
                self.private.unlink(missing_ok=True)
                if code == 0:
                    # RemainAfterExit preserves exit evidence until we read it.
                    # Stop the now-exited unit to reap any remaining own children.
                    subprocess.run(['systemctl', '--user', 'stop', self.unit],
                                   check=True, capture_output=True, timeout=5)
                return code
            if time.monotonic() >= end:
                raise subprocess.TimeoutExpired(self.unit, timeout)
            time.sleep(.05)
