#!/usr/bin/env python3
"""docs.json·photos.jsonl·events.jsonl → SQLite(server/store.py) 명시적 마이그레이션. 원본은 읽기만 한다.

  import --src <폴더> --out <새 DB>   원본을 작업 폴더로 복사(sha256 대조) → 복사본 검사 → 임시 DB → 검증 → 새 이름으로 확정(있으면 거부)
  verify --src <폴더> --db <DB>       원본 문서·rev·사진·사건 메타가 DB 와 같은지
  export --db <DB> --out <docs.json>  rollback 용: DB 문서를 docs.json 형식(v2_link Docs 가 읽는 형식)으로 새 파일에(있으면 거부)
작업 폴더 = <out>.work-<시각>/ : backup/(원본 복사) · manifest.json(명령·sha·개수·결과). 실패해도 지우지 않는다.
사진 JPEG 은 옮기거나 지우지 않는다 — DB 에는 url·시각·episode·메타만.
"""
import argparse, hashlib, json, os, shutil, sqlite3, sys, time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from server.store import DOC_KINDS, Store, default_check  # noqa: E402   (pydantic 은 기본 검사를 쓸 때만)

FILES = ('docs.json', 'photos.jsonl', 'events.jsonl')


class Refuse(Exception):
    pass


def sha(p):
    return hashlib.sha256(Path(p).read_bytes()).hexdigest()


def read_docs(path, check=default_check):
    """v2_link Docs.__init__ 과 같은 검사. 틀리면 Refuse(추정·수리 없음). 없으면 {}."""
    if not path.exists():
        return {}
    d = json.loads(path.read_text(encoding='utf-8'))
    if not isinstance(d, dict):
        raise Refuse('docs.json 최상위가 객체 아님')
    notes, active = {}, []
    for k, x in d.items():
        if not (isinstance(x, dict) and x.get('id') == k and x.get('kind') in DOC_KINDS and type(x.get('rev')) is int and x['rev'] >= 1
                and isinstance(x.get('by'), str) and isinstance(x.get('at'), str)) or check(x['kind'], x.get('doc')):
            raise Refuse(f'문서 {str(k)[:40]} 형식')
        if x['kind'] == 'note':
            if x['doc']['photo'] in notes:
                raise Refuse(f'같은 사진에 분류 둘: {notes[x["doc"]["photo"]]}, {k}')
            notes[x['doc']['photo']] = k
        if x['kind'] == 'run' and x['doc']['status'] == '진행':
            active.append(k)
    if len(active) > 1:
        raise Refuse(f'진행 중 run 여러 개: {active}')
    return d


def read_jsonl(path):
    """Media.tail 과 같게 깨진 줄은 건너뛴다(개수는 보고). 반환 (목록, 건너뛴 수)."""
    if not path.exists():
        return [], 0
    out, bad = [], 0
    for line in path.read_text(encoding='utf-8').splitlines():
        try:
            v = json.loads(line)
            if not isinstance(v, dict):
                raise ValueError
            out.append(v)
        except ValueError:
            bad += 1
    return out, bad


def load(src, check=default_check):
    docs = read_docs(src / 'docs.json', check)
    photos, bad_p = read_jsonl(src / 'photos.jsonl')
    events, bad_e = read_jsonl(src / 'events.jsonl')
    for p in photos:
        if not (isinstance(p.get('url'), str) and isinstance(p.get('saved_at'), str)):
            raise Refuse(f'사진 메타에 url·saved_at 없음: {str(p)[:80]}')
    for e in events:
        if not isinstance(e.get('at'), str):
            raise Refuse(f'사건에 at 없음: {str(e)[:80]}')
    uniq, seen = [], set()                  # 같은 url 이 두 번이면 첫 줄만(개수 보고)
    for p in photos:
        if p['url'] not in seen:
            seen.add(p['url']); uniq.append(p)
    return docs, uniq, events, {'photos_skipped_lines': bad_p, 'events_skipped_lines': bad_e, 'photos_dup_url': len(photos) - len(uniq)}


def write_db(db, docs, photos, events):
    s = Store(db)
    if s.broken:
        raise Refuse(s.broken)
    c = sqlite3.connect(db)
    try:
        with c:
            for i, x in enumerate(docs.values(), 1):
                c.execute('INSERT INTO docs(id, kind, rev, by, at, doc, seq) VALUES(?,?,?,?,?,?,?)',
                          (x['id'], x['kind'], x['rev'], x['by'], x['at'], json.dumps(x['doc'], ensure_ascii=False), i))
            c.execute("UPDATE meta SET value=? WHERE key='seq'", (len(docs),))
            # 전체 판 = v2_link 가 재시작 때 보이던 값(rev 합) — 열린 화면이 «바뀜 없음»으로 이어 받게. 이후는 단조 증가
            c.execute("UPDATE meta SET value=? WHERE key='rev'", (sum(x['rev'] for x in docs.values()),))
            for p in photos:
                c.execute('INSERT INTO photos VALUES(?,?,?,?)', (p['url'], p['saved_at'], p.get('episode') if type(p.get('episode')) is int else None,
                                                                        json.dumps(p, ensure_ascii=False)))
            for e in events:
                c.execute('INSERT INTO events(at, ev) VALUES(?,?)', (e['at'], json.dumps(e, ensure_ascii=False)))
    finally:
        c.close()


