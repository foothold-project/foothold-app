"""Only sensor IDLs are available to the decoder. Never import an RPC client."""
from functools import lru_cache

from ..depth.discovery import COMPRESSED, IMAGE
from ..mapping.inputs import (CLOUD, DEFAULT_TOPIC, FRONTEND, LOCALIZATION, LOW_TOPIC,
                              MAP, ODOM_TOPIC, RAW_TOPIC, SPORT_TOPIC)

CAMERA = 'rt/api/videohub/response'
SYSTEM = 'system'
FIXED = {
    LOW_TOPIC: 'low', SPORT_TOPIC: 'sport', RAW_TOPIC: 'cloud', DEFAULT_TOPIC: 'cloud',
    ODOM_TOPIC: 'odom', MAP: 'cloud', CLOUD: 'cloud', FRONTEND: 'odom', LOCALIZATION: 'odom',
    CAMERA: 'camera',
}
DEPTH = {IMAGE: 'image', COMPRESSED: 'compressed'}


@lru_cache
def types():
    from unitree_sdk2py.idl.unitree_go.msg.dds_ import LowState_, SportModeState_
    from unitree_sdk2py.idl.nav_msgs.msg.dds_ import Odometry_
    from unitree_sdk2py.idl.sensor_msgs.msg.dds_ import PointCloud2_
    from unitree_sdk2py.idl.unitree_api.msg.dds_ import Response_
    from ..depth.idl import Image, CompressedImage
    return dict(low=LowState_, sport=SportModeState_, cloud=PointCloud2_, odom=Odometry_,
                camera=Response_, image=Image, compressed=CompressedImage)
