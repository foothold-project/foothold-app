"""Observation-only onboard mapping worker; transport callbacks only retain samples.

All decoding, DDS initialization/publication, grid work and HTTP occur off the
control event loop. No SportClient or output sink is constructed here.
"""
import asyncio
from collections import deque, OrderedDict
from datetime import datetime, timezone
import json
import logging
import math
import os
import threading
import tempfile
from itertools import islice
import re
import time
from uuid import UUID

from .inputs import CLOUD, MAP, FRONTEND
from .poses import timestamp
from .runtime import MappingRuntime
from .uslam_control import Control
from .world import WorldAccumulator
from .tiles import Tiles

LOG = logging.getLogger(__name__)


def utc():
    return datetime.now(timezone.utc).isoformat()


def encode(body):
    # iterencode avoids the monolithic C encoder holding the GIL for an entire
    # multi-million-cell bundle while the independent safety loop is runnable.
    pieces, payload, checkpoint = [], bytearray(), time.monotonic()
    for chunk in json.JSONEncoder(allow_nan=False, separators=(',', ':')).iterencode(body):
        pieces.append(chunk)
        if len(pieces) >= 1024:
            payload.extend(''.join(pieces).encode())
            pieces.clear()
        if time.monotonic()-checkpoint > .002:
            time.sleep(0)
            checkpoint = time.monotonic()
    payload.extend(''.join(pieces).encode())
    return bytes(payload)