def compare(src_docs, photos, events, db):
    """다르면 이유 목록. 순서까지 본다."""
    s = Store(db, create=False)
    if s.broken:
        return [s.broken]
    why = []
    lst = s.listing()
    if lst['docs'] != list(src_docs.values()):
        why.append('문서 내용·순서 다름')
    if lst['rev'] < sum(x['rev'] for x in src_docs.values()):
        why.append('전체 rev 가 원본보다 작음')
    ph, ev = s.media(10 ** 9, 10 ** 9)
    if ph[::-1] != photos:
        why.append('사진 메타 다름')
    if ev[::-1] != events:
        why.append('사건 다름')
    return why


def cmd_import(a, check=default_check):
    src, out = Path(a.src), Path(a.out)
    if out.exists():
        raise Refuse(f'{out} 이미 있음 — 덮어쓰지 않음')
    work = out.with_name(f'{out.name}.work-{time.strftime("%Y%m%d-%H%M%S")}')
    (work / 'backup').mkdir(parents=True)
    man = {'cmd': sys.argv, 'src': str(src), 'out': str(out), 'at': time.strftime('%Y-%m-%dT%H:%M:%S%z'), 'files': {}, 'result': 'started'}
    try:
        for f in FILES:
            if (src / f).exists():
                shutil.copy2(src / f, work / 'backup' / f)
                h0, h1 = sha(src / f), sha(work / 'backup' / f)
                man['files'][f] = {'sha256': h0, 'bytes': (src / f).stat().st_size}
                if h0 != h1:
                    raise Refuse(f'{f} 복사본 sha 불일치(복사 중 바뀜?)')
        docs, photos, events, info = load(work / 'backup', check)  # 이후로는 복사본만 읽는다
        man.update(info, docs=len(docs), photos=len(photos), events=len(events))
        tmp = work / 'new.sqlite'
        write_db(tmp, docs, photos, events)
        why = compare(docs, photos, events, tmp)
        if why:
            raise Refuse('검증 실패: ' + ' · '.join(why))
        for f in FILES:                                        # 원본이 그새 바뀌지 않았나
            if (src / f).exists() != (f in man['files']) or (f in man['files'] and sha(src / f) != man['files'][f]['sha256']):
                raise Refuse(f'{f} 원본이 마이그레이션 중 바뀜 — 다시')
        os.link(tmp, out)                                      # 이름이 생기면 실패(덮어쓰기 없음)
        man['result'] = 'ok'; man['db_sha256'] = sha(out)
        return man
    except Exception as e:
        man['result'] = f'failed: {type(e).__name__}: {e}'
        raise
    finally:
        (work / 'manifest.json').write_text(json.dumps(man, ensure_ascii=False, indent=2), encoding='utf-8')


def cmd_verify(a):
    docs, photos, events, info = load(Path(a.src))
    why = compare(docs, photos, events, Path(a.db))
    return {'result': 'ok' if not why else 'diff', 'why': why, **info}


def cmd_export(a):
    out = Path(a.out)
    if out.exists():
        raise Refuse(f'{out} 이미 있음 — 덮어쓰지 않음')
    s = Store(Path(a.db), create=False)
    if s.broken:
        raise Refuse(s.broken)
    lst = s.listing()
    tmp = out.with_name(f'.{out.name}.tmp')
    tmp.write_text(json.dumps({x['id']: x for x in lst['docs']}, ensure_ascii=False), encoding='utf-8')
    read_docs(tmp)                                             # 내보낸 것이 v2_link 검사를 통과하는지
    os.link(tmp, out); tmp.unlink()
    return {'result': 'ok', 'docs': len(lst['docs']), 'out': str(out), 'sha256': sha(out)}


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sp = ap.add_subparsers(dest='cmd', required=True)
    p = sp.add_parser('import'); p.add_argument('--src', required=True); p.add_argument('--out', required=True)
    p = sp.add_parser('verify'); p.add_argument('--src', required=True); p.add_argument('--db', required=True)
    p = sp.add_parser('export'); p.add_argument('--db', required=True); p.add_argument('--out', required=True)
    a = ap.parse_args(argv)
    try:
        r = {'import': cmd_import, 'verify': cmd_verify, 'export': cmd_export}[a.cmd](a)
    except (Refuse, ValueError, OSError, sqlite3.Error) as e:
        print(json.dumps({'result': 'refused', 'why': f'{type(e).__name__}: {e}'}, ensure_ascii=False)); return 2
    print(json.dumps(r, ensure_ascii=False))
    return 0 if r['result'] == 'ok' else 1


if __name__ == '__main__':
    sys.exit(main())
