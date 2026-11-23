"""D435i 깊이가 끊기지 않고 들어오는지 1 초마다 한 줄 (팀장 11/23 11:23). ROS 2 realsense2_camera 의 깊이 주제를 구독만 한다.

  source /opt/ros/humble/setup.bash && ROS_LOCALHOST_ONLY=1 python3 -m foothold_agent.policy.depth_health --out ~/foothold-policy-1122/trace

한 줄: wall · 받은 장 수 · 가장 긴 틈 (ms) · 영상 크기 · 0 값 (미검출) 비율. 같은 줄을 status 파일에도 덮어써서 원격에서 바로 읽는다.
ROS_LOCALHOST_ONLY=1: 카메라 영상이 로봇 유선 랜 (DDS · LowState) 으로 나가지 않게.
"""
from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

TOPIC = '/camera/camera/depth/image_rect_raw'


def summarize(stamps, sizes, zero_fracs, now, carried=0):
    gaps = [b - a for a, b in zip(stamps, stamps[1:])]
    return {'wall': round(now, 3), 'frames': len(stamps) - carried, 'max_gap_ms': round(max(gaps) * 1e3, 1) if gaps else None,
            'size': sizes[-1] if sizes else None, 'zero_frac': round(sum(zero_fracs) / len(zero_fracs), 4) if zero_fracs else None}


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', required=True, type=Path)
    ap.add_argument('--topic', default=TOPIC)
    a = ap.parse_args(argv)
    import numpy as np
    import rclpy
    from rclpy.qos import qos_profile_sensor_data
    from sensor_msgs.msg import Image
    a.out.mkdir(parents=True, exist_ok=True)
    log = open(a.out / f'depth-health-{time.strftime("%Y%m%d-%H%M%S")}.jsonl', 'a')
    status = a.out / 'depth-health-status.json'
    rclpy.init()
    node = rclpy.create_node('foothold_depth_health')
    stamps, sizes, zeros = [], [], []

    def on_img(msg):
        stamps.append(time.monotonic())
        sizes.append([msg.width, msg.height])
        if len(stamps) % 5 == 1 and msg.encoding == '16UC1':   # 5 장에 한 번만 0 값 비율 (CPU)
            d = np.frombuffer(msg.data, np.uint16)
            zeros.append(float((d == 0).mean()))
    node.create_subscription(Image, a.topic, on_img, qos_profile_sensor_data)
    last, carried = time.monotonic(), 0
    try:
        while rclpy.ok():
            rclpy.spin_once(node, timeout_sec=.1)
            if time.monotonic() - last >= 1.:
                row = summarize(stamps, sizes, zeros, time.time(), carried=carried)
                log.write(json.dumps(row) + '\n'); log.flush()
                status.write_text(json.dumps(row))
                stamps[:] = stamps[-1:]; sizes.clear(); zeros.clear()
                carried = len(stamps)   # 앞 창의 마지막 장은 틈 계산에만 씀
                last = time.monotonic()
    except KeyboardInterrupt:
        pass
    finally:
        log.close()
        node.destroy_node()
        if rclpy.ok():
            rclpy.shutdown()


if __name__ == '__main__':
    main()
