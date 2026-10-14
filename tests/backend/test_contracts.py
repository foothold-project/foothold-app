"""계약 v1 시험 — 현행 sim/v2_link.py 와 어긋나면 실패해야 한다(이름·형식 drift 검출)."""
import ast, json, os, shutil, subprocess, sys
from pathlib import Path

import pytest
from pydantic import TypeAdapter, ValidationError

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT)); sys.path.insert(0, str(ROOT / 'sim'))
import v2_link as L  # noqa: E402  (rclpy·tornado 는 main() 안에서만 import)
from contracts.v1 import models as C  # noqa: E402

SRC = (ROOT / 'sim' / 'v2_link.py').read_text(encoding='utf-8')
Z = {'name': '금지1', 'type': '금지', 'pts': [[0, 0], [1, 0], [1, 1]]}
N = {'photo': 'media/photos/20261013/a.jpg', 'cls': '확인', 'memo': ''}
WP = {'x': 1, 'y': 2, 'name': '계단 앞', 'mods': ['사진', '운영자 확인']}
RW = {**WP, 'st': '미방문', 'at': '', 'why': '길 막힘', 'chk': '', 'photos': ['media/photos/20261013/a.jpg']}
RUN = {'mode': '수동', 'mission': 'm1', 'tmpl': 't', 'name': 'm', 'status': '중단', 'started': 't', 'ended': 't', 'memo': '', 'wps': [RW]}
TM = {'name': 't', 'desc': '', 'mods': [{'type': '사진', 'detail': '전방 1장'}]}
MI = {'name': 'm', 'tmpl': '', 'memo': '', 'wps': [WP]}
nan, inf = float('nan'), float('inf')

CASES = [  # (kind, doc) — 좋은 것·나쁜 것 섞어서. 기대값은 v2_link.doc_check 가 정한다
    ('zone', Z), ('zone', {**Z, 'pts': [[0, 0], [1, 1]]}), ('zone', {**Z, 'pts': [[0, 0], [1, nan], [1, 1]]}),
    ('zone', {**Z, 'pts': [[0, 0], [True, 0], [1, 1]]}), ('zone', {**Z, 'pts': [[0, 0], [1, inf], [1, 1]]}),
    ('zone', {**Z, 'pts': [[0, 0], [1e4, -1e4], [1, 1]]}), ('zone', {**Z, 'pts': [[0, 0], [10000.1, 0], [1, 1]]}),
    ('zone', {**Z, 'pts': [[0, 0, 0], [1, 0], [1, 1]]}), ('zone', {**Z, 'pts': [[0, 0]] * 41}), ('zone', {**Z, 'pts': [[0, 0]] * 40}),
    ('zone', {**Z, 'type': '위험'}), ('zone', {**Z, 'name': 'x' * 41}), ('zone', {**Z, 'name': 'x' * 40}), ('zone', {**Z, 'extra': 1}),
    ('zone', {'name': 'a'}), ('zone', 'str'), ('zone', None), ('zone', {**Z, 'name': 3}), ('zone', {**Z, 'pts': 'abc'}),
    ('note', N), ('note', {**N, 'cls': '맞음'}), ('note', {**N, 'cls': ['확인']}), ('note', {**N, 'cls': None}), ('note', {**N, 'cls': {'a': 1}}),
    *[('note', {**N, 'photo': p}) for p in ['http://x/a.jpg', 'javascript:alert(1)', 'media/photos/20261013/../a.jpg',
                                           'media/photos/2026/a.jpg', ['x'], 'media/photos/20261013/a..jpg', 'media/photos/20261013/' + 'a' * 80 + '.jpg',
                                           'media/photos/20261013/' + 'a' * 81 + '.jpg', 'media/photos/20261013/a.jpg\n', 'media/photos/20261013/a b.jpg']],
    ('tmpl', TM), ('tmpl', {**TM, 'mods': [{'type': '가스 측정', 'detail': ''}]}), ('tmpl', {**TM, 'mods': [{'type': 'AI 탐지', 'detail': ''}]}),
    ('tmpl', {**TM, 'rules': []}), ('tmpl', {**TM, 'mods': [TM['mods'][0]] * 7}), ('tmpl', {**TM, 'mods': [{'type': '사진'}]}),
    ('mission', MI), ('mission', {**MI, 'wps': [{**WP, 'mods': ['사진'] * 4}]}), ('mission', {**MI, 'wps': [WP] * 31}),
    ('mission', {**MI, 'wps': [{**WP, 'x': False}]}), ('mission', {**MI, 'wps': [{**WP, 'x': '1'}]}),
    ('run', RUN), ('run', {**RUN, 'wps': [{**RW, 'chk': '맞음'}]}), ('run', {**RUN, 'mode': '자동'}), ('run', {**RUN, 'status': '진행'}),
    ('run', {**RUN, 'wps': [{**RW, 'photos': ['media/photos/20261013/a.jpg'] * 11}]}), ('run', {**RUN, 'wps': [{**RW, 'st': 'x'}]}),
    ('run', {k: v for k, v in RUN.items() if k != 'memo'}), ('run', {**RUN, 'memo': 'x' * 401}),
]


