"""Bind the existing authenticated Hub's single MotionSink to phone only."""

from foothold_agent.phone.hub import Hub


class PhoneSink:
    def __init__(self, sink):
        self.sink = sink
        self.hub = None
        sink.select_source('phone')

    def apply(self, command):
        received = None if self.hub is None else self.hub.session.core.intent_t
        self.sink.apply(command, source='phone', input_received_at=received)

    def output_safety(self):
        return self.sink.output_safety()


class Go2Hub(Hub):
    def __init__(self, *args, feedback, **kwargs):
        self.feedback = feedback
        super().__init__(*args, **kwargs)

    def update_display(self):
        from .reporting import devices
        self.session.update_devices(devices(self.feedback.telemetry(), self.now()))

    def state(self, peer):
        from .reporting import project
        snapshot = self.feedback.telemetry()
        result = {**super().state(peer), **project(snapshot, self.now())}
        ages = [source.get('age_s') for source in snapshot['sources'].values()]
        if not self.feedback.fault and all(age is not None and age >= 0 for age in ages):
            result.update(robot_serial=self.feedback.serial, sensor_age_ms=int(max(ages)*1000))
        return result
