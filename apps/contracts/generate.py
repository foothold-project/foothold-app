#!/usr/bin/env python3
"""apps/contracts/models.py → apps/contracts/schema/<이름>.json + apps/contracts/ts/index.ts (생성물, 커밋).
실행: apps/server/.venv/bin/python apps/contracts/generate.py          # 다시 쓴다
     apps/server/.venv/bin/python apps/contracts/generate.py --check  # 커밋된 생성물과 다르면 종료 1(재현 검사)
TS 는 JSON Schema 부분집합(object·enum/const·anyOf/oneOf·array·$ref·원시형)만 옮긴다 — 그 밖이 나오면 실패(조용히 any 로 두지 않음)."""
import json, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from pydantic import TypeAdapter  # noqa: E402
from apps.contracts import models  # noqa: E402

OUT = ROOT / 'apps' / 'contracts'
HEAD = '// 생성물 · 수정 금지 — 정본 apps/contracts/models.py, 생성 apps/contracts/generate.py\n// 타입일 뿐 런타임 검증이 아니다. 의미 정의: docs/spec/05-API-SPEC.md\n'


def ts(s):
    if not s:
        return 'unknown'
    if '$ref' in s:
        return s['$ref'].split('/')[-1]
    if 'const' in s:
        return json.dumps(s['const'], ensure_ascii=False)
    if 'enum' in s:
        return ' | '.join(json.dumps(v, ensure_ascii=False) for v in s['enum'])
    for k in ('anyOf', 'oneOf'):
        if k in s:
            return ' | '.join(dict.fromkeys(ts(x) for x in s[k]))
    t = s.get('type')
    if t == 'array':
        if 'prefixItems' in s:
            return '[' + ', '.join(ts(item) for item in s['prefixItems']) + ']'
        inner = ts(s['items'])
        return f'({inner})[]' if '|' in inner else f'{inner}[]'
    if t == 'object' and 'properties' not in s:
        return 'Record<string, ' + (ts(s['additionalProperties']) if isinstance(s.get('additionalProperties'), dict) else 'unknown') + '>'
    prim = {'string': 'string', 'integer': 'number', 'number': 'number', 'boolean': 'boolean', 'null': 'null'}
    if t in prim:
        return prim[t]
    raise SystemExit(f'TS 변환 미지원 스키마: {json.dumps(s, ensure_ascii=False)[:200]}')


def iface(name, s):
    req = set(s.get('required', []))
    lines = [f'export interface {name} {{']
    for k, p in s['properties'].items():
        doc = p.get('description')
        if doc:
            lines.append(f'  /** {doc} */')
        lines.append(f'  {k}{"" if k in req else "?"}: {ts(p)};')
    return '\n'.join(lines + ['}'])


def build():
    files, defs, tops = {}, {}, []
    def register(name, body):
        if name in defs and defs[name] != body:
            raise ValueError('Conflicting schema definition: ' + name)
        defs[name] = body
    for name, T in models.TOP.items():
        mode = 'validation' if T in models.REQUEST_MODELS else 'serialization'
        s = TypeAdapter(T).json_schema(ref_template='#/$defs/{model}', mode=mode)
        s = {'$schema': 'https://json-schema.org/draft/2020-12/schema', '$id': f'fh-app/1/{name}', **s}
        files[f'schema/{name}.json'] = json.dumps(s, ensure_ascii=False, indent=2, sort_keys=True) + '\n'
        for key, definition in s.get('$defs', {}).items():
            register(key, definition)
        body = {k: v for k, v in s.items() if k not in ('$defs', '$schema', '$id')}
        if body.get('title') == name and body.get('type') == 'object':
            register(name, body)
        else:
            tops.append(f'export type {name} = {ts(body)};')
    out = [HEAD, f'export const CONTRACT_VERSION = {json.dumps('fh-api/1')};\n']
    for n in sorted(defs):
        d = defs[n]
        out.append(iface(n, d) if d.get('type') == 'object' and 'properties' in d else f'export type {n} = {ts(d)};')
        out.append('')
    out += tops
    files['ts/index.ts'] = '\n'.join(out).rstrip() + '\n'
    return files


def stale_files(files):
    actual = [*OUT.joinpath('schema').rglob('*.json'), *OUT.joinpath('ts').rglob('*.ts')]
    return sorted(str(p.relative_to(OUT)) for p in actual if str(p.relative_to(OUT)) not in files)


def main():
    files = build()
    if '--check' in sys.argv:
        bad = [p for p, c in files.items() if not (OUT / p).is_file() or (OUT / p).read_text(encoding='utf-8') != c]
        stale = stale_files(files)
        if bad or stale:
            print('생성물 불일치:', bad + stale); return 1
        print(f'생성물 일치 {len(files)}개'); return 0
    for old in stale_files(files):
        (OUT / old).unlink()
    for p, c in files.items():
        (OUT / p).parent.mkdir(parents=True, exist_ok=True); (OUT / p).write_text(c, encoding='utf-8')
    print(f'썼음 {len(files)}개')
    return 0


if __name__ == '__main__':
    sys.exit(main())
