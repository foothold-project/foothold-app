"""The only SDK boundary: two subscribers, no request or publication interfaces.

SDK imports are lazy; tests inject fake modules and never initialize real DDS.
Run in a dedicated process: the SDK channel factory is a process-wide singleton.
"""

import re


class Subscriptions:
    def __init__(self, state, nic):
        if not isinstance(nic, str) or not re.fullmatch(r'[a-zA-Z0-9_.:-]{1,15}', nic):
            raise ValueError('an explicit valid NIC name is required')
        self.state, self.nic = state, nic
        self._subscribers = []
        self._started = False

    def start(self):
        if self._started:
            raise RuntimeError('DDS subscriptions can only start once per process')
        self._started = True
        from unitree_sdk2py.core.channel import ChannelFactoryInitialize, ChannelSubscriber
        from unitree_sdk2py.idl.unitree_go.msg.dds_ import LowState_, SportModeState_

        ChannelFactoryInitialize(0, self.nic)
        try:
            for topic, data_type, callback in (
                    ('rt/lowstate', LowState_, self.state.lowstate),
                    ('rt/sportmodestate', SportModeState_, self.state.sportmodestate)):
                subscriber = ChannelSubscriber(topic, data_type)
                self._subscribers.append(subscriber)
                # Direct callback: no unbounded backlog extending receipt freshness.
                subscriber.Init(callback, 0)
        except Exception:
            self.close()
            raise

    def close(self):
        for subscriber in reversed(self._subscribers):
            try:
                subscriber.Close()
            except Exception:
                pass
        self._subscribers.clear()
