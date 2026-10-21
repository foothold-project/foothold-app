"""Read-only domain93 observer. No command publishers, images or point clouds."""
import json
import os
from pathlib import Path
import signal
import sys
import time

from foothold_agent.ros_bridge.config import validate_isolation


def main():
    validate_isolation()
    import rclpy
    from geometry_msgs.msg import Twist
    from std_msgs.msg import String, Empty
    from rclpy.qos import QoSProfile
    rclpy.init(args=[], domain_id=93)
    node = rclpy.create_node('fh_d1_observer_' + str(os.getpid()), use_global_arguments=False)
    folder = Path(sys.argv[1])
    alive = True
    def stop(*_):
        nonlocal alive
        alive = False
    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)
    qos = QoSProfile(depth=1)
    with (folder / 'ros-observations.jsonl').open('a', buffering=1) as log:
        def record(kind, data):
            row = {'mono': time.monotonic(), 'wall': time.time(), 'kind': kind, 'data': data}
            log.write(json.dumps(row) + '\n')
            if kind == 'state':
                temp = folder / 'state.tmp'
                temp.write_text(json.dumps(row))
                temp.replace(folder / 'state.json')
        node.create_subscription(String, '/v2_live/state', lambda m: record('state', json.loads(m.data)), qos)
        node.create_subscription(Twist, '/v2_live/cmd_vel', lambda m: record('cmd', [m.linear.x, m.linear.y, m.angular.z]), qos)
        node.create_subscription(Empty, '/v2_live/stop', lambda m: record('stop', None), qos)
        node.create_subscription(Empty, '/v2_live/resume', lambda m: record('resume', None), qos)
        try:
            while alive:
                rclpy.spin_once(node, timeout_sec=.1)
        finally:
            node.destroy_node()
            rclpy.shutdown()


if __name__ == '__main__':
    main()
