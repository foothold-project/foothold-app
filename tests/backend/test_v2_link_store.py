"""v2_link --store sqlite 가 옛 docs.json 과 HTTP 바이트가 같은지(서버가 만드는 id·시각만 정규화).
tornado 의 finish(dict) = json.dumps(v).replace('</', '<\\/') 로 같은 인코딩을 쓴다."""
import json, re, shutil, sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT)); sys.path.insert(0, str(ROOT / 'sim'))
import v2_link as L  # noqa: E402
from server import store as S  # noqa: E402
from contracts.v1 import models as C  # noqa: E402

Z = {'name': '금지1', 'type': '금지', 'pts': [[0, 0], [1.5, 0], [1, 1]]}
N = {'photo': 'media/photos/20261013/a.jpg', 'cls': '확인', 'memo': '</script>'}
RW = {'x': 1, 'y': 2.25, 'name': '계단', 'mods': ['사진'], 'st': '대기', 'at': '', 'why': '', 'chk': '', 'photos': []}
GO = {'mode': '수동', 'mission': 'm1', 'tmpl': 't', 'name': 'm', 'status': '진행', 'started': 't', 'ended': '', 'memo': '', 'wps': [RW]}


def enc(v):
    return json.dumps(v).replace('</', '<\\/')


def steps():
    """'$k' = k 번째로 새로 만든 문서 id(이번 순서 안에서), '$L0' = 이전 자료의 0번째 문서 id."""
    return [
        {'op': 'put', 'kind': 'zone', 'id': None, 'doc': Z},
        {'op': 'put', 'id': '$0', 'rev': 1, 'doc': {**Z, 'name': '금지2'}},
        {'op': 'put', 'id': '$0', 'rev': 1, 'doc': {**Z, 'name': '늦음'}},
        {'op': 'put', 'id': '$0', 'rev': 2, 'doc': {**Z, 'extra': 1}},
        {'op': 'put', 'id': '$0', 'rev': 2, 'doc': {**Z, 'pts': [[0, 0], [1, float('nan')], [1, 1]]}},
        {'op': 'put', 'id': '$0', 'rev': 2, 'doc': {**Z, 'pts': [[0, 0], [True, 0], [1, 1]]}},
        {'op': 'put', 'kind': 'evil', 'id': None, 'doc': {}}, {'op': 'put', 'kind': ['zone'], 'id': None, 'doc': Z},
        {'op': 'put', 'id': 'nope1', 'rev': 1, 'doc': Z}, {'op': 'put', 'id': 'X', 'rev': 1, 'doc': Z},
        {'op': 'put', 'id': '$0', 'rev': True, 'doc': Z}, {'op': 'put', 'id': '$0', 'rev': 2.0, 'doc': Z},
        {'op': 'nope'}, [1], 'str', None, {'op': 'del', 'id': None}, {'op': 'del', 'id': None, 'kind': 'zone'},
        {'op': 'put', 'kind': 'note', 'id': None, 'doc': {**N, 'photo': 'javascript:x'}},
        {'op': 'put', 'kind': 'note', 'id': None, 'doc': {**N, 'photo': 'media/photos/20261013/b.jpg'}},   # 이전 자료와 같은 사진 → 409
        {'op': 'put', 'kind': 'note', 'id': None, 'doc': N},
        {'op': 'put', 'kind': 'note', 'id': None, 'doc': {**N, 'cls': '보류'}},
        {'op': 'put', 'kind': 'run', 'id': None, 'doc': GO},                                     # 이전 자료에 진행 run → 409
        {'op': 'put', 'id': '$L1', 'rev': 1, 'doc': {**GO, 'status': '완료'}},
        {'op': 'put', 'kind': 'run', 'id': None, 'doc': GO},
        {'op': 'put', 'kind': 'run', 'id': None, 'doc': GO},
        {'op': 'put', 'kind': 'mission', 'id': None, 'doc': {'name': 'm', 'tmpl': '', 'memo': 'x' * 400, 'wps': [{k: RW[k] for k in ('x', 'y', 'name', 'mods')}] * 30}},
        {'op': 'put', 'kind': 'tmpl', 'id': None, 'doc': {'name': 't', 'desc': '', 'mods': [{'type': '가스 측정', 'detail': ''}]}},
        {'op': 'del', 'id': '$0', 'rev': 1}, {'op': 'del', 'id': '$0', 'rev': 2}, {'op': 'del', 'id': '$0', 'rev': 2},
        {'op': 'del', 'id': '$L0', 'rev': 1},
        {'op': 'put', 'kind': 'zone', 'id': None, 'doc': {**Z, 'name': '다시'}},
    ]


