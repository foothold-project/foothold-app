"""Optional installed ROS/Cyclone serialization check; never calls rclpy.init.

Enable FH_TEST_DEPTH_WIRE=1 with ROS Python/library import paths. This compares
official ROS 2 CDR bytes offline and never constructs a domain or participant.
"""
import os

import pytest

pytestmark = pytest.mark.skipif(os.environ.get('FH_TEST_DEPTH_WIRE') != '1',
                               reason='optional ROS 2/Cyclone offline wire comparison')


@pytest.mark.parametrize('compressed',[False,True])
def test_official_ros2_cdr_matches_depth_types(compressed):
    from rclpy.serialization import serialize_message
    from sensor_msgs.msg import Image as ROSImage, CompressedImage as ROSCompressed
    from std_msgs.msg import Header as ROSHeader
    from builtin_interfaces.msg import Time as ROSTime
    from foothold_agent.depth.idl import Image, Header, Time, CompressedImage
    from cyclonedds.qos import Qos, Policy
    ros_header=ROSHeader(stamp=ROSTime(sec=1,nanosec=2),frame_id='depth_optical_frame')
    header=Header(Time(1,2),'depth_optical_frame')
    if compressed:
        official=ROSCompressed(header=ros_header,format='16UC1; compressedDepth png',data=[1,2,3])
        wire=CompressedImage(header,'16UC1; compressedDepth png',[1,2,3])
    else:
        official=ROSImage(header=ros_header,height=2,width=3,encoding='16UC1',is_bigendian=0,step=6,data=[0]*12)
        wire=Image(header,2,3,'16UC1',0,6,[0]*12)
    encoded=serialize_message(official)
    assert encoded==wire.serialize(use_version_2=False)
    assert type(wire).deserialize(encoded)==wire
    # Instantiate QoS value objects only, never a DDS Entity.
    qos=Qos(Policy.Reliability.BestEffort,Policy.Durability.Volatile,
        Policy.History.KeepLast(1),Policy.ResourceLimits(max_samples=1,max_instances=1,max_samples_per_instance=1),
        Policy.DataRepresentation(use_cdrv0_representation=True),
        Policy.TypeConsistency.AllowTypeCoercion(ignore_member_names=True))
    assert qos[Policy.History].depth==1
