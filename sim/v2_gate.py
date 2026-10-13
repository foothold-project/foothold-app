#!/usr/bin/env python3
"""v2 보호 관문 — 휴대폰·다른 PC 가 새 UI(v2 시뮬 실연결)에 붙는 유일한 입구. HTTPS + 로그인 + 같은 출처 검사.

왜: v2_link(8790)는 로그인 없는 127.0.0.1 전용이다. 그대로 LAN 에 열면 «보호 없는 제어 포트»가 된다.
이 관문은 ① 로그인한 계정의 세션 쿠키가 있는 요청만 받고 ② 화면·사진·기록·WebSocket 을 127.0.0.1:8790 으로만 중계하고
③ 화면이 보내는 WebSocket 메시지를 크기·op 목록으로 거르고 ④ «계정 · 기기»를 서버 쪽에서 붙인다(화면이 고칠 수 없음).
로그아웃·세션 만료·탭 닫힘 → 중계 연결을 끊는다 → v2_link 가 조종권 해제 + 명령 0 + STOP 잠금.

재사용(control-app 운영 관문 phone_gate.py 와 같은 계정·인증서): 계정 확인·세션·실패 제한·출처 검사·기기 쿠키 서명을 import 한다.
  .gate 폴더는 프로그램이 읽기만 한다 — 계정 생성·인증서/키 재발급 없음, 없거나 권한이 넓으면 기동 거부. 운영 8443·57 은 건드리지 않는다.
  쿠키 이름은 운영 관문(fh_s·fh_dev)과 다르게(fh2_s·fh2_dev) — 쿠키는 포트별로 나뉘지 않아 같은 이름이면 서로 로그아웃시킨다.
신뢰 경계: 이 PC 안의 프로세스는 8790 에 직접 붙을 수 있다(관문은 네트워크 너머만 막는다).

실행(로컬 ROS PC): python3 sim/v2_gate.py --bind 0.0.0.0 --port 8453     # v2_link(8790)가 떠 있어야 화면이 동작
자체검사: python3 sim/v2_gate.py --selftest
"""
import argparse, asyncio, hashlib, hmac, json, re, sys, time
from urllib.parse import quote
from pathlib import Path

HERE = Path(__file__).resolve().parent
OPS = {'take', 'release', 'cmd', 'stop', 'resume', 'reset', 'hidden', 'photo', 'sim_start'}   # v2_link 가 받는 op 만
MSG_MAX = 1024
# 로그인 전에도 열리는 것: 로그인 화면과 그 화면이 쓰는 파일, 설치 정보(아이콘·manifest), 공개 인증서, 시작 안내
PUBLIC = re.compile(r'^(MLogin\.dc\.html|PcLogin\.dc\.html|dc\.js|live\.js|start\.html|manifest\.webmanifest|icons/[\w.-]+\.png)$')
PHONE_UA = re.compile(r'iPhone|iPad|Android|Mobile', re.I)


def gate_msg(raw):
    """화면 → v2_link 메시지 하나: 통과면 그대로, 아니면 None. 크기·JSON 객체·op 목록만 본다(내용 판단은 v2_link)"""
    if not isinstance(raw, str) or len(raw) > MSG_MAX:
        return None
    try:
        m = json.loads(raw)
    except ValueError:
        return None
    return raw if isinstance(m, dict) and m.get('op') in OPS else None


def clean_label(v):
    """기기 이름(로그인 때 입력, 기록에 남음): 제어문자 제거·40자. 비면 None"""
    v = re.sub(r'[\x00-\x1f\x7f]', '', v if isinstance(v, str) else '').strip()[:40]
    return v or None


def login_page(path, ua):
    # next 안의 ?·& 가 로그인 주소의 인자와 섞이지 않게 인코딩
    return ('MLogin.dc.html' if PHONE_UA.search(ua or '') else 'PcLogin.dc.html') + '?live=v2&next=' + quote('/' + path, safe='/')


