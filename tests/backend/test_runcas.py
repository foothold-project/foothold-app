"""C(10-15 프리셋): 새 Run 시작 때 서버의 계획 판(mrev)·스냅샷·양식 대조와 mcas 수명 — JSON(v2_link Docs)·SQLite(server/store) 같은 표.
설계 정본: runs/mission-preset-20261015/review-1c01d93/C-DESIGN.md 개정 2·3."""
import copy, json, re, sys, threading, time
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT)); sys.path.insert(0, str(ROOT / 'sim'))
import v2_link as L  # noqa: E402
from server import store as S, runcas as RC  # noqa: E402
from contracts.v1 import models as C  # noqa: E402

MS = {'src': 'gt', 'world_id': 'v5_building', 'floor_id': 'l1', 'key': '0a1b2c3d', 'rid': 'g:' + 'a' * 64}
WP = [{'x': 1, 'y': 2.25, 'name': '계단', 'mods': ['사진']}, {'x': -3.5, 'y': 0, 'name': '문', 'mods': ['운영자 확인', '대기']}]
TM = {'name': '팀 양식', 'desc': '', 'mods': [{'type': '사진', 'detail': '전방'}]}


def store(kind, tmp_path):
    if kind == 'json':
        return L.Docs(tmp_path)
    return S.Store(tmp_path / 'c.sqlite', check=lambda k, d: L.doc_check(L.DOC_KINDS[k], d))


@pytest.fixture(params=['json', 'sqlite'])
def env(request, tmp_path):
    """저장소 + 팀 양식 t + 계획 m(map 있음, 팀 양식) + 계획 b(map 없음, 내장 기본 양식 '')"""
    s = store(request.param, tmp_path)
    put = lambda k, d: s.apply({'op': 'put', 'kind': k, 'id': None, 'doc': copy.deepcopy(d)}, 'A')
    tid = put('tmpl', TM)[1]['id']
    mid = put('mission', {'name': '순찰', 'tmpl': tid, 'memo': '', 'wps': WP, 'map': MS})[1]['id']
    bid = put('mission', {'name': '기본', 'tmpl': '', 'memo': '', 'wps': WP[:1]})[1]['id']
    return s, tid, mid, bid


def env_of(s, i):
    return {x['id']: x for x in s.listing()['docs']}[i]


def new_run(s, mid, **kw):
    """C 직전 앱(1c01d93~bf4f4d8) newRun 과 같은 필드: 계획 판 사본 + mrev(+map 은 결속일 때만). R3: 계획에 finish 가 있으면 사본(없으면 키 없음)"""
    m = env_of(s, mid)
    M = m['doc']; t = {x['id']: x for x in s.listing()['docs']}.get(M['tmpl'])
    tn = RC.BASE_TMPL_NAME if M['tmpl'] in ('', 'base') or t is None or t['kind'] != 'tmpl' else t['doc']['name']   # 없는 양식 = 옛 앱이 base 로 대체했다고 가정
    d = {'mode': '수동', 'mission': mid, 'tmpl': RC.cut16(tn, 60), 'name': M['name'], 'status': '진행', 'started': '2026-10-15T18:00:00+0900', 'ended': '', 'memo': '',
         'wps': [{**w, 'mods': list(w['mods']), 'st': '대기', 'at': '', 'why': '', 'chk': '', 'photos': []} for w in M['wps']],
         **({'map': dict(M['map'])} if 'map' in M else {}), **({'finish': M['finish']} if 'finish' in M else {}), 'mrev': m['rev']}
    d.update(kw)
    return d


def put_run(s, d, rid=None, rev=None):
    m = {'op': 'put', 'kind': 'run', 'id': rid, 'doc': copy.deepcopy(d)}
    if rid:
        m['rev'] = rev
    return s.apply(m, 'B')


# ---------------------------------------------------------------- 새 Run: 통과·대조 실패


def test_pass_sets_mcas(env):
    s, tid, mid, bid = env
    for x in (mid, bid):
        c, r = put_run(s, new_run(s, x))
        assert c == 200 and 'mcas_dropped' not in r and env_of(s, r['id'])['doc']['mcas'] == 1, r
        C.DocPutOk.model_validate(r)
        put_run(s, {**env_of(s, r['id'])['doc'], 'status': '중단'}, r['id'], 1)     # 다음 시작을 위해 끝냄(진행 1개)


