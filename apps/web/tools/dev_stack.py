"""웹 화면 개발용 로컬 실서버 + 가짜 로봇(실제 로봇 명령 0). 저장소 루트에서, apps/server README 의 venv 로 실행한다.

  python apps/web/tools/dev_stack.py server <폴더> [포트]   임시 PostgreSQL(폴더 안)·마이그레이션·조직/계정 3개/로봇 1대·uvicorn
  python apps/web/tools/dev_stack.py agent <폴더>           apps/agent Client + 가짜 브리지(메모리 sink) — 끄면 «로봇 끊김»

계정 비밀번호·로봇 토큰은 실행할 때마다 새로 만들어 <폴더>/stack.json 에만 쓴다(커밋 금지 — 폴더는 runs/ 아래).
Ctrl+C(또는 SIGTERM)로 uvicorn·PostgreSQL 까지 모두 끈다. 포트는 127.0.0.1 만.
"""
import asyncio
import json
import os
from pathlib import Path
import secrets
import signal
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT))


def server(folder: Path, port: int):
    from alembic import command
    from alembic.config import Config
    from pgserver import initdb, pg_ctl
    from sqlalchemy import create_engine, text
    from sqlalchemy.engine import URL
    from sqlalchemy.orm import Session as DB
    from apps.server.fh_server.models import Organization, Robot, User
    from apps.server.fh_server.security import digest, hash_password

    # apps/server/tests/postgres.py 와 같은 방식(유닉스 소켓만, TCP 안 엶) — 자료 폴더만 작업 폴더 안
    data, sock = folder / 'pg', folder / 's'
    sock.mkdir(parents=True, exist_ok=True)
    initdb(['--auth=trust', '--encoding=UTF8', '--locale=C', '-U', 'postgres'], pgdata=data)
    pg_ctl(['-w', '-o', f'-h "" -k {sock} -p 5432', '-l', str(folder / 'pg.log'), 'start'], pgdata=data)
    uv = None
    try:
        url = lambda user: URL.create('postgresql+psycopg', username=user, database='postgres',
                                      query={'host': str(sock), 'port': '5432'}).render_as_string(hide_password=False)
        with create_engine(url('postgres')).begin() as c:
            for role in ('fh_migrate', 'fh_app', 'fh_readonly'):
                c.execute(text(f'CREATE ROLE {role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT'))
            c.execute(text('REVOKE CREATE ON SCHEMA public FROM PUBLIC'))
            c.execute(text('GRANT USAGE, CREATE ON SCHEMA public TO fh_migrate'))
        os.environ['FH_MIGRATE_DATABASE_URL'] = url('fh_migrate')
        command.upgrade(Config(str(ROOT / 'apps/server/alembic.ini')), 'head')

        pw = {k: secrets.token_urlsafe(12) for k in ('kim', 'park', 'lee')}
        token = secrets.token_urlsafe(24)
        with DB(create_engine(url('fh_migrate'))) as db:
            org = Organization(name='개발 조직', settings={})
            db.add(org); db.flush()
            users = {k: User(org_id=org.id, username=k, display_name=name, role=role, password_hash=hash_password(pw[k]), locked=False)
                     for k, name, role in (('kim', '김총괄', 'ORG_ADMIN'), ('park', '박운영', 'OPERATOR'), ('lee', '이운영', 'OPERATOR'))}
            db.add_all(users.values()); db.flush()
            robot = Robot(org_id=org.id, name='Go2-7', model='unitree_go2', owner_user_id=users['park'].id, agent_token_hash=digest(token))
            db.add(robot); db.commit()
            stack = {'org': str(org.id), 'robot': str(robot.id), 'agent_token': token, 'passwords': pw, 'base': f'http://127.0.0.1:{port}'}
        (folder / 'stack.json').write_text(json.dumps(stack, ensure_ascii=False, indent=1))
        (folder / 'stack.json').chmod(0o600)

        env = {**os.environ, 'FH_DATABASE_URL': url('fh_app'), 'FH_ORG_ID': stack['org']}
        uv = subprocess.Popen([sys.executable, '-m', 'uvicorn', 'apps.server.fh_server.main:app', '--host', '127.0.0.1', '--port', str(port),
                               '--ws-max-size', '4096', '--workers', '1', '--no-proxy-headers'], cwd=ROOT, env=env)
        print(f'서버 {stack["base"]} — 계정·토큰은 {folder / "stack.json"}', flush=True)
        signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt))
        uv.wait()
    except KeyboardInterrupt:
        pass
    finally:
        if uv and uv.poll() is None:
            uv.terminate(); uv.wait(10)
        pg_ctl(['-w', '-m', 'fast', 'stop'], pgdata=data)


def agent(folder: Path):
    from foothold_agent.link.client import Client, Settings
    from foothold_agent.link.session import Session
    from foothold_agent.safety.core import SCHEMA

    stack = json.loads((folder / 'stack.json').read_text())

    class Bridge:
        """가짜 로봇: 받은 명령을 메모리에만 두고, 정지·해제를 시뮬 state 로 되돌려 준다(물리 출력 0)"""
        stop = True
        velocity = (0.0, 0.0, 0.0)

        def apply(self, command):
            if command.kind == 'stop':
                self.stop, self.velocity = True, (0.0, 0.0, 0.0)
            elif command.kind == 'unlock':
                self.stop = False
            else:
                self.velocity = tuple(command.velocity)

    async def main():
        bridge = Bridge()
        client = Client(Session(asyncio.get_running_loop().time), bridge,
                        Settings(url=stack['base'].replace('http', 'ws', 1) + '/api/v1/agent/ws', token=stack['agent_token']))
        task = asyncio.create_task(client.run())
        last = None
        while not task.done():
            vx, _, wz = bridge.velocity
            client.on_robot_state({'schema': SCHEMA, 'episode': 0, 'stop_requested': bridge.stop, 'reset_in_progress': False,
                                   'policy_running': True, 'vx': vx, 'wz': wz})
            if (bridge.stop, bridge.velocity) != last:
                last = (bridge.stop, bridge.velocity)
                print(f'가짜 로봇: {"정지 요청" if bridge.stop else "해제"} 속도={bridge.velocity}', flush=True)
            await asyncio.sleep(0.1)
        task.result()

    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    mode, folder = sys.argv[1], Path(sys.argv[2]).resolve()
    server(folder, int(sys.argv[3]) if len(sys.argv) > 3 else 8880) if mode == 'server' else agent(folder)
