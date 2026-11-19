#!/usr/bin/env python3
"""Start/stop the installed robot computer's user service by hand; never use sudo.

No boot or login auto start (팀장 11/19: 22:16 the enabled service came up by
itself and could have sent robot commands). The unit has no [Install] section,
so it cannot be enabled, and `start` also removes any enable link an older
install left behind.
"""
import argparse
import os
from pathlib import Path
import subprocess
import secrets

UNIT = 'foothold-robot.service'


def quote(path, *, environment=False):
    value = str(path)
    if any(ord(c) < 32 or ord(c) == 127 for c in value):
        raise ValueError('control character in installation path')
    value = value.replace('\\', '\\\\').replace('"', '\\"').replace('%', '%%')
    return '"'+(value.replace('$', '$$') if environment else value)+'"'


def unit_text(root):
    return ('[Unit]\nDescription=FOOTHOLD robot computer connection\n'
            'StartLimitIntervalSec=600\nStartLimitBurst=5\n\n'
            '[Service]\nType=simple\n'
            # WorkingDirectory keeps surrounding quotes literally; only
            # systemd specifiers need escaping here, unlike ExecStart args.
            f'WorkingDirectory={str(root).replace("%", "%%")}\n'
            f'ExecStart={quote(root/"venv/bin/python", environment=True)} -I {quote(root/"launch.py", environment=True)}\n'
            'Environment=PYTHONUNBUFFERED=1\nUMask=0077\n'
            'KillSignal=SIGINT\nTimeoutStopSec=30\nRestart=on-failure\nRestartSec=20\n'
            'StandardOutput=append:%h/foothold-robot-run.log\n'
            # No [Install] section on purpose: manual start only, never at boot or login.
            'StandardError=append:%h/foothold-robot-run.log\n')


def configure(action, root):
    home = Path(os.environ['HOME'])
    if (not home.is_absolute() or home != home.resolve()
            or root != home/'foothold-robot' or root != root.resolve()
            or not (root/'launch.py').is_file() or (root/'INCOMPLETE').exists()):
        raise ValueError('complete private HOME/foothold-robot installation required')
    directory = home/'.config/systemd/user'
    if directory != directory.resolve():
        raise ValueError('real user service directory required')
    unit = directory/UNIT
    if unit.is_symlink() or unit.exists() and not unit.is_file():
        raise ValueError('regular user service file required')
    def systemctl(*args):
        subprocess.run(['systemctl', '--user', *args], check=True)
    if action == 'stop':
        systemctl('disable', '--now', UNIT)
        unit.unlink(missing_ok=True)
        systemctl('daemon-reload')
        print('연결 서비스를 멈추고 서비스 파일을 지웠습니다. 저장된 로봇 연결 정보와 기록은 남습니다.')
        return
    directory.mkdir(parents=True, exist_ok=True)
    if unit.exists():
        # An older install enabled the unit at login; drop that link first.
        subprocess.run(['systemctl', '--user', 'disable', UNIT], check=False)
    temporary = directory/(UNIT+'.'+secrets.token_hex(12)+'.tmp')
    try:
        with open(temporary, 'x', opener=lambda path, flags: os.open(path, flags, 0o600)) as output:
            output.write(unit_text(root))
        temporary.replace(unit)
    finally:
        temporary.unlink(missing_ok=True)
    systemctl('daemon-reload')
    systemctl('reset-failed', UNIT)
    systemctl('start', UNIT)
    print('연결 서비스를 지금 한 번 켰습니다. 부팅 · 로그인 때 자동으로 켜지지 않습니다. 실패하면 20초 뒤 다시 시도합니다.')
    print('기록: '+str(home/'foothold-robot-run.log'))


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('start', 'stop'))
    args = parser.parse_args(argv)
    try:
        configure(args.action, Path(__file__).resolve().parent)
        return 0
    except (OSError, ValueError, KeyError, subprocess.SubprocessError):
        print('연결 서비스 켜기 · 끄기 실패 · 사용자 로그인과 systemd 사용자 서비스를 확인하세요.')
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
