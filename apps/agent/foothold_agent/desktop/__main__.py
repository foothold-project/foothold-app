import argparse
import configparser
import asyncio
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
import webbrowser

from foothold_agent.setup import __main__ as setup
from foothold_agent.go2_direct.loader import restart_environment
from foothold_agent.setup.discovery import candidates, select
from foothold_agent.setup.storage import default_path
from foothold_agent.setup.view import Status, make_server
from . import network
from .browser import open_window, server_origin, state_dir
from foothold_agent.setup.platform import install_stop_handlers


def autostart_path():
    if os.name == 'nt':
        from .windows import startup_path
        return startup_path()
    return Path(os.environ.get('XDG_CONFIG_HOME', Path.home()/'.config'))/'autostart/foothold-robot.desktop'


def autostart_enabled():
    if os.name == 'nt':
        from .windows import autostart_enabled as windows_enabled
        return windows_enabled()
    path = autostart_path()
    if not path.exists():
        return True
    config = configparser.ConfigParser(interpolation=None)
    try:
        config.read(path)
        entry = config['Desktop Entry']
        return not entry.getboolean('Hidden', fallback=False) and entry.getboolean('X-GNOME-Autostart-enabled', fallback=True)
    except (configparser.Error, KeyError, ValueError, OSError):
        return False


def set_autostart(enabled):
    if os.name == 'nt':
        from .windows import set_autostart as windows_set
        return windows_set(enabled)
    path = autostart_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    text = ('[Desktop Entry]\nType=Application\nName=FOOTHOLD 로봇 연결\n'
            'Exec=/opt/foothold-robot/launch --autostart\nTerminal=false\n'
            'Icon=/opt/foothold-robot/foothold.svg\n'
            f'Hidden={"false" if enabled else "true"}\n')
    temporary = path.with_suffix('.tmp')
    temporary.write_text(text)
    temporary.replace(path)


class Controls:
    def __init__(self, *, status=None, server=None):
        self.lock = threading.Lock()
        self.active = False
        self.busy = False
        self.message = ''
        self.choices = []
        self.restart = False
        self.selected_nic = None
        self.request_stop = None
        self.status = status
        self.server = server_origin(server) if server is not None else None

    def can_open_server(self):
        return bool(self.server and self.status and self.status.snapshot().get('connected'))

    def snapshot(self):
        with self.lock:
            return dict(autostart=autostart_enabled(), network_choices=list(self.choices),
                        network_message=self.message, busy=self.busy, platform='windows' if os.name == 'nt' else 'linux',
                        server_web_available=self.can_open_server())

    def action(self, body):
        if body == {'action':'autostart', 'enabled':True}:
            set_autostart(True)
        elif body == {'action':'autostart', 'enabled':False}:
            set_autostart(False)
        elif body == {'action':'server-web'}:
            if not self.can_open_server():
                raise PermissionError('server connection required')
            webbrowser.open(self.server)
        elif set(body) == {'action', 'nic'} and body['action'] == 'network':
            with self.lock:
                if self.active or self.busy or body['nic'] not in [c['name'] for c in self.choices]:
                    raise PermissionError('configuration unavailable')
                self.busy = True
                self.message = '유선 연결 설정 중 · 관리자 확인 창(UAC)이 뜨면 확인하세요.' if os.name == 'nt' else '유선 연결 설정 중 · 비밀번호 창이 뜨면 확인하세요.'
            def worker():
                try:
                    network.configure(body['nic'])
                    with self.lock:
                        self.selected_nic = body['nic']
                    message = '유선 연결을 설정했습니다. 로봇을 다시 찾고 있습니다.'
                except Exception:
                    message = ('유선 설정을 마치지 못했습니다. '+
                               ('관리자 확인 창' if os.name == 'nt' else '비밀번호 창')+
                               '을 확인하고 다시 누르세요. 계속 안 되면 아래의 «직접 설정하는 법»을 펼쳐 보세요.')
                with self.lock:
                    self.message, self.busy = message, False
            threading.Thread(target=worker, daemon=True).start()
        elif body in ({'action':'quit'}, {'action':'repair'}):
            with self.lock:
                if self.busy:
                    raise PermissionError('wait for network configuration')
                self.restart = body['action'] == 'repair'
            if self.request_stop is None:
                raise PermissionError('desktop is not ready to stop')
            timer = threading.Timer(.2, self.request_stop)
            timer.daemon = True
            timer.start()
        else:
            raise ValueError('unknown desktop action')


