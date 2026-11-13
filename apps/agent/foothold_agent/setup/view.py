"""Loopback-only status view, explicit allowlist projection, no credentials."""
from copy import deepcopy
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import secrets
import threading
import time

BLOCKED_PORTS = {8453, 8792, 5190, 5191, 8870, 9430}
FIELDS = {'serial', 'code', 'expires_at', 'qr', 'preflight', 'mode', 'connected', 'field_approval_expires_at',
          'depth_topics', 'depth_selected', 'depth_notice', 'record_notice',
          'identity_confirmation', 'identity_source'}


def qr_svg(code):
    import qrcode
    from qrcode.image.svg import SvgPathImage
    return qrcode.make('foothold-pair:'+code, image_factory=SvgPathImage).to_string().decode()


class Status:
    def __init__(self):
        self._lock = threading.Lock()
        self._value = {'mode': '기체 찾는 중', 'connected': False}
        self._depth_choice = None
        self._identity_decision = None

    def request_identity(self, mac, addresses):
        request = secrets.token_urlsafe(24)
        with self._lock:
            self._identity_decision = None
            self._value.update(identity_confirmation=dict(request=request, mac=mac, addresses=addresses),
                               mode='이 로봇은 기체번호를 보내지 않습니다. 랜선으로 연결된 로봇이 맞는지 확인해 주세요')
        return request

    def confirm_identity(self, request, confirmed):
        with self._lock:
            current = self._value.get('identity_confirmation')
            if (not current or request != current['request'] or type(confirmed) is not bool
                    or self._identity_decision is not None):
                raise ValueError('current operator confirmation required')
            self._identity_decision = confirmed

    def identity_decision(self, request):
        with self._lock:
            current = self._value.get('identity_confirmation')
            if not current or current['request'] != request:
                raise PermissionError('confirmation no longer current')
            return self._identity_decision

    def clear_identity(self, request):
        with self._lock:
            current = self._value.get('identity_confirmation')
            if current and current['request'] == request:
                self._value['identity_confirmation'] = None
                self._identity_decision = None

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
        value['mode'] = {
            '승인됨 · 조종권과 잠금 해제 필요': '연결 준비 완료 · 웹에서 조종을 시작하고 움직임을 허용하세요',
            '읽기 전용 · 현장 안전 확인 필요': '상태 확인 중 · 서버의 연결 확인을 기다리고 있습니다',
        }.get(value['mode'], value['mode'])
        return value


# 웹 공식 토큰 사본(값 수정 금지): apps/web/public/brand/tokens/foothold.tokens.css 의 data-theme 두 묶음 그대로.
# 연결 프로그램은 따로 설치돼 웹 파일을 못 읽는다 — 같은지는 tests/test_desktop_browser.py 가 본다.
TOKENS = ''':root[data-theme="dark"]{
  --paper:#12161d;
  --paper-2:#191e27;
  --card:#181d26;
  --ink:#e9e7e1;
  --ink-2:#adb5c1;
  --ink-3:#7d8693;
  --dim-ink:#3ec7b4;
  --note-ink:#dc9a30;
  --rule:#2b323d;
  --brand:#3ec7b4;
  --dim:var(--brand);
  --dim-soft:#11302c;
  --note:#dc9a30;
  --note-soft:#332710;
  --stop:#e56d5e;
  --stop-soft:#331c19;
  --grid:rgba(233,231,225,.035);
  --measure:720px;
  --nav:268px;
}

:root[data-theme="light"]{
  --paper:#f6f5f1;
  --paper-2:#eeece6;
  --card:#fff;
  --ink:#161c26;
  --ink-2:#4a5566;
  --ink-3:#7c8798;
  --dim-ink:#0b6459;
  --note-ink:#8a5600;
  --rule:#d9d6cd;
  --brand:#0e7a6e;
  --dim:var(--brand);
  --dim-soft:#e0f0ed;
  --note:#a86a08;
  --note-soft:#fbf0dc;
  --stop:#a3342a;
  --stop-soft:#fbe9e7;
  --grid:rgba(22,28,38,.04);
  --measure:720px;
  --nav:268px;
}
'''

