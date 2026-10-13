"""앱(bundled B) 전용 인증 — v2_gate 의 /api/app/* 와 /api/app/ws 가 쓰는 순수 로직(네트워크·tornado 없음).

계약: less82/app-contract-storage 의 mobile/docs/FHGATE-CONTRACT.md §3 (현재 v0.1 d83761e — 사진 경로 ASCII 1~80자·.. 금지, exp 숫자, ttl_s 0<ttl≤30).
필드명·형식은 이 파일 한 곳에만 둔다(합의본이 바뀌면 여기만 고친다).
기존 쿠키 경로(/api/login·/ws·same_origin)와 섞지 않는다: 앱 세션은 별도 저장소, bearer 만 보고 쿠키는 보지 않는다.
비밀(토큰·표·비밀번호)은 반환값으로만 다루고 로그·예외 문구에 넣지 않는다.
자체검사: python3 sim/app_auth.py
"""
import re, secrets

ORIGINS = frozenset({'https://localhost', 'capacitor://localhost'})   # Android · iOS WebView — 정확 일치만
TOKEN = re.compile(r'[A-Za-z0-9_-]{16,256}')
TICKET = re.compile(r'[A-Za-z0-9_-]{16,128}')
TICKET_TTL = 20.0          # 계약 상한 30 s
TICKETS_PER_SESSION = 4    # 보관 상한(넘으면 429)


def origin_ok(origin):
    return isinstance(origin, str) and origin in ORIGINS


def bearer(auth):
    """Authorization 헤더 → 토큰 또는 None(형식이 조금이라도 다르면 None)"""
    if not isinstance(auth, str) or not auth.startswith('Bearer '):
        return None
    t = auth[7:]
    return t if TOKEN.fullmatch(t) else None


def login_body(b):
    """POST /api/app/login 본문 → (user, pw, label, device) 또는 None(400)"""
    if not isinstance(b, dict):
        return None
    user, pw, label, dev = b.get('user'), b.get('pw'), b.get('label'), b.get('device')
    if not (isinstance(user, str) and 0 < len(user) <= 64 and isinstance(pw, str) and 0 < len(pw) <= 256):
        return None
    if label is not None and not (isinstance(label, str) and len(label) <= 64):
        return None
    if dev is not None and not (isinstance(dev, str) and TOKEN.fullmatch(dev)):
        return None
    return user, pw, label, dev


# 기기 값: phone_gate dev_issue 의 «id.서명» 을 계약 문자 규칙에 맞게 «id-서명»으로 (서명 검사는 dev_check 재사용)
def device_out(cookie):
    return cookie.replace('.', '-', 1)


def device_in(v):
    return v.replace('-', '.', 1) if isinstance(v, str) else None


def login_reply(tok, device, account, exp):
    return {'token': tok, 'device': device, 'account': account, 'exp': int(exp)}


def whoami_reply(s):   # 기존 /api/whoami 와 같은 꼴
    return {'account': s['account'], 'device': s['device'][:6], 'label': s.get('label'), 'exp': s['exp']}


def actor(s):          # 쓰기 작성자 = 세션 계정·기기 (기존 X-FH-Actor 와 같은 꼴)
    return f'{s["account"]} · {s.get("label") or "기기 " + s["device"][:6]}'


class Tickets:
    """WS 1회용 표: 세션 토큰·대상 Host·앱 Origin·엔드포인트에 결속, 원자적 1회 소비, TTL·세션별 보관 상한"""

    def __init__(self, ttl=TICKET_TTL, cap=TICKETS_PER_SESSION):
        self.ttl, self.cap, self.by = ttl, cap, {}

    def issue(self, tok, host, origin, now, endpoint='/api/app/ws'):
        self.sweep(now)
        if sum(1 for x in self.by.values() if x['tok'] == tok) >= self.cap:
            return None                                        # 429
        t = secrets.token_urlsafe(24)
        self.by[t] = {'tok': tok, 'host': host, 'origin': origin, 'endpoint': endpoint, 'exp': now + self.ttl}
        return t

    def consume(self, t, host, origin, now, endpoint='/api/app/ws'):
        """→ 세션 토큰 또는 None. 결과와 무관하게 표는 사라진다(재사용·추측 시도 모두 1회)"""
        if not (isinstance(t, str) and TICKET.fullmatch(t)):
            return None
        x = self.by.pop(t, None)
        if not x or now >= x['exp'] or x['host'] != host or x['origin'] != origin or x['endpoint'] != endpoint:
            return None
        return x['tok']

    def drop_session(self, tok):
        for t in [t for t, x in self.by.items() if x['tok'] == tok]:
            del self.by[t]

    def sweep(self, now):
        for t in [t for t, x in self.by.items() if now >= x['exp']]:
            del self.by[t]


