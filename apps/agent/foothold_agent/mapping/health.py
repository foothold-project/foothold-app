"""Read-only Point-LIO preflight, independent of session accumulation."""
import math

from .poses import timestamp

FRESH_SECONDS = .5
MAX_POSITION_JUMP_M = 2.0
REASONS = {
    'MISSING_DATA': '위치 또는 점 자료를 아직 받지 못했습니다.',
    'STALE': '위치 또는 점 자료가 끊겼습니다.',
    'POSITION_OUT_OF_RANGE': '위치가 허용 좌표 범위를 벗어났습니다.',
    'POSITION_JUMP': '위치가 한 번에 2 m 넘게 바뀌었습니다.',
    'STAMP_REGRESSION': '자료 시각이 이전 시각보다 진행하지 않았습니다.',
    'FRAME_MISMATCH': '자료 좌표계가 설정과 다릅니다.',
    'STAMP_SKEW': '위치와 점 자료의 시각 차이가 큽니다.',
    'INVALID_DATA': '위치 또는 점 자료가 올바르지 않습니다.',
}


class PointLioHealth:
    def __init__(self, source, now):
        self.source, self.now = source, now
        self.state = None, None, None
        self.reason_code = None
        self.receipts = [None, None]
        self.position = None

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
            self.receipts[0 if is_pose else 1] = received
            try:
                if not 0 <= self.now()-received <= FRESH_SECONDS:
                    raise ValueError('stale_pointlio')
                if message.header.frame_id != source.frame or (is_pose and source.child_frame
                        and message.child_frame_id != source.child_frame):
                    raise ValueError('pointlio_frame')
                stamp = timestamp(message.header.stamp)
                previous = pose if is_pose else cloud
                if previous and stamp <= previous[1]:
                    raise ValueError('non_increasing_stamp')
                if is_pose:
                    raw_pose = message.pose.pose if source.pose_type == 'Odometry' else message.pose
                    xyz = tuple(getattr(raw_pose.position, axis) for axis in 'xyz')
                    if all(type(v) in (int, float) and math.isfinite(v) for v in xyz):
                        self.position = tuple(round(v, 2) for v in xyz)
                        if any(v < -10000 or v >= 10000 for v in xyz):
                            raise ValueError('coordinate_out_of_range')
                    position, _, _ = source.decode_pose(message)
                    if pose and math.dist(position, pose[2]) > MAX_POSITION_JUMP_M:
                        raise ValueError('position_jump')
                    pose = received, stamp, position
                else:
                    if message.header.frame_id != source.frame:
                        raise ValueError('pointlio_frame')
                    source.decode_cloud(message, reject_nonfinite=True)
                    cloud = received, stamp
            except (ValueError, AttributeError, TypeError, OverflowError) as exc:
                # Keep the first precise cause when both inputs fail in one tick.
                if fault is None:
                    fault = {'stale_pointlio': 'STALE', 'coordinate_out_of_range': 'POSITION_OUT_OF_RANGE',
                        'position_jump': 'POSITION_JUMP', 'non_increasing_stamp': 'STAMP_REGRESSION',
                        'pointlio_frame': 'FRAME_MISMATCH'}.get(str(exc), 'INVALID_DATA')
        # Require a complete valid pair to clear an earlier input fault.
        if fault:
            self.reason_code = fault
            error = REASONS[fault]
            pose = cloud = None
        elif pose is not None and cloud is not None:
            error = None
            self.reason_code = None
        # The service lane sees one coherent validation result, even while the
        # observation worker is decoding the next cloud.
        self.state = pose, cloud, error

    def snapshot(self, active, pose_hz, cloud_hz):
        ages = [None if at is None else round(max(0, self.now()-at), 3) for at in self.receipts]
        code = self.reason_code
        if code is None and not self.fresh():
            code = ('MISSING_DATA' if any(age is None for age in ages) else
                    'STALE' if any(age > FRESH_SECONDS for age in ages) else 'STAMP_SKEW')
        invalid = code in ('POSITION_OUT_OF_RANGE', 'POSITION_JUMP', 'STAMP_REGRESSION', 'FRAME_MISMATCH', 'INVALID_DATA')
        return dict(active=active, fresh=self.fresh(), pose_age_s=ages[0], cloud_age_s=ages[1],
            position_valid=False if invalid else None if self.position is None else True,
            reason_code=code, reason=REASONS.get(code), position_m=self.position,
            pose_hz=pose_hz, cloud_hz=cloud_hz)