def test_no_mrev_old_app_no_mcas(env):
    s, tid, mid, bid = env
    d = new_run(s, mid); del d['mrev']; del d['map']; d['name'] = '아무 이름'     # 옛 앱: 대조 0 → 이름이 달라도 저장(지금과 같음)
    c, r = put_run(s, d)
    assert c == 200 and 'mcas' not in env_of(s, r['id'])['doc']


@pytest.mark.parametrize('case', ['changed', 'gone', 'tmpl_gone', 'tmpl_renamed', 'tmpl_not_tmpl', 'tmpl_unknown_id'])
def test_conflicts_409(env, case):
    s, tid, mid, bid = env
    d = new_run(s, mid)
    M = env_of(s, mid)
    want = {'changed': 'mission_changed', 'gone': 'mission_gone'}.get(case, 'tmpl_changed')
    if case == 'changed':
        assert s.apply({'op': 'put', 'id': mid, 'rev': 1, 'doc': {**M['doc'], 'memo': '다른 기기'}}, 'C')[0] == 200
    elif case == 'gone':
        assert s.apply({'op': 'del', 'id': mid, 'rev': 1}, 'C')[0] == 200
    elif case == 'tmpl_gone':
        assert s.apply({'op': 'del', 'id': tid, 'rev': 1}, 'C')[0] == 200
    elif case == 'tmpl_renamed':
        assert s.apply({'op': 'put', 'id': tid, 'rev': 1, 'doc': {**TM, 'name': '새 이름'}}, 'C')[0] == 200
    else:      # 계획이 가리키는 양식 ID 가 tmpl 문서가 아님/없는 ID → base 로 대체 0
        zid = s.apply({'op': 'put', 'kind': 'zone', 'id': None, 'doc': {'name': 'z', 'type': '금지', 'pts': [[0, 0], [1, 0], [1, 1]]}}, 'C')[1]['id']
        tref = zid if case == 'tmpl_not_tmpl' else 'tzzz'
        assert s.apply({'op': 'put', 'id': mid, 'rev': 1, 'doc': {**M['doc'], 'tmpl': tref}}, 'C')[0] == 200
        d = {**new_run(s, mid), 'tmpl': RC.BASE_TMPL_NAME}
    n0 = len(s.listing()['docs'])
    c, r = put_run(s, d)
    assert c == 409 and r['reason_code'] == want and len(s.listing()['docs']) == n0, r
    e = C.ApiError.model_validate(r); assert e.reason_code == want
    if case == 'changed':
        assert r['cur']['id'] == mid and r['cur']['rev'] == 2


@pytest.mark.parametrize('mut', ['name', 'x', 'y', 'wp_name', 'mods', 'count', 'map_rid', 'map_extra', 'tmpl'])
def test_snapshot_mismatch(env, mut):
    s, tid, mid, bid = env
    d = new_run(s, mid)
    if mut == 'name': d['name'] = '순찰 '
    elif mut == 'x': d['wps'][0]['x'] = 1.01
    elif mut == 'y': d['wps'][1]['y'] = 0.5
    elif mut == 'wp_name': d['wps'][1]['name'] = '문2'
    elif mut == 'mods': d['wps'][1]['mods'] = ['대기', '운영자 확인']
    elif mut == 'count': d['wps'].pop()
    elif mut == 'map_rid': d['map']['rid'] = 'g:' + 'b' * 64
    elif mut == 'map_extra':           # 계획엔 map 이 없는데 Run 에 map
        d = new_run(s, bid, map=dict(MS))
    else: d['tmpl'] = '팀 양식2'
    c, r = put_run(s, d)
    assert c == 409 and r['reason_code'] == ('tmpl_changed' if mut == 'tmpl' else 'snapshot_mismatch'), r


