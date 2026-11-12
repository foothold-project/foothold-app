"""ROS 2 DDS wire layouts, derived from official msg definitions (see README).

Importing types does not construct a participant, reader or writer.
Unbounded ROS wire sequences are bounded before conversion, not redefined on wire.
"""
from dataclasses import dataclass

from cyclonedds.idl import IdlStruct
from cyclonedds.idl.annotations import final, autoid
from cyclonedds.idl.types import int32, uint8, uint32, sequence


@final
@autoid('sequential')
@dataclass
class Time(IdlStruct, typename='builtin_interfaces::msg::dds_::Time_'):
    sec: int32
    nanosec: uint32


@final
@autoid('sequential')
@dataclass
class Header(IdlStruct, typename='std_msgs::msg::dds_::Header_'):
    stamp: Time
    frame_id: str


@final
@autoid('sequential')
@dataclass
class Image(IdlStruct, typename='sensor_msgs::msg::dds_::Image_'):
    header: Header
    height: uint32
    width: uint32
    encoding: str
    is_bigendian: uint8
    step: uint32
    data: sequence[uint8]


@final
@autoid('sequential')
@dataclass
class CompressedImage(IdlStruct, typename='sensor_msgs::msg::dds_::CompressedImage_'):
    header: Header
    format: str
    data: sequence[uint8]
