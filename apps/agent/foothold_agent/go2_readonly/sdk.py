"""The only SDK boundary: two subscribers, no request or publication interfaces.

SDK imports are lazy; tests inject fake modules and never initialize real DDS.
Run in a dedicated process: the SDK channel factory is a process-wide singleton.
"""

import re
import os
from ..mapping.inputs import ObservationInputs


class Subscriptions(ObservationInputs):
    def __init__(self, state, nic, *, dds_name=None):
        pattern = r'''[^<>&"'\x00-\x1f]{1,256}''' if os.name == 'nt' else r'[a-zA-Z0-9_.:-]{1,15}'
        if not isinstance(nic, str) or not re.fullmatch(pattern, nic):
            raise ValueError('an explicit valid NIC name is required')
        if dds_name is not None and (os.name != 'nt' or not isinstance(dds_name,str)
                                     or not re.fullmatch(pattern,dds_name)):
            raise ValueError('a valid Windows DDS interface name is required')
        self.init_observations()
        self.state, self.nic = state, nic
        self.dds_name = nic if dds_name is None else dds_name
        self._subscribers = []
        self._started = False

    def start(self):
        if self._started:
            raise RuntimeError('DDS subscriptions can only start once per process')
        self._started = True
        from unitree_sdk2py.core.channel import ChannelFactoryInitialize, ChannelSubscriber
        from unitree_sdk2py.idl.unitree_go.msg.dds_ import LowState_, SportModeState_

        if os.name == 'nt':
            # The pinned SDK hardcodes a POSIX trace filename. Adapt only that
            # file location; its dedicated-interface XML and DDS setup stay intact.
            from pathlib import Path
            from xml.sax.saxutils import escape
            import sys
            channel = sys.modules[ChannelFactoryInitialize.__module__]
            directory = Path(os.environ['LOCALAPPDATA'])/'foothold/cache'
            directory.mkdir(parents=True, exist_ok=True)
            channel.ChannelConfigHasInterface = channel.ChannelConfigHasInterface.replace(
                '/tmp/cdds.LOG', escape(str(directory/'cdds.LOG')))
        ChannelFactoryInitialize(0, self.dds_name)
        try:
            for topic, data_type, callback in (
                    ('rt/lowstate', LowState_, self.state.lowstate),
                    ('rt/sportmodestate', SportModeState_, lambda msg: self.sport(self.state.sportmodestate, msg))):
                subscriber = ChannelSubscriber(topic, data_type)
                self._subscribers.append(subscriber)
                # Direct callback: no unbounded backlog extending receipt freshness.
                subscriber.Init(callback, 0)
        except Exception:
            self.close()
            raise

    def close(self):
        self.cloud_bus.close()
        for subscriber in reversed(self._subscribers):
            try:
                subscriber.Close()
            except Exception:
                pass
        self._subscribers.clear()
