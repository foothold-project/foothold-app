"""Read-only startup proof: empty manager memory must mean no surviving runtime."""
from pathlib import Path
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[2]
UNIT_PATTERNS = ('fh-rb-sim-*.service', 'fh-simmgr-agent-*.service')


def isolation_preflight(folder):
    tools = str(ROOT / 'apps/agent/tools/sim')
    if tools not in sys.path:
        sys.path.insert(0, tools)
    from isolation import preflight
    return preflight(folder)  # existing 93/DDS/resource/61 baseline gates unchanged


def startup_preflight():
    folder = ROOT / 'tmp/p1c/startup'
    folder.mkdir(parents=True, exist_ok=True, mode=0o700)
    with tempfile.TemporaryDirectory(dir=folder) as evidence:
        snapshot = isolation_preflight(Path(evidence))
    try:
        result = subprocess.run(['systemctl', '--user', 'list-units', '--all', '--plain',
            '--no-legend', '--no-pager', *UNIT_PATTERNS], text=True, capture_output=True,
            check=True, timeout=5)
    except (OSError, subprocess.SubprocessError):
        raise RuntimeError('startup user bus unavailable; no runtime absence proof') from None
    if result.stdout.strip():
        raise RuntimeError('simulation user units remain; startup refused')
    return snapshot