def test_mission_ref_to_other_kind_is_gone(env):
    s, tid, mid, bid = env
    c, r = put_run(s, new_run(s, mid, mission=tid))          # Run.mission 이 양식 문서 ID(판 1) — 계획 아님
    assert c == 409 and r['reason_code'] == 'mission_gone' and r['cur'] is None


def test_run_without_map_on_bound_mission_passes(env):
    """UI 는 지금 지도와 결속이 안 되면 map 을 빼고 시작(지도 미확인 · 기록만) — 계획 판·지점 사본이면 mcas 통과"""
    s, tid, mid, bid = env
    d = new_run(s, mid); del d['map']
    c, r = put_run(s, d)
    assert c == 200 and env_of(s, r['id'])['doc']['mcas'] == 1 and 'map' not in env_of(s, r['id'])['doc']


def test_base_tmpl_names(env):
    s, tid, mid, bid = env
    M = env_of(s, bid)['doc']
    assert s.apply({'op': 'put', 'id': bid, 'rev': 1, 'doc': {**M, 'tmpl': 'base'}}, 'C')[0] == 200
    assert put_run(s, new_run(s, bid, tmpl='지점 확인'))[1]['reason_code'] == 'tmpl_changed'
    c, r = put_run(s, new_run(s, bid))
    assert c == 200 and env_of(s, r['id'])['doc']['mcas'] == 1


def test_active_run_409_first_without_reason(env):
    s, tid, mid, bid = env
    assert put_run(s, new_run(s, mid))[0] == 200
    c, r = put_run(s, new_run(s, bid, mrev=99))           # 진행 1개 409 가 C 대조보다 먼저 — 기존 본문(사유 없음)
    assert c == 409 and 'reason_code' not in r and r['error'].startswith('이미 진행 중')


# ---------------------------------------------------------------- mcas 위조·형식


def test_client_mcas_forbidden_and_format(env):
    s, tid, mid, bid = env
    c, r = put_run(s, {**new_run(s, mid), 'mcas': 1})
    assert c == 400 and r['reason_code'] == 'mcas_forbidden'
    ok = put_run(s, new_run(s, mid))[1]['id']
    v = env_of(s, ok)['doc']; put_run(s, {**v, 'status': '중단'}, ok, 1)
    c, r = put_run(s, {**env_of(s, ok)['doc'], 'status': '진행'})        # 검증 Run 을 복사해 새 id 로 → 400
    assert c == 400 and r['reason_code'] == 'mcas_forbidden'
    for bad in (True, 1.0, '1', 0, None, 2):
        c, r = put_run(s, {**new_run(s, mid), 'mcas': bad})
        assert c == 400 and 'reason_code' not in r, bad
        assert C.check_doc('run', {**new_run(s, mid), 'mcas': bad}), bad
    assert C.check_doc('run', {**new_run(s, mid), 'mcas': 1}) is None


def test_unverified_run_cannot_be_promoted(env):
    s, tid, mid, bid = env
    d = new_run(s, mid); del d['mrev']
    rid = put_run(s, d)[1]['id']
    c, r = put_run(s, {**env_of(s, rid)['doc'], 'mcas': 1}, rid, 1)
    assert c == 400 and r['reason_code'] == 'mcas_forbidden' and 'mcas' not in env_of(s, rid)['doc']
    assert put_run(s, {**env_of(s, rid)['doc'], 'memo': 'x'}, rid, 1)[0] == 200


# ---------------------------------------------------------------- 결과 편집: 유지·낮춤


def _result_edits(d):
    d['wps'][0].update(st='방문', at='2026-10-15T18:01:00+0900', chk='확인', photos=['media/photos/20261015/a.jpg'])
    d['wps'][1].update(st='미방문', why='길 막힘')
    d['memo'] = '메모'; d['status'] = '완료'; d['ended'] = '2026-10-15T18:09:00+0900'


