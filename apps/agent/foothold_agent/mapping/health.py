"""Read-only Point-LIO preflight, independent of session accumulation."""
import math

from .poses import timestamp

FRESH_SECONDS = .5
MAX_POSITION_JUMP_M = 2.0


class PointLioHealth:
    def __init__(self, source, now):
        self.source, self.now = source, now
        self.state = None, None, None

    @property
    def error(self):
        return self.state[2]

    def fresh(self):
        at = self.now()
        pose, cloud, error = self.state
        return (error is None and pose is not None and cloud is not None
                and 0 <= at-pose[0] <= FRESH_SECONDS
                and 0 <= at-cloud[0] <= FRESH_SECONDS
                and abs(pose[1]-cloud[1]) <= 250_000_000)

    def update(self, samples):
        """Validate without writing session odometry, stamps, cells or progress."""
        source = self.source
        pose, cloud, error = self.state
        fault = None
        for topic, is_pose in ((source.odom_topic, True), (source.cloud_topic, False)):
            if topic not in samples:
                continue
            received, message = samples[topic]
            try:
                if not 0 <= self.now()-received <= FRESH_SECONDS:
                    raise ValueError('stale_pointlio')
                stamp = timestamp(message.header.stamp)
                previous = pose if is_pose else cloud
                if previous and stamp <= previous[1]:
                    raise ValueError('non_increasing_stamp')
                if is_pose:
                    position, _, _ = source.decode_pose(message)
                    if pose and math.dist(position, pose[2]) > MAX_POSITION_JUMP_M:
                        raise ValueError('position_jump')
                    pose = received, stamp, position
                else:
                    if message.header.frame_id != source.frame:
                        raise ValueError('pointlio_frame')
                    source.decode_cloud(message, reject_nonfinite=True)
                    cloud = received, stamp
            except (ValueError, AttributeError, TypeError, OverflowError):
                fault = '실시간 위치와 점 자료가 올바르지 않습니다. 받은 자료를 저장하거나 새로 시작해 주세요.'
        # Require a complete valid pair to clear an earlier input fault.
        if fault:
            error = fault
            pose = cloud = None
        elif pose is not None and cloud is not None:
            error = None
        # The service lane sees one coherent validation result, even while the
        # observation worker is decoding the next cloud.
        self.state = pose, cloud, error
