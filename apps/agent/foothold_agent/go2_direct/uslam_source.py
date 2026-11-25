"""Unitree SLAM source adapter: all onboard topic/frame/protocol assumptions.

Calculation and bundle storage consume world points plus a matching pose. A
future source adapter can supply those without changing their grid/voxel shape.
SDK imports remain lazy and belong exclusively to this observation boundary.
"""
import re

CLOUD = 'rt/uslam/frontend/cloud_world_ds'
MAP = 'rt/uslam/cloud_map'
FRONTEND = 'rt/uslam/frontend/odom'
LOCALIZATION = 'rt/uslam/localization/odom'
COMMAND_TOPIC = 'rt/uslam/client_command'
LOG_TOPIC = 'rt/uslam/server_log'
START, STOP = 'mapping/start', 'mapping/stop'
ALLOWED = frozenset((START, STOP))


class UnitreeSource:
    source = 'unitree_uslam'
    cloud_topic, map_topic, odom_topic = CLOUD, MAP, FRONTEND
    start_command, stop_command = START, STOP

    def __init__(self, env):
        self.env = env
        self.frame = env.get('FH_USLAM_FRAME', 'map')
        self.child_frame = env.get('FH_USLAM_CHILD_FRAME', 'base_link')
        if any(not isinstance(value,str) or not re.fullmatch(r'[A-Za-z0-9_/-]{1,80}', value)
               for value in (self.frame,self.child_frame)):
            raise ValueError('invalid observation frame configuration')
        self.acknowledgments = {k:v for k,v in (
            (START,env.get('FH_USLAM_START_ACK')), (STOP,env.get('FH_USLAM_STOP_ACK'))) if v}

    @property
    def input_mode(self):
        return self.env.get('FH_USLAM_INPUT','projection')

    def commands_enabled(self):
        return self.env.get('FH_USLAM_COMMANDS') == '1'

    @staticmethod
    def decode_cloud(message, **kwargs):
        from .uslam import cloud
        return cloud(message, **kwargs)

    def decode_pose(self, message):
        from .uslam import odometry
        if message.header.frame_id != self.frame or message.child_frame_id != self.child_frame:
            raise ValueError('invalid source pose frame')
        header, _ = odometry(message,self.odom_topic)
        p,q = message.pose.pose.position,message.pose.pose.orientation
        body = dict(source='/uslam/frontend/odom',frame_id=self.frame,
            stamp=dict(sec=message.header.stamp.sec,nanosec=message.header.stamp.nanosec),**header['pose'])
        return (p.x,p.y,p.z),(q.w,q.x,q.y,q.z),body

    @staticmethod
    def command_channel(callback, allowed):
        return CommandChannel(callback,allowed)


class CommandChannel:
    def __init__(self, callback, allowed):
        self.callback, self.allowed = callback, allowed
        self.reader = self.writer = None

    def open(self):
        from unitree_sdk2py.core.channel import ChannelSubscriber
        from unitree_sdk2py.idl.std_msgs.msg.dds_ import String_
        self.reader = ChannelSubscriber(LOG_TOPIC, String_)
        self.reader.Init(self.callback, 0)

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
        for handle in (self.reader,self.writer):
            if handle is not None:
                try:
                    handle.Close()
                except Exception:
                    pass
        self.reader = self.writer = None