@pytest.mark.parametrize('echo', [True, False])
def test_result_edit_keeps_mcas(env, echo):
    s, tid, mid, bid = env
    rid = put_run(s, new_run(s, mid))[1]['id']
    M = env_of(s, mid)['doc']
    assert s.apply({'op': 'put', 'id': mid, 'rev': 1, 'doc': {**M, 'name': '바뀐 계획'}}, 'C')[0] == 200   # 시작 뒤 계획 수정 → 재대조 0
    d = copy.deepcopy(env_of(s, rid)['doc']); _result_edits(d)
    if not echo:
        del d['mcas']
    c, r = put_run(s, d, rid, 1)
    assert c == 200 and 'mcas_dropped' not in r and env_of(s, rid)['doc']['mcas'] == 1 and env_of(s, rid)['doc']['status'] == '완료'


@pytest.mark.parametrize('field', ['name', 'mission', 'mrev', 'tmpl', 'started', 'mode', 'map_drop', 'map_rid', 'wp_x', 'wp_mods', 'wp_count', 'finish_add'])
def test_basis_change_drops_mcas(env, field):
    s, tid, mid, bid = env
    rid = put_run(s, new_run(s, mid))[1]['id']
    d = copy.deepcopy(env_of(s, rid)['doc'])
    if field == 'name': d['name'] = 'x'
    elif field == 'mission': d['mission'] = 'mzzz'
    elif field == 'mrev': d['mrev'] = 2
    elif field == 'tmpl': d['tmpl'] = 'x'
    elif field == 'started': d['started'] = 'x'
    elif field == 'mode': del d['mrev']          # mrev 를 모르는 옛 앱이 고쳐 씀
    elif field == 'map_drop': del d['map']        # map 을 모르는 옛 앱
    elif field == 'map_rid': d['map']['rid'] = 'w:' + 'c' * 64
    elif field == 'wp_x': d['wps'][0]['x'] = 9
    elif field == 'wp_mods': d['wps'][0]['mods'] = []
    elif field == 'finish_add': d['finish'] = '출발점 복귀'   # R3: 계획엔 없던 종료 방식을 결과 편집에서 붙임
    else: d['wps'].append({**d['wps'][0]})
    c, r = put_run(s, d, rid, 1)
    assert c == 200 and r['mcas_dropped'] is True and 'mcas' not in env_of(s, rid)['doc'], r
    assert C.DocPutOk.model_validate(r).mcas_dropped is True
    c, r = put_run(s, {**env_of(s, rid)['doc'], 'mcas': 1}, rid, 2)      # 낮춘 뒤 다시 올리기 0
    assert c == 400 and r['reason_code'] == 'mcas_forbidden'


# ---------------------------------------------------------------- R3 finish: 시작 사본 대조(키 유무·값)·결과 편집 낮춤·옛 앱


def set_finish(s, mid, f):
    """계획에 finish 를 넣는다(f=None 이면 키를 뺀다) — 판 +1"""
    e = env_of(s, mid); M = {k: v for k, v in e['doc'].items() if k != 'finish'}
    assert s.apply({'op': 'put', 'id': mid, 'rev': e['rev'], 'doc': {**M, **({'finish': f} if f else {})}}, 'C')[0] == 200


@pytest.mark.parametrize('f', ['출발점 복귀', '마지막 지점 종료'])
def test_finish_copy_passes(env, f):
    s, tid, mid, bid = env
    for x in (mid, bid):
        set_finish(s, x, f)
        c, r = put_run(s, new_run(s, x))
        doc = env_of(s, r['id'])['doc']
        assert c == 200 and doc['mcas'] == 1 and doc['finish'] == f, r
        put_run(s, {**doc, 'status': '중단'}, r['id'], 1)


@pytest.mark.parametrize('case', ['run_missing', 'run_extra', 'value'])
def test_finish_mismatch_409(env, case):
    s, tid, mid, bid = env
    if case != 'run_extra':
        set_finish(s, mid, '출발점 복귀')
    d = new_run(s, mid)
    if case == 'run_missing': del d['finish']                 # 옛 newRun(사본 안 함)이 finish 있는 계획을 시작
    elif case == 'run_extra': d['finish'] = '출발점 복귀'      # 계획엔 없는데 Run 에 채움(추정 0)
    else: d['finish'] = '마지막 지점 종료'
    n0 = len(s.listing()['docs'])
    c, r = put_run(s, d)
    assert c == 409 and r['reason_code'] == 'snapshot_mismatch' and len(s.listing()['docs']) == n0, r


