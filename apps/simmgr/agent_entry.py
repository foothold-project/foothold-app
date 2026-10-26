"""Transient-unit bootstrap. Read private child env once; preserve venv precedence."""
import json
import os
from pathlib import Path
import sys

BOOTSTRAP = '''import json, os, runpy, sys
sys.path[:0] = [sys.argv[1] + '/apps/agent', sys.argv[1]]
# ROS setup supplies bindings; venv packages retain priority over system copies.
for path in os.environ.pop('FH_AGENT_ROS_PATH', '').split(os.pathsep) + ['/usr/lib/python3/dist-packages']:
    if path and path not in sys.path:
        sys.path.append(path)
runpy.run_module('foothold_agent.ros_bridge', run_name='__main__',
    init_globals={'_simmgr_launch_proof': json.loads(sys.argv[2]) if len(sys.argv) > 2 else None})
'''


def main():
    private = Path(sys.argv[1])
    config = json.loads(private.read_text())
    private.unlink()  # no durable credential copy after exec
    script = ('set -e; source "$1"; export FH_AGENT_ROS_PATH="${PYTHONPATH:-}"; '
              'unset PYTHONPATH; exec "$2" -c "$3" "$4" "$5"')
    os.execve('/bin/bash', ['/bin/bash', '-c', script, 'simmgr-agent',
              config['setup'], config['python'], BOOTSTRAP, config['root'],
              json.dumps(config.get('simulation_binding'))], config['env'])


if __name__ == '__main__':
    main()
