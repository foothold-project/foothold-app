"""Owned observer unit bootstrap and runtime; never invoked by offline tests."""
import asyncio
import json
import math
import os
from pathlib import Path
import signal
import sys
import threading
import time

BOOTSTRAP = '''import os, sys
sys.path[:0] = [sys.argv[1] + '/apps/agent', sys.argv[1]]
for path in ['/usr/lib/python3/dist-packages']:
    if path not in sys.path: sys.path.append(path)
from apps.simmgr.observer_entry import run
import asyncio
asyncio.run(run(sys.argv[2], sys.argv[3], sys.argv[4]))
'''


def send_pose(gz, values, Pose, Boolean):
    """Only a camera Pose request can leave this adapter."""
    from .external_camera import ENTITY, SERVICE
    x, y, z, _, pitch, yaw = values
    request = Pose()
    request.name = ENTITY
    request.position.x, request.position.y, request.position.z = x, y, z
    cp, sp, cy, sy = math.cos(pitch/2), math.sin(pitch/2), math.cos(yaw/2), math.sin(yaw/2)
    request.orientation.x, request.orientation.y = -sp*sy, sp*cy
    request.orientation.z, request.orientation.w = cp*sy, cp*cy
    ok, response = gz.request(SERVICE, request, Pose, Boolean, 80)
    return ok and response.data


class Images:
    """Gz callback keeps only one bounded RGB image; encoder runs in this unit."""
    def __init__(self):
        self.lock = threading.Lock()
        self.pending = None
        self.last = self.stamp = float('-inf')

    def put(self, image, rgb_type):
        if (image.width != 320 or image.height != 240 or image.step != 960
                or image.pixel_format_type != rgb_type or len(image.data) != 230400
                or not image.HasField('header') or not image.header.HasField('stamp')):
            return
        with self.lock:
            self.pending = (time.monotonic(), image)

    def take(self, observer, sim_t):
        now = time.monotonic()
        if now-self.last < .2:
            return None
        with self.lock:
            item, self.pending = self.pending, None
        if item is None or not observer.fresh() or not isinstance(sim_t, (int, float)):
            return None
        at, image = item
        stamp = image.header.stamp.sec + image.header.stamp.nsec*1e-9
        if not (0 <= now-at <= 1 and self.stamp < stamp and 0 <= sim_t-stamp <= 1):
            return None
        self.last, self.stamp = now, stamp
        return image

    def clear(self):
        with self.lock:
            self.pending = None
        self.stamp = float('-inf')


async def run(robot, episode, socket_path):
    from foothold_agent.ros_bridge.config import validate_isolation
    validate_isolation()
    import re
    if not re.fullmatch(r'fh-srv-[0-9a-f]{12}', os.environ.get('GZ_PARTITION', '')):
        raise ValueError('observer requires owned partition')
    import cv2
    cv2.setNumThreads(1)
    import numpy as np
    import rclpy
    from rclpy.qos import QoSProfile, ReliabilityPolicy
    from sensor_msgs.msg import CompressedImage
    from std_msgs.msg import String
    from gz.transport13 import Node, NodeOptions
    from gz.msgs10.image_pb2 import Image
    from gz.msgs10.pose_pb2 import Pose
    from gz.msgs10.boolean_pb2 import Boolean
    from .external_camera import Observer, ENTITY, SERVICE, GZ_TOPIC, ROS_TOPIC

    observer, images = Observer(robot, episode), Images()
    rclpy.init()
    ros = rclpy.create_node('fh_external_observer')
    qos = QoSProfile(depth=1, reliability=ReliabilityPolicy.BEST_EFFORT)
    publisher = ros.create_publisher(CompressedImage, ROS_TOPIC, qos)
    context = {'sim_t': None}

    def status(message):
        try:
            data = json.loads(message.data)
            if not isinstance(data, dict):
                return
            before = observer.epoch
            observer.status(data)
            if before != observer.epoch:
                images.clear()
                context['sim_t'] = None
        except (ValueError, TypeError, KeyError):
            pass

    def state(message):
        try:
            data = json.loads(message.data)
            if not isinstance(data, dict):
                return
            observer.state(data)
            context['sim_t'] = data.get('sim_t') if observer.fresh() else None
            if observer.position is None:
                images.clear()
        except (ValueError, TypeError, KeyError):
            pass

    ros.create_subscription(String, '/v2_map/status', status, qos)
    ros.create_subscription(String, '/v2_live/state', state, qos)
    options = NodeOptions()
    options.partition = os.environ['GZ_PARTITION']
    gz = Node(options)
    rgb = Image.DESCRIPTOR.fields_by_name['pixel_format_type'].enum_type.values_by_name['RGB_INT8'].number
    if not gz.subscribe(Image, GZ_TOPIC, lambda m: images.put(m, rgb)):
        raise RuntimeError('external image subscription failed')

    async def request(reader, writer):
        result = {'accepted': False}
        try:
            # Private AF_UNIX IPC, one small command, no arbitrary service proxy.
            raw = await asyncio.wait_for(reader.readline(), .3)
            data = json.loads(raw)
            if not isinstance(data, dict) or set(data) != {'op', 'request'}:
                raise ValueError('invalid envelope')
            result = (observer.discard(data['request']) if data['op'] == 'discard'
                      else observer.submit(data['request'], data['op']))
        except (ValueError, TypeError, asyncio.TimeoutError):
            result = {'accepted': False}
        finally:
            try:
                writer.write(json.dumps(result).encode() + b'\n')
                await asyncio.wait_for(writer.drain(), .1)
            finally:
                writer.close()
                await writer.wait_closed()

    # Episode parent is private (0700); the socket is private as well.
    server = await asyncio.start_unix_server(request, path=socket_path, limit=4096, backlog=2)
    os.chmod(socket_path, 0o600)
    stopped = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stopped.set)
    try:
        while not stopped.is_set():
            rclpy.spin_once(ros, timeout_sec=0)
            observer.tick(lambda values: send_pose(gz, values, Pose, Boolean))
            image = images.take(observer, context['sim_t'])
            if image is not None:
                pixels = np.frombuffer(image.data, np.uint8).reshape(240, 320, 3)
                ok, jpg = cv2.imencode('.jpg', pixels[:, :, ::-1], [cv2.IMWRITE_JPEG_QUALITY, 70])
                if ok and len(jpg) <= 65536:
                    msg = CompressedImage()
                    msg.header.stamp.sec = image.header.stamp.sec
                    msg.header.stamp.nanosec = image.header.stamp.nsec
                    msg.header.frame_id, msg.format, msg.data = 'fh_external_camera', 'jpeg', jpg.tobytes()
                    publisher.publish(msg)
            await asyncio.sleep(.01)
    finally:
        observer.pending = None
        images.clear()
        server.close()
        await server.wait_closed()
        gz.unsubscribe(GZ_TOPIC)
        ros.destroy_node()
        rclpy.shutdown()
        Path(socket_path).unlink(missing_ok=True)


def main():
    private = Path(sys.argv[1])
    config = json.loads(private.read_text())
    private.unlink()
    script = 'set -e; source "$1"; exec "$2" -c "$3" "$4" "$5" "$6" "$7"'
    os.execve('/bin/bash', ['/bin/bash', '-c', script, 'simmgr-observer',
        config['setup'], config['python'], BOOTSTRAP, config['root'],
        config['robot'], config['episode'], config['socket']], config['env'])


if __name__ == '__main__':
    main()