@pytest.mark.parametrize('edit', ['same', 'change', 'drop'])
def test_finish_result_edit(env, edit):
    s, tid, mid, bid = env
    set_finish(s, mid, '출발점 복귀')
    rid = put_run(s, new_run(s, mid))[1]['id']
    d = copy.deepcopy(env_of(s, rid)['doc']); d['memo'] = '복귀 확인'
    if edit == 'change': d['finish'] = '마지막 지점 종료'
    elif edit == 'drop': del d['finish']                       # finish 를 모르는 옛 앱이 고쳐 씀
    c, r = put_run(s, d, rid, 1)
    keep = edit == 'same'
    assert c == 200 and ('mcas' in env_of(s, rid)['doc']) == keep and r.get('mcas_dropped', False) is (not keep), r


def test_finish_no_mrev_not_compared(env):
    s, tid, mid, bid = env
    set_finish(s, mid, '출발점 복귀')
    d = new_run(s, mid); del d['mrev']; d['finish'] = '마지막 지점 종료'   # mrev 모르는 앱 = 대조 0 → 저장·mcas 0
    c, r = put_run(s, d)
    assert c == 200 and 'mcas' not in env_of(s, r['id'])['doc'] and env_of(s, r['id'])['doc']['finish'] == '마지막 지점 종료'


# ---------------------------------------------------------------- 10-19 계획 출발점 start: 시작 사본 대조(키 유무·값·출처)·결과 편집 낮춤·옛 앱 409
SP = {'x': 0.5, 'y': -1.25, 'map': {**MS, 'key': '9f8e7d6c'}}


def set_start(s, mid, st):
    """계획에 start 를 넣는다(st=None 이면 키를 뺀다) — 판 +1. 관계 검사 0 이라 계획 map 과 출처가 달라도 저장된다"""
    e = env_of(s, mid); M = {k: v for k, v in e['doc'].items() if k != 'start'}
    assert s.apply({'op': 'put', 'id': mid, 'rev': e['rev'], 'doc': {**M, **({'start': st} if st else {})}}, 'C')[0] == 200


@pytest.mark.parametrize('which', ['mid', 'bid'])
def test_start_copy_passes(env, which):
    s, tid, mid, bid = env
    x = mid if which == 'mid' else bid                       # bid = 계획 map 없음(Run.map 도 없음) — start 는 그래도 사본
    set_start(s, x, SP)
    c, r = put_run(s, new_run(s, x, start=copy.deepcopy(SP)))
    doc = env_of(s, r['id'])['doc']
    assert c == 200 and doc['mcas'] == 1 and doc['start'] == SP and ('map' in doc) == (which == 'mid'), r


@pytest.mark.parametrize('case', ['old_app', 'run_extra', 'xy', 'src_floor', 'src_key', 'src_rid'])
def test_start_mismatch_409(env, case):
    s, tid, mid, bid = env
    if case != 'run_extra':
        set_start(s, mid, SP)
    d = new_run(s, mid)                                     # 옛 newRun = start 사본 안 함
    if case == 'run_extra': d['start'] = SP                 # 계획엔 없는데 Run 에 채움(추정 0)
    elif case == 'xy': d['start'] = {**SP, 'x': 0.6}
    elif case == 'src_floor': d['start'] = {**SP, 'map': {**SP['map'], 'floor_id': 'l2'}}
    elif case == 'src_key': d['start'] = {**SP, 'map': {**SP['map'], 'key': '00000000'}}
    elif case == 'src_rid': d['start'] = {**SP, 'map': {**SP['map'], 'rid': 'w:' + 'b' * 64}}
    n0 = len(s.listing()['docs'])
    c, r = put_run(s, d)
    assert c == 409 and r['reason_code'] == 'snapshot_mismatch' and len(s.listing()['docs']) == n0, r