PAGE = '''<!doctype html><html lang="ko" data-theme="dark"><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>FOOTHOLD 로봇 연결</title><style>'''+TOKENS+''':root{color-scheme:light;--on:var(--card);--line2:color-mix(in srgb,var(--rule),var(--ink) 16%)}:root[data-theme="dark"]{color-scheme:dark;--on:var(--paper)}body{font:16px/1.5 'Pretendard Variable',Pretendard,'Malgun Gothic','Segoe UI',system-ui,sans-serif;max-width:640px;margin:40px auto;padding:20px;background:var(--paper);color:var(--ink);-webkit-font-smoothing:antialiased}header{display:flex;justify-content:flex-end;margin-bottom:8px}section{background:var(--card);border:1px solid var(--rule);padding:24px;border-radius:10px}section+section{margin-top:16px}h1{font-size:22px;margin:0 0 8px}h2{font-size:17px}svg{width:240px;height:240px;background:#fff;border-radius:8px}.ok{color:var(--dim-ink)}.bad{color:var(--stop)}#code{font-size:36px;letter-spacing:8px;font-variant-numeric:tabular-nums}small{color:var(--ink-2)}button,select{font:inherit;color:var(--ink);min-height:44px;padding:0 16px;max-width:100%;margin:4px 0;box-sizing:border-box;border:1px solid var(--line2);border-radius:8px;background:var(--paper-2)}button{cursor:pointer;font-weight:600}button:disabled{opacity:.55;cursor:wait}button:hover:not(:disabled){border-color:var(--brand)}#depth-select{background:var(--brand);border-color:var(--brand);color:var(--on)}#theme{min-height:36px;padding:0 8px;margin:0;font-size:13px}summary{cursor:pointer}input[type=checkbox]{accent-color:var(--brand)}:focus-visible{outline:3px solid var(--brand);outline-offset:3px}hr{border:0;border-top:1px solid var(--rule);margin-top:24px}#depth-topics{padding-inline-start:24px;overflow-wrap:anywhere}#depth-choice{display:block;width:100%;margin-block:8px}@media(max-width:480px){body{margin:0;padding:16px}section{padding:20px}svg{max-width:100%}}</style>
<header><select id="theme" aria-label="화면 밝기"><option value="dark">어두움</option><option value="light">밝음</option><option value="system">기기 설정 따름</option></select></header>
<script>
{const pick=document.getElementById('theme'),media=matchMedia('(prefers-color-scheme: light)');const apply=()=>{document.documentElement.dataset.theme=pick.value==='light'||pick.value==='system'&&media.matches?'light':'dark'};try{const v=localStorage.getItem('fh.theme');if(v==='light'||v==='system')pick.value=v}catch{}pick.onchange=()=>{try{localStorage.setItem('fh.theme',pick.value)}catch{}apply()};media.addEventListener('change',apply);apply()}
</script>
<section><h1>로봇 연결</h1><h2 id="serial" aria-live="polite">기체 찾는 중</h2><div id="qr"></div><div id="code"></div><p id="expiry"></p>
<p id="mode" role="status"></p>
<div id="identity-confirmation" hidden aria-labelledby="identity-title"><h2 id="identity-title">랜선으로 연결된 로봇 확인</h2><p>로봇 몸의 주소: 192.168.123.161<br>연결 장치 번호(MAC): <strong id="identity-mac"></strong></p><p>이 유선에 보이는 이웃 주소</p><ul id="identity-neighbors"></ul><p>랜선이 연결된 로봇 몸을 확인한 뒤 눌러 주세요.</p><button id="identity-yes" type="button">이 로봇 맞음</button> <button id="identity-cancel" type="button">취소</button><p id="identity-error" role="status"></p></div><p id="connection"></p><p id="record-notice" role="status" hidden></p><p id="preflight"></p><small>웹 + 로봇 연결하기 → 새 로봇 추가 → 노트북 화면의 코드 넣기 → 이름 순서로 진행하세요.<br>연결 뒤 서버가 자동으로 사용 조건을 확인합니다.<br>연결된 뒤에는 웹에서 STOP을 누르고 조종을 시작하세요.<br>로봇이 멈춘 것을 확인한 뒤 움직임을 허용하고, 조종 버튼에서 손을 뗐다가 다시 눌러야 움직입니다.</small>
<div id="desktop" hidden><hr><p><label><input id="autostart" type="checkbox"> 로그인하면 자동으로 켜기</label></p>
<div id="network" hidden><label for="nic">기체에 꽂은 유선</label> <select id="nic"></select> <button id="configure">유선 연결 설정</button></div>
<details><summary>직접 설정하는 법</summary><p id="manual-settings">Ubuntu 설정 → 네트워크에서 기체에 꽂은 유선을 선택하세요.</p><p>IPv4 수동으로 중복 없는 192.168.123.200~254 주소, 접두사 24(서브넷 마스크 255.255.255.0)를 설정하세요. 게이트웨이·DNS는 비우고 기본 경로로 사용하지 마세요. 인터넷용 유선·Wi-Fi는 바꾸지 마세요.</p></details>
<p><button id="server-web" type="button" hidden>서버 웹 열기</button></p><p id="network-message" role="status"></p><p><button id="repair">다시 연결하기</button> <button id="quit">프로그램 종료</button></p>
<small id="uninstall">다시 연결하기는 웹에서 새 코드를 넣은 뒤 저장된 연결을 갱신합니다. 프로그램을 지우려면 Ubuntu 앱 센터의 설치됨 목록에서 FOOTHOLD 로봇 연결을 제거하세요. 연결 키는 남습니다.</small></div></section>
<section><h2>보이는 영상 목록</h2><p id="depth-notice">로봇에서 보내는 영상 목록을 확인하고 있습니다</p><ul id="depth-topics"></ul><label>뎁스로 볼 영상 <select id="depth-choice"><option value="">기본 후보에서 자동 선택</option></select></label><button id="depth-select" type="button">영상 선택</button><p id="depth-feedback" role="status"></p><small>이 목록은 영상 내용을 받지 않고 로봇이 알려 준 이름과 형식만 읽습니다. 선택한 영상이 실제 깊이 자료일 때만 표시합니다.</small></section>
<script>
let topicKey='',identityRequest=null;
function showIdentity(s){const c=s.identity_confirmation;document.getElementById('identity-confirmation').hidden=!c;if(!c){identityRequest=null;return}if(identityRequest!==c.request){identityRequest=c.request;document.getElementById('identity-mac').textContent=c.mac;document.getElementById('identity-neighbors').replaceChildren(...c.addresses.map(address=>{const li=document.createElement('li');li.textContent=address;return li}));document.getElementById('identity-error').textContent='';for(const id of ['identity-yes','identity-cancel'])document.getElementById(id).disabled=false;}}
async function confirmIdentity(confirmed){for(const id of ['identity-yes','identity-cancel'])document.getElementById(id).disabled=true;try{const response=await fetch('/identity-confirm',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({request:identityRequest,confirmed})});if(!response.ok)throw Error();document.getElementById('identity-error').textContent=confirmed?'연결 정보를 다시 확인하고 있습니다':'연결을 취소하고 있습니다';}catch{document.getElementById('identity-error').textContent='확인을 마치지 못했습니다. 프로그램 연결을 확인한 뒤 다시 눌러 주세요';for(const id of ['identity-yes','identity-cancel'])document.getElementById(id).disabled=false;}}
document.getElementById('identity-yes').onclick=()=>confirmIdentity(true);document.getElementById('identity-cancel').onclick=()=>confirmIdentity(false);
function showDepth(s){document.getElementById('depth-notice').textContent=s.depth_notice||'로봇에서 보내는 영상 목록을 확인하고 있습니다';const rows=s.depth_topics||[];const key=JSON.stringify(rows);if(topicKey!==key){topicKey=key;const list=document.getElementById('depth-topics');list.replaceChildren();const select=document.getElementById('depth-choice');select.replaceChildren(new Option('기본 후보에서 자동 선택',''));for(const row of rows){const item=document.createElement('li');item.textContent=row.name+' · '+row.type+(row.supported?'':' · 지원하지 않는 영상 형식');list.append(item);if(row.supported)select.add(new Option(row.name,row.name));}select.value=s.depth_selected||'';}}
document.getElementById('depth-select').onclick=async()=>{const feedback=document.getElementById('depth-feedback');try{const response=await fetch('/depth-topic',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({topic:document.getElementById('depth-choice').value||null})});feedback.textContent=response.ok?'영상 선택을 적용했습니다':'목록이 바뀌었습니다. 다시 골라 주세요';}catch{feedback.textContent='프로그램 연결을 확인하세요';}};
async function refresh(){try{const s=await(await fetch('/status',{cache:'no-store'})).json();document.getElementById('serial').textContent=s.identity_source==='mac'?'기체번호 없이 연결 · 로봇 확인됨':s.serial?'Go2 기체번호 '+s.serial+' 찾음':s.mode.startsWith('로봇을 찾지')?'로봇을 찾지 못함':'기체 찾는 중';document.getElementById('code').textContent=s.code||'';document.getElementById('qr').innerHTML=s.qr||'';document.getElementById('expiry').textContent=s.code?'10분·1회용 코드 · '+new Date(s.expires_at*1000).toLocaleTimeString()+' 만료':'';document.getElementById('mode').textContent=s.mode;document.getElementById('connection').textContent=s.connected?'● 서버 연결됨':'● 서버 연결 대기';const p=document.getElementById('preflight');p.textContent=s.preflight?(s.preflight.installation_ready?'● 자동 점검 통과':'● 자동 점검 실패: '+s.preflight.issues.join(', ')):'자동 점검 중';p.className=s.preflight&&s.preflight.installation_ready?'ok':'bad';showIdentity(s);showDepth(s);const record=document.getElementById('record-notice');record.textContent=s.record_notice||'';record.hidden=!s.record_notice;}catch{document.getElementById('mode').textContent='프로그램 연결 끊김';}setTimeout(refresh,1000)}refresh()</script>
<script>
async function action(body){try{const r=await fetch('/action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});if(!r.ok)throw Error();await desktop()}catch{document.getElementById('network-message').textContent='요청을 마치지 못했습니다. 프로그램이 켜져 있는지 확인하세요.'}}
async function desktop(){try{const r=await fetch('/desktop',{cache:'no-store'});if(!r.ok)return;const s=await r.json();document.getElementById('desktop').hidden=false;document.getElementById('server-web').hidden=!s.server_web_available;if(s.platform==='windows'){document.getElementById('configure').textContent='유선 연결 설정 (관리자 확인)';document.getElementById('manual-settings').textContent='Windows 설정 → 네트워크 및 인터넷 → 고급 네트워크 설정에서 기체에 꽂은 유선을 선택하세요.';document.getElementById('uninstall').textContent='다시 연결하기는 웹에서 새 코드를 넣은 뒤 연결을 갱신합니다. 제거: 압축을 푼 폴더나 설치 폴더의 «연결 프로그램 제거.cmd»를 실행하세요. 실행 중인 프로그램을 종료한 뒤 설치본을 지웁니다. 연결 키는 남습니다. SmartScreen 경고: 추가 정보 → 실행.';}document.getElementById('autostart').checked=s.autostart;const select=document.getElementById('nic');const previous=select.value;select.replaceChildren(...s.network_choices.map(c=>{const o=document.createElement('option');o.value=c.name;o.textContent=c.label||c.name;return o}));if(s.network_choices.some(c=>c.name===previous))select.value=previous;document.getElementById('network').hidden=!s.network_choices.length;document.getElementById('configure').disabled=s.busy;document.getElementById('quit').disabled=s.busy;document.getElementById('repair').disabled=s.busy;document.getElementById('network-message').textContent=s.network_message}catch{}}
document.getElementById('server-web').onclick=()=>action({action:'server-web'});document.getElementById('autostart').onchange=e=>action({action:'autostart',enabled:e.target.checked});document.getElementById('configure').onclick=()=>action({action:'network',nic:document.getElementById('nic').value});document.getElementById('quit').onclick=()=>action({action:'quit'});document.getElementById('repair').onclick=()=>action({action:'repair'});desktop();setInterval(desktop,2000);
</script></html>'''


