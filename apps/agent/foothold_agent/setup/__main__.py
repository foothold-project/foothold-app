"""Start the local laptop connection program; actual invocation joins DDS domain 0."""
import argparse
import asyncio
import os
import sys
import threading
import time
from pathlib import Path
from dataclasses import replace
from urllib.error import HTTPError, URLError

from .platform import inspect, install_stop_handlers
from foothold_agent.link.client import ReconnectForbidden
from foothold_agent.go2_readonly.sdk import Subscriptions
from .discovery import candidates, select
from .pairing import Pairing, origin, ws_origin
from .runtime import Inputs, SerialUnavailable, run
from .storage import default_path, load, save
from .view import Status, make_server, qr_svg
from foothold_agent.depth.source import Source as DepthSource, Publisher as DepthPublisher
from types import SimpleNamespace


async def connect(args, status, stop, *, discover=candidates, subscriptions_factory=Subscriptions,
                  preflight=inspect, pairing_factory=Pairing, runtime=run, depth_factory=DepthSource):
    # No inherited motion setting, token, legacy config file or DDS loader can
    # silently select a different entrypoint/channel in this process.
    if any(os.environ.get(k) for k in ('CYCLONEDDS_URI', 'CYCLONEDDS_HOME', 'LD_LIBRARY_PATH')):
        raise PermissionError('DDS loader overrides require review')
    report = await asyncio.to_thread(preflight, args.wheel_dir)
    status.update(preflight={'installation_ready': report['installation_ready'], 'issues': report['issues']})
    saved_credentials = credentials = load(args.config)
    server = origin(args.server) if args.server else ws_origin(credentials.agent_ws_url) if credentials else None
    if server is None:
        raise ValueError('first connection requires --server HTTPS origin')
    if credentials is not None and server != ws_origin(credentials.agent_ws_url):
        raise PermissionError('saved connection belongs to another server')
    nic = select(await asyncio.to_thread(discover), args.nic)
    inputs = Inputs()
    if os.name == 'nt' and subscriptions_factory is Subscriptions:
        subscriptions = subscriptions_factory(inputs, nic.name, dds_name=nic.dds_name)
    else:
        subscriptions = subscriptions_factory(inputs, nic.name)
    pairing = None
    depth = media_task = None
    try:
        subscriptions.start()  # only two readonly subscriptions; no motion factory
        depth = depth_factory(env=os.environ, status=status)
        depth.start()  # metadata and selected depth reader on an independent daemon
        deadline = time.monotonic()+10
        while not stop.is_set():
            try:
                serial = inputs.identity()
                break
            except SerialUnavailable:
                raise
            except PermissionError:
                if inputs.conflict or time.monotonic() >= deadline:
                    raise PermissionError('one fresh nonzero DDS identity required') from None
                await asyncio.sleep(.02)
        else:
            return
        status.update(serial=serial)
        if credentials is not None and credentials.robot_serial != serial:
            raise PermissionError('saved serial differs from current DDS identity')
        if credentials is None or getattr(args, 'repair', False):
            pairing = pairing_factory(server)
            await asyncio.to_thread(pairing.start, serial)
            status.update(code=pairing.code, expires_at=pairing.expires_at, qr=qr_svg(pairing.code),
                          mode='웹에서 노트북 화면의 코드를 넣고 이름을 입력하세요')
            while not stop.is_set():
                if inputs.identity() != serial:
                    raise PermissionError('DDS identity changed during pairing')
                try:
                    credentials = await asyncio.to_thread(pairing.poll, serial)
                except HTTPError:
                    raise PermissionError('pairing request rejected') from None
                except (ConnectionError, TimeoutError, URLError):
                    if time.time() >= pairing.expires_at:
                        raise PermissionError('pairing expired') from None
                    await asyncio.sleep(2)
                    continue
                if credentials is not None:
                    if saved_credentials is not None and saved_credentials.robot_id == credentials.robot_id:
                        credentials = replace(credentials, last_field_approval_expires_at=
                                              saved_credentials.last_field_approval_expires_at)
                    save(credentials, args.config)
                    break
                await asyncio.sleep(2)
            else:
                return
        status.update(code=None, qr=None, expires_at=None, mode='읽기 전용 · 서버 연결 중')
        def check_nic():
            if os.name == 'nt' and discover is candidates:
                from .windows_nic import matches
                return matches(nic)
            try:
                return select(discover(), nic.name) == nic
            except (ValueError, PermissionError):
                return False
        def remember(expiry):
            nonlocal credentials
            credentials = replace(credentials, last_field_approval_expires_at=expiry)
            save(credentials, args.config)
        media_config = SimpleNamespace(robot=credentials.robot_id, link=credentials.link)
        depth.bind(media_config)
        media_task = asyncio.create_task(DepthPublisher(media_config, source=depth).run())
        await runtime(credentials, nic, inputs, subscriptions, remember=remember, ready=report['installation_ready'],
                      check_nic=check_nic, status=status, stop=stop)
    finally:
        if depth is not None:
            depth.close()
        if media_task is not None:
            media_task.cancel()
            await asyncio.gather(media_task, return_exceptions=True)
        if pairing is not None:
            pairing.clear()
        status.update(code=None, qr=None, expires_at=None, connected=False)
        subscriptions.close()


