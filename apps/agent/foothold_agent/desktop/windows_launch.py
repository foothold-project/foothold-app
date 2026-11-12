"""First double-click installs into LOCALAPPDATA, then launches the shared desktop."""
import ctypes
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

from foothold_agent.setup.windows import powershell, literal, no_reparse

NAME = 'FOOTHOLD 로봇 연결'


def register_protocol(target):
    import winreg
    base = r'Software\Classes\foothold-robot'
    with winreg.CreateKey(winreg.HKEY_CURRENT_USER, base) as key:
        winreg.SetValueEx(key, '', 0, winreg.REG_SZ, 'URL:FOOTHOLD robot connection')
        winreg.SetValueEx(key, 'URL Protocol', 0, winreg.REG_SZ, '')
    with winreg.CreateKey(winreg.HKEY_CURRENT_USER, base+r'\shell\open\command') as key:
        winreg.SetValueEx(key, '', 0, winreg.REG_SZ, '"'+str(target)+'" --protocol "%1"')


def uninstall():
    """User-requested removal; keep saved connection keys and preferences."""
    import winreg
    base = r'Software\Classes\foothold-robot'
    for suffix in (r'\shell\open\command', r'\shell\open', r'\shell', ''):
        try:
            winreg.DeleteKey(winreg.HKEY_CURRENT_USER, base+suffix)
        except FileNotFoundError:
            pass
    from .windows import set_autostart
    set_autostart(False)
    desktop = powershell('[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); '
                         '[Environment]::GetFolderPath("Desktop")').stdout.strip()
    for path in (Path(desktop)/(NAME+'.lnk'),
                 Path(os.environ['APPDATA'])/'Microsoft/Windows/Start Menu/Programs'/(NAME+'.lnk')):
        path.unlink(missing_ok=True)


def shortcut(path, target):
    path.parent.mkdir(parents=True, exist_ok=True)
    powershell('$s=(New-Object -ComObject WScript.Shell).CreateShortcut('+literal(path)+'); '
               '$s.TargetPath='+literal(target)+'; $s.WorkingDirectory='+literal(target.parent)+'; $s.Save()')


def install(root):
    release = json.loads((root/'version.json').read_text())
    version = release['version']+'-'+release['build_id']
    base = Path(os.environ['LOCALAPPDATA'])/'foothold'
    destination = base/'robot'/version
    no_reparse(destination)
    if destination.resolve() != root.resolve():
        # A content/server identity prevents overwriting active binaries or
        # silently reusing an older server address. Identical builds are reused.
        if not destination.exists():
            staging = destination.with_name(version+'.installing')
            no_reparse(staging)
            if staging.exists():
                shutil.rmtree(staging)
            staging.parent.mkdir(parents=True, exist_ok=True)
            shutil.copytree(root,staging)
            staging.replace(destination)
        target = destination/(NAME+'.exe')
        desktop = powershell('[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); '
                             '[Environment]::GetFolderPath("Desktop")').stdout.strip()
        shortcut(Path(desktop)/(NAME+'.lnk'), target)
        shortcut(Path(os.environ['APPDATA'])/'Microsoft/Windows/Start Menu/Programs'/(NAME+'.lnk'), target)
        preference = base/'desktop-installed.json'
        if not preference.exists():
            from .windows import set_autostart
            set_autostart(True, executable=target)
            preference.write_text('{}\n')
        else:
            from .windows import autostart_enabled, set_autostart
            if autostart_enabled():
                set_autostart(True, executable=target)
        register_protocol(target)
        return target
    register_protocol(root/(NAME+'.exe'))
    return None


def main():
    try:
        if sys.stdout is None:
            sys.stdout = open(os.devnull,'w')
        if sys.stderr is None:
            sys.stderr = open(os.devnull,'w')
        argv = list(sys.argv[1:])
        if '--protocol' in argv:
            argv = []
        root = Path(sys.executable).resolve().parent.parent
        from .windows import InstanceLock
        base = Path(os.environ['LOCALAPPDATA'])/'foothold'
        try:
            with InstanceLock(base/'cache/install.lock'):
                target = install(root)
        except BlockingIOError:
            return
        if target is not None:
            subprocess.Popen([str(target),*argv], cwd=target.parent)
            return
        os.chdir(root)
        from .__main__ import main as desktop_main
        desktop_main(argv)
    except Exception:
        ctypes.windll.user32.MessageBoxW(None,
            '프로그램을 시작하지 못했습니다. ZIP의 모두 압축 풀기 후 실행했는지 확인하세요. '
            'SmartScreen 경고는 추가 정보 → 실행을 선택하세요. '
            '관리자 권한 없이 쓰는 사용자 폴더와 Windows PowerShell을 사용할 수 있어야 합니다.',
            NAME, 0x10)