def make_server(status, port=9611, *, controls=None):
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
            elif self.path == '/desktop' and controls is not None:
                body, kind = json.dumps(controls.snapshot(), ensure_ascii=False).encode(), 'application/json'
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
            if self.path == '/action':
                if controls is None or self.headers.get('Content-Type') != 'application/json':
                    self.send_error(403)
                    return
                limit = 4096
            elif self.path in ('/depth-topic', '/identity-confirm'):
                limit = 1024
            else:
                self.send_error(404)
                return
            try:
                size = int(self.headers.get('Content-Length', '0'))
                if not 1 <= size <= limit or self.headers.get('Content-Type') != 'application/json':
                    raise ValueError('bounded JSON required')
                self.connection.settimeout(1)
                value = json.loads(self.rfile.read(size))
                if not isinstance(value, dict):
                    raise ValueError('JSON object required')
                if self.path == '/depth-topic':
                    if set(value) != {'topic'}:
                        raise ValueError('topic selection required')
                    status.select_depth(value['topic'])
                elif self.path == '/identity-confirm':
                    if set(value) != {'request', 'confirmed'}:
                        raise ValueError('explicit confirmation required')
                    status.confirm_identity(value['request'], value['confirmed'])
                else:
                    controls.action(value)
            except (ValueError, TypeError, PermissionError, OSError):
                self.send_error(400)
                return
            self.send_response(204)
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()

    server = ThreadingHTTPServer(('127.0.0.1', port), Handler)
    server.daemon_threads = True
    return server
