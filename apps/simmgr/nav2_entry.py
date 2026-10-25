"""Child-only bootstrap; ROS imports occur only after isolated setup and exec."""
import json
import os
from pathlib import Path
import sys

BOOTSTRAP = '''import os, sys
sys.path[:0] = [sys.argv[1] + '/apps/agent', sys.argv[1]]
from foothold_agent.ros_bridge.config import validate_isolation
validate_isolation()
from apps.agent.tools.nav2.launch_nav2 import generate_launch_description
from launch import LaunchService
from launch.actions import EmitEvent, RegisterEventHandler
from launch.event_handlers import OnProcessExit
from launch.events import Shutdown
service = LaunchService()
description = generate_launch_description()
description.add_action(RegisterEventHandler(OnProcessExit(on_exit=[
    EmitEvent(event=Shutdown(reason='owned Nav2 process exited'))])))
service.include_launch_description(description)
raise SystemExit(service.run())
'''


def main():
    private = Path(sys.argv[1])
    config = json.loads(private.read_text())
    private.unlink()
    script = 'set -e; source "$1"; exec /usr/bin/python3 -c "$2" "$3"'
    os.execve('/bin/bash', ['/bin/bash', '-c', script, 'simmgr-nav2',
              config['setup'], BOOTSTRAP, config['root']], config['env'])


if __name__ == '__main__':
    main()