@pytest.mark.parametrize('edit', ['same', 'change', 'drop'])
def test_start_result_edit(env, edit):
    s, tid, mid, bid = env
    set_start(s, mid, SP)
    rid = put_run(s, new_run(s, mid, start=copy.deepcopy(SP)))[1]['id']
    d = copy.deepcopy(env_of(s, rid)['doc']); d['memo'] = '출발점 확인'
    if edit == 'change': d['start'] = {**SP, 'y': 3}
    elif edit == 'drop': del d['start']                      # start 를 모르는 앱이 키를 버리고 고쳐 씀
    c, r = put_run(s, d, rid, 1)
    keep = edit == 'same'
    assert c == 200 and ('mcas' in env_of(s, rid)['doc']) == keep and r.get('mcas_dropped', False) is (not keep), r


def test_start_no_mrev_not_compared(env):
    s, tid, mid, bid = env
    set_start(s, mid, SP)
    d = new_run(s, mid, start={**SP, 'x': 9}); del d['mrev']   # mrev 모르는 앱 = 대조 0 → 저장·mcas 0
    c, r = put_run(s, d)
    assert c == 200 and 'mcas' not in env_of(s, r['id'])['doc'] and env_of(s, r['id'])['doc']['start']['x'] == 9


@pytest.mark.parametrize('bad', [None, {}, {'x': 1, 'y': 2}, {**SP, 'map': None}, {**SP, 'x': True}, {**SP, 'extra': 1}])
def test_start_bad_shape_400(env, bad):
    s, tid, mid, bid = env
    e = env_of(s, mid)
    assert s.apply({'op': 'put', 'id': mid, 'rev': e['rev'], 'doc': {**e['doc'], 'start': bad}}, 'C')[0] == 400
    assert put_run(s, new_run(s, mid, start=bad))[0] == 400 and env_of(s, mid)['rev'] == e['rev']


def test_rev_conflict_on_run_edit_has_no_reason(env):
    s, tid, mid, bid = env
    rid = put_run(s, new_run(s, mid))[1]['id']
    d = env_of(s, rid)['doc']
    assert put_run(s, {**d, 'memo': 'a'}, rid, 1)[0] == 200
    c, r = put_run(s, {**d, 'memo': 'b'}, rid, 1)
    assert c == 409 and 'reason_code' not in r and r['cur']['rev'] == 2


def test_size_rechecked_after_mcas(env):
    """기입 전 DOC_MAX 이하, «, "mcas": 1» 을 붙이면 넘는 Run → 400(저장 0)"""
    s, tid, mid, bid = env
    d = new_run(s, mid)
    big = 30 - len(d['wps'])
    M = env_of(s, mid)['doc']
    wps = M['wps'] + [{'x': i, 'y': 0, 'name': '가' * 40, 'mods': ['사진', '운영자 확인', '대기']} for i in range(big)]
    assert s.apply({'op': 'put', 'id': mid, 'rev': 1, 'doc': {**M, 'wps': wps, 'map': {**MS, 'key': '1'}}}, 'C')[0] == 200
    d = new_run(s, mid)
    size = lambda v: len(json.dumps(v, ensure_ascii=False).encode())
    for w in d['wps']:                          # 결과 필드(why)를 3 바이트씩 채워 한도 400 바이트 안까지
        while len(w['why']) < 120 and L.DOC_MAX - 3 - size(d) > 400:
            w['why'] += '가'
    pad = L.DOC_MAX - 3 - size(d)
    assert 0 <= pad <= 400, pad                  # memo(ASCII) 로 정확히 맞춤
    d['memo'] = 'a' * pad
    assert size(d) == L.DOC_MAX - 3 and size({**d, 'mcas': 1}) > L.DOC_MAX
    n0 = len(s.listing()['docs'])
    c, r = put_run(s, d)
    assert c == 400 and '너무 큼' in r['error'] and len(s.listing()['docs']) == n0, r
    d['memo'] = 'a' * (pad - 11)                 # 붙여도 한도 안이면 통과
    c, r = put_run(s, d)
    assert c == 200 and env_of(s, r['id'])['doc']['mcas'] == 1


# ---------------------------------------------------------------- 글자: 외톨이 surrogate · cut16


