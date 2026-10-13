"""SQLite 공용 문서 저장소 — v2_link Docs(docs.json) 와 같은 apply() 계약(HTTP 코드·응답), 저장만 SQLite.

무엇이 달라지나(호환 범위 안)
  - 쓰기 하나 = 트랜잭션 하나(BEGIN IMMEDIATE). 실패하면 rollback — 이전 판 그대로.
  - «진행 run 하나»·«사진당 note 하나»는 앱 검사 + DB 부분 UNIQUE 인덱스 둘 다(다른 프로세스가 동시에 써도 둘째는 409).
  - 전체 판(rev)은 meta 에 저장한 단조 증가 값 — 재시작해도 되돌아가지 않는다(docs.json 판은 재시작 때 rev 합으로 다시 세서 삭제 뒤 작아질 수 있었다).
  - 사진·사건은 파일(JPEG)은 그대로 두고 메타만 photos·events 표에. 사진 파일을 지우지 않는다.
열 때 손상·모르는 스키마 판이면 broken(쓰기 503), 파일은 건드리지 않는다. 연결은 호출마다 새로(스레드·프로세스 공유 없음).
import 때 pydantic 이 필요 없다 — v2_link(시스템 python + rclpy·tornado)가 check=doc_check 를 넘겨 그대로 쓴다.
"""
import json, os, re, secrets, sqlite3, threading, time
from pathlib import Path

SCHEMA_VERSION = 1
DOC_KINDS = ('zone', 'tmpl', 'mission', 'run', 'note')     # contracts.v1·v2_link 와 같은 값(시험이 대조)
DOC_MAX, DOC_TOTAL = 12000, 2000
_KINDS = ','.join(f"'{k}'" for k in DOC_KINDS)
DDL = f"""
CREATE TABLE meta(key TEXT PRIMARY KEY, value ANY) STRICT;
CREATE TABLE docs(
  id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 2 AND 41),
  kind TEXT NOT NULL CHECK(kind IN ({_KINDS})),
  rev INTEGER NOT NULL CHECK(rev >= 1),
  by TEXT NOT NULL, at TEXT NOT NULL,
  doc TEXT NOT NULL CHECK(json_valid(doc)),
  seq INTEGER NOT NULL,                       -- 만든 순서(목록 순서 = docs.json 삽입 순서와 같게)
  note_photo TEXT GENERATED ALWAYS AS (CASE WHEN kind = 'note' THEN json_extract(doc, '$.photo') END) VIRTUAL,
  run_active INTEGER GENERATED ALWAYS AS (CASE WHEN kind = 'run' AND json_extract(doc, '$.status') = '진행' THEN 1 END) VIRTUAL
) STRICT;
CREATE UNIQUE INDEX one_note_per_photo ON docs(note_photo) WHERE note_photo IS NOT NULL;
CREATE UNIQUE INDEX one_active_run ON docs(run_active) WHERE run_active IS NOT NULL;
CREATE TABLE photos(url TEXT PRIMARY KEY, saved_at TEXT NOT NULL, episode INTEGER, meta TEXT NOT NULL CHECK(json_valid(meta))) STRICT;
CREATE TABLE events(n INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, ev TEXT NOT NULL CHECK(json_valid(ev))) STRICT;
"""


def now_iso():
    return time.strftime('%Y-%m-%dT%H:%M:%S%z')


def default_check(kind, doc):
    from contracts.v1.models import check_doc        # pydantic 은 쓸 때만
    return check_doc(kind, doc)


