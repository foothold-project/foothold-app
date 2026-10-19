#!/usr/bin/env python3
"""Break selected safety decisions in disposable copies, require assertion failures.

No source, existing selftest, database, network or robot is modified by this tool.
"""
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[3]
SOURCE = ROOT / 'apps/server/fh_server/leases.py'
TEST = ROOT / 'apps/server/tests/test_leases.py'
MUTATIONS = [
    ('request timeout 10 -> 20', 'timeout=10', 'timeout=20'),
    ('TIMEOUT cooldown omitted', 'r.cooldown[req.actor.user] = at + 30', 'r.cooldown[req.actor.user] = at'),
    ('lease heartbeat 15 -> 30', 'at - r.holder.heartbeat >= 15', 'at - r.holder.heartbeat >= 30'),
    ('duplicate seq accepted', 'if seq <= h.seq:', 'if seq < h.seq:'),
    ('50 ms rate gate removed', 'if at - h.last_cmd < 0.05 - 1e-9:', 'if False:'),
    ('unlock CAS removed', 'if stop_gen != r.stop_gen:', 'if False:'),
    ('transfer stale stop generation accepted', 'or stop_gen <= tr.stop_gen:', ':'),
    ('transfer permits applied nonzero', 'or applied != [0, 0, 0]', ''),
    ('transfer requires no latch', 'or not latched', ''),
    ('late transfer ack accepted', 'or self.clock() >= tr.deadline', ''),
    ('revoke no lease-null', "self.effect('agent', robot, t='lease', lease_id=None, holder_type=None)",
     "self.effect('agent', robot, t='lease', lease_id='stale', holder_type='USER')"),
    ('connection binding ignored', 'h.actor != actor', 'h.actor.user != actor.user'),
]


def run(source):
    with tempfile.TemporaryDirectory(prefix='fh-lease-mutation-') as folder:
        root = Path(folder)
        target = root / 'apps/server/fh_server/leases.py'
        target.parent.mkdir(parents=True)
        target.write_text(source)
        for part in ('apps', 'apps/server', 'apps/server/fh_server'):
            (root / part / '__init__.py').touch()
        shutil.copy(TEST, root / 'test_leases.py')
        result = subprocess.run([sys.executable, '-m', 'pytest', '-q', str(root / 'test_leases.py')],
                                cwd=root, capture_output=True, text=True, timeout=30)
        return result.returncode, result.stdout + result.stderr


def main():
    original = SOURCE.read_text()
    code, output = run(original)
    if code:
        print(output)
        raise SystemExit('Baseline did not pass')
    failed = []
    print('| Broken decision | Detection |')
    print('|---|---|')
    for name, before, after in MUTATIONS:
        if before not in original:
            raise SystemExit(f'Mutation target missing: {name}')
        code, output = run(original.replace(before, after))
        detected = code == 1 and ' failed' in output and ('AssertionError' in output or 'DID NOT RAISE' in output)
        print(f'| {name} | {"detected" if detected else "MISSED"} |')
        if not detected:
            failed.append(name)
            print(output)
    if failed:
        raise SystemExit('Undetected mutations: ' + ', '.join(failed))
    print(f'{len(MUTATIONS)}/{len(MUTATIONS)} detected by assertion failures')


if __name__ == '__main__':
    main()
