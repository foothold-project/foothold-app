"""앱 Codex 1회 묶음 검수(85d08f7/47006b6) 1~5항 + 고정 mentor id 충돌 요청의 반례 시험. 임시 폴더·TestClient 만."""
import json, sqlite3

import pytest
from fastapi.testclient import TestClient

from test_store import N, ORIGIN, Z, legacy, snap        # 같은 폴더(기존 도우미 재사용)
from server import migrate
from server import store as S
from server.api import create_app


def good_db(tmp_path):
    p = tmp_path / 'g.sqlite'; s = S.Store(p)
    for kind, doc in [('zone', Z), ('note', N)]:
        assert s.apply({'op': 'put', 'kind': kind, 'id': None, 'doc': doc}, 'A')[0] == 200
    return p


# ---------------------------------------------------------------- 1) 열 때 의미 검사 + 조회 오류는 JSON

CORRUPT = {
    'meta_rev_없음': "DELETE FROM meta WHERE key='rev'",
    'meta_rev_글자': "UPDATE meta SET value='x' WHERE key='rev'",
    'meta_seq_음수': "UPDATE meta SET value=-1 WHERE key='seq'",
    'meta_rev_합보다_작음': "UPDATE meta SET value=0 WHERE key='rev'",
    '표_없음': 'DROP TABLE docs',
    '인덱스_없음': 'DROP INDEX one_active_run',
    'doc_빈객체': "UPDATE docs SET doc='{}' WHERE kind='zone'",
    'doc_배열': "UPDATE docs SET doc='[1]' WHERE kind='note'",
    'id_형식': "UPDATE docs SET id='Bad!' WHERE kind='zone'",
}


@pytest.mark.parametrize('sql', CORRUPT.values(), ids=CORRUPT.keys())
def test_valid_sqlite_with_bad_content_is_broken(tmp_path, sql):
    p = good_db(tmp_path)
    c = sqlite3.connect(p); c.execute(sql); c.commit(); c.close()
    raw = p.read_bytes()
    s = S.Store(p)
    assert s.broken and s.apply({'op': 'put', 'kind': 'zone', 'id': None, 'doc': Z}, 'A')[0] == 503
    with pytest.raises(S.Bad):
        s.db_rev()
    cl = TestClient(create_app(s, {ORIGIN}))
    r = cl.get('/api/docs')                            # 읽기는 200 + 빈 목록 + broken 글(v2_link 와 같음)
    assert r.status_code == 200 and r.json()['broken'] and r.json()['docs'] == []
    r = cl.get('/api/media')
    assert r.status_code == 503 and 'error' in r.json() and r.headers['cache-control'] == 'no-store'
    assert p.read_bytes() == raw                        # 원본 그대로


def test_runtime_read_error_is_json_500(tmp_path, monkeypatch):
    s = S.Store(good_db(tmp_path)); cl = TestClient(create_app(s, {ORIGIN}))

    def boom(self):
        raise sqlite3.OperationalError('disk I/O error')
    monkeypatch.setattr(S.Store, '_db', boom)
    for r in (cl.get('/api/docs'), cl.get('/api/media'),
              cl.post('/api/docs', json={'op': 'put', 'kind': 'zone', 'id': None, 'doc': Z}, headers={'Origin': ORIGIN})):
        assert r.status_code == 500 and 'error' in r.json() and r.headers['cache-control'] == 'no-store'


# ---------------------------------------------------------------- 2) 원본 폴더 검사

@pytest.mark.parametrize('case', ['없음', '파일', '빈폴더', 'docs가폴더', '봉투키추가'])
def test_import_refuses_bad_src_and_makes_nothing(tmp_path, case, capsys):
    src = tmp_path / 'src'
    if case == '파일':
        src.write_text('{}')
    elif case == '빈폴더':
        src.mkdir()
    elif case == 'docs가폴더':
        (src / 'docs.json').mkdir(parents=True)
    elif case == '봉투키추가':
        src, d = legacy(tmp_path)
        j = json.loads((src / 'docs.json').read_text()); next(iter(j.values()))['x'] = 1
        (src / 'docs.json').write_text(json.dumps(j, ensure_ascii=False))
    before = snap(src) if src.is_dir() else None
    out = tmp_path / 'o.sqlite'
    assert migrate.main(['import', '--src', str(src), '--out', str(out)]) == 2
    why = json.loads(capsys.readouterr().out)['why']
    assert ('형식' if case == '봉투키추가' else 'docs.json' if case in ('빈폴더', 'docs가폴더') else '폴더 아님') in why
    assert not out.exists() and (snap(src) if src.is_dir() else None) == before
    if case != '봉투키추가':                            # 폴더 검사 실패는 작업 폴더도 만들지 않는다
        assert not list(tmp_path.glob('o.sqlite.work-*'))
    if case in ('없음', '파일'):
        assert migrate.main(['verify', '--src', str(src), '--db', str(out)]) == 2