class Store:
    """check(kind, doc) → None 이면 통과, 아니면 400 이유 글. 기본은 contracts.v1 검사.
    rev = 이 프로세스가 아는 전체 판(열 때 DB 값, 이 객체로 쓴 뒤 갱신) — 쓰는 프로세스가 하나면 DB 와 같다. DB 값은 db_rev().
    lock = 호출자용(v2_link Docs.lock 과 같은 자리). Store 자체는 lock 없이도 트랜잭션으로 안전하다."""

    def __init__(self, path, create=True, check=default_check):
        """create=False 면 없는 파일을 만들지 않는다(검증 도구용)."""
        self.path, self.broken, self.check, self.lock, self.rev = Path(path), None, check, threading.Lock(), 0
        try:
            if not self.path.exists():
                if not create:
                    raise FileNotFoundError(str(self.path))
                self._init()
            with self._db() as c:
                if c.execute('PRAGMA quick_check').fetchone()[0] != 'ok':
                    raise sqlite3.DatabaseError('quick_check 실패')
                v = c.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()
                if not v or v[0] != SCHEMA_VERSION:
                    raise sqlite3.DatabaseError(f'스키마 판 {v and v[0]} — 이 서버는 {SCHEMA_VERSION}')
                self.rev = c.execute("SELECT value FROM meta WHERE key='rev'").fetchone()[0]
        except FileNotFoundError:
            raise
        except Exception as e:          # 손상·모르는 판: 덮지 않는다
            self.broken = f'문서 DB 열기 실패({type(e).__name__}: {str(e)[:80]}) — 원본 보존, 문서 저장소 사용 불가'

    def _db(self):
        c = sqlite3.connect(self.path, timeout=5, isolation_level=None)   # 트랜잭션은 직접(BEGIN IMMEDIATE)
        c.execute('PRAGMA busy_timeout=5000')
        return _Conn(c)

    def _init(self):
        # 임시 파일에 다 만든 뒤 이름 바꾸기 — 중간에 죽어도 반쯤 만든 DB 가 정본 이름으로 남지 않는다
        tmp = self.path.with_name(f'.{self.path.name}.{os.getpid()}.{secrets.token_hex(3)}.tmp')
        c = sqlite3.connect(tmp)
        try:
            c.executescript(DDL)
            c.executemany('INSERT INTO meta VALUES(?,?)', [('schema_version', SCHEMA_VERSION), ('rev', 0), ('seq', 0)])
            c.commit()
        finally:
            c.close()
        try:
            os.link(tmp, self.path)           # 이미 있으면 실패 — 남이 먼저 만든 DB 를 덮지 않는다
        except FileExistsError:
            pass
        finally:
            tmp.unlink()
        with self._db() as c:
            c.execute('PRAGMA journal_mode=WAL')

    # ---------------------------------------------------------------- 조회

    def db_rev(self):
        with self._db() as c:
            return c.execute("SELECT value FROM meta WHERE key='rev'").fetchone()[0]

    def listing(self):
        """GET /api/docs 응답(DocsList). broken 이면 빈 목록."""
        if self.broken:
            return {'docs': [], 'rev': 0, 'broken': self.broken}
        with self._db() as c:
            c.execute('BEGIN')                # 목록과 rev 를 같은 시점에서 읽는다
            rows = c.execute('SELECT id, kind, rev, by, at, doc FROM docs ORDER BY seq').fetchall()
            rv = c.execute("SELECT value FROM meta WHERE key='rev'").fetchone()[0]
            c.execute('COMMIT')
        return {'docs': [_env(r) for r in rows], 'rev': rv, 'broken': None}

    # ---------------------------------------------------------------- 쓰기 — v2_link Docs.apply 와 같은 순서·코드

    def apply(self, m, actor):
        """m = {op:'put'|'del', kind, id(새 문서는 None), rev, doc} → (HTTP 코드, 응답). sqlite3.Error 는 호출자에게(→ 500, 이미 rollback)."""
        if self.broken:
            return 503, {'error': self.broken}
        if not isinstance(m, dict) or m.get('op') not in ('put', 'del'):
            return 400, {'error': 'op 는 put·del'}
        did = m.get('id')
        if did is not None:
            if not isinstance(did, str) or not _id_ok(did):
                return 400, {'error': 'id 형식'}
            rev = m.get('rev')
            if type(rev) is not int or rev < 1:
                return 400, {'error': 'rev 는 1 이상 정수'}
        doc = m.get('doc')
        if m['op'] == 'put':                 # 형식 검사는 트랜잭션 밖(쓰기 잠금을 짧게). kind 는 기존 문서 것이 우선이라 아래서 다시 본다
            kind0 = m.get('kind')
            pre = None if did is not None else (
                f'종류는 {sorted(DOC_KINDS)}' if not isinstance(kind0, str) or kind0 not in DOC_KINDS else self.check(kind0, doc))
            if pre:
                return 400, {'error': pre}
        with self._db() as c:
            c.execute('BEGIN IMMEDIATE')
            try:
                code, r = self._apply(c, m, did, doc, actor)
                rv = c.execute("SELECT value FROM meta WHERE key='rev'").fetchone()[0]
                c.execute('COMMIT' if code == 200 else 'ROLLBACK')
                if code == 200:
                    self.rev = rv                 # 커밋이 끝난 뒤에만(실패면 이전 값 그대로)
                return code, r
            except sqlite3.IntegrityError:      # 앱 검사를 빠져나간 «하나만» 위반(다른 프로세스 경합) → 409
                c.execute('ROLLBACK')
                cur = self._dup(c, m, did, doc)
                if cur:
                    return 409, {'error': _dup_msg(cur['kind']), 'cur': cur}
                raise
            except BaseException:
                c.execute('ROLLBACK'); raise

    def _apply(self, c, m, did, doc, actor):
        cur = None
        if did is not None:
            row = c.execute('SELECT id, kind, rev, by, at, doc FROM docs WHERE id=?', (did,)).fetchone()
            if row is None:
                return 404, {'error': '없는 문서(다른 기기가 지웠을 수 있음)'}
            cur = _env(row)
            if m['rev'] != cur['rev']:
                return 409, {'error': '다른 기기가 먼저 고침 — 새로 읽은 뒤 다시', 'cur': cur}
        kind = cur['kind'] if cur else m.get('kind')
        if not isinstance(kind, str) or kind not in DOC_KINDS:      # v2_link 와 같은 순서: 종류 → 삭제 → 형식
            return 400, {'error': f'종류는 {sorted(DOC_KINDS)}'}
        if m['op'] == 'del':
            if cur is None:
                return 400, {'error': '지울 id 필요'}
            c.execute('DELETE FROM docs WHERE id=? AND rev=?', (did, cur['rev']))
            self._bump(c)
            return 200, {'ok': True, 'id': did, 'kind': kind, 'name': cur['doc'].get('name', '')}
        e = self.check(kind, doc)
        if e:
            return 400, {'error': e}
        raw = json.dumps(doc, ensure_ascii=False)
        if len(raw.encode()) > DOC_MAX:
            return 400, {'error': f'문서가 너무 큼({DOC_MAX} 바이트 이하)'}
        dup = self._dup(c, {'kind': kind}, did, doc)
        if dup:
            return 409, {'error': _dup_msg(kind), 'cur': dup}
        at = now_iso()
        if cur is None:
            if c.execute('SELECT count(*) FROM docs').fetchone()[0] >= DOC_TOTAL:
                return 400, {'error': f'문서 수 한도 {DOC_TOTAL}'}
            did = f'{kind[0]}{time.strftime("%m%d%H%M%S")}{secrets.token_hex(4)}'
            seq = c.execute("UPDATE meta SET value=value+1 WHERE key='seq' RETURNING value").fetchone()[0]
            c.execute('INSERT INTO docs(id, kind, rev, by, at, doc, seq) VALUES(?,?,1,?,?,?,?)', (did, kind, actor, at, raw, seq))
            new_rev = 1
        else:
            new_rev = cur['rev'] + 1
            n = c.execute('UPDATE docs SET rev=?, by=?, at=?, doc=? WHERE id=? AND rev=?', (new_rev, actor, at, raw, did, cur['rev'])).rowcount
            assert n == 1                    # IMMEDIATE 잠금 안이라 위에서 읽은 판 그대로
        self._bump(c)
        return 200, {'ok': True, 'id': did, 'rev': new_rev, 'kind': kind, 'name': doc.get('name', ''), 'new': cur is None}

    @staticmethod
    def _dup(c, m, did, doc):
        kind = m.get('kind')
        if kind == 'note' and isinstance(doc, dict):
            row = c.execute('SELECT id, kind, rev, by, at, doc FROM docs WHERE note_photo=? AND id IS NOT ?', (doc.get('photo'), did)).fetchone()
        elif kind == 'run' and isinstance(doc, dict) and doc.get('status') == '진행':
            row = c.execute('SELECT id, kind, rev, by, at, doc FROM docs WHERE run_active=1 AND id IS NOT ?', (did,)).fetchone()
        else:
            return None
        return _env(row) if row else None

    @staticmethod
    def _bump(c):
        c.execute("UPDATE meta SET value=value+1 WHERE key='rev'")

    # ---------------------------------------------------------------- 사진·사건 메타(파일은 그대로)

    def add_photo(self, meta):
        with self._db() as c:
            c.execute('INSERT INTO photos VALUES(?,?,?,?)', (meta['url'], meta['saved_at'], meta.get('episode'), json.dumps(meta, ensure_ascii=False)))

    def add_event(self, e):
        with self._db() as c:
            c.execute('INSERT INTO events(at, ev) VALUES(?,?)', (e['at'], json.dumps(e, ensure_ascii=False)))

    def media(self, n_photos=200, n_events=300):
        """GET /api/media 의 photos·events(최신 먼저) — Media.tail(...)[::-1] 과 같은 순서."""
        with self._db() as c:
            ph = [json.loads(r[0]) for r in c.execute('SELECT meta FROM photos ORDER BY rowid DESC LIMIT ?', (n_photos,))]
            ev = [json.loads(r[0]) for r in c.execute('SELECT ev FROM events ORDER BY n DESC LIMIT ?', (n_events,))]
        return ph, ev


class _Conn:
    """with 블록 = 연결 하나(끝나면 닫힘). sqlite3 기본 with 는 닫지 않아서 따로."""

    def __init__(self, c):
        self.c = c

    def __enter__(self):
        return self.c

    def __exit__(self, *a):
        self.c.close()


def _id_ok(s):
    return re.fullmatch(r'[a-z]\w{1,40}', s) is not None       # v2_link 와 같은 정규식


def _env(r):
    return {'id': r[0], 'kind': r[1], 'rev': r[2], 'by': r[3], 'at': r[4], 'doc': json.loads(r[5])}


def _dup_msg(kind):
    return '이미 진행 중인 수동 임무가 있음 — 먼저 끝내세요' if kind == 'run' else '이 사진은 다른 기기가 먼저 분류함 — 최신 판 위에 다시'