@pytest.mark.parametrize('where', ['run_name', 'mission_memo', 'tmpl_name', 'note_memo', 'wp_why'])
def test_lone_surrogate_400(env, where):
    s, tid, mid, bid = env
    bad = '가\ud83e'
    if where == 'run_name':
        m = {'op': 'put', 'kind': 'run', 'id': None, 'doc': {**new_run(s, mid), 'name': bad}}
    elif where == 'wp_why':
        d = new_run(s, mid); d['wps'][0]['why'] = bad; m = {'op': 'put', 'kind': 'run', 'id': None, 'doc': d}
    elif where == 'mission_memo':
        m = {'op': 'put', 'id': mid, 'rev': 1, 'doc': {**env_of(s, mid)['doc'], 'memo': bad}}
    elif where == 'tmpl_name':
        m = {'op': 'put', 'kind': 'tmpl', 'id': None, 'doc': {**TM, 'name': bad}}
    else:
        m = {'op': 'put', 'kind': 'note', 'id': None, 'doc': {'photo': 'media/photos/20261015/a.jpg', 'cls': '확인', 'memo': bad}}
    n0, rv = len(s.listing()['docs']), s.listing()['rev']
    c, r = s.apply(m, 'A')
    assert c == 400 and len(s.listing()['docs']) == n0 and s.listing()['rev'] == rv, r
    assert C.check_doc(m.get('kind') or 'mission', m['doc'])
    ok = json.loads(json.dumps('가🤖'))          # 올바른 쌍은 한 글자 — 통과
    assert C.check_doc('tmpl', {**TM, 'name': ok}) is None and L.doc_check(L.DOC_KINDS['tmpl'], {**TM, 'name': ok}) is None


# 공통 표본(ui/tests/unit/preset_bind.test.ts 의 cutName 시험과 같은 입력·기대값)
CUT = [('한' * 56 + '🤖' + '나나', 57, '한' * 56), ('한' * 56 + '🤖' + '나나', 60, '한' * 56 + '🤖' + '나나'), ('🤖' * 30, 59, '🤖' * 29),
       ('a' + '😀' * 29, 60, 'a' + '😀' * 29), ('a' + '😀' * 30, 60, 'a' + '😀' * 29), ('가' * 61, 60, '가' * 60), ('', 60, '')]


@pytest.mark.parametrize('s_,n,want', CUT)
def test_cut16(s_, n, want):
    got = RC.cut16(s_, n)
    assert got == want and len(got.encode('utf-16-le')) // 2 <= n
    assert C.check_doc('tmpl', {**TM, 'name': got}) is None


def test_emoji_tmpl_name_matches_cut16(env):
    """양식 이름이 60 code point(이모지 포함) — Run.tmpl 기대값 = cut16(이름, 60). UTF-16 slice(0,60)(C 직전 앱)는 외톨이 → 400"""
    s, tid, mid, bid = env
    nm = '양' * 59 + '🤖'                 # 60 code point · UTF-16 61 단위 — slice(0,60) 이면 🤖 의 앞 반쪽만 남음
    assert s.apply({'op': 'put', 'id': tid, 'rev': 1, 'doc': {**TM, 'name': nm}}, 'C')[0] == 200
    c, r = put_run(s, new_run(s, mid))
    assert c == 200 and env_of(s, r['id'])['doc']['tmpl'] == '양' * 59
    put_run(s, {**env_of(s, r['id'])['doc'], 'status': '중단'}, r['id'], 1)
    u16 = nm.encode('utf-16-le')[:120].decode('utf-16-le', 'surrogatepass')       # JS .slice(0, 60)
    assert put_run(s, new_run(s, mid, tmpl=u16))[0] == 400
    assert put_run(s, new_run(s, mid, tmpl=nm))[1]['reason_code'] == 'tmpl_changed'   # 자르지 않은 이름도 거절(규칙 하나)


# ---------------------------------------------------------------- 상수·예약어


def test_base_tmpl_name_matches_ui():
    ts = (ROOT / 'ui/src/data/tmpl.ts').read_text(encoding='utf-8')
    assert re.search(r"BASE_T: T = \{ id: 'base', kind: '기본', locked: true, name: '([^']*)'", ts).group(1) == RC.BASE_TMPL_NAME