def legacy(d):
    d.mkdir()
    old = L.Docs(d)
    for kind, doc in [('zone', {**Z, 'name': '이전'}), ('run', GO), ('note', {**N, 'photo': 'media/photos/20261013/b.jpg'})]:
        assert old.apply({'op': 'put', 'kind': kind, 'id': None, 'doc': doc}, '운영자 · 휴대폰')[0] == 200
    return [x['id'] for x in old.d.values()]


def play(docs, legacy_ids):
    """각 단계의 (응답 바이트, 목록 바이트, docs_rev) — id·at 정규화."""
    ids, out = {}, []
    names = {f'"{v}"': f'"L{i}"' for i, v in enumerate(legacy_ids)}
    for i, m in enumerate(steps()):
        if isinstance(m, dict) and isinstance(m.get('id'), str) and m['id'].startswith('$'):
            k = m['id'][1:]
            m = {**m, 'id': legacy_ids[int(k[1:])] if k.startswith('L') else ids[int(k)]}
        with docs.lock:
            code, r = docs.apply(m, '운영자 B · 휴대폰')
        if code == 200 and r.get('new'):
            names[f'"{r["id"]}"'] = f'"N{len(ids)}"'; ids[len(ids)] = r['id']
        out.append((code, enc(r), enc(docs.listing()), docs.rev))
    norm = []
    for code, a, b, rv in out:
        for k in sorted(names, key=len, reverse=True):
            a, b = a.replace(k, names[k]), b.replace(k, names[k])
        at = re.compile(r'"at": "\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d{4}"')
        norm.append((code, at.sub('"at": "T"', a), at.sub('"at": "T"', b), rv))
    return norm


def test_sqlite_store_is_byte_identical_to_docs_json(tmp_path):
    lids = legacy(tmp_path / 'src')
    a_dir, b_dir = tmp_path / 'a', tmp_path / 'b'
    shutil.copytree(tmp_path / 'src', a_dir); shutil.copytree(tmp_path / 'src', b_dir)
    raw = (b_dir / 'docs.json').read_bytes()
    old, note_a = L.open_docs('json', a_dir)
    new, note_b = L.open_docs(f'sqlite:{tmp_path / "docs.sqlite"}', b_dir)
    assert isinstance(old, L.Docs) and isinstance(new, S.Store) and note_a == note_b == ''
    # v2_link Docs 의 id = 종류+초+pid+n(n 은 열 때마다 0부터) — 같은 초·같은 pid 로 다시 열면 기존 id 를 다시 만들어 그 문서를 덮는다.
    # 시험에서만 생기는 조건(실제 재시작은 초가 바뀜)이라 옛 쪽 카운터를 비켜 둔다. Store 는 무작위 꼬리 + PK 충돌 시 예외라 덮지 않는다
    old.n = 1000
    assert enc(old.listing()) == enc(new.listing()) and old.rev == new.rev           # 이전 직후(재시작한 옛 서버와 같음)
    ra, rb = play(old, lids), play(new, lids)
    assert len(ra) == len(steps())
    for i, (x, y) in enumerate(zip(ra, rb)):
        assert x == y, (i, steps()[i], x, y)
    assert {c for c, *_ in ra} == {200, 400, 404, 409}
    assert (b_dir / 'docs.json').read_bytes() == raw                                  # 원본은 읽기만
    C.DocsList.model_validate(new.listing())


