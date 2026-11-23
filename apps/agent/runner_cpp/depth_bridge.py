"""Publish normalized D435i depth to a local START runner depth socket."""
import argparse
import math
import os
import socket
import struct
import time

import numpy as np

from foothold_agent.policy.depth import DepthResampler


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--socket", required=True)
    parser.add_argument("--topic", default="/camera/camera/depth/image_rect_raw")
    parser.add_argument("--camera-info", default="/camera/camera/depth/camera_info")
    args = parser.parse_args()

    if os.environ.setdefault("ROS_LOCALHOST_ONLY", "1") != "1":
        raise SystemExit("the D435i bridge requires ROS_LOCALHOST_ONLY=1")
    import rclpy
    from rclpy.qos import qos_profile_sensor_data
    from sensor_msgs.msg import CameraInfo, Image

    rclpy.init()
    node = rclpy.create_node("foothold_start_depth_bridge")
    destination = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
    destination.setblocking(False)
    calibration = None
    resampler = None

    def info(message):
        nonlocal calibration, resampler
        candidate = (message.k[0], message.k[4], message.k[2], message.k[5],
                     message.width, message.height, message.header.frame_id)
        fx, fy, cx, cy, width, height, frame = candidate
        if (candidate == calibration or not frame or min(width, height) <= 0
                or not all(map(math.isfinite, (fx, fy, cx, cy))) or min(fx, fy) <= 0):
            return
        resampler = DepthResampler(fx, fy, cx, cy, width, height)
        calibration = candidate
        node.get_logger().info(f"D435i policy depth grid coverage {resampler.coverage:.3f}")

    def image(message):
        observed = time.monotonic_ns()
        if calibration is None or message.encoding != "16UC1":
            return
        width, height, frame = calibration[-3:]
        if (message.width, message.height, message.header.frame_id) != (width, height, frame):
            return
        if message.step < width * 2 or len(message.data) != message.step * height:
            return
        source = np.ndarray((height, width), dtype=">u2" if message.is_bigendian else "<u2",
                            buffer=message.data, strides=(message.step, 2))
        depth = resampler(source).astype("<f4", copy=False)
        packet = struct.pack("<Q", observed) + depth.tobytes()
        try:
            destination.sendto(packet, args.socket)
        except (BlockingIOError, FileNotFoundError, ConnectionRefusedError):
            # The runner may start later or restart. Never build a frame backlog.
            pass

    subscriptions = (
        node.create_subscription(CameraInfo, args.camera_info, info, qos_profile_sensor_data),
        node.create_subscription(Image, args.topic, image, qos_profile_sensor_data),
    )
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        for subscription in subscriptions:
            node.destroy_subscription(subscription)
        destination.close()
        node.destroy_node()
        rclpy.try_shutdown()


if __name__ == "__main__":
    main()
