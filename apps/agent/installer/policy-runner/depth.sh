#!/bin/bash
# D435i 깊이 켜기 + 끊김 기록 (팀장 11/23 11:23). ROS_LOCALHOST_ONLY=1 로 영상이 로봇 유선 랜에 나가지 않게.
# 11/24: (1) 부팅 직후 시계 맞춤 (NTP) 을 최대 90 초 기다린 뒤 켬. 카메라가 먼저 켜지면 시계가 뒤에 바뀌어
#            깊이 지연 값이 -1276 ms 처럼 어긋났음 (12:18 재부팅). 인터넷이 없으면 90 초 뒤 그대로 켬.
#        (3) 지연이 음수거나 0.5 초를 5 초 이어 넘으면 (시계 어긋남) 다시 켬 · START 중에는 안 함.
#        (2) 깊이가 들어오다가 10 초 이어 0 장이면 (11:37 VIDIOC_QBUF 오류 뒤 40 분 0 장) 실패로 끝내
#            systemd 가 10 초 뒤 다시 켬 (Restart=on-failure). 켠 뒤 90 초 안에 한 장도 없어도 같음.
source /opt/ros/humble/setup.bash
export ROS_LOCALHOST_ONLY=1
for _ in $(seq 90); do
  [ "$(timedatectl show -p NTPSynchronized --value 2>/dev/null)" = yes ] && break
  sleep 1
done
TRACE="$HOME/foothold-policy-1122/trace"
rm -f "$TRACE/depth-health-status.json"   # 앞 실행의 상태 파일을 「이미 들어옴」 으로 잘못 읽지 않게 (12:24:44 실행이 13 초 만에 다시 켜짐)
taskset -c 0-3 ros2 launch realsense2_camera rs_launch.py enable_color:=false enable_infra1:=false enable_infra2:=false \
  depth_module.depth_profile:=640x480x30 initial_reset:=false > "$TRACE/depth-camera-$(date +%Y%m%d-%H%M%S).log" 2>&1 &
CAM=$!
cd "$HOME/foothold-policy-1122/run"
PYTHONPATH="$HOME/foothold-policy-1122/run:$PYTHONPATH" python3 -m foothold_agent.policy.depth_health --out ../trace &
HEALTH=$!
trap 'kill -INT $HEALTH $CAM 2>/dev/null; wait $HEALTH $CAM' EXIT INT TERM
seen=0; zero=0; t=0
while kill -0 $HEALTH 2>/dev/null && kill -0 $CAM 2>/dev/null; do
  sleep 1; t=$((t + 1))
  read -r n badlat < <(python3 -c "import json,sys,time;d=json.load(open(sys.argv[1]));ok=time.time()-d['wall']<3;l=d.get('lat_ms_p50');print((d.get('frames') or 0) if ok else 0, int(ok and l is not None and (l<0 or l>500)))" "$TRACE/depth-health-status.json" 2>/dev/null || echo "0 0")
  if [ "$n" -gt 0 ]; then seen=1; zero=0; else zero=$((zero + 1)); fi
  # 11/24 팀장: 시계가 카메라보다 늦게 맞춰져 지연이 터무니없으면 (음수 · 0.5 초 넘음) 5 초 이어질 때 카메라를 다시 켬.
  # START (우리 모드) 중에는 다시 켜지 않음 (걷는 중 깊이가 몇 초 끊기지 않게 · 기록만 남음).
  if [ "${badlat:-0}" = 1 ] && [ ! -e /tmp/foothold-start-active ]; then badn=$((${badn:-0} + 1)); else badn=0; fi
  if [ "${badn:-0}" -ge 5 ]; then echo "depth: 지연 값이 5 초 이어 터무니없음 (시계 어긋남) → 다시 켬"; exit 1; fi
  if [ $seen = 1 ] && [ $zero -ge 10 ]; then echo "depth: 10 초 이어 0 장 → 다시 켬"; exit 1; fi
  if [ $seen = 0 ] && [ $t -ge 90 ]; then echo "depth: 90 초 동안 한 장도 없음 → 다시 켬"; exit 1; fi
done
echo "depth: 카메라 또는 기록이 끝남 → 다시 켬"; exit 1
