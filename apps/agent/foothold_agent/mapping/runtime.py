"""Latest-only inputs and independent acquisition/HTTP workers; never motion outputs."""
import asyncio
from collections import deque
from concurrent.futures import ThreadPoolExecutor
import json
import math
from pathlib import Path
import os
import re
import threading
import time
from urllib.parse import urlsplit, urlunsplit
from urllib.error import HTTPError
from urllib.request import Request, build_opener, ProxyHandler
from uuid import UUID

from .core import Accumulator
from foothold_agent.mapping.inputs import DEFAULT_TOPIC
from .poses import Poses


class TransferError(RuntimeError):
    def __init__(self, code, reason):
        self.code, self.reason = code, reason
        super().__init__(reason)


class MappingRuntime:
    def __init__(self, observer, channel, settings, robot, env, *, now=time.monotonic, request=None,
                 enabled=lambda: True):
        self.observer, self.channel, self.settings = observer, channel, settings
        self.robot, self.env, self.now = str(UUID(str(robot))), env, now
        self.enabled = enabled
        self.lock = threading.Lock()
        self.commands = deque(maxlen=8)
        self.poses = Poses(now)
        self.odom_handle = None
        self.topic = env.get('FH_MAPPING_LIDAR_TOPIC', DEFAULT_TOPIC)
        self.odom_frame = env.get('FH_MAPPING_LIDAR_FRAME', 'odom' if self.topic == DEFAULT_TOPIC else '') == 'odom'
        self.latest = None
        self.last_input_stamp = -1
        self.online = False
        self.stopping = threading.Event()
        self.handle = None
        self.error = None
        self.request = request or self.http
        self.io = ThreadPoolExecutor(max_workers=2, thread_name_prefix='mapping-http')
        self.report_future = self.save_future = None
        self.save_session = None
        self.next_report = float('-inf')
        self.last_cloud = self.now()
        self.thread = None
        self.path = None
        try:
            extrinsic = ((0.,)*6 if self.odom_frame else
                         tuple(float(n) for n in env.get('FH_MAPPING_LIDAR_TO_BODY', '0,0,0,0,0,0').split(',')))
            if len(extrinsic) != 6 or not all(math.isfinite(n) and abs(n) <= 100 for n in extrinsic):
                raise ValueError()
        except ValueError:
            extrinsic = (0.,)*6
            self.error = '지도 센서 설정을 확인해 주세요.'
        self.core = Accumulator(now=now, extrinsic=extrinsic)
        base = urlsplit(settings.url)
        self.base = urlunsplit(('https' if base.scheme == 'wss' else 'http', base.netloc,
            base.path.rsplit('/agent/ws', 1)[0] + '/agent/robots/' + self.robot + '/slam/', '', ''))
        self.folder = Path(env.get('FH_MAPPING_CACHE_DIR', str(Path.home()/'.cache/foothold/mapping')))

    def command(self, frame):
        # Reader remains constant-time; even PCD encoding never runs on its loop.
        if self.stopping.is_set() or not self.enabled():
            return
        with self.lock:
            if len(self.commands) < self.commands.maxlen:
                self.commands.append(dict(frame))

    def sport(self, message):
        if not self.stopping.is_set():
            self.poses.sport(message)

    def odom(self, message):
        if not self.stopping.is_set():
            self.poses.odom(message)

    def close(self):
        self.online = False
        self.stopping.set()
        if getattr(self.observer, 'mapping', None) is self:
            self.observer.mapping = None

    def cloud(self, message):
        if self.stopping.is_set() or not self.enabled():
            return
        received = self.now()
        try:
            if len(message.data) > 2_000_000 or len(message.fields) > 32 or message.width*message.height > 100000:
                return
            sec, ns = message.header.stamp.sec, message.header.stamp.nanosec
            if type(sec) is not int or type(ns) is not int or not 0 <= sec <= 0x7FFFFFFF or not 0 <= ns < 1_000_000_000:
                return
            stamp = sec*1_000_000_000 + ns
            if stamp <= 0:
                return
            raw = (bytes(message.data), message.width, message.height, message.point_step, message.row_step,
                message.is_bigendian, tuple((f.name, f.offset, f.datatype, f.count) for f in message.fields),
                message.header.frame_id)
            with self.lock:
                if stamp <= self.last_input_stamp:
                    return
                self.last_input_stamp = stamp
                self.latest = (received, stamp, raw)
        except (AttributeError, TypeError, ValueError, OverflowError):
            pass

    def http(self, session, suffix, data):
        request = Request(self.base + session + '/' + suffix, data=data, method='POST', headers={
            'Authorization': 'Bearer ' + self.settings.token,
            'Content-Type': 'application/json' if suffix == 'progress' else 'application/octet-stream'})
        opener = build_opener(ProxyHandler({}))
        try:
            with opener.open(request, timeout=60 if suffix == 'point-cloud' else 2) as response:
                return json.loads(response.read(2_000_000))
        except HTTPError as error:
            try:
                try:
                    payload = error.read(8192)
                finally:
                    error.close()
                body = json.loads(payload).get('error', {})
                code, reason = body.get('code'), body.get('message')
                if (isinstance(code, str) and re.fullmatch(r'[A-Z0-9_]{1,80}', code)
                        and isinstance(reason, str) and 0 < len(reason) <= 200 and '\x00' not in reason
                        and any('가' <= char <= '힣' for char in reason)):
                    if code == 'INVALID_POINT_CLOUD':
                        reason = '지도 자료를 읽을 수 없습니다. 연결 프로그램을 확인한 뒤 다시 저장하거나 취소해 주세요.'
                    raise TransferError(code, reason) from None
            except (ValueError, AttributeError, TypeError):
                pass
            raise TransferError('MAPPING_SAVE_FAILED', '지도를 저장하지 못했습니다. 연결을 확인한 뒤 다시 저장해 주세요.') from None

    def save(self, session, data):
        self.folder.mkdir(parents=True, exist_ok=True, mode=0o700)
        path = self.folder / (session + '.pcd')
        # UUID-derived local name, restrictive raw-data permissions.
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, 'wb') as target:
            target.write(data)
        self.path = path
        return self.request(session, 'point-cloud', data)

    def step(self):
        if self.stopping.is_set() or not self.enabled():
            return
        with self.lock:
            commands, self.commands = self.commands, deque(maxlen=8)
            latest, self.latest = self.latest, None
        for frame in commands:
            # A new server-authorized UUID proves the prior server session ended.
            # Its cancel/SAVED reply may have been lost while this laptop was offline.
            if (frame.get('t') == 'slam' and frame.get('op') == 'start' and frame.get('session_id') != self.core.session_id
                    and self.core.session_id is not None and set(frame) == {'t', 'op', 'session_id', 'floor_id'}):
                try:
                    UUID(frame['session_id'])
                    UUID(frame['floor_id'])
                except (TypeError, ValueError, AttributeError):
                    continue
                self.core.command(dict(t='slam', op='cancel', session_id=self.core.session_id, floor_id=self.core.floor_id))
            if not self.core.command(frame):
                if self.core.session_id is None and frame.get('op') == 'save':
                    if self.core.command({**frame, 'op': 'start'}):
                        self.core.fail('MAPPING_SESSION_LOST', '연결 프로그램이 다시 시작되어 만든 지도가 없습니다. 취소한 뒤 새로 시작해 주세요.')
                continue
            self.next_report = float('-inf')
            if frame['op'] == 'start':
                self.last_cloud = self.now()
                if self.error:
                    self.core.fail('MAPPING_CONFIG_REQUIRED', self.error)
            elif frame['op'] == 'cancel':
                # Cancel invalidates local completion; server also rejects in-flight uploads.
                if self.path:
                    self.path.unlink(missing_ok=True)
        if self.core.status == 'RUNNING':
            if not self.online:
                self.core.fail('LINK_LOST', '연결이 끊겼습니다. 다시 연결한 뒤 저장하거나 취소해 주세요.')
            elif latest:
                received, stamp, raw = latest
                pose = self.poses.nearest(received, stamp)
                if pose is not None and 0 <= self.now()-received <= .5:
                    try:
                        from foothold_agent.go2_direct.media import points
                        import numpy as np
                        frames = ((self.env['FH_MAPPING_LIDAR_FRAME'],) if self.env.get('FH_MAPPING_LIDAR_FRAME')
                                  else (('odom',) if self.odom_frame else ('lidar_link', 'utlidar_lidar')))
                        _, data = points(raw, max_points=100000, frames=frames)
                        self.core.add(np.frombuffer(data, dtype='<f4').reshape(-1, 3), pose[2], pose[3], stamp=stamp,
                                      frame='odom' if self.odom_frame else 'lidar_link')
                        self.last_cloud = received
                    except ImportError:
                        self.core.fail('MAPPING_DEPENDENCY', '지도 만들기 구성요소를 설치한 뒤 다시 연결해 주세요.')
                    except ValueError:
                        self.core.fail('SENSOR_FRAME', '지도 센서 자료를 읽을 수 없습니다. 센서 설정을 확인해 주세요.')
            if self.now()-self.last_cloud > 3:
                self.core.fail('SENSOR_UNAVAILABLE', '라이다 점과 로봇 위치를 받지 못했습니다. 연결을 확인해 주세요.')
        if self.save_future is not None and self.save_future.done():
            future, self.save_future = self.save_future, None
            if self.core.session_id == self.save_session and self.core.status == 'SAVING':
                try:
                    future.result()
                    self.core.status = 'SAVED'
                except TransferError as error:
                    self.core.fail(error.code, error.reason)
                except Exception:
                    self.core.fail('MAPPING_SAVE_FAILED', '지도를 저장하지 못했습니다. 연결을 확인한 뒤 다시 저장해 주세요.')
                self.next_report = float('-inf')
        if self.core.status == 'SAVING' and self.save_future is None:
            try:
                data = self.core.pcd()
                self.save_session = self.core.session_id
                self.save_future = self.io.submit(self.save, self.save_session, data)
            except ValueError:
                self.core.fail('MAPPING_EMPTY', '아직 그린 지도가 없습니다. 취소한 뒤 다시 시작해 주세요.')
        if self.online and self.now() >= self.next_report and (self.report_future is None or self.report_future.done()):
            body = self.core.report()
            if body:
                self.report_future = self.io.submit(self.request, self.core.session_id, 'progress',
                    json.dumps(body, ensure_ascii=False, allow_nan=False).encode())
            self.next_report = self.now()+1

    def worker(self):
        try:
            if self.stopping.is_set() or not self.enabled():
                return
            self.acquire()
            while not self.stopping.wait(.05):
                try:
                    self.step()
                except Exception:
                    self.core.fail('MAPPING_FAILED', '지도를 그리지 못했습니다. 연결을 확인한 뒤 저장하거나 취소해 주세요.')
        finally:
            # SDK Init/Close may stall; neither runs on the control/STOP loop.
            for handle in (self.handle, self.odom_handle):
                if handle is not None:
                    try:
                        handle.Close()
                    except Exception:
                        pass
            self.handle = self.odom_handle = None

    def acquire(self):
        try:
            topic = self.topic
            if not topic or len(topic) > 200 or any(c.isspace() for c in topic):
                raise ValueError('invalid cloud topic')
            self.handle = self.channel.cloud(topic, self.cloud)
        except Exception:
            self.error = '지도 센서에 연결하지 못했습니다. 연결 프로그램 설정을 확인해 주세요.'
        if not self.stopping.is_set() and hasattr(self.channel, 'odometry'):
            try:
                self.odom_handle = self.channel.odometry(self.odom)
            except Exception:
                pass  # sport pose remains available when odometry is absent

    async def run(self):
        self.observer.mapping = self
        self.channel.add_sport_listener(self.sport)
        self.thread = threading.Thread(target=self.worker, name='mapping-acquire', daemon=True)
        self.thread.start()
        try:
            while self.enabled():
                self.online = bool(self.observer.connected and not self.observer.link_lost
                                   and not self.observer.reconnect_required)
                await asyncio.sleep(.05)
        finally:
            self.close()
            if hasattr(self.channel, 'remove_sport_listener'):
                self.channel.remove_sport_listener(self.sport)
            self.io.shutdown(wait=False, cancel_futures=True)


def attach(observer, channel, settings, robot, env, *, enabled=lambda: True):
    """Return background task, never changes the control task graph's health."""
    if not hasattr(channel, 'cloud') or not hasattr(channel, 'add_sport_listener'):
        return None  # observation-less adapters retain their existing control lifetime
    try:
        mapper = MappingRuntime(observer, channel, settings, robot, env, enabled=enabled)
    except (ValueError, TypeError, AttributeError):
        return None  # a mapping configuration fault cannot stop physical control
    observer.mapping = mapper
    return asyncio.create_task(mapper.run())
