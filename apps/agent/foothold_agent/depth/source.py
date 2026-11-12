"""One daemon observation worker: discovery, one selected reader, conversion.

It shares neither control locks nor executors. Close only signals; a native
decoder or DDS operation that stalls can never delay the control watchdog/STOP.
"""
from datetime import datetime, timezone
import secrets
import threading
import time

from foothold_agent.go2_direct.media import Publisher as MediaPublisher
from .convert import colour, limits
from .discovery import Discovery, Images, choose, notice, shared_participant, UNAVAILABLE


class Source:
    def __init__(self, config=None, env=None, *, status=None, now=time.monotonic,
                 participant=shared_participant, discovery=Discovery, images=Images):
        self.config, self.env, self.status, self.now = config, env or {}, status, now
        self.participant, self.discovery_factory, self.images_factory = participant, discovery, images
        self.epoch, self.seq = secrets.randbits(52), 0
        self.closing = threading.Event()
        self.lock = threading.Lock()
        self.latest = None
        self.thread = None
        self.invalid = False

    def bind(self, config):
        with self.lock:
            self.config = config
            self.latest = None

    def start(self):
        if self.thread is None:
            self.thread = threading.Thread(target=self.run, daemon=True, name='go2-depth-observe')
            self.thread.start()

    def update(self, rows, selected, text):
        if self.status is not None:
            self.status.update(depth_topics=rows, depth_selected=selected['name'] if selected else None, depth_notice=text)

    def run(self):
        discovery = images = None
        selected = None
        try:
            low, high = limits(float(self.env.get('FH_GO2_DEPTH_MIN_M', '.2')),
                               float(self.env.get('FH_GO2_DEPTH_MAX_M', '5')))
            participant = self.participant()
            discovery = self.discovery_factory(participant)
            last_stamp, next_frame, next_discovery = -1, float('-inf'), float('-inf')
            rows = []
            while not self.closing.is_set():
                stamp = self.now()
                if stamp >= next_discovery:
                    rows = discovery.poll()
                    requested = (self.status.depth_choice() if self.status else None) or self.env.get('FH_GO2_DEPTH_TOPIC')
                    choice = choose(rows, requested)
                    if choice != selected:
                        if images is not None:
                            images.close()
                        images = None
                        with self.lock:
                            self.latest = None
                        selected, last_stamp, self.invalid = choice, -1, False
                        if selected:
                            images = self.images_factory(participant, selected)
                    text = notice(rows, selected)
                    if self.sample('depth') is not None:
                        text = f'뎁스 영상 수신 중 · {low:g}–{high:g} m · 가까움 빨강 / 멀리 파랑'
                    elif self.invalid:
                        text = '선택한 영상의 깊이 형식을 읽을 수 없습니다 — 16UC1·32FC1 깊이 또는 compressedDepth PNG인지 확인하세요'
                    self.update(rows, selected, text)
                    next_discovery = stamp+.2
                if images is not None and stamp >= next_frame:
                    for message in images.take():
                        received = self.now()
                        try:
                            header = message.header
                            sec, nano = header.stamp.sec, header.stamp.nanosec
                            if (type(sec) is not int or type(nano) is not int
                                    or not 0 <= sec <= 0x7fffffff or not 0 <= nano < 1_000_000_000):
                                continue
                            marker = sec*1_000_000_000+nano
                            if marker <= max(0, last_stamp):
                                continue
                            last_stamp = marker
                            captured_at = datetime.now(timezone.utc).isoformat()
                            frame, payload = colour(message, low, high)
                            self.invalid = False
                            if self.now()-received <= 1 and not self.closing.is_set():
                                with self.lock:
                                    if self.config is not None:
                                        self.seq += 1
                                        frame.update(version='media/1', robot=self.config.robot,
                                            epoch=self.epoch, episode_id=None, channel='depth', seq=self.seq,
                                            captured_at=captured_at)
                                        self.latest = received, frame, payload
                        except Exception:
                            # Bad colour/JPEG/RVL/RGB cannot become depth. Keep
                            # metadata discovery running when an image is invalid.
                            self.invalid = True
                    next_frame = self.now()+.2
                self.closing.wait(.02)
        except Exception:
            self.update([], None, UNAVAILABLE)
        finally:
            for resource in (images, discovery):
                if resource is not None:
                    try:
                        resource.close()
                    except Exception:
                        pass

    def sample(self, channel):
        if channel != 'depth':
            return None
        with self.lock:
            item = self.latest
        return item if item and not self.closing.is_set() and 0 <= self.now()-item[0] <= 1 else None

    def close(self):
        self.closing.set()


class Publisher(MediaPublisher):
    channels = ('depth',)

    def __init__(self, config, env=None, channel=None, *, source=None, status=None):
        source = source or Source(config, env, status=status)
        super().__init__(config, env or {}, channel, source_factory=lambda *_: source)
