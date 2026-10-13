"""FastAPI 문서·기록 조회 어댑터 — v2_link 의 /api/docs·/api/media 와 같은 HTTP 계약(contracts/v1), 저장은 server/store.py.

경계(새 전면 서버가 아니다)
  - 인증은 하지 않는다. 앞단 관문(v2_gate)이 로그인·출처 검사 후 X-FH-Actor 를 붙여 중계한다는 기존 신뢰 경계를 그대로 쓴다.
    그래서 이 앱은 127.0.0.1 에만 띄워야 한다(관문 없이 LAN 노출 = 보호 없는 쓰기 포트).
  - 조종(Core·lock·20 Hz tick·ROS)에 손대지 않는다. 쓰기 성공 사건은 on_event 콜백으로 넘길 뿐(넘길지·어떻게 기록할지는 호출자).
  - DB 호출은 일꾼 스레드에서(GET 은 동기 함수, POST 는 run_in_threadpool). DB 대기가 이벤트 루프를 막지 않고, 이 앱은 watchdog 을 소유하지 않는다.
"""
import json, re, sqlite3
from urllib.parse import unquote

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

from contracts.v1 import models as C

NO_STORE = {'Cache-Control': 'no-store'}
BODY_MAX = 64 * 1024
KIND_KO = {'zone': '구역', 'tmpl': '임무 양식', 'mission': '임무 계획', 'run': '임무 진행', 'note': '사진 분류'}


def actor_from_header(v):
    """v2_link.actor_from_header 와 같은 규칙(시험이 대조). 관문이 붙인 «계정 · 기기», 퍼센트 인코딩 UTF-8."""
    if not v:
        return ''
    try:
        if not v.isascii():
            raise ValueError
        a = unquote(v, errors='strict')
    except (ValueError, UnicodeDecodeError):
        return '관문 기기(이름 해독 실패)'
    return re.sub(r'[\x00-\x1f\x7f]', '', a).strip()[:48] or '관문 기기'


def create_app(store, allowed_origins, on_event=None, version=lambda: '미확인'):
    """store = server.store.Store. allowed_origins = 쓰기를 받을 Origin 집합(서버 자신의 주소).
    on_event(text) = 쓰기 성공 사건 한 줄(예: Core.ev 를 조종 lock 안에서 부르는 함수). 실패해도 응답은 그대로."""
    app = FastAPI(title='foothold docs adapter', version=C.CONTRACT_VERSION, docs_url=None, redoc_url=None, openapi_url=None)

    def out(code, body):
        return JSONResponse(body, status_code=code, headers=NO_STORE)

    @app.get('/api/docs')
    def get_docs():
        return out(200, store.listing())

    @app.post('/api/docs')
    async def post_docs(request: Request):
        if request.headers.get('origin') not in allowed_origins:
            return out(403, {'error': '다른 출처'})
        raw = await request.body()
        if len(raw) > BODY_MAX:                  # 문서 본문 상한(12000 B)+봉투 여유. 큰 본문을 JSON 파싱하지 않는다
            return out(400, {'error': f'요청이 너무 큼({BODY_MAX} 바이트 이하)'})
        try:
            m = json.loads(raw)
        except ValueError:
            return out(400, {'error': 'JSON 아님'})
        actor = actor_from_header(request.headers.get('x-fh-actor', '')) or '이 PC(127.0.0.1)'
        try:
            code, r = await run_in_threadpool(store.apply, m, actor)     # DB 대기는 일꾼 스레드에서
        except sqlite3.Error as e:
            return out(500, {'error': f'저장 실패 · {type(e).__name__} — 이전 상태 그대로, 초안은 화면에'})
        if code == 200 and on_event:
            try:
                on_event(f'{KIND_KO[r["kind"]]} {"삭제" if m.get("op") == "del" else "추가" if r.get("new") else "수정"} · {r["name"] or r["id"]} · {actor}')
            except Exception:
                pass
        return out(code, r)

    @app.get('/api/media')
    def get_media():
        ph, ev = store.media()
        return out(200, {'photos': ph, 'events': ev, 'ver': version()})

    return app