async def connect_when_ready(args, status, controls):
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    controls.request_stop = lambda: loop.call_soon_threadsafe(stop.set)
    restore = install_stop_handlers(stop)
    try:
        while not stop.is_set():
            try:
                found = await asyncio.to_thread(candidates)
                with controls.lock:
                    nic_name = args.nic or controls.selected_nic
                if nic_name:
                    found = [n for n in found if n.name == nic_name]
                with controls.lock:
                    ready = len(found) == 1 and not controls.busy
                    if ready:
                        controls.active, controls.choices = True, []
                if ready:
                    select(found, nic_name)  # same selection rule as the existing program
                    args.nic = nic_name
                    await setup.serve(args, status, stop=stop)
                    return
                choices = await asyncio.to_thread(network.available)
                with controls.lock:
                    controls.choices = choices
                if len(found) > 1:
                    message = '로봇용 유선이 여러 개입니다. 사용할 랜선 하나만 남기고 다시 연결하세요.'
                elif choices:
                    message = '로봇을 찾지 못했습니다. 기체에 꽂은 유선을 선택해 유선 연결 설정을 누르세요.'
                else:
                    message = ('로봇을 찾지 못했습니다. 기체 전원과 노트북 랜선을 확인하세요. '
                               '인터넷용 유선 대신 기체 전용 USB 랜 어댑터를 사용하세요. '
                               '연결한 뒤 «유선 연결 설정»을 누르세요. Wi-Fi는 켜 두세요. '
                               '계속 안 되면 아래의 «직접 설정하는 법»을 펼쳐 보세요.')
                status.update(mode=message)
            except Exception:
                status.update(mode='유선 연결 정보를 읽지 못했습니다. 랜선을 확인하고 «유선 연결 설정»을 누르세요. 계속 안 되면 «직접 설정하는 법»을 펼쳐 보세요.')
            try:
                await asyncio.wait_for(stop.wait(), 2)
            except asyncio.TimeoutError:
                pass
    finally:
        controls.request_stop = None
        restore()


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    # The protocol is only an activation signal. Discard the whole untrusted
    # payload, including anything that resembles our own CLI options.
    if '--protocol' in argv:
        argv = []
    parser = argparse.ArgumentParser(description='FOOTHOLD 로봇 연결')
    parser.add_argument('--autostart', action='store_true')
    parser.add_argument('--managed', action='store_true', help=argparse.SUPPRESS)
    parser.add_argument('--repair', action='store_true')
    parser.add_argument('--no-browser', action='store_true')
    parser.add_argument('--nic', help='restrict discovery to this wired NIC (also for no-robot verification)')
    args = parser.parse_args(argv)
    if args.autostart and not autostart_enabled():
        return 0
    root = Path(sys.executable).resolve().parent.parent if os.name == 'nt' else Path(sys.executable).resolve().parents[2]
    if root == Path('/opt/foothold-robot') and not args.managed:
        active = subprocess.run(['systemctl', '--user', 'is-active', '--quiet', 'foothold-robot.service']).returncode == 0
        subprocess.run(['systemctl', '--user', 'start', 'foothold-robot.service'], check=True)
        if active and not args.no_browser:
            open_window('http://127.0.0.1:9611')
        return 0
    os.environ['PATH'] = str(root/'tools')+os.pathsep+os.environ.get('PATH', '/usr/bin:/bin')
    args.server = json.loads((root/'server.json').read_text())['server']
    args.config, args.wheel_dir = default_path(), str(root/'wheels')
    cache = state_dir()
    cache.mkdir(mode=0o700, parents=True, exist_ok=True)
    if os.name == 'nt':
        from .windows import InstanceLock
        instance = InstanceLock(cache/'desktop.lock')
    else:
        from .locking import InstanceLock
        instance = InstanceLock(cache/'desktop.lock')
    try:
        instance.__enter__()
    except BlockingIOError:
        if not args.no_browser:
            open_window('http://127.0.0.1:9611')
        return 0
    try:
        status = Status()
        controls = Controls(status=status, server=args.server)
        report = setup.inspect(args.wheel_dir)  # metadata only, even without a connected NIC
        status.update(preflight={'installation_ready':report['installation_ready'], 'issues':report['issues']})
        server = make_server(status, 9611, controls=controls)
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        try:
            if not args.no_browser:
                open_window('http://127.0.0.1:9611')
            asyncio.run(connect_when_ready(args, status, controls))
        finally:
            server.shutdown()
            worker.join(timeout=3)
            server.server_close()
    finally:
        instance.__exit__(None, None, None)
    if controls.restart:
        os.execve(sys.executable, [sys.executable, '-I', '-m', 'foothold_agent.desktop', '--managed', '--repair'],
                  restart_environment())
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
