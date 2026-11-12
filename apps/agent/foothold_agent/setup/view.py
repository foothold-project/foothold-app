"""Loopback-only status view, explicit allowlist projection, no credentials."""
from copy import deepcopy
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import threading
import time

BLOCKED_PORTS = {8453, 8792, 5190, 5191, 8870, 9430}
FIELDS = {'serial', 'code', 'expires_at', 'qr', 'preflight', 'mode', 'connected', 'field_approval_expires_at',
          'depth_topics', 'depth_selected', 'depth_notice'}


def qr_svg(code):
    import qrcode
    from qrcode.image.svg import SvgPathImage
    return qrcode.make('foothold-pair:'+code, image_factory=SvgPathImage).to_string().decode()


class Status:
    def __init__(self):
        self._lock = threading.Lock()
        self._value = {'mode': '기체 찾는 중', 'connected': False}
        self._depth_choice = None

    def depth_choice(self):
        with self._lock:
            return self._depth_choice

    def select_depth(self, topic):
        with self._lock:
            if topic is not None and (not isinstance(topic, str) or not any(
                    row['name'] == topic and row['supported'] for row in self._value.get('depth_topics', []))):
                raise ValueError('choose a discovered supported image topic')
            self._depth_choice = topic

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
<section><h2>보이는 영상 목록</h2><p id="depth-notice">로봇에서 보내는 영상 목록을 확인하고 있습니다</p><ul id="depth-topics"></ul><label>뎁스로 볼 영상 <select id="depth-choice"><option value="">기본 후보에서 자동 선택</option></select></label><button id="depth-select" type="button">영상 선택</button><p id="depth-feedback" role="status"></p><small>이 목록은 영상 내용을 받지 않고 로봇이 알려 준 이름과 형식만 읽습니다. 선택한 영상이 실제 깊이 자료일 때만 표시합니다.</small></section>
<style>#depth-topics{padding-inline-start:24px;overflow-wrap:anywhere}#depth-choice{display:block;max-width:100%;width:100%;margin-block:8px;font:inherit;padding:8px}#depth-select{font:inherit;padding:8px 16px;border:1px solid #186c3b;border-radius:8px;background:#186c3b;color:white;cursor:pointer}#depth-select:hover{background:#12532d}#depth-select:focus-visible,#depth-choice:focus-visible{outline:3px solid #192821;outline-offset:3px}</style>
<script>
let topicKey='';
function showDepth(s){document.getElementById('depth-notice').textContent=s.depth_notice||'로봇에서 보내는 영상 목록을 확인하고 있습니다';const rows=s.depth_topics||[];const key=JSON.stringify(rows);if(topicKey!==key){topicKey=key;const list=document.getElementById('depth-topics');list.replaceChildren();const select=document.getElementById('depth-choice');select.replaceChildren(new Option('기본 후보에서 자동 선택',''));for(const row of rows){const item=document.createElement('li');item.textContent=row.name+' · '+row.type+(row.supported?'':' · 지원하지 않는 영상 형식');list.append(item);if(row.supported)select.add(new Option(row.name,row.name));}select.value=s.depth_selected||'';}}
document.getElementById('depth-select').onclick=async()=>{const feedback=document.getElementById('depth-feedback');try{const response=await fetch('/depth-topic',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({topic:document.getElementById('depth-choice').value||null})});feedback.textContent=response.ok?'영상 선택을 적용했습니다':'목록이 바뀌었습니다. 다시 골라 주세요';}catch{feedback.textContent='프로그램 연결을 확인하세요';}};
async function refresh(){try{const s=await(await fetch('/status',{cache:'no-store'})).json();document.getElementById('serial').textContent=s.serial?'Go2 기체번호 '+s.serial+' 찾음':'기체 찾는 중';document.getElementById('code').textContent=s.code||'';document.getElementById('qr').innerHTML=s.qr||'';document.getElementById('expiry').textContent=s.code?'10분·1회용 코드 · '+new Date(s.expires_at*1000).toLocaleTimeString()+' 만료':'';document.getElementById('mode').textContent=s.mode;document.getElementById('connection').textContent=s.connected?'● 서버 연결됨':'● 서버 연결 대기';const p=document.getElementById('preflight');p.textContent=s.preflight?(s.preflight.installation_ready?'● 자동 점검 통과':'● 자동 점검 실패: '+s.preflight.issues.join(', ')):'자동 점검 중';p.className=s.preflight&&s.preflight.installation_ready?'ok':'bad';showDepth(s);}catch{document.getElementById('mode').textContent='프로그램 연결 끊김';}setTimeout(refresh,1000)}refresh()</script></html>'''


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

        def do_POST(self):
            expected = f'127.0.0.1:{self.server.server_port}'
            if (self.headers.get('Host') != expected or self.headers.get('Origin') != 'http://'+expected
                    or self.headers.get('Sec-Fetch-Site') == 'cross-site'):
                self.send_error(403)
                return
            if self.path != '/depth-topic':
                self.send_error(404)
                return
            try:
                size = int(self.headers.get('Content-Length', '0'))
                if not 1 <= size <= 1024 or self.headers.get('Content-Type') != 'application/json':
                    raise ValueError('bounded JSON required')
                self.connection.settimeout(1)
                value = json.loads(self.rfile.read(size))
                if not isinstance(value, dict) or set(value) != {'topic'}:
                    raise ValueError('topic selection required')
                status.select_depth(value['topic'])
            except (ValueError, TypeError, OSError):
                self.send_error(400)
                return
            self.send_response(204)
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()

    server = ThreadingHTTPServer(('127.0.0.1', port), Handler)
    server.daemon_threads = True
    return server
