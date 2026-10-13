"""SQLite 저장소·마이그레이션·FastAPI 어댑터 시험. ROS·공개 포트 없음, 임시 폴더만."""
import json, multiprocessing as mp, sqlite3, sys
from pathlib import Path
from urllib.parse import quote

import pytest
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT)); sys.path.insert(0, str(ROOT / 'sim'))
import v2_link as L  # noqa: E402
from contracts.v1 import models as C  # noqa: E402
from server import migrate  # noqa: E402
from server.api import actor_from_header, create_app  # noqa: E402
from server.store import Store  # noqa: E402

Z = {'name': '금지1', 'type': '금지', 'pts': [[0, 0], [1, 0], [1, 1]]}
N = {'photo': 'media/photos/20261013/a.jpg', 'cls': '확인', 'memo': ''}
WP = {'x': 1, 'y': 2, 'name': '계단 앞', 'mods': ['사진']}
RW = {**WP, 'st': '대기', 'at': '', 'why': '', 'chk': '', 'photos': []}
GO = {'mode': '수동', 'mission': 'm1', 'tmpl': 't', 'name': 'm', 'status': '진행', 'started': 't', 'ended': '', 'memo': '', 'wps': [RW]}
ORIGIN = 'http://127.0.0.1:8790'


# ---------------------------------------------------------------- v2_link Docs 와 같은 결과(코드·응답 키·rev)

def script():
    """(요청, 참조) — 참조 '$0' 은 0번째 200 응답의 id 로 바꾼다(두 저장소의 id 가 달라서)."""
    return [
        ({'op': 'put', 'kind': 'zone', 'id': None, 'doc': Z}, None),
        ({'op': 'put', 'id': '$0', 'rev': 1, 'doc': {**Z, 'name': '금지2'}}, None),
        ({'op': 'put', 'id': '$0', 'rev': 1, 'doc': {**Z, 'name': '늦음'}}, None),        # 409 cur
        ({'op': 'put', 'id': '$0', 'rev': 2, 'doc': {**Z, 'extra': 1}}, None),            # 400
        ({'op': 'put', 'kind': 'evil', 'id': None, 'doc': {}}, None),
        ({'op': 'put', 'id': 'nope1', 'rev': 1, 'doc': Z}, None),                         # 404
        ({'op': 'put', 'id': 'X', 'rev': 1, 'doc': Z}, None),                             # id 형식
        ({'op': 'put', 'id': '$0', 'rev': True, 'doc': Z}, None),
        ({'op': 'nope'}, None), ([1], None), ({'op': 'del', 'id': None}, None),
        ({'op': 'put', 'kind': 'note', 'id': None, 'doc': N}, None),
        ({'op': 'put', 'kind': 'note', 'id': None, 'doc': {**N, 'cls': '보류'}}, None),   # 409 같은 사진
        ({'op': 'put', 'kind': 'run', 'id': None, 'doc': GO}, None),
        ({'op': 'put', 'kind': 'run', 'id': None, 'doc': GO}, None),                     # 409 진행 둘
        ({'op': 'put', 'id': '$13', 'rev': 1, 'doc': {**GO, 'memo': '자기 수정'}}, None),
        ({'op': 'put', 'id': '$13', 'rev': 2, 'doc': {**GO, 'status': '완료'}}, None),
        ({'op': 'put', 'kind': 'run', 'id': None, 'doc': GO}, None),
        ({'op': 'put', 'kind': 'zone', 'id': None, 'doc': {**Z, 'name': 'x' * 41}}, None),
        ({'op': 'del', 'id': '$0', 'rev': 1}, None),                                    # 409
        ({'op': 'del', 'id': '$0', 'rev': 2}, None),
        ({'op': 'del', 'id': '$0', 'rev': 2}, None),                                    # 404
        ({'op': 'put', 'kind': 'tmpl', 'id': None, 'doc': {'name': 'big', 'desc': '', 'mods': []}}, None),
    ]


