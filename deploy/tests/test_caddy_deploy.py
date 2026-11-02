"""Run deploy.sh in a temporary filesystem with fake service/build commands."""
import hashlib
import io
import os
from pathlib import Path
import subprocess
import tarfile

import pytest


SCRIPTS = Path(__file__).resolve().parents[1]
SHA = '1' * 40


def executable(path, body):
    path.write_text('#!/usr/bin/env bash\nset -euo pipefail\n' + body)
    path.chmod(0o755)


@pytest.mark.parametrize('case', ['same', 'replace', 'validate', 'reload', 'smoke',
                                 'manual', 'untracked', 'enrol'])
def test_deploy_caddy_transaction(tmp_path, case):
    tools, bin_dir = tmp_path / 'tools', tmp_path / 'bin'
    tools.mkdir()
    bin_dir.mkdir()
    env = dict(os.environ, TEST_ROOT=str(tmp_path), TEST_CASE=case,
               PYTHONPATH=str(SCRIPTS.parent), PATH=str(bin_dir) + ':' + os.environ['PATH'])
    # Only the disposable copies use the synthetic root/uid. Production paths
    # and the EUID gate are untouched; no privileges, services or ports needed.
    for name in ['common.sh', 'deploy.sh']:
        source = (SCRIPTS / name).read_text()
        source = source.replace('/opt/foothold', str(tmp_path / 'opt/foothold'))
        source = source.replace('/var/lib/foothold', str(tmp_path / 'var/lib/foothold'))
        source = source.replace('/etc/caddy', str(tmp_path / 'etc/caddy'))
        source = source.replace('/etc/foothold', str(tmp_path / 'etc/foothold'))
        source = source.replace('[[ $EUID == 0 && $# == 1 ]]', '[[ $# == 1 ]]')
        (tools / name).write_text(source)
    state = tmp_path / 'var/lib/foothold'
    incoming = state / 'incoming'
    incoming.mkdir(parents=True)
    caddy_state = state / 'caddy-sync'
    caddy_state.mkdir(mode=0o700)
    config = tmp_path / 'etc/caddy/Caddyfile'
    config.parent.mkdir(parents=True)
    proposed = b'{$FH_SITE} { respond "new" }\n'
    original = proposed if case in ('same', 'enrol') else b'# original\n'
    config.write_bytes(original)
    config.chmod(0o640)
    record = caddy_state / 'applied.sha256'
    if case not in ('untracked', 'enrol'):
        baseline = b'operator replaced this' if case == 'manual' else original
        record.write_text(hashlib.sha256(baseline).hexdigest() + '\n')
        record.chmod(0o600)
    before_hash = record.read_bytes() if record.exists() else None
    site = tmp_path / 'etc/foothold/site.env'
    site.parent.mkdir(parents=True)
    site.write_text('FH_SITE=test.example.invalid\n')
    previous = tmp_path / 'opt/foothold/releases/previous'
    previous.mkdir(parents=True)
    current = previous.parent.parent / 'current'
    current.symlink_to(previous)
    archive = incoming / (SHA + '.tar.gz')
    with tarfile.open(archive, 'w:gz') as tar:
        for name, data in [('COMMIT', (SHA + '\n').encode()),
                           ('apps/web/dist/index.html', b'<html>fake</html>'),
                           ('deploy/Caddyfile', proposed)]:
            item = tarfile.TarInfo(name)
            item.size = len(data)
            tar.addfile(item, io.BytesIO(data))
    archive.with_suffix('.gz.sha256').write_text(
        hashlib.sha256(archive.read_bytes()).hexdigest() + ' ' + archive.name + '\n')
    executable(bin_dir / 'chown', 'exit 0\n')
    executable(bin_dir / 'caddy', '''
[[ ${FH_SITE:-} == test.example.invalid ]] || exit 98
echo "caddy $*" >> "$TEST_ROOT/trace"
if [[ $TEST_CASE == validate && $* == *candidate.Caddyfile* ]]; then exit 1; fi
''')
    executable(bin_dir / 'systemctl', '''
echo "systemctl $*" >> "$TEST_ROOT/trace"
if [[ $TEST_CASE == reload && $1 == reload && ! -e $TEST_ROOT/reload-failed ]]; then
    touch "$TEST_ROOT/reload-failed"; exit 1
fi
''')
    executable(bin_dir / 'python3.12', '''
mkdir -p "$3/bin"
cat > "$3/bin/python" <<'PYTHON'
#!/usr/bin/env bash
set -euo pipefail
echo "venv $*" >> "$TEST_ROOT/trace"
if [[ $TEST_CASE == smoke && $* == '-m deploy.smoke' ]]; then exit 1; fi
PYTHON
chmod 755 "$3/bin/python"
''')
    # Exercise the real helper CLI with root metadata mocked at the OS boundary.
    # Caddy/systemctl remain executable fakes for Python and shell alike.
    (tmp_path / 'driver.py').write_text('''
import os
from pathlib import Path
import sys
from types import SimpleNamespace
from unittest.mock import patch
from deploy import caddy_sync as c
root = Path(os.environ['TEST_ROOT'])
sync = c.Sync(root / 'etc/caddy/Caddyfile', root / 'var/lib/foothold/caddy-sync')
fstat, lstat = os.fstat, Path.lstat
def info(s):
    return SimpleNamespace(st_uid=0, st_gid=0, st_mode=s.st_mode,
                           st_ino=s.st_ino, st_mtime_ns=s.st_mtime_ns)
sys.argv = sys.argv[1:]
with patch.object(c, 'Sync', return_value=sync), patch.object(os, 'geteuid', return_value=0), \\
     patch.object(os, 'fchown'), patch.object(os, 'fstat', side_effect=lambda fd: info(fstat(fd))), \\
     patch.object(Path, 'lstat', autospec=True, side_effect=lambda p: info(lstat(p))):
    c.main()
''')
    executable(bin_dir / 'python3', 'exec /usr/bin/python3 "$TEST_ROOT/driver.py" "$@"\n')
    result = subprocess.run(['bash', str(tools / 'deploy.sh'), SHA], env=env,
                            capture_output=True, text=True)
    trace = (tmp_path / 'trace').read_text()
    log = (state / 'deploys.log').read_text()
    failed = case in ('validate', 'reload', 'smoke')
    assert (result.returncode != 0) == failed, result.stdout + result.stderr
    if failed:
        assert config.read_bytes() == original
        assert config.stat().st_mode & 0o777 == 0o640
        assert record.read_bytes() == before_hash
        assert current.resolve() == previous
        assert 'systemctl reload caddy' in trace
        assert 'exit=1' in log
        if case != 'validate':
            assert 'rollback=restored' in log
    else:
        assert current.resolve().name == SHA and 'exit=0' in log
        assert 'venv -m deploy.smoke' in trace
        if case == 'replace':
            assert config.read_bytes() == proposed
            assert config.stat().st_mode & 0o777 == 0o644
        else:
            assert config.read_bytes() == original
            assert config.stat().st_mode & 0o777 == 0o640
        if case in ('replace', 'enrol'):
            assert record.read_text().strip() == hashlib.sha256(proposed).hexdigest()
        elif before_hash is not None:
            assert record.read_bytes() == before_hash
        else:
            assert not record.exists()
    if case in ('manual', 'untracked'):
        assert 'overwrite REFUSED' in result.stderr
    if case in ('same', 'manual', 'untracked', 'enrol'):
        assert 'candidate.Caddyfile' not in trace
        assert trace.count('systemctl reload caddy') == 1  # legacy behavior only
    assert not (caddy_state / 'pending.json').exists()