def test_migration_failure_falls_back_to_docs_json(tmp_path):
    d = tmp_path / 'm'; legacy(d)
    j = json.loads((d / 'docs.json').read_text())
    n = next(x for x in j.values() if x['kind'] == 'note'); j['n2x'] = {**n, 'id': 'n2x'}        # 같은 사진에 분류 둘
    (d / 'docs.json').write_text(json.dumps(j, ensure_ascii=False)); raw = (d / 'docs.json').read_bytes()
    docs, note = L.open_docs(f'sqlite:{tmp_path / "x.sqlite"}', d)
    assert isinstance(docs, L.Docs) and not docs.broken and note.startswith('SQLite 이전 실패')
    assert not (tmp_path / 'x.sqlite').exists() and (d / 'docs.json').read_bytes() == raw


def test_existing_db_is_used_not_remigrated(tmp_path):
    d = tmp_path / 'e'; legacy(d)
    db = tmp_path / 'e.sqlite'
    s, _ = L.open_docs(f'sqlite:{db}', d)
    _, r = s.apply({'op': 'put', 'kind': 'zone', 'id': None, 'doc': Z}, 'A')
    s2, note = L.open_docs(f'sqlite:{db}', d)                     # 재시작: docs.json 을 다시 읽지 않는다
    assert note == '' and r['id'] in [x['id'] for x in s2.listing()['docs']] and s2.rev == s.rev
    assert len(list(tmp_path.glob('e.sqlite.work-*'))) == 1


@pytest.mark.parametrize('spec', ['sqlite:', 'sqlite', 'yaml:x', ''])
def test_bad_store_spec_refuses_to_start(tmp_path, spec):
    with pytest.raises(SystemExit):
        L.open_docs(spec, tmp_path)


def test_store_constants_match():
    assert set(S.DOC_KINDS) == set(L.DOC_KINDS) == set(C.DOC_KINDS)
    assert (S.DOC_MAX, S.DOC_TOTAL) == (L.DOC_MAX, L.DOC_TOTAL) == (C.DOC_MAX, C.DOC_TOTAL)


# 10-15 프리셋 1단계: 옛 문서(map 없음)와 새 문서(map·mrev)가 섞인 저장소가 json·sqlite 둘 다 기동되고, 옛 앱 재저장(map 빠짐)은 그대로 받는다
MS = {'src': 'gt', 'world_id': 'v5_building', 'floor_id': 'l1', 'key': '0a1b2c3d'}
WP0 = {'x': 1, 'y': 2.25, 'name': '계단', 'mods': ['사진']}


@pytest.mark.parametrize('kind', ['json', 'sqlite'])
def test_mixed_old_new_mission_docs_load(tmp_path, kind):
    d = tmp_path / 'm'; d.mkdir(); env = lambda i, k, doc: {'id': i, 'kind': k, 'rev': 1, 'by': 'A', 'at': 't', 'doc': doc}
    old = {'name': '옛', 'tmpl': '', 'memo': '', 'wps': [WP0]}
    (d / 'docs.json').write_text(json.dumps({'m1': env('m1', 'mission', old), 'm2': env('m2', 'mission', {**old, 'name': '새', 'map': MS}),
                                             'r1': env('r1', 'run', {**GO, 'status': '중단', 'mrev': 1, 'map': MS})}, ensure_ascii=False), encoding='utf-8')
    s, note = (L.Docs(d), '') if kind == 'json' else L.open_docs(f'sqlite:{tmp_path / "m.sqlite"}', d)
    assert note == '' and s.listing()['broken'] is None and len(s.listing()['docs']) == 3
    c, r = s.apply({'op': 'put', 'id': 'm2', 'rev': 1, 'doc': {**old, 'name': '옛 앱 재저장'}}, 'B')   # 옛 앱: map 을 모름 → 빠진 채 저장(서버가 채우지 않음 = 미확인)
    assert c == 200 and 'map' not in {x['id']: x for x in s.listing()['docs']}['m2']['doc']
    assert s.apply({'op': 'put', 'kind': 'mission', 'id': None, 'doc': {**old, 'map': None}}, 'B')[0] == 400
