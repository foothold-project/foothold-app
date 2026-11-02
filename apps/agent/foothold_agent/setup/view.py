"""Loopback-only status view, explicit allowlist projection, no credentials."""
from copy import deepcopy
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import threading
import time

BLOCKED_PORTS = {8453, 8792, 5190, 5191, 8870, 9430}
FIELDS = {'serial', 'code', 'expires_at', 'qr', 'preflight', 'mode', 'connected', 'field_approval_expires_at'}


def qr_svg(code):
    import qrcode
    from qrcode.image.svg import SvgPathImage
    return qrcode.make('foothold-pair:'+code, image_factory=SvgPathImage).to_string().decode()


class Status:
    def __init__(self):
        self._lock = threading.Lock()
        self._value = {'mode': '기체 찾는 중', 'connected': False}

    def update(self, **values):
        if not set(values) <= FIELDS:
            raise ValueError('status field outside public projection')
        with self._lock:
            self._value.update(values)

    def snapshot(self):
        with self._lock:
            value = deepcopy(self._value)
        if value.get('expires_at') is not None and time.time() >= value['expires_at']:
            value.update(code=None, qr=None)
        return value


PAGE = '''<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>FOOTHOLD 로봇 연결</title><style>body{font:18px system-ui;max-width:640px;margin:40px auto;padding:20px;background:#f3f5f4;color:#192821}section{background:white;padding:24px;border-radius:16px}svg{width:240px;height:240px}.ok{color:#186c3b}.bad{color:#b22525}#code{font-size:36px;letter-spacing:8px}small{color:#57625d}</style>
<section><h1>로봇 연결</h1><h2 id="serial">기체 찾는 중</h2><div id="qr"></div><div id="code"></div><p id="expiry"></p>
<p id="mode"></p><p id="connection"></p><p id="preflight"></p><small>폰에서 + 로봇 연결하기 → 새 로봇 추가 → 같은 기체번호 확인 → 등록 → 현장 안전 확인을 진행하세요.<br>다시 실행한 뒤에는 새 현장 안전 확인이 필요합니다.<br>승인 뒤에도 조종권 획득·실측 정지·잠금 해제·새 중립 입력이 필요합니다.</small></section>
<script>async function refresh(){try{const s=await(await fetch('/status',{cache:'no-store'})).json();document.getElementById('serial').textContent=s.serial?'Go2 기체번호 '+s.serial+' 찾음':'기체 찾는 중';document.getElementById('code').textContent=s.code||'';document.getElementById('qr').innerHTML=s.qr||'';document.getElementById('expiry').textContent=s.code?'10분·1회용 코드 · '+new Date(s.expires_at*1000).toLocaleTimeString()+' 만료':'';document.getElementById('mode').textContent=s.mode;document.getElementById('connection').textContent=s.connected?'● 서버 연결됨':'● 서버 연결 대기';const p=document.getElementById('preflight');p.textContent=s.preflight?(s.preflight.installation_ready?'● 자동 점검 통과':'● 자동 점검 실패: '+s.preflight.issues.join(', ')):'자동 점검 중';p.className=s.preflight&&s.preflight.installation_ready?'ok':'bad';}catch{document.getElementById('mode').textContent='프로그램 연결 끊김';}setTimeout(refresh,1000)}refresh()</script></html>'''


def make_server(status, port=9611):
    if type(port) is not int or port in BLOCKED_PORTS or not 0 <= port <= 65535:
        raise ValueError('choose a dedicated setup port')

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_GET(self):
            expected = f'127.0.0.1:{self.server.server_port}'
            host = self.headers.get('Host')
            request_origin = self.headers.get('Origin')
            if (host != expected or self.headers.get('Sec-Fetch-Site') == 'cross-site'
                    or request_origin is not None and request_origin != 'http://'+expected):
                self.send_error(403)
                return
            if self.path == '/':
                body, kind = PAGE.encode(), 'text/html; charset=utf-8'
            elif self.path == '/status':
                body, kind = json.dumps(status.snapshot(), ensure_ascii=False, allow_nan=False).encode(), 'application/json'
            else:
                self.send_error(404)
                return
            self.send_response(200)
            self.send_header('Content-Type', kind)
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.send_header('Content-Security-Policy', "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'")
            self.end_headers()
            self.wfile.write(body)

    server = ThreadingHTTPServer(('127.0.0.1', port), Handler)
    server.daemon_threads = True
    return server
