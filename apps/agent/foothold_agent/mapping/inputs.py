"""Shared read-only DDS subscribers on an already initialized NIC/participant."""
import threading

DEFAULT_TOPIC = 'rt/utlidar/cloud'


class Handle:
    def __init__(self, bus, topic, callback):
        self.bus, self.topic, self.callback = bus, topic, callback

    def Close(self):
        self.bus.remove(self.topic, self.callback)


class CloudBus:
    def __init__(self):
        self.lock = threading.RLock()
        self.topics = {}

    def subscribe(self, topic, callback):
        from unitree_sdk2py.core.channel import ChannelSubscriber
        from unitree_sdk2py.idl.sensor_msgs.msg.dds_ import PointCloud2_
        with self.lock:
            if topic not in self.topics:
                sub = ChannelSubscriber(topic, PointCloud2_)
                callbacks = set()
                self.topics[topic] = sub, callbacks
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
        if sub:
            sub.Close()

    def close(self):
        with self.lock:
            entries, self.topics = self.topics, {}
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

    def add_sport_listener(self, callback):
        self.sport_listeners = (*self.sport_listeners, callback)

    def sport(self, primary, message):
        primary(message)  # preserve original safety feedback first
        for callback in self.sport_listeners:
            try:
                callback(message)
            except Exception:
                pass
