"""Read-only startup proof: empty manager memory must mean no surviving runtime."""
from datetime import datetime, timezone
import json
import logging
from pathlib import Path
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[2]
LOGGER = logging.getLogger('uvicorn.error.simmgr')
UNIT_PATTERNS = ('fh-rb-sim-*.service', 'fh-simmgr-nav2-*.service', 'fh-simmgr-agent-*.service')
OBSERVER_UNIT_PATTERN = 'fh-simmgr-observer-*.service'


def wait_resource_gate(folder):
    """Require the preview's 3000 MiB / load1 <= 7 envelope for 60 seconds.

    Run before the world (and hence before Nav2); D1's immediate preflight stays.
    A single failing sample refuses this attempt, without automatic retries.
    """
    tools = str(ROOT / 'apps/agent/tools/sim')
    if tools not in sys.path:
        sys.path.insert(0, tools)
    from isolation import resources
    started = time.monotonic()
    with (folder / 'resource-gate.jsonl').open('x') as output:
        while True:
            sample = resources()
            output.write(json.dumps(sample) + '\n')
            output.flush()
            if sample['mem_available_mib'] < 3000 or sample['load1'] > 7:
                raise ResourceGateError()
            remaining = 60 - (time.monotonic() - started)
            if remaining <= 0:
                return
            time.sleep(min(1, remaining))


class ResourceGateError(RuntimeError):
    """The established resource gate rejected before any launch was attempted."""
    def __init__(self):
        super().__init__('preflight resource gate failed; no launch')


def isolation_preflight(folder):
    tools = str(ROOT / 'apps/agent/tools/sim')
    if tools not in sys.path:
        sys.path.insert(0, tools)
    from isolation import preflight
    return preflight(folder)  # existing 93/DDS/resource/61 baseline gates unchanged


def startup_preflight(real=False):
    resources_ok = True
    folder = ROOT / 'tmp/p1c/startup'
    folder.mkdir(parents=True, exist_ok=True, mode=0o700)
    with tempfile.TemporaryDirectory(dir=folder) as evidence:
        try:
            snapshot = isolation_preflight(Path(evidence))
        except RuntimeError as error:
            # The established checker writes its evidence before the resource
            # gate. Only that exact gate may become a warning for a fake runtime.
            if str(error) != 'preflight resource gate failed; no launch':
                raise
            if real:
                raise ResourceGateError() from None
            snapshot = json.loads((Path(evidence) / 'preflight.json').read_text())
            if snapshot['domain93'] or snapshot['dds_ports']:
                raise RuntimeError('isolation unavailable; startup refused') from None
            LOGGER.warning('fake launcher resource warning: MemAvailable/load gate exceeded')
            resources_ok = False
    try:
        result = subprocess.run(['systemctl', '--user', 'list-units', '--all', '--plain',
            '--no-legend', '--no-pager', OBSERVER_UNIT_PATTERN, *UNIT_PATTERNS], text=True, capture_output=True,
            check=True, timeout=5)
    except (OSError, subprocess.SubprocessError):
        raise RuntimeError('startup user bus unavailable; no runtime absence proof') from None
    if result.stdout.strip():
        raise RuntimeError('simulation user units remain; startup refused')
    LOGGER.info(
        'startup preflight utc=%s sim_units=0 nav2_units=0 agent_units=0 observer_units=0 domain93_processes=0 MemAvailableMiB=%s load1=%s',
        datetime.now(timezone.utc).isoformat(), snapshot.get('mem_available_mib'), snapshot.get('load1'))
    return {**snapshot, 'resources_ok': resources_ok}
