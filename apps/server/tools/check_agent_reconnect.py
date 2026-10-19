#!/usr/bin/env python3
"""Read a pinned PR #8 package into a temporary directory, then test real Client.

No agent worktree is modified. Requires the requested Git object locally; supply
--agent-repo when running this tool from a disposable mutation tree.
"""
import argparse
import io
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parents[3]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--agent-repo', default=str(ROOT))
    parser.add_argument('--agent-ref', default='WORKTREE')
    args = parser.parse_args()
    plugin = ['-p', 'fh_realtime_mutation_probe', '--realtime-mutation-report', os.environ['FH_REALTIME_MUTATION_REPORT']] if 'FH_REALTIME_MUTATION_REPORT' in os.environ else []
    if args.agent_ref == 'WORKTREE':
        env = {**os.environ, 'PYTHONPATH': os.pathsep.join([str(ROOT / 'apps/agent'), str(ROOT), os.environ.get('PYTHONPATH', '')]),
               'FH_REVIEW_AGENT_COMMIT': 'WORKTREE'}
        return subprocess.run([sys.executable, '-m', 'pytest', '-q', '-s', *plugin,
            'apps/server/tools/agent_reconnect_case.py'], cwd=ROOT, env=env).returncode
    commit = subprocess.check_output(['git', '-C', args.agent_repo, 'rev-parse', args.agent_ref], text=True).strip()
    archive = subprocess.check_output(['git', '-C', args.agent_repo, 'archive', commit, 'apps/agent/foothold_agent'])
    with tempfile.TemporaryDirectory(prefix='fh-real-agent-') as folder:
        with tarfile.open(fileobj=io.BytesIO(archive)) as bundle:
            bundle.extractall(folder, filter='data')
        env = {**os.environ, 'PYTHONPATH': os.pathsep.join([
            str(Path(folder) / 'apps/agent'), str(ROOT), os.environ.get('PYTHONPATH', '')]), 'FH_REVIEW_AGENT_COMMIT': commit}
        print('Real PR #8 Client: ' + commit, flush=True)
        result = subprocess.run([sys.executable, '-m', 'pytest', '-q', '-s', *plugin,
            'apps/server/tools/agent_reconnect_case.py'], cwd=ROOT, env=env)
        return result.returncode


if __name__ == '__main__':
    raise SystemExit(main())
