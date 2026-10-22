"""Test-only publisher timing hook; absent from production PYTHONPATH.

The manager wrapper substitutes only the owned agent bootstrap executable.
No Core decisions, expected values, ROS topics, or unit bounds are changed.
"""
import json
import os
from pathlib import Path
import runpy
import sys
import time

ROOT = Path(__file__).resolve().parents[3]
sys.path[:0] = [str(ROOT), str(ROOT / 'apps/agent')]


def hook():
    import atexit
    import queue
    import threading
    from foothold_agent.phone.hub import Hub
    from foothold_agent.ros_bridge.sink import RosSink
    path = Path(os.environ.pop('FH_MEASURE_FILE'))
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    output = os.fdopen(fd, 'w', buffering=1)
    pending = queue.Queue(maxsize=8192)
    latest = {'seq': None, 'received': None}
    current = threading.local()
    lock = threading.Lock()
    def record(value):
        try:
            pending.put_nowait(value)
        except queue.Full:
            # Missing records remain visible as unmatched driver samples.
            path.with_suffix('.overflow').touch(mode=0o600, exist_ok=True)
    def drain():
        while True:
            value = pending.get()
            if value is None:
                break
            output.write(json.dumps(value) + '\n')
        output.close()
    worker = threading.Thread(target=drain, name='test-publisher-recorder', daemon=True)
    worker.start()
    original_receive, original_init = Hub.receive, RosSink.__init__
    def receive(self, peer, raw):
        arrived = time.monotonic()
        # A command can publish synchronously inside receive(), before its ACK.
        # Correlation is provisional until the driver confirms a positive ACK.
        try:
            candidate = json.loads(raw)
            current.sample = ({'seq': candidate['seq'], 'received': arrived}
                if isinstance(candidate, dict) and candidate.get('t') == 'cmd' else None)
        except (ValueError, TypeError, KeyError, UnicodeError, RecursionError, OverflowError):
            current.sample = None
        try:
            result = original_receive(self, peer, raw)
        finally:
            current.sample = None
        if result.get('t') == 'cmd.ack':
            with lock:
                latest.update(seq=result['seq'], received=arrived)
            record({'kind': 'received', 'seq': result['seq'], 'mono': arrived,
                'applied': result['applied'], 'reason': result['reason']})
        return result
    def initialize(self, velocity, stop, resume, **kwargs):
        def publish(value):
            with lock:
                sample = dict(getattr(current, 'sample', None) or latest)
            velocity(value)
            record({'kind': 'published', 'mono': time.monotonic(),
                'velocity': list(value), **sample})
        original_init(self, publish, stop, resume, **kwargs)
    Hub.receive, RosSink.__init__ = receive, initialize
    def close():
        pending.put(None)
        worker.join(3)
    atexit.register(close)


def manager():
    import types
    import subprocess
    from apps.simmgr import agent_unit
    original = subprocess.run
    def launch(args, *positional, **kwargs):
        old = str(ROOT / 'apps/simmgr/agent_entry.py')
        if isinstance(args, list) and old in args:
            args = list(args)
            index = args.index(old)
            args[index:index + 1] = [str(Path(__file__).resolve()), 'agent']
        return original(args, *positional, **kwargs)
    agent_unit.subprocess = types.SimpleNamespace(run=launch, TimeoutExpired=subprocess.TimeoutExpired)
    from apps.simmgr.__main__ import main
    main()


def agent():
    from apps.simmgr import agent_entry
    private = Path(sys.argv[2])
    config = json.loads(private.read_text())
    config['env']['FH_MEASURE_FILE'] = str(private.parent / 'publisher.jsonl')
    private.write_text(json.dumps(config))
    agent_entry.BOOTSTRAP = agent_entry.BOOTSTRAP.replace(
        "runpy.run_module('foothold_agent.ros_bridge', run_name='__main__')",
        f"runpy.run_path({str(Path(__file__).resolve())!r}, run_name='first_launch_hook')['hook']()\n"
        "runpy.run_module('foothold_agent.ros_bridge', run_name='__main__')")
    sys.argv = [sys.argv[0], str(private)]
    agent_entry.main()


if __name__ == '__main__':
    {'manager': manager, 'agent': agent}[sys.argv[1]]()
