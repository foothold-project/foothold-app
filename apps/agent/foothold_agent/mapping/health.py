"""Read-only Point-LIO preflight, independent of session accumulation."""
from collections import deque
import math

from .poses import timestamp

FRESH_SECONDS = .5
CLOUD_FRESH_SECONDS = 1.5
STAMP_TOLERANCE_NS = 250_000_000
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
    def __init__(self, source, now, env=None):
        self.source, self.now = source, now
        self.cloud_fresh_seconds = CLOUD_FRESH_SECONDS
        try:
            value = float((env or {}).get('FH_MAPPING_POINTLIO_CLOUD_FRESH_S', CLOUD_FRESH_SECONDS))
            if math.isfinite(value) and .3 <= value <= 5:
                self.cloud_fresh_seconds = value
        except (ValueError, TypeError, OverflowError):
            pass
        # Independent of session histories: preflight also runs before start.
        # Bounded even at 2.7 kHz, with enough room for the longest cloud age.
        self.pose_stamps = deque(maxlen=16384)
        self.state = None, None, None
        self.reason_code = None
        self.receipts = [None, None]
        self.position = None

    @property
    def error(self):
        return self.state[2]

    def fresh(self, at=None):
        at = self.now() if at is None else at
        pose, cloud, error = self.state
        return (error is None and pose is not None and cloud is not None
                and 0 <= at-pose[0] <= FRESH_SECONDS
                and 0 <= at-cloud[0] <= self.cloud_fresh_seconds
                and cloud[2])

    def expires_at(self):
        pose, cloud, _ = self.state
        deadlines = [item[0]+limit for item, limit in
                     ((pose, FRESH_SECONDS), (cloud, self.cloud_fresh_seconds)) if item is not None]
        return min(deadlines) if deadlines else self.now()

    def update(self, samples):
        """Validate without writing session odometry, stamps, cells or progress."""
        source = self.source
        pose, cloud, error = self.state
        fault = None
        at = self.now()
        while self.pose_stamps and at-self.pose_stamps[0][0] > self.cloud_fresh_seconds+FRESH_SECONDS:
            self.pose_stamps.popleft()
        for topic, is_pose in ((source.odom_topic, True), (source.cloud_topic, False)):
            if topic not in samples:
                continue
            received, message = samples[topic]
            self.receipts[0 if is_pose else 1] = received
            try:
                limit = FRESH_SECONDS if is_pose else self.cloud_fresh_seconds
                if not 0 <= self.now()-received <= limit:
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
                    self.pose_stamps.append((received, stamp))
                else:
                    if message.header.frame_id != source.frame:
                        raise ValueError('pointlio_frame')
                    source.decode_cloud(message, reject_nonfinite=True)
                    cloud = received, stamp, False
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
            self.pose_stamps.clear()
        elif pose is not None and cloud is not None:
            # Remember a validated pair while newer odometry advances; the
            # cloud need not match the latest pose on every service tick.
            if not cloud[2]:
                cloud = cloud[0], cloud[1], any(abs(stamp-cloud[1]) <= STAMP_TOLERANCE_NS
                                              for _, stamp in self.pose_stamps)
            error = None
            self.reason_code = None
        # The service lane sees one coherent validation result, even while the
        # observation worker is decoding the next cloud.
        self.state = pose, cloud, error

    def snapshot(self, active, pose_hz, cloud_hz):
        at = self.now()
        raw_ages = [None if received is None else at-received for received in self.receipts]
        ages = [None if age is None else round(max(0, age), 3) for age in raw_ages]
        fresh = self.fresh(at)
        code = self.reason_code
        if code is None and not fresh:
            code = ('MISSING_DATA' if any(age is None for age in raw_ages) else
                    'STALE' if not 0 <= raw_ages[0] <= FRESH_SECONDS
                    or not 0 <= raw_ages[1] <= self.cloud_fresh_seconds else 'STAMP_SKEW')
        invalid = code in ('POSITION_OUT_OF_RANGE', 'POSITION_JUMP', 'STAMP_REGRESSION', 'FRAME_MISMATCH', 'INVALID_DATA')
        return dict(active=active, fresh=fresh, pose_age_s=ages[0], cloud_age_s=ages[1],
            position_valid=False if invalid else None if self.position is None else True,
            reason_code=code, reason=REASONS.get(code), position_m=self.position,
            pose_hz=pose_hz, cloud_hz=cloud_hz)
