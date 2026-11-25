"""웹 화면 개발용 로컬 실서버 + 가짜 로봇(실제 로봇 명령 0). 저장소 루트에서, apps/server README 의 venv 로 실행한다.

  python apps/web/tools/dev_stack.py server <폴더> [포트]   임시 PostgreSQL(폴더 안)·마이그레이션·조직/계정 3개/로봇 1대·uvicorn
  python apps/web/tools/dev_stack.py agent <폴더>           apps/agent Client + 가짜 브리지(메모리 sink) — 끄면 «로봇 끊김»
      FH_AGENT_TOKEN=<토큰> 을 주면 stack.json 대신 그 토큰으로 붙는다(화면에서 새로 등록한 로봇 확인용)
  server ... --demo-robots go2-a,go2-b [--demo-floors f1]
      데모 로봇(시나리오 로봇 id 마다 1 대·토큰 1 개)과 층마다 빈 지도(승인 판)를 더 만들고
      <폴더>/demo/demo.yaml(데모 등록 설정: 토큰 파일 경로·층 id) 을 쓴다. 토큰 값은 <폴더>/demo/*.token 에만.
      python -m foothold_agent.demo run <시나리오> --config <폴더>/demo/demo.yaml --replay <재생 자료>

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


DEMO_MAP = (600, 400, 0.1)   # 빈 데모 지도: 60 m x 40 m, 원점 (0, 0). 시나리오 좌표가 이 안에 들어와야 한다


def _api(base, method, path, body=None, token=None, content_type='application/json'):
    import urllib.request
    data = body if isinstance(body, bytes) or body is None else json.dumps(body).encode()
    request = urllib.request.Request(base + path, data=data, method=method)
    request.add_header('Content-Type', content_type)
    if token:
        request.add_header('Authorization', 'Bearer ' + token)
    with urllib.request.urlopen(request, timeout=10) as response:
        return json.loads(response.read() or b'null')


def demo_site(base, password, floors, folder):
    """서버 API 로(화면과 같은 길) 데모 현장·층·빈 지도 승인 판을 만들고 층별 id 를 돌려준다"""
    import time
    import urllib.error
    for _ in range(100):
        try:
            _api(base, 'GET', '/api/v1/auth/session')
        except urllib.error.HTTPError:
            break      # 401 = 서버가 응답한다
        except OSError:
            time.sleep(0.2)
    token = _api(base, 'POST', '/api/v1/auth/login', dict(username='kim', password=password, client='app'))['access_token']
    site = _api(base, 'POST', '/api/v1/sites', dict(name='데모 현장'), token)
    building = _api(base, 'POST', f'/api/v1/sites/{site["id"]}/buildings', dict(name='데모 창고'), token)
    width, height, resolution = DEMO_MAP
    pgm = f'P5 {width} {height} 255\n'.encode() + bytes([254]) * (width * height)
    result = {}
    for level, key in enumerate(floors, 1):
        floor = _api(base, 'POST', f'/api/v1/buildings/{building["id"]}/floors', dict(name=f'데모 {key}', level=level), token)
        image = _api(base, 'POST', '/api/v1/uploads', pgm, token, 'image/x-portable-graymap')['upload_id']
        meta = (f'image: {key}.pgm\nresolution: {resolution}\norigin: [0.0, 0.0, 0.0]\n'
                'negate: 0\noccupied_thresh: 0.65\nfree_thresh: 0.196\n').encode()
        upload = _api(base, 'POST', f'/api/v1/uploads?image={image}', meta, token, 'text/yaml')['upload_id']
        version = _api(base, 'POST', f'/api/v1/floors/{floor["id"]}/map-versions',
                       dict(base_version_id=None, image=upload, reason='데모 빈 지도',
                            features=dict(zones=[], waypoints=[], connectors=[], edits=[])), token)
        result[key] = dict(floor_id=str(floor['id']), map_version_id=str(version['id']))
    return result


def server(folder: Path, port: int, demo_robots=(), demo_floors=('f1',)):
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
    # SIGTERM 도 Ctrl+C 처럼 — 시작·종료 중 어디서 와도 아래 finally 가 uvicorn·PostgreSQL 을 끈다
    signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt))
    uv = None
    try:
        initdb(['--auth=trust', '--encoding=UTF8', '--locale=C', '-U', 'postgres'], pgdata=data)
        pg_ctl(['-w', '-o', f'-h "" -k {sock} -p 5432', '-l', str(folder / 'pg.log'), 'start'], pgdata=data)
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
            db.add(robot)
            # 데모 로봇: 실기와 같은 «등록된 로봇 + 토큰 1 개». 이름 앞 «데모» 로만 구분(서버 데모 표시 칸은 아직 없다)
            demo_tokens = {rid: secrets.token_urlsafe(24) for rid in demo_robots}
            demo_rows = {rid: Robot(org_id=org.id, name=f'데모 {rid}', model='unitree_go2', owner_user_id=users['park'].id,
                                    agent_token_hash=digest(t)) for rid, t in demo_tokens.items()}
            db.add_all(demo_rows.values()); db.commit()
            stack = {'org': str(org.id), 'robot': str(robot.id), 'agent_token': token, 'passwords': pw, 'base': f'http://127.0.0.1:{port}',
                     'demo_robots': {rid: str(r.id) for rid, r in demo_rows.items()}}
        (folder / 'stack.json').write_text(json.dumps(stack, ensure_ascii=False, indent=1))
        (folder / 'stack.json').chmod(0o600)

        # 지도 파일 저장소(S3a)도 폴더 안 — 기본값 /var/lib/foothold/files 를 쓰지 않는다
        env = {**os.environ, 'FH_DATABASE_URL': url('fh_app'), 'FH_ORG_ID': stack['org'], 'FH_FILES_ROOT': str((folder / 'files').resolve())}
        uv = subprocess.Popen([sys.executable, '-m', 'uvicorn', 'apps.server.fh_server.main:app', '--host', '127.0.0.1', '--port', str(port),
                               '--ws-max-size', '4096', '--workers', '1', '--no-proxy-headers'], cwd=ROOT, env=env)
        if demo_robots:
            demo = folder / 'demo'
            demo.mkdir(exist_ok=True)
            for rid, t in demo_tokens.items():
                path = demo / f'{rid}.token'
                path.touch(0o600); path.chmod(0o600); path.write_text(t)
            floors = demo_site(stack['base'], pw['kim'], demo_floors, folder)
            # JSON 은 YAML 이기도 하다(서버 venv 에 yaml 이 없어도 쓴다). 토큰 값은 넣지 않는다.
            (demo / 'demo.yaml').write_text(json.dumps(dict(
                demo=True, url=stack['base'].replace('http', 'ws', 1) + '/api/v1/agent/ws',
                robots={rid: dict(token_file=f'{rid}.token') for rid in demo_robots}, floors=floors), ensure_ascii=False, indent=1))
            print(f'데모 로봇 {len(demo_robots)} 대·층 {len(floors)} 개 · 설정 {demo / "demo.yaml"}', flush=True)
        print(f'서버 {stack["base"]} — 계정·토큰은 {folder / "stack.json"}', flush=True)
        uv.wait()
    except KeyboardInterrupt:
        pass
    finally:
        signal.signal(signal.SIGTERM, signal.SIG_IGN)   # 정리 중 두 번째 SIGTERM 이 정리를 끊지 않게
        try:
            if uv and uv.poll() is None:
                uv.terminate()
                try:
                    uv.wait(10)
                except subprocess.TimeoutExpired:
                    uv.kill(); uv.wait()
        finally:
            if (data / 'postmaster.pid').exists():
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
                        Settings(url=stack['base'].replace('http', 'ws', 1) + '/api/v1/agent/ws', token=os.environ.get('FH_AGENT_TOKEN') or stack['agent_token']))
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
    args, options = [], {}
    rest = iter(sys.argv[1:])
    for arg in rest:
        if arg in ('--demo-robots', '--demo-floors'):
            options[arg[2:].replace('-', '_')] = tuple(v for v in next(rest).split(',') if v)
        else:
            args.append(arg)
    mode, folder = args[0], Path(args[1]).resolve()
    if mode == 'server':
        server(folder, int(args[2]) if len(args) > 2 else 8880, **options)
    else:
        agent(folder)
