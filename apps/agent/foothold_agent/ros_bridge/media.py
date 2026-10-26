"""Separate DDS reader/executor thread; never a command publisher or safety lock."""
import threading
import time

from .config import validate_isolation

RGB_TOPIC = '/v2_live/camera/compressed'
POINT_TOPIC = '/v2_map/points'
# Reserved interface with simmgr C; not subscribed/advertised until a source exists.
EXTERNAL_TOPIC = '/v2_live/external_cam/compressed'


class MediaRosSource:
    def __init__(self, media):
        self.media = media
        self.closing = threading.Event()
        self.thread = None
        self.error = None
        self.sim_time = None
        self.stamps = {}

    def update_time(self, epoch, sim_time, received=None):
        if self.sim_time is None or self.sim_time[0] != epoch:
            self.stamps.clear()
        self.sim_time = epoch, sim_time, time.monotonic() if received is None else received

    def fresh(self, channel, message):
        binding, clock, generation = self.media.binding, self.sim_time, self.media.generation
        if binding is None or clock is None or clock[0] != binding['epoch']:
            return False
        try:
            stamp = message.header.stamp.sec + message.header.stamp.nanosec * 1e-9
            if (time.monotonic() - clock[2] > 1 or not -1 <= clock[1] - stamp <= 1
                    or stamp <= self.stamps.get(channel, float('-inf'))):
                return False
            self.stamps[channel] = stamp
            return generation
        except (AttributeError, TypeError):
            return False

    def rgb(self, message):
        generation = self.fresh('rgb', message)
        if generation and message.format.lower() in ('jpeg', 'jpg'):
            self.media.submit('rgb', message.data, expected_generation=generation)

    def cloud(self, message):
        generation = self.fresh('lidar', message)
        if generation:
            self.media.submit_cloud(message, expected_generation=generation)

    def start(self):
        validate_isolation()
        self.thread = threading.Thread(target=self._run, name='media-rclpy', daemon=True)
        self.thread.start()

    def _run(self):
        context = node = executor = None
        try:
            validate_isolation()
            import rclpy
            from rclpy.context import Context
            from rclpy.executors import SingleThreadedExecutor
            from rclpy.qos import qos_profile_sensor_data
            from sensor_msgs.msg import CompressedImage, PointCloud2
            context = Context()
            rclpy.init(args=[], context=context, domain_id=93)
            node = rclpy.create_node('foothold_media_' + self.media.robot.replace('-', ''), context=context,
                enable_rosout=False, start_parameter_services=False, use_global_arguments=False)
            from copy import copy
            qos = copy(qos_profile_sensor_data)
            qos.depth = 1
            if 'rgb' not in self.media.reasons:
                node.create_subscription(CompressedImage, RGB_TOPIC, self.rgb, qos)
            node.create_subscription(PointCloud2, POINT_TOPIC, self.cloud, qos)
            executor = SingleThreadedExecutor(context=context)
            executor.add_node(node)
            while not self.closing.is_set():
                executor.spin_once(timeout_sec=.05)
        except Exception as error:
            self.error = type(error).__name__  # no credentials/ROS message in diagnostics
            self.media.reasons.update(rgb='Media ROS reader unavailable', lidar='Media ROS reader unavailable')
        finally:
            if executor is not None:
                executor.shutdown(timeout_sec=.2)
            if node is not None:
                node.destroy_node()
            if context is not None and context.ok():
                context.shutdown()

    def close(self):
        self.closing.set()
        if self.thread is not None:
            self.thread.join(timeout=.5)
