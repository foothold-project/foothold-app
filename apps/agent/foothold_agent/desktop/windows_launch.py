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


def stop_installed(installation):
    """Ask only the installed desktop listener to quit, then confirm exit.

    Do not terminate the agent forcibly: its normal quit path closes the link
    and performs the existing stop cleanup. A busy/missing listener or a process
    that does not exit aborts removal instead of deleting active binaries.
    """
    installation = Path(installation)
    no_reparse(installation)
    script = '$root='+literal(installation)+'; $uninstaller='+str(os.getpid())+r''';
$prefix=[IO.Path]::GetFullPath($root).TrimEnd('\')+'\'
function InstalledProcesses {
 @(Get-CimInstance Win32_Process | Where-Object {
  $_.ProcessId -ne $uninstaller -and $_.ExecutablePath -and
  $_.ExecutablePath.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase)
 })
}
$running=@(InstalledProcesses)
if ($running.Count) {
 $ids=@($running | ForEach-Object { $_.ProcessId })
 $listener=@(Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort 9611 -State Listen -ErrorAction SilentlyContinue |
  Where-Object { $_.OwningProcess -in $ids })
 if ($listener.Count -ne 1) { throw 'Close the installed connection program, then run removal again' }
 $request=[Net.HttpWebRequest]::Create('http://127.0.0.1:9611/action')
 $request.Proxy=$null; $request.AllowAutoRedirect=$false; $request.Timeout=3000
 $request.Method='POST'; $request.ContentType='application/json'
 $request.Headers['Origin']='http://127.0.0.1:9611'
 $body=[Text.Encoding]::UTF8.GetBytes('{"action":"quit"}')
 $request.ContentLength=$body.Length
 $stream=$request.GetRequestStream()
 try { $stream.Write($body,0,$body.Length) } finally { $stream.Dispose() }
 $response=$request.GetResponse(); $response.Dispose()
 $deadline=[DateTime]::UtcNow.AddSeconds(10)
 do {
  $running=@(InstalledProcesses)
  if (!$running.Count) { break }
  Start-Sleep -Milliseconds 100
 } while ([DateTime]::UtcNow -lt $deadline)
 if ($running.Count) { throw 'Connection program is still running; removal cancelled' }
}
'''
    powershell(script, timeout=20)
    # Also check the desktop's own lifetime lock: incomplete Windows process
    # metadata must never let an active installation pass the exit check.
    from .windows import InstanceLock
    with InstanceLock(installation.parent/'cache/desktop.lock'):
        pass


def uninstall():
    """User-requested removal; keep saved connection keys and preferences."""
    stop_installed(Path(os.environ['LOCALAPPDATA'])/'foothold/robot')
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
