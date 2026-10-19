"""Approval-gated launch DESCRIPTION only; importing never initializes ROS.

A3a-2 supplies the process/cgroup/isolation supervisor; this is not a launcher.
No recovery/smoother/collision/docking node is implicitly brought up.
"""
import os
from pathlib import Path

# Every potential command-producing role has an explicit disposition. Adding a
# role requires review: none may publish directly into the bridge command set.
COMMAND_ROLES = {
    'controller_server': '/fh_nav/intent',
    'behavior_server': '/fh_nav/intent',  # zero configured behaviors
    'velocity_smoother': 'DISABLED',
    'collision_monitor': 'DISABLED',
    'docking_server': 'DISABLED',
    'waypoint_follower': 'DISABLED',
}


def generate_launch_description():
    if os.environ.get('FH_NAV2_EXECUTE') != '1':
        raise RuntimeError('A3a-2 approval and FH_NAV2_EXECUTE=1 required')
    from foothold_agent.ros_bridge.config import validate_isolation
    validate_isolation()
    from launch import LaunchDescription
    from launch_ros.actions import Node
    params = str(Path(__file__).with_name('nav2_params.yaml'))
    bt = str(Path(__file__).with_name('straight.xml'))
    nodes = []
    for package, executable in (
            ('nav2_controller', 'controller_server'), ('nav2_planner', 'planner_server'),
            ('nav2_behaviors', 'behavior_server'), ('nav2_bt_navigator', 'bt_navigator')):
        overrides = {'use_sim_time': True}
        if executable == 'bt_navigator':
            overrides['default_nav_to_pose_bt_xml'] = bt
        nodes.append(Node(package=package, executable=executable, name=executable,
                          parameters=[params, overrides], output='screen',
                          remappings=[('cmd_vel', '/fh_nav/intent'),
                                      ('cmd_vel_nav', '/fh_nav/intent'),
                                      ('cmd_vel_smoothed', '/fh_nav/intent')]))
    nodes.append(Node(package='nav2_lifecycle_manager', executable='lifecycle_manager',
                      name='fh_nav_lifecycle_manager', parameters=[{
                          'use_sim_time': True, 'autostart': True,
                          'node_names': ['controller_server', 'planner_server', 'behavior_server', 'bt_navigator']}]))
    return LaunchDescription(nodes)