def test_server_ids_never_base(env):
    s, tid, mid, bid = env
    for _ in range(3):
        i = s.apply({'op': 'put', 'kind': 'tmpl', 'id': None, 'doc': TM}, 'A')[1]['id']
        assert i not in RC.BASE_IDS and i.startswith('t')
    assert s.apply({'op': 'put', 'id': 'base', 'rev': 1, 'doc': TM}, 'A')[0] == 404


# ---------------------------------------------------------------- SQLite 두 연결 경합


def test_sqlite_race_mission_edit_waits_for_run_txn(tmp_path):
    """B 가 Run 트랜잭션 안에서 계획을 읽는 순간 A(다른 연결·다른 Store)가 계획을 고치려 하면, A 는 B 커밋까지 기다린다
    → 결과는 직렬(Run mcas=1·mrev=1 → 그 뒤 계획 rev 2). 끼어들기(B 가 옛 판을 읽고 A 가 먼저 커밋) 0"""
    chk = lambda k, d: L.doc_check(L.DOC_KINDS[k], d)
    a = S.Store(tmp_path / 'r.sqlite', check=chk); b = S.Store(tmp_path / 'r.sqlite', check=chk)
    mid = a.apply({'op': 'put', 'kind': 'mission', 'id': None, 'doc': {'name': 'm', 'tmpl': '', 'memo': '', 'wps': WP}}, 'A')[1]['id']
    out, orig = {}, S.Store._one
    def slow_one(c, i):
        r = orig(c, i)
        if i == mid and 't' not in out:
            M = r['doc']
            out['t'] = threading.Thread(target=lambda: out.__setitem__('a', a.apply({'op': 'put', 'id': mid, 'rev': 1, 'doc': {**M, 'memo': '끼어들기'}}, 'A')))
            out['t'].start(); time.sleep(0.4)
            out['alive'] = out['t'].is_alive()     # IMMEDIATE 잠금 때문에 아직 못 씀
        return r
    S.Store._one = staticmethod(slow_one)
    try:
        c, r = put_run(b, new_run(b, mid))
    finally:
        S.Store._one = staticmethod(orig)
    out['t'].join(10)
    assert out['alive'] and c == 200 and env_of(b, r['id'])['doc']['mcas'] == 1 and env_of(b, r['id'])['doc']['mrev'] == 1
    assert out['a'][0] == 200 and env_of(a, mid)['rev'] == 2
    c2, r2 = put_run(b, {**new_run(b, mid), 'mrev': 1, 'status': '진행'})   # 이제 옛 판(1)으로 새 시작 → 409(진행 1개가 먼저라 앞 Run 끝낸 뒤)
    assert c2 == 409
    put_run(b, {**env_of(b, r['id'])['doc'], 'status': '중단'}, r['id'], 1)
    c3, r3 = put_run(b, {**new_run(b, mid), 'mrev': 1})
    assert c3 == 409 and r3['reason_code'] == 'mission_changed'


def test_json_and_sqlite_same_bodies(tmp_path):
    """같은 순서의 쓰기 → JSON·SQLite 응답 코드·본문(서버가 만드는 id·시각 제외)이 같다"""
    res = {}
    for k in ('json', 'sqlite'):
        (tmp_path / k).mkdir(); s = store(k, tmp_path / k)
        put = lambda kd, d: s.apply({'op': 'put', 'kind': kd, 'id': None, 'doc': copy.deepcopy(d)}, 'A')
        tid = put('tmpl', TM)[1]['id']; mid = put('mission', {'name': '순찰', 'tmpl': tid, 'memo': '', 'wps': WP, 'map': MS})[1]['id']
        seq = []
        seq.append(put_run(s, {**new_run(s, mid), 'mcas': 1}))
        seq.append(put_run(s, new_run(s, mid, name='x')))
        c, r = put_run(s, new_run(s, mid)); seq.append((c, r)); rid = r['id']
        d = copy.deepcopy(env_of(s, rid)['doc']); d['wps'][0]['x'] = 5
        seq.append(put_run(s, d, rid, 1))
        res[k] = json.dumps([(c, {kk: v for kk, v in r.items() if kk not in ('id', 'cur')}) for c, r in seq], ensure_ascii=False)
    assert res['json'] == res['sqlite']