class OnboardRuntime(MappingRuntime):
    def __init__(self, *args, command_allowed=lambda: False, **kwargs):
        super().__init__(*args, **kwargs)
        self.frame = self.env.get('FH_USLAM_FRAME', 'map')
        self.child_frame = self.env.get('FH_USLAM_CHILD_FRAME', 'base_link')
        if any(not re.fullmatch(r'[A-Za-z0-9_/-]{1,80}', value) for value in (self.frame, self.child_frame)):
            raise ValueError('invalid observation frame configuration')
        self.mode = self.env.get('FH_USLAM_INPUT', 'projection')
        if self.mode not in ('projection', 'scan'):
            raise ValueError('invalid USLAM input mode')
        self.core = WorldAccumulator(mode=self.mode, frame=self.frame, max_points=500000, now=self.now)
        self.pending_samples = {}
        self.pose_history = deque(maxlen=64)
        self.input_stamps = {}
        self.handles = []
        self.bridge = None
        self.command_allowed = command_allowed
        self.control = Control(self.publish, enabled=self.can_publish, now=self.now,
            acknowledgments={k: v for k, v in (
                ('mapping/start', self.env.get('FH_USLAM_START_ACK')),
                ('mapping/stop', self.env.get('FH_USLAM_STOP_ACK'))) if v})
        self.phase = 'UNKNOWN'
        self.command_id = None
        self.revision = 1
        self.update_seq = self.voxel_seq = 0
        self.sent_cells = set()
        self.changes = OrderedDict()
        self.change_seq = 0
        self.reset = True
        self.tiles = Tiles()
        self.times = {}
        self.last_odom = None
        self.final_received = False
        self.save_requested = None
        self.frozen = None
        self.rebuild = None
        self.next_rebuild = None
        self.save_failed = False
        self.confirmed_report = None
        self.was_enabled = False

    def can_publish(self):
        return (not self.stopping.is_set() and self.enabled() and self.online
                and self.env.get('FH_USLAM_COMMANDS') == '1' and self.command_allowed())

    def publish(self, value):
        if self.bridge is None:
            raise PermissionError('response reader unavailable')
        self.bridge.publish(value)

    def command(self, frame):
        if self.stopping.is_set() or not self.enabled():
            return
        if frame.get('source') != 'unitree_uslam':
            return
        try:
            frame = dict(frame)
            for name in ('command_id', 'session_id', 'floor_id'):
                frame[name] = str(UUID(frame[name]))
            requested = datetime.fromisoformat(frame['requested_at'].replace('Z', '+00:00'))
            if requested.tzinfo is None or frame['op'] not in ('start', 'save', 'cancel'):
                return
            if type(frame['revision']) is not int or not 1 <= frame['revision'] < 2**53:
                return
        except (KeyError, TypeError, ValueError, AttributeError):
            return
        super().command(frame)

    def receive(self, topic, message):
        if self.stopping.is_set() or not self.enabled():
            return
        # Retain one reference per topic, never copy/parse a cloud on DDS lane.
        try:
            if topic in (CLOUD, MAP) and len(message.data) > 16_000_000:
                self.dropped(topic, 'input_bytes')
                return
            with self.lock:
                self.pending_samples[topic] = self.now(), message
        except (AttributeError, TypeError):
            self.dropped(topic, 'malformed_sample')

    def on_log(self, message):
        try:
            if isinstance(message.data, str) and len(message.data) <= 4096:
                self.receive('log', message)
        except AttributeError:
            pass

    def dropped(self, topic, reason):
        LOG.warning('USLAM dropped topic=%s reason=%s monotonic=%.6f utc=%s', topic, reason, self.now(), utc())

    def suspend(self):
        super().suspend()
        self.control.disconnect()
        with self.lock:
            self.pending_samples.clear()
        self.pose_history.clear()
        self.rebuild = None
        self.next_rebuild = None

    def acquire(self):
        from functools import partial
        from foothold_agent.go2_direct.uslam_commands import CommandChannel
        try:
            for topic in (FRONTEND, CLOUD, MAP):
                handle = self.channel.cloud_bus.subscribe(topic, partial(self.receive, topic), odometry=topic == FRONTEND)
                self.handles.append(handle)
            self.bridge = CommandChannel(self.on_log, self.can_publish)
            self.bridge.open()
        except Exception:
            self.dropped('readers', 'reader_unavailable')
            self.release_readers()

    def release_readers(self):
        if self.bridge is not None:
            self.bridge.close()
            self.bridge = None
        for handle in self.handles:
            try:
                handle.Close()
            except Exception:
                pass
        self.handles.clear()

    def handle_command(self, frame):
        op, sid = frame['op'], frame['session_id']
        if frame['command_id'] in self.control.seen:
            return
        if op != 'start' and (sid != self.core.session_id or frame['floor_id'] != self.core.floor_id):
            return
        if op == 'start':
            if self.core.session_id == sid:
                return  # same session never restarts the robot, even under a new command UUID
            if self.core.session_id is not None:
                self.core.status = 'CANCELLED'
            self.control.disconnect()
            simple = {k: frame[k] for k in ('t', 'op', 'session_id', 'floor_id')}
            if not self.core.command(simple):
                return
            self.revision, self.update_seq, self.voxel_seq = frame['revision'], 0, 0
            self.sent_cells, self.reset, self.final_received = set(), True, False
            self.changes.clear()
            self.tiles = Tiles()
            self.times, self.last_odom = {}, None
            self.frozen, self.save_requested, self.save_failed = None, None, False
            self.confirmed_report = None
            self.rebuild = None
            self.next_rebuild = None
            self.pose_history.clear()
            self.input_stamps.clear()
            with self.lock:
                self.pending_samples.clear()
            self.phase, self.core.status = 'START_REQUESTED', 'STARTING'
        elif op == 'cancel':
            self.core.status = 'CANCELLED'
            self.rebuild = None
            self.next_rebuild = None
            self.control.disconnect()  # local cancellation cannot claim a robot stop
            self.control.seen.add(frame['command_id'])
            return
        elif self.frozen is not None:
            self.save_failed = False  # retry identical frozen bundle; never replay DDS stop
            self.command_id = frame['command_id']
            return
        self.command_id = frame['command_id']
        self.times['agent_received_at'] = utc()
        if op == 'save':
            self.phase, self.core.status = 'SAVE_REQUESTED', 'SAVING'
            self.save_requested, self.final_received = self.now(), False
            self.times.pop('robot_ack_at', None)
            if self.control.pending is not None:
                self.control.disconnect()  # an old start reply cannot acknowledge stop
                self.control.seen.add(self.command_id)
                self.phase, self.core.status = 'UNKNOWN', 'UNKNOWN'
                return
        if not self.control.request('mapping/start' if op == 'start' else 'mapping/stop', self.command_id):
            self.phase, self.core.status = 'UNKNOWN', 'UNKNOWN'
        elif self.control.published_at is not None:
            self.times['command_published_at'] = utc()
        self.next_report = float('-inf')

    def consume_samples(self, samples):
        import numpy as np
        from foothold_agent.go2_direct.uslam import cloud, odometry
        if 'log' in samples:
            received, message = samples['log']
            self.control.on_log(message.data, received)
        if FRONTEND in samples:
            received, message = samples[FRONTEND]
            try:
                if not 0 <= self.now()-received <= .5:
                    raise ValueError('stale_pose')
                stamp = timestamp(message.header.stamp)
                if message.header.frame_id != self.frame or message.child_frame_id != self.child_frame:
                    raise ValueError('frame')
                header, _ = odometry(message, FRONTEND)
                p, q = message.pose.pose.position, message.pose.pose.orientation
                if self.pose_history and stamp <= self.pose_history[-1][1]:
                    raise ValueError('stamp')
                self.pose_history.append((received, stamp, (p.x,p.y,p.z), (q.w,q.x,q.y,q.z)))
                self.last_odom = dict(source='/uslam/frontend/odom', frame_id=self.frame,
                    stamp=dict(sec=message.header.stamp.sec, nanosec=message.header.stamp.nanosec), **header['pose'])
            except (ValueError, AttributeError, TypeError, OverflowError):
                self.dropped(FRONTEND, 'invalid_frame_stamp_pose')
        for topic in (CLOUD, MAP):
            if topic not in samples or self.core.session_id is None or self.core.status in ('SAVED', 'CANCELLED') or self.frozen:
                continue
            received, message = samples[topic]
            try:
                if not 0 <= self.now()-received <= .5 or message.header.frame_id != self.frame:
                    raise ValueError('frame_or_age')
                stamp = timestamp(message.header.stamp)
                if stamp <= self.input_stamps.get(topic, 0):
                    raise ValueError('non_increasing_stamp')
                poses = [p for p in self.pose_history if 0 <= self.now()-p[0] <= .5 and abs(p[1]-stamp) <= 250_000_000]
                if not poses:
                    # A final full map is history, but still needs a valid same-frame
                    # height reference. Never invent a robot_odom fallback.
                    raise ValueError('missing_synchronized_frontend_pose')
                pose = min(poses, key=lambda p: abs(p[1]-stamp))
                if topic == MAP:
                    candidate = dict(message=message, received=received, stamp=stamp, pose=pose, offset=0)
                    if self.rebuild is not None:
                        self.next_rebuild = candidate
                    else:
                        self.rebuild = candidate
                    self.input_stamps[MAP] = stamp
                    continue
                header, payload = cloud(message, max_points=self.core.cap, deadline=self.now()+.015, now=self.now)
                result = self.core.add_world(np.frombuffer(payload, dtype='<f4').reshape(-1,3), pose[2], pose[3],
                    stamp=stamp, frame=self.frame, replace=topic == MAP)
                self.core.truncated |= header['truncated']
                self.input_stamps[topic] = stamp
                self.tiles.changed(self.core.grid)
                self.change_seq += 1
                for key in self.core.added:
                    self.changes[key] = True, self.change_seq
                at = utc()
                self.times.setdefault('first_data_at', at)
                self.times['last_data_at'] = at
                LOG.warning('USLAM cloud topic=%s stamp=%d points=%d bytes=%d version=%d elapsed_ms=%.3f truncated=%s monotonic=%.6f utc=%s',
                    topic, stamp, header['count'], len(payload), self.core.version, result['elapsed_ms'], self.core.truncated, self.now(), at)
            except (ValueError, AttributeError, TypeError, OverflowError):
                self.dropped(topic, 'invalid_frame_stamp_or_pose')

    def rebuild_step(self):
        """Build full snapshots offscreen in bounded chunks; publish one new revision."""
        import numpy as np
        from foothold_agent.go2_direct.uslam import cloud
        pending = self.rebuild
        if pending is None:
            return
        if 'core' not in pending:
            pending['core'] = WorldAccumulator(mode='projection',frame=self.frame,
                max_points=500000,cap=2048,budget_ms=100,now=self.now)
        message, pose, core = pending['message'], pending['pose'], pending['core']
        offset = pending['offset']
        try:
            _, payload = cloud(message, max_points=500000, sample_start=offset, sample_limit=2048)
            core.add_world(np.frombuffer(payload,dtype='<f4').reshape(-1,3),pose[2],pose[3],
                stamp=offset+1,frame=self.frame)
            pending['offset'] += 2048
            count = message.width * message.height
            if pending['offset'] < min(count,500000):
                return
            self.core.cells, self.core.grid = core.cells, core.grid
            self.core.last_pose, self.core.robot = core.last_pose, core.robot
            self.core.last_cloud_stamp = pending['stamp']
            self.core.truncated = core.truncated or count > 500000
            self.core.version += 1
            self.revision += 1
            self.reset, self.sent_cells = True, set()
            self.tiles = Tiles()
            self.tiles.changed(core.grid)
            self.change_seq += 1
            self.changes = OrderedDict((key,(True,self.change_seq)) for key in core.cells)
            self.final_received = self.save_requested is not None and pending['received'] >= self.save_requested
            at = utc()
            self.times.setdefault('first_data_at',at)
            self.times['last_data_at'] = at
            LOG.warning('USLAM full_map points=%d bytes=%d revision=%d truncated=%s monotonic=%.6f utc=%s',
                count,len(message.data),self.revision,self.core.truncated,self.now(),at)
        except (ValueError,AttributeError,TypeError,OverflowError):
            self.dropped(MAP,'invalid_full_map')
        self.rebuild, self.next_rebuild = self.next_rebuild, None

    def grid_body(self, *, crop=False, max_cells=None):
        import numpy as np
        grid = self.core.grid
        states = np.where(grid.L < -10, 1, np.where(grid.L > 15, 2, 0)).astype('uint8').reshape(grid.size, grid.size)
        c, r, w, h = 0, 0, grid.size, grid.size
        if crop:
            rows, cols = np.nonzero(states)
            if rows.size:
                c, r = int(cols.min()), int(rows.min())
                w, h = int(cols.max())-c+1, int(rows.max())-r+1
            else:
                w = h = 1
        if max_cells is not None and w * h > max_cells:
            return None
        return dict(revision=self.revision, resolution=.05, frame_id=self.frame,
            origin=[(grid.c0+c)*.05, (grid.r0+r)*.05, 0], floor_z=(self.core.last_pose[2]-.3 if self.core.last_pose else 0),
            width=w, height=h, cells=states[r:r+h,c:c+w].ravel().tolist())

    def report_body(self):
        self.update_seq += 1
        pending = list(islice(self.changes.items(), 2000))
        added = [key for key, (present, _) in pending if present]
        removed = [key for key, (present, _) in pending if not present]
        self.voxel_seq += 1
        body = dict(t='slam.update', source='unitree_uslam', session_id=self.core.session_id, floor_id=self.core.floor_id,
            status=self.core.status, phase=self.phase, command_id=self.command_id, revision=self.revision,
            update_seq=self.update_seq, point_count=len(self.core.cells), elapsed_s=max(0,self.now()-self.core.started),
            times=dict(self.times), odom=self.last_odom,
            voxels=dict(revision=self.revision, seq=self.voxel_seq, reset=self.reset, resolution=.05,
                        frame_id=self.frame, added=added, removed=removed))
        grid = self.grid_body(crop=True, max_cells=4000)
        if grid is not None:
            body['grid'] = grid
        if self.core.truncated:
            body.update(error_code='MAPPING_PARTIAL', reason='계산 한도 안에서 받은 자료입니다. 최종 지도와 좌표 보정은 실기 확인이 필요합니다.')
        body['tiles'] = [dict(revision=self.revision, tile_seq=t['version'], x=t['tx'], y=t['ty'],
            frame_id=self.frame, floor_z=(self.core.last_pose[2]-.3 if self.core.last_pose else 0),
            resolution=.05, size=64, cells=t['cells']) for t in self.tiles.take(self.core.grid)]
        return body, added, removed

    def store_bundle(self, data, session):
        self.folder.mkdir(parents=True, exist_ok=True, mode=0o700)
        path = self.folder / (session + '.bundle.json')
        fd, temporary = tempfile.mkstemp(prefix=session+'.', suffix='.tmp', dir=self.folder)
        try:
            with os.fdopen(fd, 'wb') as target:
                target.write(data)
                target.flush()
                os.fsync(target.fileno())
            os.replace(temporary, path)
        finally:
            try:
                os.unlink(temporary)
            except FileNotFoundError:
                pass
        return self.request(session, 'bundle', data)

    def step(self):
        if self.stopping.is_set():
            return
        with self.lock:
            commands, self.commands = self.commands, deque(maxlen=8)
            samples, self.pending_samples = self.pending_samples, {}
        for frame in commands:
            self.handle_command(frame)
        self.consume_samples(samples)
        self.rebuild_step()
        status = self.control.tick()
        if status == 'ACKNOWLEDGED' and self.core.status not in ('SAVED', 'CANCELLED', 'FAILED'):
            self.times.setdefault('robot_ack_at', utc())
            if self.save_requested is None:
                self.phase, self.core.status = 'STARTED', 'RUNNING'
            else:
                self.phase, self.core.status = 'ROBOT_SAVED', 'FINALIZING'
        elif status in ('UNKNOWN', 'DISABLED') and self.core.status not in ('SAVED','CANCELLED','FAILED'):
            self.phase, self.core.status = 'UNKNOWN', 'UNKNOWN'
        if self.save_future is not None and self.save_future.done():
            future, self.save_future = self.save_future, None
            try:
                future.result()
                if self.core.session_id == self.save_session and self.core.status != 'CANCELLED':
                    self.core.status = 'SAVED'
                    self.times['saved_at'] = utc()
                    LOG.warning('USLAM saved monotonic=%.6f utc=%s', self.now(), self.times['saved_at'])
            except Exception:
                if self.core.session_id == self.save_session and self.core.status != 'CANCELLED':
                    self.save_failed = True
                    self.core.status, self.phase = 'FAILED', 'FAILED'
        if (self.save_requested is not None and self.save_future is None and not self.save_failed
                and self.rebuild is None
                and MAP not in self.pending_samples
                and self.core.status not in ('SAVED','CANCELLED') and self.core.cells
                and (self.final_received and self.phase == 'ROBOT_SAVED' or self.now()-self.save_requested >= 10)):
            if self.frozen is None:
                body = dict(session_id=self.core.session_id, revision=self.revision, frame_id=self.frame,
                    resolution=.05, voxels=list(self.core.cells), grid=self.grid_body(),
                    robot_save=('ROBOT_SAVED' if self.phase == 'ROBOT_SAVED' and self.final_received
                                and not self.core.truncated else 'UNKNOWN'), times=dict(self.times))
                self.frozen = encode(body)
                if len(self.frozen) > 50 * 1024 * 1024:
                    self.core.status, self.phase, self.save_failed = 'FAILED', 'FAILED', True
                    return
            # Publish every final tile/change before the server owns SAVED and
            # stops accepting live progress; reconnect must see the whole pair.
            if (not self.changes and not self.tiles.pending
                    and self.confirmed_report == (self.core.session_id,self.revision,self.command_id)):
                self.save_session = self.core.session_id
                self.save_future = self.io.submit(self.store_bundle, self.frozen, self.save_session)
        if self.report_future is not None and self.report_future.done():
            future, self.report_future = self.report_future, None
            try:
                future.result()
                added, removed, revision, session, tiles, changes, command_id = self.report_changes
                if revision == self.revision and session == self.core.session_id and command_id == self.command_id:
                    self.confirmed_report = session,revision,command_id
                    self.sent_cells.update(added)
                    self.sent_cells.difference_update(removed)
                    self.reset = False
                    self.tiles.acknowledge(tiles)
                    for key, version in changes:
                        if self.changes.get(key) == version:
                            self.changes.pop(key)
            except Exception:
                pass  # regenerate from last acknowledged set
        if self.online and self.core.session_id and self.now() >= self.next_report and self.report_future is None:
            body, added, removed = self.report_body()
            data = encode(body)
            # Keep the oldest tiles; defer later tiles before shrinking changes.
            while len(data) > 65536 and body['tiles']:
                body['tiles'].pop()
                data = encode(body)
            while len(data) > 65536 and (added or removed):
                if len(added) >= len(removed):
                    del added[len(added)//2:]
                else:
                    del removed[len(removed)//2:]
                body['voxels'].update(added=added, removed=removed)
                data = encode(body)
            if len(data) <= 65536:
                tiles = [dict(tx=t['x'], ty=t['y'], version=t['tile_seq']) for t in body['tiles']]
                changes = [(key, self.changes[key]) for key in (*added, *removed)]
                self.report_changes = added, removed, self.revision, self.core.session_id, tiles, changes, self.command_id
                self.report_future = self.io.submit(self.request, self.core.session_id, 'progress', data)
            self.next_report = self.now()+.25

    def worker(self):
        try:
            while not self.stopping.wait(.02):
                enabled = self.enabled()
                if not enabled:
                    if self.was_enabled:
                        self.suspend()
                        self.release_readers()
                    self.was_enabled = False
                    continue
                if not self.was_enabled or not self.handles and self.now() >= getattr(self, 'next_acquire', 0):
                    self.acquire()
                    self.next_acquire = self.now()+1
                    self.was_enabled = True
                try:
                    self.step()
                except Exception:
                    self.phase, self.core.status = 'FAILED', 'FAILED'
                    self.dropped('worker', 'mapping_failed')
        finally:
            self.release_readers()

    async def run(self):
        self.thread = threading.Thread(target=self.worker, name='uslam-observe', daemon=True)
        self.thread.start()
        try:
            while True:
                connected = bool(self.enabled() and self.observer.connected and not self.observer.link_lost
                                 and not self.observer.reconnect_required)
                if self.online and not connected:
                    self.suspend()
                self.online = connected
                await asyncio.sleep(.02)
        finally:
            self.close()
            self.io.shutdown(wait=False, cancel_futures=True)