def test_empty_start_needs_explicit_flag(tmp_path, capsys):
    src = tmp_path / 'e'; src.mkdir(); out = tmp_path / 'e.sqlite'
    assert migrate.main(['import', '--src', str(src), '--out', str(out), '--allow-empty']) == 0
    assert S.Store(out).listing() == {'docs': [], 'rev': 0, 'broken': None}


# ---------------------------------------------------------------- 3) 확정 뒤 증거 분리 · export 임시 파일

def test_import_evidence_is_separate_from_live_db(tmp_path, capsys):
    src, _ = legacy(tmp_path); out = tmp_path / 'docs.sqlite'
    assert migrate.main(['import', '--src', str(src), '--out', str(out)]) == 0
    work = next(tmp_path.glob('docs.sqlite.work-*')); man = json.loads((work / 'manifest.json').read_text())
    snapf = work / 'snapshot.sqlite'
    assert not (work / 'new.sqlite').exists() and out.stat().st_nlink == 1
    assert migrate.sha(snapf) == man['snapshot_sha256'] == man['db_sha256']
    assert not [p for p in tmp_path.rglob('*') if p.name.endswith(('-wal', '-shm')) and 'work-' in str(p)]
    s = S.Store(out)
    assert s.apply({'op': 'put', 'kind': 'zone', 'id': None, 'doc': {**Z, 'name': '이후'}}, 'C')[0] == 200
    assert migrate.sha(snapf) == man['snapshot_sha256']           # 계속 써도 증거는 그대로


def test_export_does_not_touch_existing_temp_files(tmp_path, capsys):
    db = good_db(tmp_path); back = tmp_path / 'back'; back.mkdir()
    old = back / '.docs.json.tmp'; old.write_text('남의 임시 파일')          # 옛 고정 이름과 충돌
    assert migrate.main(['export', '--db', str(db), '--out', str(back / 'docs.json')]) == 0
    assert old.read_text() == '남의 임시 파일' and sorted(p.name for p in back.iterdir()) == ['.docs.json.tmp', 'docs.json']


# ---------------------------------------------------------------- 4) 사진 메타 중복 · JPEG 없음

def test_photo_duplicates_and_missing_jpeg(tmp_path, capsys):
    src, _ = legacy(tmp_path)
    lines = (src / 'photos.jsonl').read_text().splitlines()
    ghost = {**json.loads(lines[0]), 'url': 'media/photos/20261013/없음.jpg'}
    (src / 'photos.jsonl').write_text('\n'.join(lines + [lines[0], json.dumps(ghost, ensure_ascii=False)]) + '\n')
    before = snap(src); out = tmp_path / 'a.sqlite'
    assert migrate.main(['import', '--src', str(src), '--out', str(out)]) == 0
    man = json.loads(capsys.readouterr().out)
    assert man['photos_dup_identical'] == 1 and man['photos_missing_jpeg'] == 1 and man['photos'] == 3
    assert snap(src) == before                                     # 지우거나 고치지 않음
    bad = {**json.loads(lines[0]), 'episode': 99}                  # 같은 url, 다른 메타 → 거부
    (src / 'photos.jsonl').write_text('\n'.join(lines + [json.dumps(bad, ensure_ascii=False)]) + '\n')
    before = snap(src)
    assert migrate.main(['import', '--src', str(src), '--out', str(tmp_path / 'b.sqlite')]) == 2
    assert not (tmp_path / 'b.sqlite').exists() and snap(src) == before


# ---------------------------------------------------------------- 5) 본문 상한은 받은 바이트로