def run_script(apply):
    ids, out = {}, []
    for i, (m, _) in enumerate(script()):
        if isinstance(m, dict) and isinstance(m.get('id'), str) and m['id'].startswith('$'):
            m = {**m, 'id': ids[int(m['id'][1:])]}
        code, r = apply(m)
        if code == 200 and 'rev' in r and r.get('new'):
            ids[i] = r['id']
        shape = {k: v for k, v in r.items() if k not in ('id', 'cur')}
        if 'cur' in r:
            shape['cur'] = {k: v for k, v in r['cur'].items() if k not in ('id', 'at')}
        out.append((code, shape))
    return out


def test_apply_matches_v2_link(tmp_path):
    (tmp_path / 'a').mkdir(); a = L.Docs(tmp_path / 'a')
    b = Store(tmp_path / 'b.sqlite')
    ra, rb = run_script(lambda m: a.apply(m, 'A')), run_script(lambda m: b.apply(m, 'A'))
    assert [c for c, _ in ra] == [c for c, _ in rb]
    for (ca, sa), (cb, sb) in zip(ra, rb):
        if ca == 200 or 'cur' in sa:            # 성공·충돌은 응답 내용까지, 400 은 코드만(이유 글은 pydantic 기반이라 다를 수 있음)
            assert sa == sb
    assert [x['doc'] for x in a.d.values()] == [x['doc'] for x in b.listing()['docs']]
    assert a.rev == b.listing()['rev']
    C.DocsList.model_validate(b.listing())


# ---------------------------------------------------------------- 동시성: 다른 프로세스·스레드가 같은 순간에

def _worker(db, doc, q, barrier):
    s = Store(db)
    barrier.wait()
    q.put(s.apply({'op': 'put', 'kind': doc[0], 'id': None, 'doc': doc[1]}, 'P')[0])


@pytest.mark.parametrize('doc', [('note', N), ('run', GO)])
def test_one_only_across_processes(tmp_path, doc):
    db = tmp_path / 'c.sqlite'; Store(db)
    ctx = mp.get_context('spawn'); q = ctx.Queue(); n = 8; bar = ctx.Barrier(n)
    ps = [ctx.Process(target=_worker, args=(db, doc, q, bar)) for _ in range(n)]
    [p.start() for p in ps]; [p.join(60) for p in ps]
    codes = sorted(q.get(timeout=5) for _ in range(n))
    assert codes == [200] + [409] * (n - 1), codes
    s = Store(db); assert len(s.listing()['docs']) == 1 and s.rev() == 1


def test_parallel_edits_same_rev_one_wins(tmp_path):
    from concurrent.futures import ThreadPoolExecutor
    s = Store(tmp_path / 'e.sqlite'); _, r = s.apply({'op': 'put', 'kind': 'zone', 'id': None, 'doc': Z}, 'A')
    with ThreadPoolExecutor(8) as ex:
        codes = sorted(ex.map(lambda i: Store(s.path).apply({'op': 'put', 'id': r['id'], 'rev': 1, 'doc': {**Z, 'name': f'n{i}'}}, f'D{i}')[0], range(8)))
    assert codes == [200] + [409] * 7
    d = s.listing()['docs'][0]; assert d['rev'] == 2 and s.rev() == 2


def test_db_constraint_is_the_backstop(tmp_path, monkeypatch):
    """앱 검사를 끄면(다른 프로세스 경합 흉내) DB 부분 UNIQUE 가 둘째를 막고 409 + cur."""
    s = Store(tmp_path / 'u.sqlite')
    assert s.apply({'op': 'put', 'kind': 'note', 'id': None, 'doc': N}, 'A')[0] == 200
    real = Store._dup
    calls = []
    monkeypatch.setattr(Store, '_dup', staticmethod(lambda c, m, did, doc: calls.append(1) if len(calls) == 0 else real(c, m, did, doc)))
    code, r = s.apply({'op': 'put', 'kind': 'note', 'id': None, 'doc': {**N, 'cls': '보류'}}, 'B')
    assert code == 409 and r['cur']['doc']['cls'] == '확인' and len(s.listing()['docs']) == 1 and s.rev() == 1