@pytest.mark.parametrize('kind,doc', CASES)
def test_doc_body_matches_v2_link(kind, doc):
    want = L.doc_check(L.DOC_KINDS[kind], doc) is None
    assert (C.check_doc(kind, doc) is None) == want, (kind, doc, C.check_doc(kind, doc))


def test_doc_error_names_path():
    assert C.check_doc('zone', {**Z, 'pts': [[0, 0], [1, nan], [1, 1]]}).startswith('doc.pts[1][1]:')


def test_kind_sets_match():
    assert set(C.DOC_KINDS) == set(L.DOC_KINDS) and (C.DOC_MAX, C.DOC_TOTAL) == (L.DOC_MAX, L.DOC_TOTAL)
    for k, spec in L.DOC_KINDS.items():
        assert set(C.DOC_KINDS[k].model_fields) == set(spec), k


CMDS = [{'fx': 1, 'fy': 0, 'fw': -1}, {'fx': 0.0, 'fy': 0.0, 'fw': 0.0}, {'fx': nan, 'fy': 0, 'fw': 0}, {'fx': inf, 'fy': 0, 'fw': 0},
        {'fx': True, 'fy': 0, 'fw': 0}, {'fx': '1', 'fy': 0, 'fw': 0}, {'fx': 1.5, 'fy': 0, 'fw': 0}, {'fx': 1, 'fy': 0},
        {'fx': None, 'fy': 0, 'fw': 0}, {'fx': -1, 'fy': 1, 'fw': 0, 'future': 'x'}]


@pytest.mark.parametrize('m', CMDS)
def test_cmd_matches_valid_axes(m):
    ok = True
    try:
        TypeAdapter(C.ClientOp).validate_python({'op': 'cmd', **m})
    except ValidationError:
        ok = False
    assert ok == (L.valid_axes(m) is not None), m


def test_client_ops_match_gate():
    import v2_gate as G
    ops = set()
    for M in (C.OpSimple, C.OpCmd, C.OpRid, C.OpMapGet, C.OpMapStart, C.OpViewGet):
        ops |= set(M.model_fields['op'].annotation.__args__)
    assert ops == G.OPS
    for op in G.OPS:                                   # 미래 필드가 있어도 기존 op 를 거부하지 않는다
        m = {'op': op, 'v': 'fh-app/2', 'rid': 1, **({'fx': 0, 'fy': 0, 'fw': 0} if op == 'cmd' else {}),
             **({'building_id': 'v5', 'floor_id': 'l1', 'map_version': 'gt-20261012'} if op in ('map_get', 'height_get') else {}),
             **({'world_id': 'rooms_a', 'floor_id': 'f1', 'mode': 'slam'} if op == 'map_start' else {}),
             **({'what': 'points'} if op == 'view_get' else {})}
        TypeAdapter(C.ClientOp).validate_python(m)


def _dict_keys(fn_name, var=None):
    """v2_link.py 안 함수의 return dict(또는 var= 대입 dict) 키 — 계약과 실제 코드의 이름 drift 검사용"""
    for node in ast.walk(ast.parse(SRC)):
        if isinstance(node, ast.FunctionDef) and node.name == fn_name:
            for n in ast.walk(node):
                d = (n.value if isinstance(n, ast.Return) and var is None else
                     n.value if isinstance(n, ast.Assign) and var and getattr(n.targets[0], 'id', None) == var else None)
                if isinstance(d, ast.Dict) and all(isinstance(k, ast.Constant) for k in d.keys):
                    return {k.value for k in d.keys}
    raise AssertionError(fn_name)


def test_status_fields_match_snapshot():
    assert set(C.Status.model_fields) == _dict_keys('snapshot')
    assert set(C.SimStartState.model_fields) == _dict_keys('state')


def test_photo_meta_fields_match_take_photo():
    keys = _dict_keys('take_photo', 'meta') | {'saved_at', 'bytes', 'url'}       # Media.photo 가 붙이는 3개
    assert set(C.PhotoMeta.model_fields) == keys


def test_sim_state_is_clean_state_output():
    raw = {'schema': L.SCHEMA, 'episode': 2, 'stop_requested': False, 'reset_in_progress': False, 'policy_running': True,
           'x': 1.5, 'yaw': nan, 'fallen': 'yes', 'cmd_applied': [0.6, 0, 0], 'source': 'gt'}
    d = L.clean_state(raw)
    s = C.SimState.model_validate(d)
    assert s.yaw is None and s.fallen is None and s.x == 1.5 and set(C.SimState.model_fields) == set(d)
    with pytest.raises(ValidationError):                # 관문값은 null 이 될 수 없다
        C.SimState.model_validate({**d, 'episode': True})


