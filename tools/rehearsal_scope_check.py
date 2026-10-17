#!/usr/bin/env python3
"""리허설 API 접착이 기존 제어 경로를 바꾸지 않았는지 R28 AST와 대조(파일/기록 읽기만)."""
import argparse
import ast
import copy
from pathlib import Path
import subprocess


def dump(node):
    return ast.dump(node, include_attributes=False)


def definition(tree, name):
    return next(n for n in tree.body if isinstance(n, (ast.FunctionDef, ast.ClassDef)) and n.name == name)


def check(base):
    root = Path(__file__).resolve().parents[1]
    old_link = ast.parse(subprocess.check_output(['git', 'show', f'{base}:sim/v2_link.py'], cwd=root))
    new_link = ast.parse((root / 'sim/v2_link.py').read_text())
    old_gate = ast.parse(subprocess.check_output(['git', 'show', f'{base}:sim/v2_gate.py'], cwd=root))
    new_gate = ast.parse((root / 'sim/v2_gate.py').read_text())
    n = 0
    for old, new in ((old_link, new_link), (old_gate, new_gate)):
        for item in old.body:
            if isinstance(item, (ast.FunctionDef, ast.ClassDef)) and item.name != 'main':
                assert dump(item) == dump(definition(new, item.name)), item.name
                n += 1
    before, after = definition(old_link, 'main'), copy.deepcopy(definition(new_link, 'main'))
    added_vars = {'rehearsal_store', 'rehearsal_init_lock', 'rehearsal_slots'}
    added_defs = {'rehearsal_work', 'RehearsalAPI'}
    after.body = [node for node in after.body if not (
        (isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id in added_vars for t in node.targets)) or
        (isinstance(node, (ast.FunctionDef, ast.ClassDef)) and node.name in added_defs) or
        (isinstance(node, ast.Import) and len(node.names) == 1 and node.names[0].name == 'asyncio'))]
    removed = 0
    for node in ast.walk(after):
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == 'Application':
            routes = node.args[0]
            assert isinstance(routes, ast.List)
            kept = []
            for route in routes.elts:
                if isinstance(route, ast.Tuple) and isinstance(route.elts[0], ast.Constant) and route.elts[0].value == '/api/rehearsal':
                    removed += 1
                else:
                    kept.append(route)
            routes.elts = kept
    assert removed == 1
    assert dump(before) == dump(after), 'link main changed outside the isolated planning API'
    n += 1
    gm_old, gm_new = definition(old_gate, 'main'), definition(new_gate, 'main')
    # Existing authentication and WS relay implementations must remain identical.
    for name in ('Login', 'WhoAmI', 'Logout', 'Bridge', 'AppLogin', 'AppWhoAmI', 'AppTicket', 'AppLogout', 'AppBridge'):
        assert dump(definition(gm_old, name)) == dump(definition(gm_new, name)), name
        n += 1
    for name in ('OPS', 'MSG_MAX', 'HEALTH'):
        def value(tree):
            return next(x.value for x in tree.body if isinstance(x, ast.Assign) and any(isinstance(t, ast.Name) and t.id == name for t in x.targets))
        assert dump(value(old_gate)) == dump(value(new_gate)), name
        n += 1
    print(f'REHEARSAL_SCOPE_OK checks={n} base={base} control_and_auth_unchanged')


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--base', default='a0d4df920232da6416f37655c424e5ab313365b0')
    check(p.parse_args().base)
