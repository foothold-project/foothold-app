"""One daemon observation worker: discovery, one selected reader, conversion.

It shares neither control locks nor executors. Close only signals; a native
decoder or DDS operation that stalls can never delay the control watchdog/STOP.
"""
from collections import Counter
from datetime import datetime, timezone
import logging
import secrets
import threading
import time

from foothold_agent.go2_direct.media import Publisher as MediaPublisher
from .convert import colour, limits
from .discovery import DEFAULT_TOPICS, Discovery, Images, choose, notice, shared_participant, UNAVAILABLE

STALL_SECONDS = 12.
RETRY_SECONDS = 1.
REPORT_SECONDS = 30.
LOG = logging.getLogger(__name__)

READ_ERROR = '뎁스 영상을 읽을 수 없어 다시 연결하고 있습니다'
NO_IMAGE = '뎁스 카메라는 보이지만 영상이 도착하지 않고 있습니다'
INVALID_IMAGE = '선택한 영상에서 거리 정보를 읽을 수 없습니다'
OLD_IMAGE = '뎁스 영상은 도착하지만 촬영 시각이 갱신되지 않고 있습니다'
SLOW_IMAGE = '뎁스 영상은 도착하지만 화면에 표시하기까지 시간이 오래 걸리고 있습니다'


class Source:
    def __init__(self, config=None, env=None, *, status=None, now=time.monotonic,
                 participant=shared_participant, discovery=Discovery, images=Images,
                 recorder=None, recording_allowed=lambda: False):
        self.config, self.env, self.status, self.now = config, env or {}, status, now
        self.participant, self.discovery_factory, self.images_factory = participant, discovery, images
        self.epoch, self.seq = secrets.randbits(52), 0
        self.closing = threading.Event()
        self.lock = threading.Lock()
        self.latest = None
        self.thread = None
        self.recorder, self.recording_allowed = recorder, recording_allowed

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
            detail = None
            last_arrival = retry_at = 0.
            last_displayed = None
            counts = Counter()
            next_report = self.now() + REPORT_SECONDS
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
                        selected, last_stamp, detail = choice, -1, None
                        last_arrival = retry_at = stamp
                        last_displayed = None
                        counts.clear()
                        next_report = stamp + REPORT_SECONDS
                    if selected and images is None and stamp >= retry_at:
                        try:
                            images = self.images_factory(participant, selected)
                            last_arrival = self.now()
                            counts['opens'] += 1
                        except Exception:
                            counts['open_errors'] += 1
                            detail = READ_ERROR
                            retry_at = stamp + RETRY_SECONDS
                    if images is not None and stamp - last_arrival >= STALL_SECONDS:
                        images.close()
                        images = None
                        counts['stalls'] += 1
                        detail = NO_IMAGE
                        retry_at = stamp + RETRY_SECONDS
                    text = detail or notice(rows, selected)
                    if last_displayed is not None and stamp - last_displayed < STALL_SECONDS and detail is None:
                        text = f'최근 뎁스 영상을 받았습니다 · {low:g}–{high:g} m · 가까움 빨강 / 멀리 파랑'
                    elif images is not None and stamp - last_arrival >= 3 and last_displayed is None:
                        text = NO_IMAGE
                    self.update(rows, selected, text)
                    next_discovery = stamp+.2
                if images is not None and stamp >= next_frame:
                    try:
                        counts['takes'] += 1
                        messages = images.take()
                    except Exception:
                        images.close()
                        images = None
                        with self.lock:
                            self.latest = None
                        detail = READ_ERROR
                        counts['errors'] += 1
                        last_displayed = None
                        retry_at = self.now() + RETRY_SECONDS
                        self.update(rows, selected, detail)
                        messages = ()
                    for message in messages:
                        received = self.now()
                        counts['samples'] += 1
                        last_arrival = received
                        try:
                            header = message.header
                            sec, nano = header.stamp.sec, header.stamp.nanosec
                            if (type(sec) is not int or type(nano) is not int
                                    or not 0 <= sec <= 0x7fffffff or not 0 <= nano < 1_000_000_000):
                                counts['bad_stamp'] += 1
                                detail = '뎁스 영상의 촬영 시각을 읽을 수 없습니다'
                                continue
                            marker = sec*1_000_000_000+nano
                            # ROS Header may legitimately leave its stamp zero.
                            # Receive freshness still uses the laptop clock;
                            # only supplied positive sensor stamps are deduped.
                            if marker and marker <= last_stamp:
                                counts['old_stamp'] += 1
                                detail = OLD_IMAGE
                                continue
                            if marker:
                                last_stamp = marker
                            captured_at = datetime.now(timezone.utc).isoformat()
                            frame, payload = colour(message, low, high)
                            detail = SLOW_IMAGE
                            if self.now()-received <= 1 and not self.closing.is_set():
                                detail = None
                                with self.lock:
                                    if self.config is not None:
                                        self.seq += 1
                                        frame.update(version='media/1', robot=self.config.robot,
                                            epoch=self.epoch, episode_id=None, channel='depth', seq=self.seq,
                                            captured_at=captured_at)
                                        self.latest = received, frame, payload
                                        last_displayed = received
                                        counts['frames'] += 1
                                    else:
                                        counts['unbound'] += 1
                                        detail = '뎁스 영상이 도착했습니다. 로봇 연결을 기다리고 있습니다'
                                try:
                                    if self.recorder is not None and self.recording_allowed():
                                        self.recorder.depth(message, frame, selected['name'])
                                except Exception:
                                    pass  # disk failure never invalidates the depth observation
                            else:
                                counts['slow_or_closed'] += 1
                        except Exception:
                            counts['invalid'] += 1
                            # Bad colour/JPEG/RVL/RGB cannot become depth. Keep
                            # metadata discovery running when an image is invalid.
                            detail = INVALID_IMAGE
                    next_frame = self.now()+.2
                if selected and stamp >= next_report:
                    # User-defined topic names may contain device identifiers.
                    topic = selected['name'] if selected['name'] in DEFAULT_TOPICS else 'custom'
                    log = LOG.info if counts['frames'] and not counts['stalls'] else LOG.warning
                    log('Depth receiver topic=%s readers=%d takes=%d samples=%d frames=%d events=%s',
                        topic, int(images is not None), counts['takes'], counts['samples'], counts['frames'],
                        {k: v for k, v in counts.items() if k not in ('takes', 'samples', 'frames')})
                    counts.clear()
                    next_report = stamp + REPORT_SECONDS
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