def test_body_cap_counts_received_bytes(tmp_path):
    s = S.Store(tmp_path / 'b.sqlite'); cl = TestClient(create_app(s, {ORIGIN}))
    ok = json.dumps({'op': 'put', 'kind': 'zone', 'id': None, 'doc': Z}).encode()
    big = b'{"op":"put","pad":"' + b'x' * (64 * 1024) + b'"}'

    def chunks(b):                                      # Content-Length 없이(chunked)
        yield from (b[i:i + 4096] for i in range(0, len(b), 4096))
    h = {'Origin': ORIGIN}
    for r in (cl.post('/api/docs', content=chunks(big), headers=h),
              cl.post('/api/docs', content=big, headers={**h, 'Content-Length': '10'}),    # 거짓 길이
              cl.post('/api/docs', content=ok, headers={**h, 'Content-Length': 'abc'})):
        assert r.status_code == 400 and '너무 큼' in r.json()['error']                  # 다른 이유의 400 이 아니라 상한
    assert cl.post('/api/docs', content=chunks(ok), headers=h).status_code == 200
    assert len(s.listing()['docs']) == 1


# ---------------------------------------------------------------- 고정 mentor ②: 새 id 충돌은 덮지 않고 다시 뽑는다

def test_new_id_collision_redraws(tmp_path, monkeypatch):
    s = S.Store(tmp_path / 'i.sqlite')
    tails = iter(['aaaaaaaa', 'aaaaaaaa', 'bbbbbbbb'])
    monkeypatch.setattr(S.secrets, 'token_hex', lambda n: next(tails))
    monkeypatch.setattr(S.time, 'strftime', lambda f, *a: '1013120000' if f == '%m%d%H%M%S' else '2026-10-13T12:00:00+0900')
    a = s.apply({'op': 'put', 'kind': 'zone', 'id': None, 'doc': Z}, 'A')[1]
    b = s.apply({'op': 'put', 'kind': 'zone', 'id': None, 'doc': {**Z, 'name': '둘째'}}, 'B')[1]
    assert (a['id'], b['id']) == ('z1013120000aaaaaaaa', 'z1013120000bbbbbbbb')
    assert [x['doc']['name'] for x in s.listing()['docs']] == ['금지1', '둘째']


# ---------------------------------------------------------------- d10edb6 검수: v2_link 경로는 pydantic 없이(doc_check 주입이 import·검증까지)

NO_PYDANTIC = r'''
import sys, json, shutil
from pathlib import Path
class Block:
    def find_spec(self, name, path=None, target=None):
        if name == 'pydantic' or name.startswith(('pydantic.', 'pydantic_core', 'contracts')):
            raise ImportError('차단: ' + name)
sys.meta_path.insert(0, Block())
root, tmp = Path(sys.argv[1]), Path(sys.argv[2])
sys.path[:0] = [str(root), str(root / 'sim')]
import v2_link as L
from server.store import Store
src = tmp / 'm'; src.mkdir()
d = L.Docs(src)
z = {'name': '금지1', 'type': '금지', 'pts': [[0, 0], [1, 0], [1, 1]]}
for kind, doc in [('zone', z), ('note', {'photo': 'media/photos/20261013/a.jpg', 'cls': '확인', 'memo': ''})]:
    assert d.apply({'op': 'put', 'kind': kind, 'id': None, 'doc': doc}, 'A')[0] == 200
raw = (src / 'docs.json').read_bytes()
s, note = L.open_docs(f'sqlite:{tmp / "m.sqlite"}', src)
assert isinstance(s, Store) and note == '' and not s.broken, (type(s), note, getattr(s, 'broken', None))
assert s.listing()['docs'] == list(L.Docs(src).d.values()) and (src / 'docs.json').read_bytes() == raw
assert s.apply({'op': 'put', 'kind': 'zone', 'id': None, 'doc': {**z, 'name': '이후'}}, 'B')[0] == 200
e = tmp / 'e'; e.mkdir()
s2, note2 = L.open_docs(f'sqlite:{tmp / "e.sqlite"}', e)
assert isinstance(s2, Store) and note2 == '' and s2.listing()['docs'] == []
assert not any(k == 'pydantic' or k.startswith(('pydantic', 'contracts')) for k in sys.modules)
print('OK')
'''


@pytest.mark.parametrize('py', ['venv', '/usr/bin/python3'])       # 시스템 python = 운영 v2_link 와 같은 해석기(pydantic 없음)
def test_v2_link_sqlite_path_needs_no_pydantic(tmp_path, py):
    import os, subprocess, sys as _s
    from test_store import ROOT
    exe = _s.executable if py == 'venv' else py
    if not os.path.exists(exe):
        pytest.skip(f'{exe} 없음')
    r = subprocess.run([exe, '-c', NO_PYDANTIC, str(ROOT), str(tmp_path)], capture_output=True, text=True)
    assert r.returncode == 0 and r.stdout.strip() == 'OK', r.stderr[-800:]
