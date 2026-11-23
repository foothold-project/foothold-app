#!/bin/bash
# D435i 깊이 켜기 + 끊김 기록 (팀장 11/23 11:23). ROS_LOCALHOST_ONLY=1 로 영상이 로봇 유선 랜에 나가지 않게.
source /opt/ros/humble/setup.bash
export ROS_LOCALHOST_ONLY=1
ros2 launch realsense2_camera rs_launch.py enable_color:=false enable_infra1:=false enable_infra2:=false \
  depth_module.depth_profile:=640x480x30 initial_reset:=false > "$HOME/foothold-policy-1122/depth-camera.log" 2>&1 &
CAM=$!
trap 'kill -INT $CAM 2>/dev/null; wait $CAM' EXIT INT TERM
cd "$HOME/foothold-policy-1122/run"
PYTHONPATH="$HOME/foothold-policy-1122/run:$PYTHONPATH" python3 -m foothold_agent.policy.depth_health --out ../trace
