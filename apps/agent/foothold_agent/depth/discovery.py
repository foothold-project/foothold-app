"""Camera publisher metadata only; enumerating never creates an image reader."""
IMAGE = 'sensor_msgs::msg::dds_::Image_'
COMPRESSED = 'sensor_msgs::msg::dds_::CompressedImage_'
TYPES = (IMAGE, COMPRESSED)
DEFAULT_TOPICS = (
    'rt/camera/depth/image_rect_raw', 'rt/camera/depth/image_raw',
    'rt/camera/camera/depth/image_rect_raw',
    'rt/camera/aligned_depth_to_color/image_raw', 'rt/depth/image_raw',
)
EMPTY = '로봇 쪽에서 뎁스 영상을 내보내지 않고 있습니다 — 확장 장치에서 카메라 프로그램을 켜야 합니다'
CHECKING = '로봇에서 보내는 영상 목록을 확인하고 있습니다'
UNAVAILABLE = '영상 목록을 확인할 수 없습니다 — 연결 프로그램의 depth 설치와 기체 전용 유선 연결을 확인하세요'


def topic_name(value):
    if not isinstance(value, str) or not value or len(value) > 256 or any(ord(c) < 33 for c in value):
        raise ValueError('bounded DDS topic name required')
    return 'rt'+value if value.startswith('/') else value


def image_topics(endpoints):
    rows = {}
    for item in endpoints:
        name, kind = getattr(item, 'topic_name', None), getattr(item, 'type_name', None)
        if (not isinstance(name, str) or not isinstance(kind, str) or len(name) > 256 or len(kind) > 256
                or any(ord(c) < 32 for c in name+kind)
                or not any(word in (name+' '+kind).casefold() for word in ('image', 'depth', 'camera'))):
            continue
        rows[name, kind] = dict(name=name, type=kind, supported=kind in TYPES)
    return [rows[key] for key in sorted(rows)[:64]]


def choose(rows, requested=None):
    supported = [row for row in rows if row['supported']]
    if requested:
        requested = topic_name(requested)
        matching = [row for row in supported if row['name'] == requested]
        return matching[0] if len(matching) == 1 else None
    for name in DEFAULT_TOPICS:
        matching = [row for row in supported if row['name'] == name]
        if len(matching) == 1:
            return matching[0]
    depth = [row for row in supported if 'depth' in row['name'].casefold()]
    return depth[0] if len(depth) == 1 else None


def notice(rows, selected):
    if not rows:
        return EMPTY
    if selected is None:
        return '보이는 영상 중 뎁스 영상을 고르세요 — 이름만으로 깊이 자료인지는 확인할 수 없습니다'
    return '뎁스 영상 수신 대기 — 실제 깊이 자료를 받으면 웹·폰에 표시합니다'


def shared_participant():
    # Pinned Unitree SDK has no public participant accessor. Reuse its exact
    # domain-0/NIC participant; fail closed if it has not already been opened.
    # Do not call ChannelFactoryInitialize or construct DomainParticipant here.
    from unitree_sdk2py.core.channel import ChannelFactory
    factory = ChannelFactory()
    participant = getattr(factory, '_ChannelFactory__participant', None)
    if not getattr(factory, '_ChannelFactory__initialized', False) or participant is None:
        raise RuntimeError('existing read-only DDS channel required')
    return participant


class Discovery:
    def __init__(self, participant):
        from cyclonedds.builtin import BuiltinDataReader, BuiltinTopicDcpsPublication
        self.reader = BuiltinDataReader(participant, BuiltinTopicDcpsPublication)
        self.endpoints = {}

    def poll(self):
        from cyclonedds.core import InstanceState
        for item in self.reader.take(64):
            info = item.sample_info
            if not info.valid_data or info.instance_state != InstanceState.Alive:
                self.endpoints.pop(item.key, None)
            elif item.key in self.endpoints or len(self.endpoints) < 256:
                self.endpoints[item.key] = item
        return image_topics(self.endpoints.values())

    def close(self):
        self.reader = None
        self.endpoints.clear()


class Images:
    def __init__(self, participant, selected):
        from cyclonedds.topic import Topic
        from cyclonedds.sub import DataReader
        from cyclonedds.qos import Qos, Policy
        from .idl import Image, CompressedImage
        self.topic = Topic(participant, selected['name'], Image if selected['type'] == IMAGE else CompressedImage)
        self.reader = DataReader(participant, self.topic, qos=Qos(
            Policy.Reliability.BestEffort, Policy.Durability.Volatile,
            Policy.History.KeepLast(1), Policy.ResourceLimits(max_samples=1, max_instances=1, max_samples_per_instance=1),
            Policy.DataRepresentation(use_cdrv0_representation=True),
            Policy.TypeConsistency.AllowTypeCoercion(ignore_member_names=True)))

    def take(self):
        from cyclonedds.internal import InvalidSample
        return [item for item in self.reader.take(1) if not isinstance(item, InvalidSample)]

    def close(self):
        self.reader = self.topic = None
