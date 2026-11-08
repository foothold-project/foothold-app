"""Child bootstrap evidence: incomplete exit never proves RosNode absence."""
from contextlib import contextmanager
import json
import os
from pathlib import Path
import sys


def write(path, value):
    temp = path.with_suffix('.pending')
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as stream:
        json.dump(value, stream)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temp, path)


@contextmanager
def monitor(folder):
    path = Path(folder) / 'agent-startup.json'
    evidence = dict(schema=1, complete=False, rosnode_created=False,
                    partition=os.environ.get('GZ_PARTITION'), domain=os.environ.get('ROS_DOMAIN_ID'))
    write(path, evidence)
    previous = sys.getprofile()
    if previous is not None:
        raise RuntimeError('startup profiler already installed')
    def profile(frame, event, arg):
        if (event == 'call' and frame.f_code.co_name == '__init__'
                and frame.f_code.co_filename.endswith('/ros_bridge/node.py')):
            # Conservative: constructor entry counts as creation, even on error.
            evidence['rosnode_created'] = True
            write(path, evidence)
            sys.setprofile(None)  # no profiling overhead once absence is impossible
    sys.setprofile(profile)
    try:
        yield
    finally:
        tracking_intact = evidence['rosnode_created'] or sys.getprofile() is profile
        sys.setprofile(previous)
        evidence['complete'] = tracking_intact
        write(path, evidence)


def run_module(folder, *args, **kwargs):
    import runpy
    with monitor(folder):
        return runpy.run_module(*args, **kwargs)
