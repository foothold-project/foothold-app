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
    parser.add_argument('--agent-ref', default='4392fc708ad471047bf710dc978c20b903168255')
    args = parser.parse_args()
    commit = subprocess.check_output(['git', '-C', args.agent_repo, 'rev-parse', args.agent_ref], text=True).strip()
    archive = subprocess.check_output(['git', '-C', args.agent_repo, 'archive', commit, 'apps/agent/foothold_agent'])
    with tempfile.TemporaryDirectory(prefix='fh-real-agent-') as folder:
        with tarfile.open(fileobj=io.BytesIO(archive)) as bundle:
            bundle.extractall(folder, filter='data')
        env = {**os.environ, 'PYTHONPATH': os.pathsep.join([
            str(Path(folder) / 'apps/agent'), str(ROOT)]), 'FH_REVIEW_AGENT_COMMIT': commit}
        print('Real PR #8 Client: ' + commit, flush=True)
        result = subprocess.run([sys.executable, '-m', 'pytest', '-q', '-s',
            'apps/server/tools/agent_reconnect_case.py'], cwd=ROOT, env=env)
        return result.returncode


if __name__ == '__main__':
    raise SystemExit(main())
