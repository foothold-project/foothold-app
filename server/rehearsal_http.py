"""/api/rehearsal 의 HTTP 쪽 순수 함수(프레임워크 없음) — 본문 상한·엄격 JSON·응답 상한. 연결(tornado·관문)은 root 소유.

  handle_get(store)               -> (code, dict)   쿼리 없는 GET = 목록(메타만)
  handle_post(store, raw, actor)  -> (code, dict)   raw = 요청 본문 bytes
계약: runs/sim-fleet-planning-20261018/API.md §1·§2. gzip 본문 미지원(Content-Encoding 은 연결 쪽에서 거부).
"""
import json

from .rehearsal import LIMITS

REQ_MAX, RESP_MAX = LIMITS['request_bytes'], LIMITS['response_bytes']


def _no_dupes(pairs):
    d = {}
    for k, v in pairs:
        if k in d:
            raise ValueError(f'중복 키 «{k}»')
        d[k] = v
    return d


def _no_const(name):
    raise ValueError(f'JSON 에 {name} 는 쓸 수 없습니다')


def loads_strict(raw):
    """UTF-8 JSON. 중복 키·NaN·Infinity 거부(1e999 같은 넘침은 scene 검증이 유한수 검사로 거부)."""
    return json.loads(raw.decode('utf-8'), object_pairs_hook=_no_dupes, parse_constant=_no_const)


def _capped(code, r):
    """응답이 1 MiB 를 넘으면 보내지 않는다(tornado 기본 ensure_ascii 기준 = 더 큰 쪽으로 잰다)."""
    if len(json.dumps(r).encode()) > RESP_MAX:
        return 500, {'error': '응답 상한(1 MiB) 초과 — 서버 계산 오류, 요청을 줄여 다시 시도하세요'}
    return code, r


def handle_get(store):
    return _capped(200, store.listing())


def handle_post(store, raw, actor):
    if not isinstance(raw, (bytes, bytearray)):
        return 400, {'error': '본문이 없습니다'}
    if len(raw) > REQ_MAX:
        return 413, {'error': f'요청이 {REQ_MAX // 1024} KiB 를 넘습니다'}
    try:
        body = loads_strict(bytes(raw))
    except UnicodeDecodeError:
        return 400, {'error': 'UTF-8 이 아닙니다'}
    except RecursionError:
        return 400, {'error': 'JSON 중첩이 너무 깊습니다'}
    except ValueError as e:
        return 400, {'error': f'JSON 아님 · {e}'[:200]}
    return _capped(*store.apply(body, actor))
