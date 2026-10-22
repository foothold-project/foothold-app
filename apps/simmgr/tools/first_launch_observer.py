"""Read-only domain93 observer, started after RUNNING and exited before DELETE."""
from pathlib import Path
import runpy


if __name__ == '__main__':
    # Reuse the established state/cmd/STOP observer; no publishers or frame storage.
    runpy.run_path(str(Path(__file__).resolve().parents[2] / 'agent/tools/sim/observe.py'), run_name='__main__')