# ---------------------------------------------------------------- 실패·손상·재시작

def test_write_failure_rolls_back(tmp_path, monkeypatch):
    s = Store(tmp_path / 'f.sqlite'); _, r = s.apply({'op': 'put', 'kind': 'zone', 'id': None, 'doc': Z}, 'A')
    before = (s.listing(), (tmp_path / 'f.sqlite').read_bytes())

    def boom(c):
        raise sqlite3.OperationalError('disk I/O error')
    monkeypatch.setattr(Store, '_bump', staticmethod(boom))       # 문서 행을 쓴 «뒤»에 실패
    for m in [{'op': 'put', 'kind': 'zone', 'id': None, 'doc': Z}, {'op': 'put', 'id': r['id'], 'rev': 1, 'doc': {**Z, 'name': 'x'}},
              {'op': 'del', 'id': r['id'], 'rev': 1}]:
        with pytest.raises(sqlite3.OperationalError):
            s.apply(m, 'A')
        assert s.listing() == before[0]
    client = TestClient(create_app(s, {ORIGIN}))
    res = client.post('/api/docs', content=json.dumps({'op': 'put', 'kind': 'zone', 'id': None, 'doc': Z}), headers={'Origin': ORIGIN})
    assert res.status_code == 500 and '이전 상태 그대로' in res.json()['error'] and s.listing() == before[0]


def test_rev_survives_restart_and_never_goes_back(tmp_path):
    p = tmp_path / 'r.sqlite'; s = Store(p)
    _, a = s.apply({'op': 'put', 'kind': 'zone', 'id': None, 'doc': Z}, 'A')
    s.apply({'op': 'put', 'id': a['id'], 'rev': 1, 'doc': {**Z, 'name': 'b'}}, 'A')
    s.apply({'op': 'del', 'id': a['id'], 'rev': 2}, 'A')
    assert Store(p).rev() == 3                   # docs.json 이었다면 재시작 뒤 rev 합 = 0 으로 되돌아감
    _, b = Store(p).apply({'op': 'put', 'kind': 'zone', 'id': None, 'doc': Z}, 'A')
    assert Store(p).rev() == 4 and Store(p).listing()['docs'][0]['id'] == b['id']


@pytest.mark.parametrize('junk', [b'not a database at all' * 100, b''])
def test_corrupt_file_is_untouched_and_503(tmp_path, junk):
    p = tmp_path / 'x.sqlite'; p.write_bytes(junk)
    s = Store(p)                                 # 빈 파일 = 빈 sqlite → 스키마 판 없음 → 역시 사용 불가
    assert s.broken and s.apply({'op': 'put', 'kind': 'zone', 'id': None, 'doc': Z}, 'A')[0] == 503
    assert p.read_bytes() == junk and s.listing() == {'docs': [], 'rev': 0, 'broken': s.broken}


def test_future_schema_version_refused(tmp_path):
    p = tmp_path / 'v.sqlite'; Store(p)
    c = sqlite3.connect(p); c.execute("UPDATE meta SET value=2 WHERE key='schema_version'"); c.commit(); c.close()
    raw = p.read_bytes()
    s = Store(p); assert s.broken and '스키마 판 2' in s.broken and s.apply({'op': 'del', 'id': 'z1', 'rev': 1}, 'A')[0] == 503
    assert p.read_bytes() == raw


# ---------------------------------------------------------------- 마이그레이션: 실제 v2_link 가 만든 자료로

