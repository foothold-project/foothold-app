"""Shared read-only DDS subscribers on an already initialized NIC/participant."""
import threading

LOW_TOPIC = 'rt/lowstate'
SPORT_TOPIC = 'rt/sportmodestate'
RAW_TOPIC = 'rt/utlidar/cloud'
DEFAULT_TOPIC = 'rt/utlidar/cloud_deskewed'
ODOM_TOPIC = 'rt/utlidar/robot_odom'

CLOUD = 'rt/uslam/frontend/cloud_world_ds'
MAP = 'rt/uslam/cloud_map'
FRONTEND = 'rt/uslam/frontend/odom'
LOCALIZATION = 'rt/uslam/localization/odom'


class Handle:
    def __init__(self, bus, topic, callback):
        self.bus, self.topic, self.callback = bus, topic, callback

    def Close(self):
        self.bus.remove(self.topic, self.callback)


class CloudBus:
    def __init__(self):
        self.lock = threading.RLock()
        self.topics = {}
        self.types = {}

    def subscribe(self, topic, callback, *, odometry=False, pose_type=None):
        from unitree_sdk2py.core.channel import ChannelSubscriber
        kind=pose_type or ('Odometry' if odometry else 'PointCloud2')
        if kind=='PoseStamped':
            from unitree_sdk2py.idl.geometry_msgs.msg.dds_ import PoseStamped_ as Message
        elif kind=='Odometry':
            from unitree_sdk2py.idl.nav_msgs.msg.dds_ import Odometry_ as Message
        elif kind=='PointCloud2':
            from unitree_sdk2py.idl.sensor_msgs.msg.dds_ import PointCloud2_ as Message
        else:
            raise ValueError('unsupported observation type')
        with self.lock:
            if topic in self.types and self.types[topic]!=kind:
                raise ValueError('conflicting observation types')
            if topic not in self.topics:
                sub = ChannelSubscriber(topic, Message)
                callbacks = set()
                self.topics[topic] = sub, callbacks
                self.types[topic] = kind
                def dispatch(message):
                    with self.lock:
                        listeners = tuple(callbacks)
                    for listener in listeners:
                        try:
                            listener(message)
                        except Exception:
                            pass  # one observation cannot break another or safety
                try:
                    sub.Init(dispatch, 0)
                except BaseException:
                    self.topics.pop(topic, None)
                    self.types.pop(topic, None)
                    sub.Close()
                    raise
            self.topics[topic][1].add(callback)
        return Handle(self, topic, callback)

    def remove(self, topic, callback):
        sub = None
        with self.lock:
            entry = self.topics.get(topic)
            if entry:
                entry[1].discard(callback)
                if not entry[1]:
                    sub, _ = self.topics.pop(topic)
                    self.types.pop(topic, None)
        if sub:
            sub.Close()

    def close(self):
        with self.lock:
            entries, self.topics = self.topics, {}
            self.types = {}
        for sub, _ in entries.values():
            try:
                sub.Close()
            except Exception:
                pass


class ObservationInputs:
    """No new participant; callbacks never touch a motion interface."""
    def init_observations(self):
        self.cloud_bus = CloudBus()
        self.sport_listeners = ()

    def cloud(self, topic, callback):
        return self.cloud_bus.subscribe(topic, callback)

    def odometry(self, callback):
        return self.cloud_bus.subscribe(ODOM_TOPIC, callback, odometry=True)

    def add_sport_listener(self, callback):
        self.sport_listeners = (*self.sport_listeners, callback)

    def remove_sport_listener(self, callback):
        self.sport_listeners = tuple(c for c in self.sport_listeners if c != callback)

    def sport(self, primary, message):
        primary(message)  # preserve original safety feedback first
        for callback in self.sport_listeners:
            try:
                callback(message)
            except Exception:
                pass
