"""Small independent GLIM observation snapshot; never evidence of a saved map."""
import math
import struct

from .poses import timestamp


class GlimLive:
    def __init__(self, source, now):
        self.source, self.now = source, now
        self.last_data = None
        self.preview = None
        self.seq = 0
        self.next_decode = float('-inf')

    def update(self, samples, not_before):
        for topic in (self.source.odom_topic, self.source.cloud_topic):
            if topic not in samples:
                continue
            received, message = samples[topic]
            if received < not_before or not 0 <= self.now()-received <= 1:
                continue
            try:
                if topic == self.source.odom_topic:
                    self.source.decode_pose(message)
                else:
                    if self.now() < self.next_decode:
                        continue
                    self.next_decode = self.now()+1
                    if message.header.frame_id != self.source.frame:
                        raise ValueError('glim_frame')
                    timestamp(message.header.stamp)
                    # A cumulative map is replaced, never ray traced or merged
                    # into the Point-LIO revision. Decode a bounded uniform sample.
                    _, payload = self.source.decode_cloud(message, max_points=1024, reject_nonfinite=True)
                    cells = sorted({tuple(math.floor(v/.25) for v in xyz)
                                    for xyz in struct.iter_unpack('<fff', payload)})
                    self.seq += 1
                    self.preview = dict(source='glim', seq=self.seq, frame_id=self.source.frame,
                        stamp=dict(sec=message.header.stamp.sec, nanosec=message.header.stamp.nanosec),
                        resolution=.25, cells=cells)
                self.last_data = received
            except (ValueError, AttributeError, TypeError, OverflowError):
                continue  # Invalid GLIM observation cannot disturb Point-LIO.

    def snapshot(self, services, saving=False, processed_chunks=None):
        owned = services.glim in services.owned
        stage = ('SAVING' if saving else 'STARTING' if services.status == 'STARTING' else
                 'RECEIVING' if owned and services.status == 'STARTED' and self.last_data is not None else
                 'STARTING' if owned and services.status == 'STARTED' else
                 'UNKNOWN' if owned or services.status == 'UNKNOWN' or services.start_error else 'OFF')
        return dict(stage=stage, data_age_s=None if self.last_data is None else
            round(max(0, self.now()-self.last_data), 3), processed_chunks=processed_chunks, gpu=None,
            reason=services.start_error)
