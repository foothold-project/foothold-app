"""The only SDK boundary: two subscribers, no request or publication interfaces.

SDK imports are lazy; tests inject fake modules and never initialize real DDS.
Run in a dedicated process: the SDK channel factory is a process-wide singleton.
"""

from collections import Counter, deque
import math
import re
import os
import threading
from ..mapping.inputs import ObservationInputs


class ReceiptIntervals:
    """Append numeric DDS entry times; the reporter owns interval calculations."""
    CAPACITY = 32768

    def __init__(self):
        self.receipts = deque()
        self.previous = None
        # If reporting stalls for more than a full buffer, fold the remaining
        # tail into a histogram instead of losing intervals or growing a queue.
        self.lock = threading.Lock()
        self.tail = None
        self.overflow = Counter()
        self.maximum = 0.
        self.over_200 = 0

    def record(self, stamp):
        if len(self.receipts) < self.CAPACITY:
            self.receipts.append(stamp)
            return stamp
        with self.lock:
            if len(self.receipts) < self.CAPACITY:  # reporter drained while waiting
                self.receipts.append(stamp)
            else:
                previous = self.receipts[-1] if self.tail is None else self.tail
                gap = max(0., stamp - previous)
                self.tail = max(previous, stamp)
                self.overflow[round(gap * 1000)] += 1
                self.maximum = max(self.maximum, gap)
                self.over_200 += gap > .2
        return stamp

    def summary(self, topic):
        with self.lock:
            # deque append/popleft are atomic; callbacks appended during this
            # drain belong to the next window. Keep the boundary receipt.
            stamps = [self.receipts.popleft() for _ in range(len(self.receipts))]
            tail, self.tail = self.tail, None
            bins, self.overflow = self.overflow, Counter()
            maximum, over = self.maximum, self.over_200
            self.maximum, self.over_200 = 0., 0
        previous = self.previous
        for stamp in sorted(stamps):
            if previous is not None:
                gap = max(0., stamp - previous)
                bins[round(gap * 1000)] += 1
                maximum = max(maximum, gap)
                over += gap > .2
            previous = stamp
        self.previous = previous if tail is None else tail
        count = sum(bins.values())
        cumulative = 0
        p50 = p95 = -1
        for milliseconds, frequency in sorted(bins.items()):
            cumulative += frequency
            if p50 < 0 and cumulative >= math.ceil(count * .50):
                p50 = milliseconds
            if cumulative >= math.ceil(count * .95):
                p95 = milliseconds
                break
        maximum = maximum * 1000 if count else -1
        return (f'{topic}_n={count} {topic}_p50_ms={p50} {topic}_p95_ms={p95} '
                f'{topic}_max_ms={maximum:.2f} {topic}_over_200ms={over}')


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
        # Setup's approval-scoped media workers share one SDK camera reader on
        # this participant. Read-only discovery itself never opens the client.
        self.video_client = None
        self.video_lock = threading.Lock()

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