def legacy(tmp_path):
    src = tmp_path / 'legacy'; src.mkdir()
    d = L.Docs(src); md = L.Media(src)
    for kind, doc in [('zone', Z), ('note', N), ('run', GO), ('tmpl', {'name': 't', 'desc': '', 'mods': []})]:
        assert d.apply({'op': 'put', 'kind': kind, 'id': None, 'doc': doc}, '운영자 · 휴대폰')[0] == 200
    zid = next(k for k, x in d.d.items() if x['kind'] == 'zone')
    assert d.apply({'op': 'put', 'id': zid, 'rev': 1, 'doc': {**Z, 'name': '고침'}}, 'B')[0] == 200
    md.photo(b'\xff\xd8a', {'episode': 3, 'x': 1.0}); md.photo(b'\xff\xd8b', {'episode': None})
    md.event({'t': '01:02:03', 'st': 'ok', 'text': 'a'})
    with open(src / 'events.jsonl', 'a') as f:
        f.write('깨진 줄\n')
    md.event({'t': '01:02:04', 'st': 'warn', 'text': 'b'})
    return src, d


def snap(src):
    return {p.name: p.read_bytes() for p in sorted(src.rglob('*')) if p.is_file()}


def test_migrate_import_verify_continue_export_rollback(tmp_path, capsys):
    src, d = legacy(tmp_path); before = snap(src)
    out = tmp_path / 'docs.sqlite'
    assert migrate.main(['import', '--src', str(src), '--out', str(out)]) == 0
    man = json.loads(capsys.readouterr().out)
    assert man['docs'] == 4 and man['photos'] == 2 and man['events'] == 2 and man['events_skipped_lines'] == 1
    assert snap(src) == before                                     # 원본(사진 JPEG 포함) 그대로
    s = Store(out)
    assert s.listing()['docs'] == list(d.d.values()) and s.rev() == d.rev
    ph, ev = s.media()
    assert ph == L.Media(src).tail('photos.jsonl', 200)[::-1] and ev == L.Media(src).tail('events.jsonl', 300)[::-1]
    assert migrate.main(['verify', '--src', str(src), '--db', str(out)]) == 0
    # 새 DB 로 계속 쓴 뒤 → export → v2_link Docs 가 그대로 읽는다(rollback 경로)
    _, r = s.apply({'op': 'put', 'kind': 'zone', 'id': None, 'doc': {**Z, 'name': '이후'}}, 'C')
    assert migrate.main(['verify', '--src', str(src), '--db', str(out)]) == 1   # 이제 원본과 다름(정상)
    back = tmp_path / 'back'; back.mkdir()
    assert migrate.main(['export', '--db', str(out), '--out', str(back / 'docs.json')]) == 0
    old = L.Docs(back); assert not old.broken and list(old.d.values()) == s.listing()['docs'] and r['id'] in old.d
    # 덮어쓰기 거부
    assert migrate.main(['import', '--src', str(src), '--out', str(out)]) == 2
    assert migrate.main(['export', '--db', str(out), '--out', str(back / 'docs.json')]) == 2
    work = list(tmp_path.glob('docs.sqlite.work-*'))
    assert work and json.loads((work[0] / 'manifest.json').read_text())['result'] == 'ok'


@pytest.mark.parametrize('bad', ['{깨짐', '[1]', 'dupnote', 'tworuns', 'badrev'])
def test_migrate_refuses_bad_source_without_db(tmp_path, bad):
    src, d = legacy(tmp_path)
    j = json.loads((src / 'docs.json').read_text())
    if bad == 'dupnote':
        n = next(x for x in j.values() if x['kind'] == 'note'); j['n2x'] = {**n, 'id': 'n2x'}
    elif bad == 'tworuns':
        r = next(x for x in j.values() if x['kind'] == 'run'); j['r2x'] = {**r, 'id': 'r2x'}
    elif bad == 'badrev':
        next(iter(j.values()))['rev'] = True
    (src / 'docs.json').write_text(json.dumps(j, ensure_ascii=False) if bad in ('dupnote', 'tworuns', 'badrev') else bad)
    before = snap(src); out = tmp_path / 'n.sqlite'
    assert migrate.main(['import', '--src', str(src), '--out', str(out)]) == 2
    assert not out.exists() and snap(src) == before
    man = json.loads(next(tmp_path.glob('n.sqlite.work-*/manifest.json')).read_text())
    assert man['result'].startswith('failed')


