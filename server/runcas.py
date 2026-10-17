"""C(10-15 프리셋): 새 수동 임무 진행(Run)을 받을 때 서버가 계획 판(mrev)·스냅샷·양식을 대조하고, 통과한 Run 에만 mcas=1 을 찍는다.
설계 정본: runs/mission-preset-20261015/review-1c01d93/C-DESIGN.md 개정 2·3 (원문 §2 tmpl 행·§3 «mcas 400»·§4 옛 서버 문단은 대체됨).

부르는 곳: v2_link Docs.apply(self.lock 안) · server/store.Store._apply(BEGIN IMMEDIATE 트랜잭션 안) — 둘 다 같은 함수, get 만 다르다.
형식 검사(doc_check / contracts check_doc)·크기·진행 1개(409) 를 통과한 뒤에 부르고, 반환 문서로 형식·크기를 다시 검사한다.
표준 라이브러리만(시스템 python 의 v2_link 와 pydantic 쓰는 쪽이 같이 import).

보장: mcas 있는 Run = 생성 순간 서버의 Mission 현재 판 == mrev, 이름·지점(x·y·name·mods)·map(있으면 rid 포함 전체)이 그 판의 사본,
      양식은 그 순간 존재·이름 같음(''·'base' = 내장 기본 양식). 결과 편집(방문·사진·끝내기)은 근거 필드가 같으면 mcas 유지, 다르면 낮춤.
안 함: 양식 본문 개정·할 일 목록 · map 이 지금 시뮬과 같은지(UI gtHere 몫) · 시작 뒤 Mission 변경 재대조 · 다른 기기의 저장 안 한 초안.
"""

BASE_TMPL_NAME = '지점 확인 다녀오기'     # ui/src/data/tmpl.ts BASE_T.name 과 같아야 한다(시험이 TS 원문과 대조)
BASE_IDS = ('', 'base')                    # Mission.tmpl 이 이 값이면 내장 기본 양식(서버 문서 아님). 서버 발급 ID(t…)와 겹치지 않음
REASONS = ('mission_gone', 'mission_changed', 'tmpl_changed', 'snapshot_mismatch', 'mcas_forbidden')
_R = ('mode', 'mission', 'mrev', 'name', 'tmpl', 'started', 'map')     # 검증 근거 필드(Run 최상위) — 나머지는 결과 필드
_WP_R = ('x', 'y', 'name', 'mods')                                     # 지점의 근거 필드 — st·at·why·chk·photos 는 결과


def cut16(s, n):
    """code point 경계에서만 자르고 UTF-16 단위 합 ≤ n (UI run.ts cutName 과 같은 결과 — 시험이 공통 표본으로 대조)."""
    o, u = [], 0
    for ch in s:
        w = 2 if ord(ch) > 0xFFFF else 1
        if u + w > n:
            break
        o.append(ch); u += w
    return ''.join(o)


def _basis(d):
    return tuple((k in d, d.get(k)) for k in _R), len(d['wps']), [tuple(w.get(k) for k in _WP_R) for w in d['wps']]


def _no(code, reason, msg, cur=None):
    return code, {'error': msg, 'cur': cur, 'reason_code': reason}, None


def run_gate(cur, doc, get):
    """kind=run 의 put 하나. cur = 저장된 봉투(고치기) 또는 None(새 Run). get(id) = 같은 잠금/트랜잭션 안에서 읽은 봉투 또는 None.
    반환 (None, 저장할 새 문서, 낮춤 여부) 또는 (HTTP 코드, 응답 본문, None). 받은 doc 은 바꾸지 않는다(사본에 mcas 기입·제거)."""
    has = 'mcas' in doc                       # 형식(정수 1)은 이미 doc_check 가 봄
    out = {k: v for k, v in doc.items() if k != 'mcas'}
    if cur is not None:                       # 고치기: 저장값이 근거 — 들어온 mcas 로 승격 0
        old = cur['doc']
        if 'mcas' not in old:
            return _no(400, 'mcas_forbidden', 'mcas 는 서버만 붙인다 — 서버 대조 없이 시작한 기록은 올릴 수 없음') if has else (None, out, False)
        if _basis(old) == _basis(out):
            return None, {**out, 'mcas': 1}, False
        return None, out, True                # 근거가 바뀜 → 낮춤(기록은 남기고 «서버 대조» 표시만 뗀다)
    if has:
        return _no(400, 'mcas_forbidden', 'mcas 는 서버만 붙인다 — 새 기록에 보낼 수 없음')
    if 'mrev' not in doc:                     # mrev 를 모르는 옛 앱 = 지금과 같은 경로(대조 0, mcas 0)
        return None, out, False
    m = get(doc['mission'])
    if m is None or m['kind'] != 'mission':
        return _no(409, 'mission_gone', '계획이 다른 기기에서 지워짐 — 시작 안 됨')
    if m['rev'] != doc['mrev']:
        return _no(409, 'mission_changed', '다른 기기가 계획을 고침 — 시작 안 됨 · 다시 열어 확인', m)
    M, tid = m['doc'], m['doc']['tmpl']
    t = None
    if tid in BASE_IDS:
        want = cut16(BASE_TMPL_NAME, 60)
    else:
        t = get(tid)
        if t is None or t['kind'] != 'tmpl':
            return _no(409, 'tmpl_changed', '계획의 양식이 지워짐 — 시작 안 됨 · 양식을 다시 고르세요')
        want = cut16(t['doc']['name'], 60)
    if doc['tmpl'] != want:
        return _no(409, 'tmpl_changed', '다른 기기가 양식 이름을 바꿈 — 시작 안 됨 · 다시 열어 확인', t)
    W = M['wps']
    if doc['name'] != M['name'] or len(doc['wps']) != len(W) or any(tuple(a[k] for k in _WP_R) != tuple(b[k] for k in _WP_R) for a, b in zip(doc['wps'], W)) \
            or ('map' in doc and doc['map'] != M.get('map')):
        return _no(409, 'snapshot_mismatch', '기록이 계획 판의 사본과 다름 — 시작 안 됨 · 다시 열어 확인', m)
    return None, {**out, 'mcas': 1}, False