def _status(**kw):
    return {'op': 'status', 'role': 'view', 'latch': True, 'applied': [0.0, 0.0, 0.0], 'reason': '', 'sim_block': '시뮬 상태 미수신',
            'resume_pending': False, 'reset_pending': False, 'episode': None, 'ros_domain': '61', 'state_age': None, 'cam_age': None,
            'sim': None, 'events': [{'t': '01:02:03', 'st': 'warn', 'text': 'x'}], 'note': L.PRESETS_NOTE, 'me': '이 PC(127.0.0.1)',
            'holder': None, 'ver': 'abc', 'sim_start': {'ok': False, 'why': 'RL 래퍼 미설정', 'busy': False, 'session': None}, 'docs_rev': 0, **kw}


def test_server_msgs_tolerate_future_fields_but_not_wrong_types():
    ad = TypeAdapter(C.ServerMsg)
    assert isinstance(ad.validate_json(json.dumps(_status(future={'a': 1}))), C.Status)
    for bad in [{'latch': 1}, {'applied': [0, 0]}, {'docs_rev': True}, {'state_age': nan}]:
        with pytest.raises(ValidationError):
            ad.validate_python(_status(**bad))
    r = ad.validate_python({'op': 'reply', 'rid': None, 'ok': False, 'text': '사진 실패'})
    assert isinstance(r, C.Reply) and r.photo is None


def test_real_photo_meta_round_trip(tmp_path):
    meta = {'frame_at': '2026-10-13T10:00:00.000+0900', 'frame_stamp_sim_s': 12.5, 'episode': 3, 'by': 'A', 'source': 'gt', 'x': 1.0,
            'y': None, 'yaw': 0.1, 'gt_note': '…', 'gt_age_s': 0.05, 'camera': 'Gazebo 렌더(실카메라 아님)'}
    out = L.Media(tmp_path).photo(b'\xff\xd8x', meta)
    C.PhotoMeta.model_validate(out)
    C.MediaList.model_validate({'photos': [out], 'events': [], 'ver': 'x'})


def test_doc_envelopes_from_real_docs(tmp_path):
    d = L.Docs(tmp_path)
    for kind, doc in [('zone', Z), ('note', N), ('tmpl', TM), ('mission', MI), ('run', RUN)]:
        c, r = d.apply({'op': 'put', 'kind': kind, 'id': None, 'doc': doc}, 'A · 휴대폰'); assert c == 200, r
    lst = C.DocsList.model_validate({'docs': list(d.d.values()), 'rev': d.rev, 'broken': None})
    assert [x.kind for x in lst.docs] == ['zone', 'note', 'tmpl', 'mission', 'run']
    zid = next(k for k, x in d.d.items() if x['kind'] == 'zone')
    c, r = d.apply({'op': 'put', 'id': zid, 'rev': 9, 'doc': Z}, 'B'); assert c == 409
    assert C.ApiError.model_validate(r).cur.id == zid
    TypeAdapter(C.DocWrite).validate_python({'op': 'del', 'id': zid, 'rev': 1})


def test_generated_files_reproducible():
    r = subprocess.run([sys.executable, str(ROOT / 'tools' / 'generate_contracts.py'), '--check'], capture_output=True, text=True)
    assert r.returncode == 0, r.stdout + r.stderr


TSC = os.environ.get('FH_TSC') or shutil.which('tsc')


@pytest.mark.skipif(not TSC, reason='tsc 없음 — FH_TSC=<tsc 경로> 로 지정하면 생성 TS 를 실제 표본으로 타입 검사')
def test_generated_ts_typechecks(tmp_path):
    (tmp_path / 'index.ts').write_text((ROOT / 'contracts/v1/ts/index.ts').read_text(encoding='utf-8'), encoding='utf-8')
    (tmp_path / 'use.ts').write_text(
        "import type { ServerMsg, DocWrite, ClientOp } from './index';\n"
        f"const s: ServerMsg = {json.dumps(_status(), ensure_ascii=False)};\n"
        f"const w: DocWrite = {json.dumps({'op': 'put', 'kind': 'zone', 'id': None, 'doc': Z}, ensure_ascii=False)};\n"
        "const c: ClientOp = { op: 'cmd', fx: 1, fy: 0, fw: 0 };\n"
        "// @ts-expect-error 존재하지 않는 op\nconst bad: ClientOp = { op: 'drive' };\n"
        "export { s, w, c, bad };\n", encoding='utf-8')
    r = subprocess.run([TSC, '--noEmit', '--strict', '--target', 'es2022', '--moduleResolution', 'bundler', '--module', 'esnext',
                        str(tmp_path / 'use.ts')], capture_output=True, text=True)
    assert r.returncode == 0, r.stdout + r.stderr
