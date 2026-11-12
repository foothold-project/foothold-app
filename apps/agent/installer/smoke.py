#!/usr/bin/env python3
"""Rootless extraction/run/remove verification. Never joins DDS or configures a NIC."""
import argparse
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import time
from urllib.request import Request, urlopen


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('package', type=Path)
    parser.add_argument('--keep-open', action='store_true')
    args = parser.parse_args()
    package = args.package.resolve()
    with socket.socket() as probe:
        probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        probe.bind(('127.0.0.1', 9611))  # Fail before touching a pre-existing service.
    with tempfile.TemporaryDirectory(prefix='offline-smoke-', dir=package.parent) as temporary:
        work = Path(temporary)
        root, home = work/'root', work/'home'
        home.mkdir()
        subprocess.run(['dpkg-deb','--extract',str(package),str(root)],check=True)
        app = root/'opt/foothold-robot'
        for rel in ('usr/share/applications/foothold-robot.desktop',
                    'etc/xdg/autostart/foothold-robot.desktop',
                    'usr/lib/systemd/user/foothold-robot.service'):
            assert (root/rel).is_file(), rel
        private = home/'.config/foothold'
        private.mkdir(parents=True, mode=0o700)
        key = private/'agent.json'
        key.write_text('{"test":"retained-connection-key"}\n')
        key.chmod(0o600)
        legacy = private/'go2-agent.env'
        legacy.write_text('MUST_NOT_BE_READ_OR_CHANGED\n')
        environment = dict(HOME=str(home), XDG_CONFIG_HOME=str(home/'.config'),
                           PATH=str(app/'tools')+':/usr/bin:/bin', LANG='C.UTF-8')
        python = app/'python/bin/python3'
        preflight = subprocess.run([str(python),'-I','-m','foothold_agent.go2_direct.preflight',
                                    '--wheel-dir',str(app/'wheels')],env=environment,
                                   text=True,capture_output=True,check=True)
        report = json.loads(preflight.stdout)
        assert report['installation_ready'] and not report['sdk_imported'] and not report['robot_connected']
        subprocess.run([str(python),'-I','-c','import cv2,qrcode; assert cv2.__version__ == "4.10.0"'],
                       env=environment,check=True)
        process = subprocess.Popen([str(app/'launch'),'--no-browser','--nic','fh-missing'],
                                   env=environment, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        url = 'http://127.0.0.1:9611'
        def get(path):
            with urlopen(url+path, timeout=2) as response: return json.load(response)
        def action(body):
            request = Request(url+'/action',data=json.dumps(body).encode(),
                              headers={'Origin':url,'Content-Type':'application/json'})
            with urlopen(request, timeout=2) as response: assert response.status == 204
        try:
            deadline = time.monotonic()+20
            while time.monotonic() < deadline:
                assert process.poll() is None, process.communicate()
                try:
                    status = get('/status')
                    if '로봇을 찾지 못했습니다' in status['mode']: break
                except OSError:
                    pass
                time.sleep(.1)
            else:
                raise AssertionError('no missing-robot guidance within 20 seconds')
            with urlopen(url, timeout=2) as response:
                page = response.read().decode()
            assert '유선 연결 설정' in page and '로그인하면 자동으로 켜기' in page
            assert not status['connected'] and status.get('code') is None
            action(dict(action='autostart',enabled=False))
            assert not get('/desktop')['autostart']
            auto = home/'.config/autostart/foothold-robot.desktop'
            assert 'Hidden=true' in auto.read_text()
            # A disabled login start must return without binding or contacting DDS.
            subprocess.run([str(app/'launch'),'--autostart','--no-browser'],env=environment,check=True,timeout=5)
            action(dict(action='autostart',enabled=True))
            assert get('/desktop')['autostart'] and 'Hidden=false' in auto.read_text()
            duplicate = subprocess.run([str(app/'launch'),'--no-browser','--nic','fh-missing'],
                                       env=environment,check=True,timeout=5)
            if args.keep_open:
                print(json.dumps(dict(ready=url,home=str(home),pid=process.pid)),flush=True)
                # Browser QA can send the exit action; cap retained test at 3 min.
                try:
                    process.wait(timeout=180)
                except subprocess.TimeoutExpired:
                    action(dict(action='quit'))
            else:
                action(dict(action='quit'))
            process.wait(timeout=10)
            assert process.returncode == 0, process.communicate()
            assert key.read_text() == '{"test":"retained-connection-key"}\n'
            assert legacy.read_text() == 'MUST_NOT_BE_READ_OR_CHANGED\n'
            shutil.rmtree(root)  # Rootless removal of package-owned files only.
            assert key.exists() and auto.exists() and not app.exists()
            print(json.dumps(dict(result='PASS',installation='rootless extraction only',
                                  preflight=True,missing_robot=True,autostart_files=True,
                                  optout=True,duplicate=True,removed=True,connection_key_preserved=True)))
        finally:
            if process.poll() is None:
                process.terminate()
                try: process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill(); process.wait()


if __name__ == '__main__':
    main()
