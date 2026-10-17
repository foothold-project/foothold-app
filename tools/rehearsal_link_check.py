#!/usr/bin/env python3
"""실제 v2_link 계획 HTTP 경로 + 실제 저장소를 임시 폴더/로컬 HTTP로 검증. ROS 기동 0."""
import ast
import asyncio
import json
from pathlib import Path
import sys
import tempfile
import threading
from types import SimpleNamespace
from urllib.parse import unquote

import tornado.httpclient
import tornado.httpserver
import tornado.ioloop
import tornado.netutil
import tornado.web


async def check():
    root = Path(__file__).resolve().parents[1]
    sys.path.insert(0, str(root))
    source = root / 'sim' / 'v2_link.py'
    tree = ast.parse(source.read_text())
    main = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == 'main')
    wanted = {'rehearsal_store', 'rehearsal_init_lock', 'rehearsal_slots'}
    nodes = [n for n in main.body if
             (isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id in wanted for t in n.targets)) or
             (isinstance(n, (ast.FunctionDef, ast.ClassDef)) and n.name in {'rehearsal_work', 'RehearsalAPI'})]
    assert len(nodes) == 5
    ret = ast.parse('return RehearsalAPI, rehearsal_slots').body[0]
    boot = ast.FunctionDef(name='boot', args=ast.arguments(posonlyargs=[], args=[], kwonlyargs=[], kw_defaults=[], defaults=[]),
                           body=nodes + [ret], decorator_list=[])
    module = ast.fix_missing_locations(ast.Module(body=[boot], type_ignores=[]))
    sockets = tornado.netutil.bind_sockets(0, '127.0.0.1')
    port = sockets[0].getsockname()[1]
    origin = f'http://127.0.0.1:{port}'
    with tempfile.TemporaryDirectory(prefix='fh-rehearsal-http-') as folder:
        ns = {'asyncio': asyncio, 'threading': threading, 'Path': Path, 'tornado': tornado,
              'a': SimpleNamespace(media=folder), 'allowed_origins': {origin},
              'actor_from_header': lambda x: unquote(x) if x else None}
        exec(compile(module, str(source), 'exec'), ns)
        handler, slots = ns['boot']()
        server = tornado.httpserver.HTTPServer(tornado.web.Application([(r'/api/rehearsal', handler)]))
        server.add_sockets(sockets)
        client = tornado.httpclient.AsyncHTTPClient()
        n = 0

        async def request(body=None, expected=200, headers=None, raw=None):
            nonlocal n
            kwargs = {} if body is None and raw is None else {'method': 'POST', 'body': raw if raw is not None else json.dumps(body)}
            r = await client.fetch(f'{origin}/api/rehearsal', headers=headers or {'Origin': origin, 'Content-Type': 'application/json'},
                                   raise_error=False, request_timeout=20, **kwargs)
            assert r.code == expected, (expected, r.code, r.body)
            assert r.headers.get('Cache-Control') == 'no-store'
            assert r.headers.get('Content-Type', '').startswith('application/json')
            n += 1
            return json.loads(r.body)

        try:
            await request({'op': 'list'}, 403, {'Origin': 'http://outside.invalid'})
            assert not (Path(folder) / 'rehearsal').exists(), '異 origin must not create store'
            await request({'op': 'list'}, 400, {'Origin': origin, 'Content-Encoding': 'gzip'})
            assert not (Path(folder) / 'rehearsal').exists()
            listing = await request()
            assert listing['projects'] == []
            scene = {'schema': 'fh_rehearsal_scene/1', 'name': 'HTTP 검증',
                     'world': {'origin': [0, 0], 'size': [8, 6], 'resolution': 0.05, 'background': None},
                     'floors': [{'id': 'floor1', 'name': '1층', 'z': 0, 'height': 3}], 'elements': [],
                     'robots': [{'id': 'robot1', 'name': '계획 로봇', 'model': 'go2_proxy', 'floor': 'floor1',
                                 'pose': [1, 1, 0], 'sensors': []}], 'equipment': [],
                     'routes': [{'id': 'route1', 'robot': 'robot1', 'floor': 'floor1', 'points': [[1, 1], [3, 1]]}],
                     'scenarios': [{'id': 'case_a', 'name': 'A', 'robots': ['robot1'], 'routes': ['route1']}]}
            made = await request({'op': 'put', 'id': None, 'scene': scene}, headers={'Origin': origin, 'X-FH-Actor': 'test-user'})
            project = made['project']; pid = project['id']
            assert project['rev'] == 1
            got = await request({'op': 'get', 'id': pid})
            assert got['scene'] == scene
            await request({'op': 'put', 'id': pid, 'rev': 0, 'scene': scene}, 409)
            await request(raw='{"op":"list","op":"delete"}', expected=400)
            await request(raw='{"op":"analyze","scene":NaN}', expected=400)
            analyzed = await request({'op': 'analyze', 'id': pid})
            assert analyzed['ok'] is True and '기하' in analyzed['note']
            exported = await request({'op': 'export', 'id': pid})
            assert exported['mime'] == 'application/zip' and exported['bytes'] > 0
            assert (await request())['projects'][0]['id'] == pid
            await slots.acquire()
            try:
                await request(expected=503)
            finally:
                slots.release()
            await request({'op': 'delete', 'id': pid, 'rev': 1})
            assert (await request())['projects'] == []
            assert not (Path(folder) / 'photos').exists()
            assert not (Path(folder) / 'docs.json').exists()
            print(f'REHEARSAL_LINK_OK checks={n} actual_handler_actual_store_temporary_only')
        finally:
            server.stop()
            await server.close_all_connections()


if __name__ == '__main__':
    asyncio.run(check())
