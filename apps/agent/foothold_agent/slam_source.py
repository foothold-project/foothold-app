"""Point-LIO live / GLIM final adapters; no motion package imports."""
import math
import re

SOURCES=frozenset(('point_lio','glim'))


def dds_topic(value):
    if not value or not re.fullmatch(r'/[A-Za-z0-9_/]{1,150}',value):
        raise ValueError('invalid configured ROS topic')
    return 'rt/'+value.lstrip('/')


class Source:
    def __init__(self,env,source='point_lio'):
        if source not in SOURCES:
            raise ValueError('unsupported SLAM source')
        self.source=source
        prefix='FH_MAPPING_POINT_LIO_' if source=='point_lio' else 'FH_MAPPING_GLIM_'
        self.cloud_name=env.get(prefix+'CLOUD_TOPIC','/cloud_registered' if source=='point_lio' else '')
        self.odom_name=env.get(prefix+'ODOM_TOPIC','/aft_mapped_to_init' if source=='point_lio' else '')
        self.frame=env.get(prefix+'FRAME','')
        self.child_frame=env.get(prefix+'CHILD_FRAME','')
        for frame in (self.frame,self.child_frame):
            if frame and not re.fullmatch(r'[A-Za-z0-9_/-]{1,80}',frame):
                raise ValueError('invalid configured world frame')
        self.cloud_topic=dds_topic(self.cloud_name) if self.cloud_name else ''
        self.odom_topic=dds_topic(self.odom_name) if self.odom_name else ''
        self.map_topic=self.cloud_topic
        self.configured=bool(self.frame and self.cloud_topic and self.odom_topic)
        # Registration does not prove the body origin equals the lidar origin.
        self.input_mode=('scan' if source=='point_lio' and env.get('FH_MAPPING_POINT_LIO_SENSOR_ORIGIN_VERIFIED','').lower()=='true' else 'projection')
        self.final_verified=source=='glim' and env.get('FH_MAPPING_GLIM_FINAL_TOPIC_VERIFIED','').lower()=='true'

    @staticmethod
    def decode_cloud(message,**kwargs):
        from .mapping.pointcloud import decode
        return decode(message,**kwargs)

    def decode_pose(self,message):
        from .mapping.poses import timestamp
        timestamp(message.header.stamp)
        if not self.configured or message.header.frame_id!=self.frame:
            raise ValueError('world frame configuration required')
        if self.child_frame and message.child_frame_id!=self.child_frame:
            raise ValueError('child frame mismatch')
        p,q=message.pose.pose.position,message.pose.pose.orientation
        position,quaternion=(p.x,p.y,p.z),(q.w,q.x,q.y,q.z)
        if not all(type(v) in (int,float) and math.isfinite(v) for v in (*position,*quaternion)):
            raise ValueError('invalid source pose')
        norm=math.hypot(*quaternion)
        if not .9<=norm<=1.1 or any(v< -10000 or v>=10000 for v in position):
            raise ValueError('invalid source pose')
        w,x,y,z=(v/norm for v in quaternion)
        body=dict(source=self.odom_name,provider=self.source,frame_id=self.frame,
            stamp=dict(sec=message.header.stamp.sec,nanosec=message.header.stamp.nanosec),
            x=p.x,y=p.y,z=p.z,yaw=math.atan2(2*(w*z+x*y),1-2*(y*y+z*z)))
        return position,(w,x,y,z),body
