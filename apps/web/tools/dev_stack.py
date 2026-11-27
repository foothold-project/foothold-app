"""웹 화면 개발용 로컬 실서버 + 가짜 로봇(실제 로봇 명령 0). 저장소 루트에서, apps/server README 의 venv 로 실행한다.

  python apps/web/tools/dev_stack.py server <폴더> [포트]   임시 PostgreSQL(폴더 안)·마이그레이션·조직/계정 3개/로봇 1대·uvicorn
  python apps/web/tools/dev_stack.py agent <폴더>           apps/agent Client + 가짜 브리지(메모리 sink) — 끄면 «로봇 끊김»
      FH_AGENT_TOKEN=<토큰> 을 주면 stack.json 대신 그 토큰으로 붙는다(화면에서 새로 등록한 로봇 확인용)
  server ... --demo-robots go2-a,go2-b [--demo-floors f1]
      서버가 뜬 뒤 아래 demo 와 같은 일을 kim(총괄)·park(운영) 계정으로 한다
  python apps/web/tools/dev_stack.py demo <폴더> <서버 주소> --demo-robots go2-a,go2-b [--demo-floors f1]
      이미 떠 있는 로컬 서버(Docker 등)에 데모 로봇을 실기와 같은 연결 코드 길(pairing)로 1 대·토큰 1 개씩 등록하고
      층마다 빈 지도(승인 판)를 만든 뒤 <폴더>/demo/demo.yaml(토큰 파일 경로·층 id) 을 쓴다.
      총괄 계정은 환경 변수 FH_DEMO_ADMIN_USER · FH_DEMO_ADMIN_PASSWORD 로만 받고, 운영 계정 demo-operator 를 새로 만든다.
      토큰·비밀번호 값은 <폴더>/demo/ 의 0600 파일에만 쓰고 화면에 내지 않는다.
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


def _secret(path, value):
    path.touch(0o600); path.chmod(0o600); path.write_text(value)


def _wait(base):
    import time
    import urllib.error
    for _ in range(100):
        try:
            _api(base, 'GET', '/api/v1/auth/session')
        except urllib.error.HTTPError:
            return     # 401 = 서버가 응답한다
        except OSError:
            time.sleep(0.2)
    raise SystemExit(f'서버 응답 없음: {base}')


def _login(base, username, password):
    return _api(base, 'POST', '/api/v1/auth/login', dict(username=username, password=password, client='app'))['access_token']


def demo_register(base, admin, robots, floors, folder, operator=None):
    """서버 API 로만(화면·실기와 같은 길) 데모 로봇·현장·층·빈 지도 승인 판을 만들고 demo.yaml 을 쓴다.

    로봇은 실기처럼 연결 코드로 등록한다: 기체 쪽 pairing/start → 운영자 claim·confirm → 기체 쪽 poll 로 토큰.
    일련번호는 MAC 대체 범위(0xFFFF0000..)라 실기 일련번호와 겹치지 않고, 이름 앞 «데모» 로 구분한다
    (서버에 데모 표시 칸은 아직 없다).
    """
    demo = folder / 'demo'
    demo.mkdir(parents=True, exist_ok=True)
    _wait(base)
    admin_token = _login(base, *admin)
    if operator is None:
        operator = ('demo-operator', secrets.token_urlsafe(12))
        _api(base, 'POST', '/api/v1/users', dict(username=operator[0], display_name='데모 운영', role='OPERATOR',
                                                  temp_password=operator[1]), admin_token)
        _secret(demo / 'operator.json', json.dumps(dict(username=operator[0], password=operator[1])))
    op_token = _login(base, *operator)
    url, ids = None, {}
    for i, rid in enumerate(robots):
        started = _api(base, 'POST', '/api/v1/pairing/start',
                       dict(model='unitree_go2', robot_serial=f'{0xFFFF0000 + i}-{secrets.randbelow(2 ** 32)}'))
        _api(base, 'POST', '/api/v1/pairing/claim', dict(code=started['code']), op_token)
        robot = _api(base, 'POST', f'/api/v1/pairing/{started["pairing_id"]}/confirm', dict(name=f'데모 {rid}'), op_token)
        paired = _api(base, 'POST', f'/api/v1/pairing/{started["pairing_id"]}/poll', dict(poll_secret=started['poll_secret']))
        _secret(demo / f'{rid}.token', paired['agent_token'])
        url, ids[rid] = paired['agent_ws_url'], str(robot['id'])
    site = _api(base, 'POST', '/api/v1/sites', dict(name='데모 현장'), admin_token)
    building = _api(base, 'POST', f'/api/v1/sites/{site["id"]}/buildings', dict(name='데모 창고'), admin_token)
    width, height, resolution = DEMO_MAP
    pgm = f'P5 {width} {height} 255\n'.encode() + bytes([254]) * (width * height)
    floor_ids = {}
    for level, key in enumerate(floors, 1):
        floor = _api(base, 'POST', f'/api/v1/buildings/{building["id"]}/floors', dict(name=f'데모 {key}', level=level), admin_token)
        image = _api(base, 'POST', '/api/v1/uploads', pgm, admin_token, 'image/x-portable-graymap')['upload_id']
        meta = (f'image: {key}.pgm\nresolution: {resolution}\norigin: [0.0, 0.0, 0.0]\n'
                'negate: 0\noccupied_thresh: 0.65\nfree_thresh: 0.196\n').encode()
        upload = _api(base, 'POST', f'/api/v1/uploads?image={image}', meta, admin_token, 'text/yaml')['upload_id']
        version = _api(base, 'POST', f'/api/v1/floors/{floor["id"]}/map-versions',
                       dict(base_version_id=None, image=upload, reason='데모 빈 지도',
                            features=dict(zones=[], waypoints=[], connectors=[], edits=[])), admin_token)
        floor_ids[key] = dict(floor_id=str(floor['id']), map_version_id=str(version['id']))
    # JSON 은 YAML 이기도 하다(서버 venv 에 yaml 이 없어도 쓴다). 토큰 값은 넣지 않는다.
    (demo / 'demo.yaml').write_text(json.dumps(dict(
        demo=True, url=url, robots={rid: dict(token_file=f'{rid}.token') for rid in robots},
        floors=floor_ids, robot_ids=ids), ensure_ascii=False, indent=1))
    print(f'데모 로봇 {len(robots)} 대·층 {len(floor_ids)} 개 · 설정 {demo / "demo.yaml"}', flush=True)


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
            db.add(robot); db.commit()
            stack = {'org': str(org.id), 'robot': str(robot.id), 'agent_token': token, 'passwords': pw, 'base': f'http://127.0.0.1:{port}'}
        (folder / 'stack.json').write_text(json.dumps(stack, ensure_ascii=False, indent=1))
        (folder / 'stack.json').chmod(0o600)

        # 지도 파일 저장소(S3a)도 폴더 안 — 기본값 /var/lib/foothold/files 를 쓰지 않는다
        env = {**os.environ, 'FH_DATABASE_URL': url('fh_app'), 'FH_ORG_ID': stack['org'], 'FH_FILES_ROOT': str((folder / 'files').resolve())}
        uv = subprocess.Popen([sys.executable, '-m', 'uvicorn', 'apps.server.fh_server.main:app', '--host', '127.0.0.1', '--port', str(port),
                               '--ws-max-size', '4096', '--workers', '1', '--no-proxy-headers'], cwd=ROOT, env=env)
        if demo_robots:
            demo_register(stack['base'], ('kim', pw['kim']), demo_robots, demo_floors, folder, operator=('park', pw['park']))
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
    elif mode == 'demo':
        admin = (os.environ.get('FH_DEMO_ADMIN_USER', ''), os.environ.get('FH_DEMO_ADMIN_PASSWORD', ''))
        if not all(admin) or not options.get('demo_robots'):
            raise SystemExit('FH_DEMO_ADMIN_USER · FH_DEMO_ADMIN_PASSWORD 와 --demo-robots 가 필요하다')
        demo_register(args[2].rstrip('/'), admin, options['demo_robots'], options.get('demo_floors', ('f1',)), folder)
    else:
        agent(folder)
