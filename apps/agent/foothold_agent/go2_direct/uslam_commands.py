"""Lazy String-only DDS boundary, constructed exclusively on observation workers."""
COMMAND_TOPIC = 'rt/uslam/client_command'
LOG_TOPIC = 'rt/uslam/server_log'
ALLOWED = frozenset(('mapping/start', 'mapping/stop'))


class CommandChannel:
    def __init__(self, callback, allowed):
        self.callback, self.allowed = callback, allowed
        self.reader = self.writer = None

    def open(self):
        from unitree_sdk2py.core.channel import ChannelSubscriber
        from unitree_sdk2py.idl.std_msgs.msg.dds_ import String_
        self.reader = ChannelSubscriber(LOG_TOPIC, String_)
        self.reader.Init(self.callback, 0)  # response subscription before writer

    def publish(self, value):
        if value not in ALLOWED or not self.allowed() or self.reader is None:
            raise PermissionError('SLAM command unavailable')
        from unitree_sdk2py.core.channel import ChannelPublisher
        from unitree_sdk2py.idl.std_msgs.msg.dds_ import String_
        if self.writer is None:
            self.writer = ChannelPublisher(COMMAND_TOPIC, String_)
            self.writer.Init()
        if not self.allowed():
            raise PermissionError('SLAM command unavailable')
        if self.writer.Write(String_(data=value)) is False:
            raise OSError('SLAM command write failed')

    def close(self):
        for handle in (self.reader, self.writer):
            if handle is not None:
                try:
                    handle.Close()
                except Exception:
                    pass
        self.reader = self.writer = None
