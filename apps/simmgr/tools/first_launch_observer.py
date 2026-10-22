"""Read-only domain93 observer, started after RUNNING and exited before DELETE."""
from pathlib import Path
import runpy
import sys


if __name__ == '__main__':
    if '--dry-run' in sys.argv:
        from foothold_agent.ros_bridge.config import validate_isolation
        validate_isolation()
        import rclpy
        from geometry_msgs.msg import Twist
        from std_msgs.msg import String, Empty
        from rclpy.qos import QoSProfile
        print('ROS setup and observer imports ready; rclpy.init not called; domain93 participation=0')
        raise SystemExit(0)
    # Reuse the established state/cmd/STOP observer; no publishers or frame storage.
    runpy.run_path(str(Path(__file__).resolve().parents[2] / 'agent/tools/sim/observe.py'), run_name='__main__')