def selftest():
    assert gate_msg('{"op":"cmd","fx":1,"fy":0,"fw":0}') and gate_msg('{"op":"photo","rid":3}')
    for bad in ['{"op":"call_service"}', '[1]', 'x', '{"op":"take"' + ' ' * 2000 + '}', None, '{"x":1}']:
        assert gate_msg(bad) is None, bad
    assert clean_label(' 노트북\n1 ') == '노트북1' and clean_label('') is None and clean_label(None) is None and len(clean_label('a' * 99)) == 40
    for ok in ['MLogin.dc.html', 'dc.js', 'icons/icon-192.png', 'manifest.webmanifest', 'start.html']:
        assert PUBLIC.match(ok), ok
    for no in ['Main.dc.html', 'MDrive.dc.html', 'index.html', '', 'icons/../Main.dc.html', 'api/media', 'media/photos/20261013/a.jpg']:
        assert not PUBLIC.match(no), no
    assert login_page('MDrive.dc.html', 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)').startswith('MLogin')
    assert login_page('Main.dc.html', 'Mozilla/5.0 (X11; Linux x86_64)').startswith('PcLogin')
    from urllib.parse import parse_qs, urlsplit
    assert parse_qs(urlsplit(login_page('MDrive.dc.html?live=v2&stickLayout=a b', '')).query)['next'] == ['/MDrive.dc.html?live=v2&stickLayout=a b']
    print('[v2_gate] selftest OK')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--bind', default='127.0.0.1', help='휴대폰을 붙일 때 0.0.0.0')
    ap.add_argument('--port', type=int, default=8453)
    ap.add_argument('--upstream', default='127.0.0.1:8790', help='v2_link (127.0.0.1 에만 떠 있어야 함)')
    ap.add_argument('--web', default=str(HERE.parent / 'web'))
    ap.add_argument('--gate-src', default=str(HERE.parent.parent / 'control-app' / 'ros'), help='phone_gate.py 가 있는 폴더(재사용)')
    ap.add_argument('--state', default=str(HERE.parent.parent / 'control-app' / '.gate'), help='계정·인증서 폴더(읽기만)')
    ap.add_argument('--ttl', type=float, default=12 * 3600, help='로그인 세션 수명 s')
    ap.add_argument('--selftest', action='store_true')
    a = ap.parse_args()
    if a.selftest:
        return selftest()
    if not a.upstream.startswith(('127.0.0.1:', 'localhost:')):
        sys.exit('[v2_gate] --upstream 은 127.0.0.1 의 v2_link 여야 한다')
    sys.path.insert(0, a.gate_src)
    import phone_gate as G                           # 운영 관문과 같은 계정 확인·세션·출처 검사
    from app_gateway import load_key                 # 읽기만(없거나 권한이 넓으면 기동 거부 — 새로 만들지 않음)
    import tornado.httpclient, tornado.ioloop, tornado.web, tornado.websocket
    import ssl

    state = Path(a.state)
    for n in ('accounts.json', 'cert.pem', 'key.pem', 'hmac.key', 'sans'):
        if not (state / n).exists():
            sys.exit(f'[v2_gate] {state / n} 없음 — 운영 관문 준비가 먼저(이 관문은 새로 만들지 않는다)')
    accounts = G.load_accounts(state / 'accounts.json')   # 권한 0600 확인 포함
    if not accounts:
        sys.exit('[v2_gate] 계정 없음')
    hosts = G.lan_ips() if a.bind in ('0.0.0.0', '') else [a.bind]
    sans = (state / 'sans').read_text()
    missing = [h for h in hosts if f'IP:{h}' not in sans.split(',')]
    if missing:                                      # 인증서 재발급은 운영 관문 소유 — 여기서는 하지 않는다
        sys.exit(f'[v2_gate] 인증서에 없는 주소 {missing} — 운영 관문(phone_gate) 재기동으로 인증서를 갱신한 뒤 다시')
    devkey = hmac.new(load_key(str(state / 'hmac.key')), b'fh2-device-id', hashlib.sha256).digest()
    sessions, rl = G.Sessions(a.ttl), G.RateLimit()
    gate_hosts = {f'{h}:{a.port}' for h in hosts} | {f'localhost:{a.port}', f'127.0.0.1:{a.port}'}
    COOKIE = dict(httponly=True, secure=True, samesite='Strict', path='/')
    UP_HTTP, UP_WS = f'http://{a.upstream}', f'ws://{a.upstream}/ws'
    UP_ORIGIN = f'http://{a.upstream}'
    login_slots = asyncio.Semaphore(2)
    log = lambda s: print(f'[v2_gate] {time.strftime("%H:%M:%S")} {s}', flush=True)   # 쿠키·비밀번호·키는 찍지 않는다

    class Base(tornado.web.RequestHandler):
        def session(self):
            return sessions.get(self.get_cookie('fh2_s'), time.time())

        def origin_ok(self):
            return G.same_origin(self.request.headers.get('Origin'), self.request.host, gate_hosts)

        def set_default_headers(self):
            self.set_header('Cache-Control', 'no-store')
            self.set_header('X-Frame-Options', 'DENY')
            self.set_header('X-Content-Type-Options', 'nosniff')

    class Login(Base):
        async def post(self):
            ip, now = self.request.remote_ip, time.time()
            if not self.origin_ok(): self.set_status(403); return self.finish({'error': '다른 출처'})
            if rl.blocked(ip, now): self.set_status(429); return self.finish({'error': '실패가 많음 — 5분 뒤 다시'})
            try:
                b = json.loads(self.request.body); user, pw = b['user'], b['pw']
                assert isinstance(user, str) and isinstance(pw, str) and 0 < len(user) <= 64 and 0 < len(pw) <= 256
            except (ValueError, KeyError, TypeError, AssertionError):
                self.set_status(400); return self.finish({'error': '형식'})
            if login_slots.locked(): self.set_status(429); return self.finish({'error': '로그인이 몰려 있음 — 잠시 뒤 다시'})
            async with login_slots:
                ok = await asyncio.get_running_loop().run_in_executor(None, G.verify_pw, accounts, user, pw)
            if not ok:
                rl.failed(ip, time.time()); log(f'로그인 실패 {ip}'); self.set_status(401)
                return self.finish({'error': '계정 또는 비밀번호가 틀림'})
            dev = G.dev_check(devkey, self.get_cookie('fh2_dev'))
            if dev is None:
                dev, c = G.dev_issue(devkey); self.set_cookie('fh2_dev', c, expires_days=365, **COOKIE)
            tok = sessions.create(user, dev, time.time())
            sessions.by_tok[tok]['label'] = clean_label(b.get('device'))
            self.set_cookie('fh2_s', tok, max_age=int(a.ttl), **COOKIE)
            log(f'로그인 {user} 기기 {dev[:6]} {ip}')
            self.finish({'ok': True, 'account': user})

    class WhoAmI(Base):
        def get(self):
            s = self.session()
            if not s: self.set_status(401); return self.finish({'error': '로그인 필요'})
            self.finish({'account': s['account'], 'device': s['device'][:6], 'label': s.get('label'), 'exp': s['exp']})

    class Logout(Base):
        async def post(self):
            if not self.origin_ok(): self.set_status(403); return self.finish({'error': '다른 출처'})
            s = sessions.end(self.get_cookie('fh2_s'))
            for c in list(s['conns']) if s else []:
                c.close(4401, 'logout')               # 중계 끊김 → v2_link: 조종권 해제 · 0 · STOP 잠금
            self.clear_cookie('fh2_s', path='/')
            if s: log(f'로그아웃 {s["account"]}')
            self.finish({'ok': True})

    class Hosts(Base):                                # 시작 안내(QR)에 쓸 주소 — 이 관문에 닿은 사람에게만 보이는 정보
        def get(self):
            self.finish({'urls': [f'https://{h}:{a.port}/' for h in hosts if h != '127.0.0.1']})

    class Proxy(Base):                                # 사진·기록 목록 — 로그인 뒤에만 8790 으로 중계(GET 만)
        async def get(self, path):
            if not self.session(): self.set_status(401); return self.finish({'error': '로그인 필요'})
            try:
                r = await tornado.httpclient.AsyncHTTPClient().fetch(f'{UP_HTTP}/{path}', raise_error=False, request_timeout=10)
            except OSError:
                self.set_status(502); return self.finish({'error': 'v2_link 없음'})
            self.set_status(r.code if r.code in (200, 404) else 502)
            self.set_header('Content-Type', r.headers.get('Content-Type', 'application/octet-stream'))
            self.finish(r.body or b'')

    class Page(tornado.web.StaticFileHandler):
        async def get(self, path, include_body=True):
            if path in ('', 'index.html'):            # 첫 화면: 휴대폰은 조종, PC 는 관제
                return self.redirect(('MDrive.dc.html' if PHONE_UA.search(self.request.headers.get('User-Agent', '')) else 'Main.dc.html') + '?live=v2')
            if not PUBLIC.match(path) and not sessions.get(self.get_cookie('fh2_s'), time.time()):
                return self.redirect('/' + login_page(path + ('?' + self.request.query if self.request.query else ''), self.request.headers.get('User-Agent')))
            return await super().get(path, include_body)

        def set_extra_headers(self, path):
            self.set_header('Cache-Control', 'no-store')
            self.set_header('X-Frame-Options', 'DENY')

    class Bridge(tornado.websocket.WebSocketHandler):
        def check_origin(self, origin):
            return G.same_origin(origin, self.request.host, gate_hosts)

        async def open(self):
            self.up, self.gone = None, False
            self.tok = self.get_cookie('fh2_s'); s = sessions.get(self.tok, time.time())
            if not s:
                log(f'거부(로그인 없음) {self.request.remote_ip}'); return self.close(4401, 'login')
            actor = f'{s["account"]} · {s.get("label") or "기기 " + s["device"][:6]}'
            req = tornado.httpclient.HTTPRequest(UP_WS, headers={'Origin': UP_ORIGIN, 'X-FH-Actor': quote(actor, safe='')})   # 헤더는 ASCII 만(한글 → 퍼센트 인코딩, v2_link 가 엄격 해독)
            try:
                up = await tornado.websocket.websocket_connect(req, on_message_callback=self.down)
            except OSError:
                log('v2_link 없음'); return self.close(1011, 'upstream')
            if self.gone or sessions.get(self.tok, time.time()) is not s:   # 기다리는 사이 닫힘·로그아웃
                up.close(); return None if self.gone else self.close(4401, 'session')
            self.up, self.s = up, s
            s['conns'].add(self)
            log(f'연결 {actor} {self.request.remote_ip}')

        def down(self, msg):                           # v2_link → 화면 (상태 JSON·영상 JPEG)
            if self.up is None: return
            if msg is None: return self.close(1011, 'upstream closed')
            try:
                self.write_message(msg, binary=isinstance(msg, bytes))
            except tornado.websocket.WebSocketClosedError:
                pass

        def on_message(self, raw):                     # 화면 → v2_link
            if self.up is None: return
            if not sessions.get(self.tok, time.time()):
                return self.close(4401, 'session')
            m = gate_msg(raw)
            if m is None:
                log('차단·끊음: 허용 안 된 메시지'); return self.close(4403, 'denied')
            self.up.write_message(m)

        def on_close(self):
            self.gone = True
            if self.up is not None:
                self.up.close(); self.s['conns'].discard(self)

    def sweep():
        for tok in sessions.expired(time.time()):
            s = sessions.end(tok)
            for c in list(s['conns']) if s else []:
                c.close(4401, 'expired')

    app = tornado.web.Application([
        (r'/ws', Bridge), (r'/api/login', Login), (r'/api/whoami', WhoAmI), (r'/api/logout', Logout), (r'/api/hosts', Hosts),
        (r'/(api/media|media/photos/\d{8}/[\w.-]+\.jpg)', Proxy),
        (r'/(ca\.crt)', tornado.web.StaticFileHandler, {'path': str(state)}),     # 공개 인증서만
        (r'/(.*)', Page, {'path': a.web}),
    ], websocket_max_message_size=4 * 1024)
    ctx = ssl.create_default_context(ssl.Purpose.CLIENT_AUTH); ctx.load_cert_chain(str(state / 'cert.pem'), str(state / 'key.pem'))
    app.listen(a.port, address=a.bind, ssl_options=ctx, max_body_size=4 * 1024)
    tornado.ioloop.PeriodicCallback(sweep, 2000).start()
    for h in hosts: log(f'열기: https://{h}:{a.port}/  (계정 {len(accounts)}개 · 중계 {a.upstream})')
    tornado.ioloop.IOLoop.current().start()


if __name__ == '__main__':
    main()
