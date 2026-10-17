#!/usr/bin/env python3
"""계획 API의 실제 관문 클래스를 추출해 로컬 임시 HTTP 서버로 인증 경계를 확인한다.

실제 계정·관문·ROS를 사용하지 않으며 앱 쿠키/토큰은 이 프로세스의 가짜 값이다.
"""
import ast
import asyncio
import json
from pathlib import Path
import sys
import time
from urllib.parse import quote

import tornado.httpclient
import tornado.httpserver
import tornado.netutil
import tornado.simple_httpclient
import tornado.web


async def check():
    source = Path(__file__).resolve().parents[1] / 'sim' / 'v2_gate.py'
    tree = ast.parse(source.read_text())
    main = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == 'main')
    names = {'Base', 'DocsProxy', 'RehearsalProxy', 'AppBase', 'AppRehearsal'}
    nodes = [n for n in main.body if isinstance(n, ast.ClassDef) and n.name in names]
    assert {n.name for n in nodes} == names
    seen = []

    class Up(tornado.web.RequestHandler):
        def get(self):
            seen.append(('GET', self.request.path, self.request.headers.get('X-FH-Actor')))
            self.finish({'projects': []})

        def post(self):
            body = json.loads(self.request.body)
            seen.append(('POST', self.request.path, self.request.headers.get('X-FH-Actor'), body))
            self.set_status(body.get('test_status', 200))
            if body.get('test_oversize'):
                return self.finish(b'x' * (1024 * 1024 + 1))
            self.finish({'ok': True})

    up_sockets = tornado.netutil.bind_sockets(0, '127.0.0.1')
    up_port = up_sockets[0].getsockname()[1]
    up = tornado.httpserver.HTTPServer(tornado.web.Application([(r'/api/rehearsal', Up)]))
    up.add_sockets(up_sockets)
    sockets = tornado.netutil.bind_sockets(0, '127.0.0.1')
    port = sockets[0].getsockname()[1]
    host = f'127.0.0.1:{port}'

    class Sessions:
        def get(self, tok, now):
            return {'account': 'qa', 'device': 'qa-device', 'label': 'test phone'} if tok == 'test-session' else None

    class FakeAuth:
        @staticmethod
        def origin_ok(origin):
            return origin == 'https://localhost'

        @staticmethod
        def bearer(header):
            return 'test-session' if header == 'Bearer qa-only-token' else None

    class FakeG:
        @staticmethod
        def same_origin(origin, request_host, hosts):
            return request_host in hosts and origin == f'http://{request_host}'

    # Execute the actual top-level limit function, not a test reimplementation.
    policy = [n for n in tree.body if (isinstance(n, ast.FunctionDef) and n.name == 'request_body_ok') or
              (isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id in {'REHEARSAL_PATHS', 'REHEARSAL_MAX'} for t in n.targets))]
    ns = {'tornado': tornado, 'asyncio': asyncio, 'time': time, 'quote': quote, 'sessions': Sessions(), 'app_sessions': Sessions(),
          'G': FakeG, 'A': FakeAuth, 'gate_hosts': {host}, 'UP_HTTP': f'http://127.0.0.1:{up_port}',
          'UP_ORIGIN': f'http://127.0.0.1:{up_port}'}
    exec(compile(ast.Module(body=policy + nodes, type_ignores=[]), str(source), 'exec'), ns)

    class Legacy(ns['Base']):
        def post(self):
            self.finish({'ok': True})

    app = tornado.web.Application([(r'/api/rehearsal', ns['RehearsalProxy']),
                                  (r'/api/app/rehearsal', ns['AppRehearsal']), (r'/api/docs', Legacy)])
    server = tornado.httpserver.HTTPServer(app, max_body_size=ns['REHEARSAL_MAX'])
    server.add_sockets(sockets)
    http = tornado.httpclient.AsyncHTTPClient()
    n = 0

    async def request(path, expected, method='GET', headers=None, body=None):
        nonlocal n
        response = await http.fetch(f'http://{host}{path}', method=method, headers=headers or {},
                                    body=body, raise_error=False, request_timeout=5)
        assert response.code == expected, (path, response.code, response.body)
        assert response.headers.get('Content-Type', '').startswith('application/json'), response.body
        n += 1
        return response

    try:
        web = {'Cookie': 'fh2_s=test-session', 'Origin': f'http://{host}', 'Content-Type': 'application/json'}
        native = {'Authorization': 'Bearer qa-only-token', 'Origin': 'https://localhost', 'Content-Type': 'application/json'}
        await request('/api/rehearsal', 401)
        await request('/api/rehearsal', 200, headers=web)
        await request('/api/rehearsal', 403, 'POST', {**web, 'Origin': 'https://outside.invalid'}, '{}')
        await request('/api/rehearsal', 200, 'POST', web, '{"op":"list"}')
        assert seen[-1][2] == quote('qa · test phone', safe='')
        assert seen[-1][1] == '/api/rehearsal' and seen[-1][3] == {'op': 'list'}
        before = len(seen)
        await request('/api/rehearsal', 400, 'POST', {**web, 'Content-Encoding': 'gzip'}, '{}')
        assert len(seen) == before
        await request('/api/app/rehearsal', 401, headers={'Origin': 'https://localhost', 'Cookie': 'fh2_s=test-session'})
        await request('/api/app/rehearsal', 403, headers={**native, 'Origin': 'https://outside.invalid'})
        await request('/api/app/rehearsal', 200, headers=native)
        await request('/api/app/rehearsal', 200, 'POST', native, '{"op":"list"}')
        for code in (400, 404, 409, 413, 422, 500, 503, 507):
            await request('/api/rehearsal', code, 'POST', web, json.dumps({'test_status': code}))
        await request('/api/rehearsal', 502, 'POST', web, '{"test_oversize":true}')
        await ns['RehearsalProxy'].slots.acquire()
        await ns['RehearsalProxy'].slots.acquire()
        try:
            await request('/api/rehearsal', 503, headers=web)
        finally:
            ns['RehearsalProxy'].slots.release(); ns['RehearsalProxy'].slots.release()
        # A background drawing can exceed the old limit; older endpoints cannot.
        body = json.dumps({'padding': 'x' * (17 * 1024)})
        await request('/api/rehearsal', 200, 'POST', web, body)
        before = len(seen)
        await request('/api/docs', 413, 'POST', web, body)
        assert len(seen) == before
        for path, limit in (('/api/rehearsal', 262144), ('/api/app/rehearsal', 262144), ('/api/docs', 16384), ('/api/login', 16384)):
            assert ns['request_body_ok'](path, limit) and not ns['request_body_ok'](path, limit + 1)
            n += 1
        assert not ns['request_body_ok']('/api/docs', True)
        assert not ns['request_body_ok']('/api/docs', -1)
        print(f'REHEARSAL_PROXY_OK checks={n} authenticated_local_http_only')
    finally:
        server.stop(); up.stop()
        await server.close_all_connections(); await up.close_all_connections()


if __name__ == '__main__':
    asyncio.run(check())