async def serve(args, status, *, stop=None):
    stop = stop if stop is not None else asyncio.Event()
    restore = install_stop_handlers(stop)
    try:
        try:
            await connect(args, status, stop)
            return True
        except ReconnectForbidden:
            status.update(mode='이 노트북의 연결이 해제됨 → 다시 연결: 종료 후 --repair로 실행하고 폰에서 새 QR을 확인하세요',
                          connected=False, code=None, qr=None, expires_at=None)
            print('이 노트북의 연결이 해제됨 → 다시 연결: 종료 후 --repair로 실행하세요.', file=sys.stderr)
            await stop.wait()
            return False
        except SerialUnavailable:
            status.update(mode='기체번호를 읽을 수 없는 기체 — 수동 절차 (GO2-SERVER-DRIVE.md의 문제 생겼을 때 참고)',
                          connected=False, code=None, qr=None, expires_at=None)
            await stop.wait()
            return False
        except Exception:
            status.update(mode='연결 거부 · 랜선·자동 점검·서버 연결을 확인한 뒤 프로그램을 다시 실행하세요',
                          connected=False, code=None, qr=None, expires_at=None)
            print('연결을 거부했습니다. 노트북 화면을 확인하고 종료하려면 Ctrl+C를 누르세요.', file=sys.stderr)
            await stop.wait()
            return False
    finally:
        restore()


def main(argv=None):
    parser = argparse.ArgumentParser(description='FOOTHOLD 노트북 연결 프로그램 (유선 DDS 읽기 → 폰 등록 → 현장 승인)')
    parser.add_argument('--server', help='first run: HTTPS server origin; later recovered from private saved connection')
    parser.add_argument('--repair', action='store_true',
                        help='explicitly pair again; replace the saved token only after phone confirmation succeeds')
    parser.add_argument('--nic', help='choose one detected dedicated wired NIC when there are multiple')
    parser.add_argument('--port', type=int, default=9611)
    parser.add_argument('--config', type=Path, default=default_path(),
                        help='private absolute agent.json path (legacy go2-agent.env is never read)')
    parser.add_argument('--wheel-dir', default='runs/go2-x86-artifacts')
    parser.add_argument('--no-browser', action='store_true')
    args = parser.parse_args(argv)
    status = Status()
    server = worker = None
    try:
        # Listener validation/bind happens before any DDS import/initialization.
        server = make_server(status, args.port)
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        url = f'http://127.0.0.1:{server.server_port}'
        print('로봇 연결 화면: '+url, flush=True)
        if not args.no_browser:
            from foothold_agent.desktop.browser import open_window
            open_window(url)
        return 0 if asyncio.run(serve(args, status)) else 2
    except (Exception, KeyboardInterrupt):
        # Exception text and tracebacks may contain request/credential values.
        status.update(mode='연결 거부 또는 종료 · 랜선·자동 점검·서버 연결을 확인하세요', connected=False,
                      code=None, qr=None, expires_at=None)
        print('로봇 연결이 종료되었습니다. 랜선·자동 점검·서버 연결을 확인하세요.', file=sys.stderr)
        return 2
    finally:
        if worker is not None:
            server.shutdown()
            worker.join(timeout=3)
        if server is not None:
            server.server_close()


if __name__ == '__main__':
    raise SystemExit(main())