def selftest():
    assert origin_ok('https://localhost') and origin_ok('capacitor://localhost')
    for o in (None, '', 'http://localhost', 'https://localhost:443', 'https://localhost/', 'https://LOCALHOST', 'null', 'https://127.0.0.1'):
        assert not origin_ok(o), o
    good = 'A' * 16
    assert bearer('Bearer ' + good) == good
    for h in (None, good, 'bearer ' + good, 'Bearer  ' + good, 'Bearer ' + good + ' ', 'Bearer ' + 'A' * 15, 'Bearer ' + 'A' * 257, 'Bearer ' + 'A' * 15 + '.', 'Basic ' + good):
        assert bearer(h) is None, h
    assert login_body({'user': 'u', 'pw': 'p'}) == ('u', 'p', None, None)
    assert login_body({'user': 'u', 'pw': 'p', 'label': 'x' * 64, 'device': 'a' * 16})
    for b in ({}, {'user': '', 'pw': 'p'}, {'user': 'u' * 65, 'pw': 'p'}, {'user': 'u', 'pw': 'p' * 257}, {'user': 'u', 'pw': 1},
              {'user': 'u', 'pw': 'p', 'label': 'x' * 65}, {'user': 'u', 'pw': 'p', 'device': 'bad.dev.value.xx'}, {'user': 'u', 'pw': 'p', 'device': 3}, [], None):
        assert login_body(b) is None, b
    c = 'abcdef012345.' + 'f' * 32
    assert TOKEN.fullmatch(device_out(c)) and device_in(device_out(c)) == c and device_in(None) is None
    T = Tickets(ttl=10, cap=2)
    a = T.issue('tokA', 'h:1', 'https://localhost', 0)
    assert TICKET.fullmatch(a)
    assert T.consume(a, 'h:1', 'https://localhost', 1) == 'tokA'
    assert T.consume(a, 'h:1', 'https://localhost', 1) is None                          # 1회
    b = T.issue('tokA', 'h:1', 'https://localhost', 0)
    assert T.consume(b, 'h:2', 'https://localhost', 1) is None                          # Host 결속
    assert T.consume(b, 'h:1', 'https://localhost', 1) is None                          # 틀린 시도에도 소비됨
    b = T.issue('tokA', 'h:1', 'https://localhost', 0)
    assert T.consume(b, 'h:1', 'capacitor://localhost', 1) is None                      # Origin 결속
    b = T.issue('tokA', 'h:1', 'https://localhost', 0)
    assert T.consume(b, 'h:1', 'https://localhost', 10) is None                         # 만료
    b = T.issue('tokA', 'h:1', 'https://localhost', 0)
    assert T.consume(b, 'h:1', 'https://localhost', 1, endpoint='/ws') is None          # 엔드포인트 결속
    x, y = T.issue('tokA', 'h', 'https://localhost', 0), T.issue('tokA', 'h', 'https://localhost', 0)
    assert x and y and T.issue('tokA', 'h', 'https://localhost', 0) is None             # 보관 상한
    assert T.issue('tokB', 'h', 'https://localhost', 0)
    T.drop_session('tokA'); assert T.consume(x, 'h', 'https://localhost', 1) is None    # 로그아웃 → 남은 표 폐기
    assert T.issue('tokA', 'h', 'https://localhost', 20)                                # 만료분 정리 뒤 다시 발급
    assert T.consume('short', 'h', 'https://localhost', 0) is None and T.consume(None, 'h', 'https://localhost', 0) is None
    print('app_auth selftest OK')


if __name__ == '__main__':
    selftest()
