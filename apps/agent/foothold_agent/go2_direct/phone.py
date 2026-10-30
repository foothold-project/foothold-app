"""Bind the existing authenticated Hub's single MotionSink to phone only."""


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