# ---------------------------------------------------------------- FastAPI 어댑터(로컬 포트 없이 TestClient)

def test_api_contract(tmp_path):
    s = Store(tmp_path / 'api.sqlite'); evs = []
    c = TestClient(create_app(s, {ORIGIN}, on_event=evs.append, version=lambda: 'abc'))
    H = {'Origin': ORIGIN, 'X-FH-Actor': quote('운영자 B · 휴대폰')}
    put = {'op': 'put', 'kind': 'zone', 'id': None, 'doc': Z}
    assert c.post('/api/docs', content=json.dumps(put)).status_code == 403
    assert c.post('/api/docs', content=json.dumps(put), headers={'Origin': 'http://evil'}).status_code == 403
    assert c.post('/api/docs', content=b'{x', headers=H).json() == {'error': 'JSON 아님'}
    assert c.post('/api/docs', content=b' ' * (64 * 1024 + 1), headers=H).status_code == 400
    r = c.post('/api/docs', content=json.dumps(put), headers=H)
    assert r.status_code == 200 and r.headers['cache-control'] == 'no-store'
    ok = C.DocPutOk.model_validate(r.json()); assert evs == [f'구역 추가 · 금지1 · 운영자 B · 휴대폰']
    lst = C.DocsList.model_validate(c.get('/api/docs').json()); assert lst.docs[0].by == '운영자 B · 휴대폰'
    r = c.post('/api/docs', content=json.dumps({'op': 'put', 'id': ok.id, 'rev': 9, 'doc': Z}), headers=H)
    assert r.status_code == 409 and C.ApiError.model_validate(r.json()).cur.rev == 1
    r = c.post('/api/docs', content=json.dumps({'op': 'put', 'kind': 'zone', 'id': None, 'doc': {**Z, 'pts': [[0, 0], [1, float('nan')], [1, 1]]}}), headers=H)
    assert r.status_code == 400 and r.json()['error'].startswith('doc.pts[1][1]')
    r = c.post('/api/docs', content=json.dumps({'op': 'del', 'id': ok.id, 'rev': 1}), headers={'Origin': ORIGIN})
    assert r.status_code == 200 and C.DocDelOk.model_validate(r.json()) and evs[-1].endswith('· 이 PC(127.0.0.1)')
    s.add_photo({**{k: None for k in C.PhotoMeta.model_fields}, 'frame_at': 't', 'by': 'A', 'gt_note': '', 'gt_age_s': 0.1, 'camera': 'c',
                 'saved_at': 's', 'bytes': 3, 'url': 'media/photos/20261013/a.jpg'})
    s.add_event({'t': '01:02:03', 'st': 'ok', 'text': 'a', 'at': 'x'})
    m = C.MediaList.model_validate(c.get('/api/media').json()); assert m.ver == 'abc' and len(m.photos) == 1 and m.events[0].text == 'a'


def test_api_broken_store_is_503(tmp_path):
    p = tmp_path / 'b.sqlite'; p.write_bytes(b'junk' * 50)
    c = TestClient(create_app(Store(p), {ORIGIN}))
    assert c.get('/api/docs').json()['broken']
    assert c.post('/api/docs', content=json.dumps({'op': 'put', 'kind': 'zone', 'id': None, 'doc': Z}), headers={'Origin': ORIGIN}).status_code == 503


@pytest.mark.parametrize('v', ['', quote('tester · 휴대폰'), '%FF%FE', '휴대폰', quote('a\nb' + 'x' * 99), '%0A', 'plain'])
def test_actor_header_matches_v2_link(v):
    assert actor_from_header(v) == L.actor_from_header(v)
