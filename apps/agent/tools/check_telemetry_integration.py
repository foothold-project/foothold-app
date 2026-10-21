"""ROS-free actual Client -> existing server -> private PostgreSQL acceptance.

Explicit invocation only, no robot commands, no ROS/systemd/simulation. Requires
apps/server/requirements-test.txt and agent [link]. Reserves a loopback socket;
FH_TEST_PORT_RANGE optionally restricts the available ports.
"""
import asyncio
import json
import os
from pathlib import Path
import threading
import time

from contextlib import contextmanager
import socket

@contextmanager
def server_socket():
    scoped = os.environ.get('FH_TEST_PORT_RANGE')
    if scoped:
        first, last = map(int, scoped.split(':'))
        if not 1024 <= first <= last <= 65535:
            raise ValueError('invalid FH_TEST_PORT_RANGE')
        ports = range(first, last + 1)
    else:
        ports = (0,)
    with socket.socket() as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        for port in ports:
            try:
                sock.bind(('127.0.0.1', port))
                sock.listen(1)
                break
            except OSError:
                continue
        else:
            raise RuntimeError('no available loopback test port')
        yield sock

ROOT = Path(__file__).resolve().parents[3]


def main():
    import httpx
    import uvicorn
    from alembic import command
    from alembic.config import Config
    from apps.server.tests.postgres import temporary_postgres
    from apps.server.tests.conftest import seeded
    from apps.server.fh_server.api import Settings as ServerSettings, create_app
    from foothold_agent.link.client import Client, Settings
    from foothold_agent.link.session import Session
    from foothold_agent.ros_bridge.telemetry import MapBinding, Telemetry
    from websockets.asyncio.client import connect

    class Sink:
        def apply(self, cmd):
            assert cmd.kind != 'unlock' and not any(cmd.velocity)

    with temporary_postgres() as urls, server_socket() as sock:
        prior = os.environ.get('FH_MIGRATE_DATABASE_URL')
        try:
            os.environ['FH_MIGRATE_DATABASE_URL'] = urls['migrate']
            command.upgrade(Config(str(ROOT / 'apps/server/alembic.ini')), 'head')
        finally:
            if prior is None:
                os.environ.pop('FH_MIGRATE_DATABASE_URL', None)
            else:
                os.environ['FH_MIGRATE_DATABASE_URL'] = prior
        data = seeded.__wrapped__(urls)
        from sqlalchemy import create_engine
        from sqlalchemy.orm import Session as DBSession
        from apps.server.fh_server.models import Robot
        from apps.server.fh_server.security import digest
        engine = create_engine(urls['migrate'])
        with DBSession(engine) as db:
            db.get(Robot, data['robots']['mine']).agent_token_hash = digest('unique-telemetry-test-token')
            db.commit()
        engine.dispose()
        app = create_app(ServerSettings(urls['app'], data['org']))
        accepted = []
        original = app.state.realtime.accept_state
        def observe(rid, peer, msg):
            result = original(rid, peer, msg)
            if result:
                accepted.append(msg.model_dump(mode='json'))
            return result
        app.state.realtime.accept_state = observe  # observe after actual schema/auth/ownership checks
        server = uvicorn.Server(uvicorn.Config(app, log_level='error', ws_max_size=4096))
        thread = threading.Thread(target=lambda: server.run(sockets=[sock]), daemon=True)
        thread.start()
        try:
            deadline = time.monotonic()+10
            while not server.started:
                assert thread.is_alive() and time.monotonic() < deadline
                time.sleep(.01)
            base = 'http://127.0.0.1:' + str(sock.getsockname()[1])
            with httpx.Client(base_url=base, trust_env=False) as http:
                response = http.post('/api/v1/auth/login', json={'username': 'one',
                    'password': 'fake-test-password', 'client': 'app'})
                response.raise_for_status()
                access = response.json()['access_token']

            async def check():
                session = Session()
                client = Client(session, Sink(), Settings(base.replace('http:', 'ws:') + '/api/v1/agent/ws', 'unique-telemetry-test-token'))
                # Explicit synthetic binding only; this does not register or guess a map.
                floor = '00000000-0000-4000-8000-000000000001'
                version = '00000000-0000-4000-8000-000000000002'
                cache = Telemetry(binding=MapBinding('w', 'f', 'v', floor, version, 'a'*64, 1, 'run'))
                task = asyncio.create_task(client.run())
                try:
                    async with connect(base.replace('http:', 'ws:')+'/api/v1/ws', proxy=None,
                            additional_headers={'authorization': 'Bearer '+access}) as screen:
                        await screen.send(json.dumps({'t': 'sub', 'id': 'telemetry', 'proto': 'fh-rt/1',
                            'robots': [str(data['robots']['mine'])], 'streams': ['state']}))
                        async def wait_screen(speed):
                            async def read():
                                while True:
                                    frame = json.loads(await screen.recv())
                                    if frame.get('t') == 'state' and frame.get('connection') == 'ONLINE' and frame.get('speed') == speed:
                                        return frame
                            return await asyncio.wait_for(read(), 4)
                        await wait_screen(None)
                        received = time.monotonic()
                        cache.update_state({'schema': 'v2_live/state/1', 'episode': 1, 'sim_t': 1.,
                            'stop_requested': True, 'reset_in_progress': False, 'policy_running': True,
                            'vx': .3, 'vy': .4, 'source': 'gz_gt'}, received)
                        cache.update_map({'schema': 'v2_map_status/1', 'map_frame': 'map', 'epoch': 1,
                            'world_id': 'w', 'floor_id': 'f', 'map_version': 'v', 'run_id': 'run',
                            'map_accepting': True, 'sim_t': 1., 'pose_map': {'source': 'gt_identity',
                                'stamp_sim': 1., 'x': 2., 'y': 3., 'yaw': .25}}, received)
                        client.update_telemetry(cache.snapshot())
                        client.update_devices([{'key': 'test-lidar', 'kind': 'LIDAR', 'label': 'L1',
                            'state': 'OK', 'received_monotonic_s': received}])
                        frame = await wait_screen(.5)
                        assert frame['devices'][0]['state'] == 'OK'
                        assert frame['location'] is not None
                        assert frame['location']['x'] == 2. and frame['location']['y'] == 3.
                        assert frame['location']['yaw'] == .25 and frame['location']['map_version_id'] is None
                        assert any(s['speed'] == .5 and s['pose']['x'] == 2. for s in accepted)
                        frame = await wait_screen(None)
                        assert frame['location'] is None
                        assert frame['devices'][0]['state'] == 'MISSING'
                        assert accepted[-1]['speed'] is None and accepted[-1]['pose']['x'] is None
                        assert all(s['battery']['soc'] is None for s in accepted)
                finally:
                    task.cancel()
                    await asyncio.gather(task, return_exceptions=True)
            asyncio.run(check())
            print('PASS: actual Client/server accepted speed=.5 and pose=(2,3,.25), then stale null; live devices OK -> MISSING; battery unknown; pose mapped with map_version_id null, stale location null')
        finally:
            server.should_exit = True
            thread.join(10)
            assert not thread.is_alive(), 'private server did not stop'


if __name__ == '__main__':
    main()
