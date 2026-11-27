"""Observation-only onboard mapping worker; transport callbacks only retain samples.

All decoding, DDS subscription, service lifecycle, grid work and HTTP occur off the
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
import time
from uuid import UUID

from foothold_agent.slam_source import Source, SOURCES
from .poses import timestamp
from .runtime import MappingRuntime,TransferError
from .services import Services
from .health import PointLioHealth, FRESH_SECONDS, MAX_POSITION_JUMP_M
from .raw_recording import RawRecorder
from .world import WorldAccumulator
from .tiles import Tiles
from .glim_dump import DumpSession

LOG = logging.getLogger(__name__)
DISCONNECT_GRACE_SECONDS = 5 * 60
POINTLIO_WAIT_SECONDS = 30


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
    def __init__(self,*args,command_allowed=lambda:False,source=None,service_run=None,local_enabled=None,**kwargs):
        super().__init__(*args,**kwargs)
        self.local_enabled=local_enabled or self.enabled
        self.live=source or Source(self.env,'point_lio')
        self.final=Source(self.env,'glim')
        self.source=self.live
        self.frame=self.live.frame or 'unconfigured'
        self.mode=self.live.input_mode
        self.core=WorldAccumulator(mode=self.mode,frame=self.frame,max_points=500000,now=self.now)
        self.pending_samples={}
        self.pose_histories={key:deque(maxlen=64) for key in SOURCES}
        self.input_stamps={}
        self.handles=[]
        self.pointlio=PointLioHealth(self.live,self.now)
        self.services=Services(self.env,self.local_recording_allowed,run=service_run,
            now=self.now,fresh=self.pointlio.fresh)
        self.services_fault=None
        self.services_requested=False
        self.raw=RawRecorder(self.env,self.local_recording_allowed,self.services)
        self.seen=set()
        self.phase='UNKNOWN'
        self.command_id=None
        self.revision=1
        self.update_seq=self.voxel_seq=0
        self.sent_cells=set()
        self.changes=OrderedDict()
        self.change_seq=0
        self.reset=True
        self.tiles=Tiles()
        self.times={}
        self.last_odom=None
        self.final_received=False
        self.save_requested=None
        self.frozen=self.rebuild=None
        self.bundle_cancelled=threading.Event()
        self.save_failed=False
        self.confirmed_report=None
        self.remote_terminal=False
        self.was_enabled=False
        self.disconnected_since=None
        self.services_disconnected=False
        self.input_wait_since=None
        self.not_before=float('-inf')
        self.dump=None
        self.dump_eligible=False
        self.dump_failed=False
        self.dump_timeout=180.

    def close(self):
        self.raw.close()
        self.services.close()
        super().close()

    def command(self, frame):
        if self.stopping.is_set() or not self.enabled():
            return
        if frame.get('source') not in SOURCES:
            return
        try:
            frame = dict(frame)
            for name in ('command_id', 'session_id', 'floor_id'):
                frame[name] = str(UUID(frame[name]))
            requested = datetime.fromisoformat(frame['requested_at'].replace('Z', '+00:00'))
            if requested.tzinfo is None or frame['op'] not in ('start', 'save', 'cancel'):
                return
            if frame['op']=='start' and frame['source']!='point_lio':
                return
            if frame.get('pipeline','point_lio+glim')!='point_lio+glim' or frame.get('final_source','glim')!='glim':
                return
            if type(frame['revision']) is not int or not 1 <= frame['revision'] < 2**53:
                return
        except (KeyError, TypeError, ValueError, AttributeError):
            return
        frame['_received_monotonic'],frame['_received_utc']=self.now(),utc()
        if (frame['op']=='cancel' and frame['session_id']==self.core.session_id
                and frame['floor_id']==self.core.floor_id):
            self.services.stop()
            self.raw.stop('cancelled')
        if (frame['op']=='save' and frame['session_id']==self.core.session_id
                and frame['floor_id']==self.core.floor_id):
            self.raw.stop('save_requested')
        super().command(frame)

    def receive(self, topic, message):
        if (self.stopping.is_set() or not self.local_enabled()
                or self.core.status in ('SAVED','CANCELLED') and not self.services.control_enabled()):
            return
        # Retain one reference per topic, never copy/parse a cloud on DDS lane.
        try:
            if topic in (self.live.cloud_topic,self.final.cloud_topic) and len(message.data)>16_000_000:
                self.dropped(topic, 'input_bytes')
                return
            with self.lock:
                self.pending_samples[topic] = self.now(), message
        except (AttributeError, TypeError):
            self.dropped(topic, 'malformed_sample')

    def dropped(self, topic, reason):
        LOG.warning('SLAM dropped topic=%s reason=%s monotonic=%.6f utc=%s', topic, reason, self.now(), utc())

    def suspend(self):
        # A transport loss does not revoke local observation permission.
        if self.disconnected_since is None:
            self.disconnected_since=self.now()
        self.online=False
        self.next_report=float('-inf')

    def local_recording_allowed(self):
        return (not self.stopping.is_set() and self.local_enabled()
            and (self.online or self.core.session_id is not None
                and self.disconnected_since is not None and not self.services_disconnected
                and self.now()-self.disconnected_since<DISCONNECT_GRACE_SECONDS))

    def stop_observation(self):
        self.raw.stop('observation_unavailable')
        self.services_disconnected=True
        self.services.stop()
        with self.lock:
            self.commands.clear()
            self.pending_samples.clear()
        for history in self.pose_histories.values():
            history.clear()
        self.rebuild=None
        if self.core.session_id and self.core.status not in ('SAVED','CANCELLED'):
            self.phase,self.core.status='UNKNOWN','UNKNOWN'

    def acquire(self):
        from functools import partial
        try:
            for source in (self.live,self.final):
                if not source.configured:
                    continue
                topics=[(source.odom_topic,True)]
                if source is self.live:
                    topics.append((source.cloud_topic,False))
                for topic,is_pose in topics:
                    handle=self.channel.cloud_bus.subscribe(topic,partial(self.receive,topic),
                        **({'pose_type':source.pose_type} if is_pose else {}))
                    self.handles.append(handle)
        except Exception:
            self.dropped('readers','reader_unavailable')
            self.release_readers()

    def release_readers(self):
        for handle in self.handles:
            try: handle.Close()
            except Exception: pass
        self.handles.clear()

    def handle_command(self,frame):
        op,sid=frame['op'],frame['session_id']
        if frame['command_id'] in self.seen or len(self.seen)>=4096:
            return
        if op!='start' and (sid!=self.core.session_id or frame['floor_id']!=self.core.floor_id):
            return
        if op!='start' and self.remote_terminal:
            return
        self.seen.add(frame['command_id'])
        LOG.warning('SLAM command_received op=%s monotonic=%.6f utc=%s',op,frame['_received_monotonic'],frame['_received_utc'])
        if op=='start':
            if self.core.session_id==sid:
                return
            self.raw.stop('session_replaced')
            self.core.status='CANCELLED'
            self.source=self.live
            self.frame=self.live.frame or 'unconfigured'
            self.core=WorldAccumulator(mode=self.live.input_mode,frame=self.frame,max_points=500000,now=self.now)
            self.not_before=frame['_received_monotonic']
            self.input_stamps.clear()
            for history in self.pose_histories.values():
                history.clear()
            if not self.core.command({k:frame[k] for k in ('t','op','session_id','floor_id')}):
                return
            self.revision,self.update_seq,self.voxel_seq=frame['revision'],0,0
            self.sent_cells,self.reset,self.final_received=set(),True,False
            self.changes.clear()
            self.tiles=Tiles()
            self.times,self.last_odom={},None
            self.frozen=self.save_requested=self.rebuild=None
            self.bundle_cancelled=threading.Event()
            self.save_failed=False
            self.confirmed_report=None
            self.remote_terminal=False
            self.dump=None
            self.dump_eligible=self.dump_failed=False
            self.services_requested=False
            self.services_disconnected=False
            self.services_fault=None
            self.input_wait_since=None
            self.phase,self.core.status='START_REQUESTED','STARTING'
            if not self.live.configured:
                self.problem('MAPPING_FRAME_REQUIRED','Point-LIO 토픽과 지도 좌표 설정을 확인해 주세요.')
            else:
                root=self.env.get('FH_MAPPING_GLIM_DUMP_ROOT','')
                if root and self.final.configured:
                    try:
                        self.dump_timeout=float(self.env.get('FH_MAPPING_GLIM_DUMP_TIMEOUT_S','180'))
                        if not math.isfinite(self.dump_timeout) or not 10<=self.dump_timeout<=600:
                            raise ValueError('invalid dump timeout')
                        self.dump=DumpSession(root,sid,self.revision+1,self.final.frame,now=self.now)
                        self.dump.prepare()
                    except (OSError,ValueError):
                        self.dump=None
                        self.dropped('dump','session_prepare_failed')
                services_requested = self.services.start()
                self.services_requested=services_requested
                if not services_requested:
                    if self.services.control_enabled():
                        self.problem('MAPPING_SERVICES_FAILED','지도 서비스를 시작하지 못했습니다. 설치 설정과 관측 연결을 확인해 주세요.')
                    else:
                        self.problem('MAPPING_SERVICES_DISABLED','지도 서비스 실행 설정이 꺼져 있습니다. 설치 설정을 확인해 주세요.')
                self.raw.start(sid, services_requested=services_requested)
        elif op=='cancel':
            self.raw.stop('cancelled')
            self.core.status='CANCELLED'
            self.bundle_cancelled.set()
            self.remove_bundle(sid)
            self.phase='UNKNOWN'
            self.rebuild=None
            self.services.stop()
            return
        elif self.frozen is not None:
            self.raw.stop('save_requested')
            self.save_failed=False
            self.phase,self.core.status='SAVE_REQUESTED','SAVING'
        else:
            self.raw.stop('save_requested')
            self.save_requested=frame['_received_monotonic']
            self.final_received=False
            self.dump_eligible=bool(self.dump and not self.services_disconnected and not self.services_fault
                and self.session_services_ready() and self.services.status=='STARTED'
                and self.services.glim in self.services.owned)
            self.services.stop()
            self.phase,self.core.status='SAVE_REQUESTED','SAVING'
            if not self.dump_eligible:
                self.problem('GLIM_FINAL_CONFIGURATION_REQUIRED','GLIM 최종 지도 규격과 좌표 설정 확인이 필요합니다. 받은 범위만 저장할 수 있습니다.')
        self.command_id=frame['command_id']
        self.times['agent_received_at']=frame['_received_utc']
        self.next_report=float('-inf')

    def problem(self,code,reason):
        self.phase,self.core.status='UNKNOWN','UNKNOWN'
        self.core.error_code,self.core.reason=code,reason

    def consume_samples(self,samples):
        if not self.session_receiving_ready():
            return
        import numpy as np
        for source in (self.live,self.final):
            history=self.pose_histories[source.source]
            ready_at=self.services.ready_at
            if source.odom_topic in samples:
                received,message=samples[source.odom_topic]
                try:
                    if (not 0<=self.now()-received<=.5 or self.services.status=='STARTING'
                            or ready_at is not None and received<ready_at):
                        raise ValueError('stale_pose')
                    stamp=timestamp(message.header.stamp)
                    position,quaternion,body=source.decode_pose(message)
                    if history and stamp<=history[-1][1]:
                        raise ValueError('non_increasing_stamp')
                    history.append((received,stamp,position,quaternion,body))
                    if self.source.source==source.source and not (source is self.final and self.final_received):
                        self.last_odom=body
                except (ValueError,AttributeError,TypeError,OverflowError):
                    self.dropped(source.odom_topic,'invalid_frame_stamp_pose')
                    self.core.error_code,self.core.reason='SLAM_INPUT_REJECTED','지도 위치 자료의 시각과 좌표 설정을 확인해 주세요.'
            topic=source.cloud_topic
            if (topic not in samples or not self.core.session_id or self.core.status in ('SAVED','CANCELLED')
                    or self.frozen or source is self.live and self.source is self.final
                    or source is self.final or self.save_requested is not None):
                continue
            received,message=samples[topic]
            try:
                if received<self.not_before:
                    continue
                if not source.configured or message.header.frame_id!=source.frame or not 0<=self.now()-received<=.5:
                    raise ValueError('frame_or_age')
                if self.services.status=='STARTING' or ready_at is not None and received<ready_at:
                    continue
                stamp=timestamp(message.header.stamp)
                if stamp<=self.input_stamps.get(topic,0):
                    raise ValueError('non_increasing_stamp')
                poses=[pose for pose in history if 0<=self.now()-pose[0]<=.5 and abs(pose[1]-stamp)<=250000000
                       and (ready_at is None or pose[0]>=ready_at)]
                if not poses:
                    raise ValueError('missing_synchronized_pose')
                pose=min(poses,key=lambda pose:abs(pose[1]-stamp))
                header,payload=source.decode_cloud(message,max_points=self.core.cap)
                result=self.core.add_world(np.frombuffer(payload,dtype='<f4').reshape(-1,3),pose[2],pose[3],
                    stamp=stamp,frame=source.frame)
                self.core.truncated|=header['truncated']
                if self.core.error_code in ('SLAM_INPUT_REJECTED','SLAM_DATA_UNAVAILABLE'):
                    self.core.error_code=self.core.reason=None
                self.input_stamps[topic]=stamp
                self.tiles.changed(self.core.grid)
                self.change_seq+=1
                for key in self.core.added: self.changes[key]=True,self.change_seq
                at=utc()
                self.times.setdefault('first_data_at',at)
                self.times['last_data_at']=at
                LOG.warning('SLAM data source=%s stamp=%d points=%d bytes=%d elapsed_ms=%.3f received_monotonic=%.6f monotonic=%.6f utc=%s',
                    source.source,stamp,header['count'],len(payload),result['elapsed_ms'],received,self.now(),at)
            except (ValueError,AttributeError,TypeError,OverflowError):
                self.dropped(topic,'invalid_frame_stamp_or_pose')
                self.core.error_code,self.core.reason='SLAM_INPUT_REJECTED','지도 점과 위치의 시각·좌표 설정을 확인해 주세요.'

    def dump_step(self):
        if (self.save_requested is None or not self.dump_eligible or self.dump_failed
                or self.final_received or self.rebuild is not None or self.frozen is not None
                or self.core.status in ('SAVED','CANCELLED','FAILED')):
            return
        try:
            if self.dump.ready(stopped=self.services.status=='STOPPED' and not self.services.owned):
                self.rebuild=dict(chunks=iter(self.dump.chunks(self.final)),
                    core=WorldAccumulator(mode='projection',frame=self.final.frame,
                        max_points=500000,cap=512,budget_ms=100,now=self.now),offset=0)
        except (OSError,ValueError,KeyError,TypeError):
            self.dump_failed=True
            self.problem('GLIM_DUMP_UNCONFIRMED','GLIM 저장 파일의 세션과 완료를 확인하지 못했습니다. 받은 범위만 저장합니다.')

    def rebuild_step(self):
        """Read the verified dump offscreen; switch only after the final check."""
        pending = self.rebuild
        if pending is None:
            return
        core=pending['core']
        try:
            try:
                points,pose=next(pending['chunks'])
            except StopIteration:
                points=None
            if points is not None:
                pending['pose']=pose
                pending['offset']+=1
                core.add_world(points,pose[0],pose[1],stamp=pending['offset'],
                    frame=self.final.frame,complete_chunk=True)
                return
            if not core.cells:
                raise ValueError('empty final map')
            pose=pending['pose']
            self.core.cells, self.core.grid = core.cells, core.grid
            self.source=self.final
            self.frame=self.source.frame
            self.core.frame=self.frame
            self.last_odom=pose[2]
            self.core.last_pose, self.core.robot = core.last_pose, core.robot
            self.core.floor_z = core.floor_z
            self.core.last_cloud_stamp = pose[3]
            self.core.truncated = core.truncated
            self.core.error_code=self.core.reason=None
            self.core.version += 1
            self.revision = self.dump.binding['revision']
            self.reset, self.sent_cells = True, set()
            self.tiles = Tiles()
            self.tiles.changed(core.grid)
            self.change_seq += 1
            self.changes = OrderedDict((key,(True,self.change_seq)) for key in core.cells)
            self.final_received = True
            at = utc()
            self.times.setdefault('first_data_at',at)
            self.times['last_data_at'] = at
            self.times['slam_ack_at']=utc()
            LOG.warning('SLAM dump_completed revision=%d truncated=%s monotonic=%.6f utc=%s',
                self.revision,self.core.truncated,self.now(),at)
        except (OSError,ValueError,AttributeError,TypeError,OverflowError,KeyError,StopIteration):
            self.dump_failed=True
            self.dropped(self.final.map_topic,'invalid_full_map')
            self.problem('GLIM_REBUILD_FAILED','GLIM 최종 지도를 읽지 못했습니다. 마지막 실시간 지도를 유지합니다.')
        self.rebuild=None

    def save_timed_out(self):
        timeout=self.dump_timeout if self.dump_eligible else 10
        return self.save_requested is not None and self.now()-self.save_requested>=timeout

    def services_stopped(self):
        return not self.services.owned and not self.services.pending and self.services.status!='STARTING'

    def session_services_ready(self):
        # ready_at survives stop failure for this session's bounded fallback,
        # but an unaccepted/replaced start must never inherit an older graph.
        return (not self.services.control_enabled() or self.services_requested
            and self.services.ready_at is not None and self.services.ready_at>=self.not_before)

    def session_receiving_ready(self):
        # Historical readiness authorizes saving retained data, not new input
        # after owned services stop or disconnect cleanup invalidates the run.
        return (not self.remote_terminal and (not self.services.control_enabled() or self.session_services_ready()
            and not self.services_disconnected and not self.services_fault
            and self.services.receiving_ready()))

    def check_services_health(self):
        if (self.services.control_enabled() and self.session_services_ready()
                and self.save_requested is None and not self.services_disconnected
                and not self.services_fault
                and self.core.session_id and self.core.status not in ('SAVED','CANCELLED','FAILED')):
            if self.services.pointlio_restarted:
                self.services_fault='위치 계산이 다시 시작되어 기준을 확인할 수 없습니다. 받은 자료를 저장하거나 새로 시작해 주세요.'
            elif self.pointlio.error or self.services.status!='STARTED' or self.services.glim not in self.services.owned:
                self.services_fault=self.services_fault or self.pointlio.error or self.services.start_error or (
                    '지도 기록이 꺼졌습니다. 받은 자료를 저장하거나 새로 시작해 주세요.')
            elif not self.services.receiving_ready():
                if self.input_wait_since is None:
                    receipts=[item[0] for item in self.pointlio.state[:2] if item is not None]
                    self.input_wait_since=min(self.now(),min(receipts)+FRESH_SECONDS) if receipts else self.now()
                self.problem('MAPPING_INPUT_WAITING','위치 자료를 기다리는 중')
            elif self.input_wait_since is not None:
                pose=self.pointlio.state[0]
                if (pose is not None and self.core.last_pose is not None
                        and math.dist(pose[2],self.core.last_pose)>MAX_POSITION_JUMP_M):
                    self.services_fault='위치 기준이 바뀌었습니다. 받은 자료를 저장하거나 새로 시작해 주세요.'
                else:
                    self.input_wait_since=None
                    self.core.error_code=self.core.reason=None
                    self.phase,self.core.status=('STARTED','RUNNING') if self.core.cells else ('START_REQUESTED','STARTING')
            if self.input_wait_since is not None and self.now()-self.input_wait_since>=POINTLIO_WAIT_SECONDS:
                self.services_fault=self.services_fault or '위치 자료를 30초 동안 받지 못했습니다. 받은 자료를 저장하거나 새로 시작해 주세요.'
        if self.services_fault and self.save_requested is None and self.core.status not in ('SAVED','CANCELLED','FAILED'):
            if self.core.error_code!='MAPPING_SERVICES_UNAVAILABLE':
                self.raw.stop('pointlio_or_glim_unavailable')
                self.services.stop()
            self.problem('MAPPING_SERVICES_UNAVAILABLE',self.services_fault)

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
            origin=[(grid.c0+c)*.05, (grid.r0+r)*.05, 0], floor_z=self.core.floor_z if self.core.floor_z is not None else 0,
            width=w, height=h, cells=states[r:r+h,c:c+w].ravel().tolist())

    def report_body(self):
        self.update_seq += 1
        pending = list(islice(self.changes.items(), 2000))
        added = [key for key, (present, _) in pending if present]
        removed = [key for key, (present, _) in pending if not present]
        self.voxel_seq += 1
        body = dict(t='slam.update', source=self.source.source, session_id=self.core.session_id, floor_id=self.core.floor_id,
            pipeline='point_lio+glim',final_source='glim',
            status=self.core.status, phase=self.phase, command_id=self.command_id, revision=self.revision,
            update_seq=self.update_seq, point_count=len(self.core.cells), elapsed_s=max(0,self.now()-self.core.started),
            times=dict(self.times), odom=self.last_odom,
            error_code=self.core.error_code,reason=self.core.reason,
            voxels=dict(revision=self.revision, seq=self.voxel_seq, reset=self.reset, resolution=.05,
                        frame_id=self.frame, added=added, removed=removed))
        grid = self.grid_body(crop=True,max_cells=4000) if self.core.grid.ready and self.core.status!='FAILED' else None
        if grid is not None:
            body['grid'] = grid
        if self.core.truncated and not self.core.error_code:
            body.update(error_code='MAPPING_PARTIAL', reason='계산 한도 안에서 받은 자료입니다. 최종 지도와 좌표 보정은 실기 확인이 필요합니다.')
        body['tiles'] = [dict(revision=self.revision, tile_seq=t['version'], x=t['tx'], y=t['ty'],
            frame_id=self.frame, floor_z=self.core.floor_z if self.core.floor_z is not None else 0,
            resolution=.05, size=64, cells=t['cells']) for t in (self.tiles.take(self.core.grid) if self.core.status!='FAILED' else [])]
        raw_reason = self.raw.reason(self.core.session_id)
        if raw_reason:
            reason = body.get('reason') or ''
            body['reason'] = (reason[:max(0, 197-len(raw_reason))] + ' · ' + raw_reason).lstrip(' ·')
        return body, added, removed

    def remove_bundle(self, session):
        try:
            (self.folder / (session + '.bundle.json')).unlink(missing_ok=True)
        except OSError:
            self.dropped('bundle', 'cache_cleanup_failed')

    def store_bundle(self, data, session, cancelled):
        if cancelled.is_set():
            return
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
        try:
            if cancelled.is_set():
                return
            response = self.request(session,'bundle',data)
            if (not isinstance(response, dict) or response.get('session_id') != session
                    or response.get('status') not in ('SAVED', 'RECEIVED_ONLY')):
                raise TransferError('MAPPING_SAVE_UNCONFIRMED','지도 묶음 수신 확인이 안 되어 다시 저장해야 합니다.')
            self.remove_bundle(session)
            return response
        finally:
            # Cancel may run before the atomic file replacement or during HTTP.
            if cancelled.is_set():
                self.remove_bundle(session)
            if self.core.session_id==session:
                self.raw.stop('session_ended')
                self.services.stop()

    def finish_remote_report(self,response,session):
        if (session!=self.core.session_id or self.remote_terminal or not isinstance(response,dict)
                or response.get('status') not in ('CANCELLED','SAVED','RECEIVED_ONLY')):
            return
        self.remote_terminal=True
        self.raw.stop('cancelled' if response['status']=='CANCELLED' else 'session_ended')
        self.services.stop()
        self.bundle_cancelled.set()
        self.remove_bundle(session)
        self.core.status='SAVED' if response['status']=='RECEIVED_ONLY' else response['status']
        self.phase='UNKNOWN'
        self.save_requested=self.frozen=self.rebuild=None
        self.save_failed=True
        self.confirmed_report=None

    def step(self):
        if self.stopping.is_set() or not self.local_enabled():
            return
        with self.lock:
            commands, self.commands = self.commands, deque(maxlen=8)
            samples, self.pending_samples = self.pending_samples, {}
        if self.report_future is not None and self.report_future.done():
            try:
                self.finish_remote_report(self.report_future.result(),self.report_changes[3])
            except Exception:
                pass  # A failed request leaves the report pending for retry.
        if self.services.control_enabled():
            self.check_services_health()
            self.pointlio.update(samples)
        for frame in commands:
            self.handle_command(frame)
        self.check_services_health()
        if (self.services_disconnected and self.save_requested is None
                and self.core.status not in ('SAVED','CANCELLED','FAILED')):
            self.problem('MAPPING_SERVICES_DISCONNECTED','연결이 끊겨 지도 서비스 정지를 요청했습니다. 받은 자료를 저장하거나 새 세션으로 다시 시작해 주세요.')
        if samples:
            self.consume_samples(samples)
        self.dump_step()
        self.rebuild_step()
        if self.phase=='START_REQUESTED' and self.services.status in ('UNKNOWN','STOPPED'):
            self.problem('MAPPING_SERVICES_FAILED',self.services.start_error or '지도 서비스를 시작하지 못했습니다. 설치 설정을 확인해 주세요.')
        if self.phase=='START_REQUESTED' and self.now()-self.core.started>10:
            if self.services.status=='STARTED':
                self.problem('SLAM_DATA_UNAVAILABLE','지도 서비스는 시작됐지만 지도 점과 대응 위치를 받지 못했습니다.')
            else:
                self.problem('MAPPING_SERVICES_TIMEOUT','지도 서비스 시작을 확인하지 못했습니다. 설치 설정을 확인해 주세요.')
                self.services.stop()
        if (self.save_requested is None and self.core.cells and self.session_receiving_ready() and self.services.status=='STARTED'
                and self.core.status not in ('SAVED','CANCELLED','FAILED')):
            self.phase,self.core.status='STARTED','RUNNING'
        elif self.save_requested is not None and self.core.status not in ('SAVED','CANCELLED','FAILED'):
            if self.final_received and not self.core.truncated:
                self.phase,self.core.status='SLAM_SAVED','FINALIZING'
            elif self.final_received and self.core.truncated:
                self.problem('MAPPING_PARTIAL','계산 한도로 잘린 최종 지도입니다. 받은 범위만 저장합니다.')
            elif self.save_timed_out() and self.rebuild is None:
                self.dump_failed=True
                reason=('지도 서비스 정지를 확인하지 못했습니다. GLIM 최종 저장은 미확인으로 두고 받은 범위만 저장합니다.'
                    if not self.services_stopped() else 'GLIM 최종 저장 확인이 안 되어 받은 범위만 저장합니다.')
                self.problem('GLIM_FINAL_UNCONFIRMED',reason)
        if self.save_future is not None and self.save_future.done():
            future, self.save_future = self.save_future, None
            try:
                future.result()
                if self.core.session_id == self.save_session and self.core.status != 'CANCELLED' and not self.remote_terminal:
                    self.core.status = 'SAVED'
                    self.services.stop()
                    self.times['saved_at'] = utc()
                    LOG.warning('SLAM saved monotonic=%.6f utc=%s', self.now(), self.times['saved_at'])
            except Exception as error:
                if self.core.session_id == self.save_session and self.core.status != 'CANCELLED' and not self.remote_terminal:
                    self.save_failed = True
                    self.core.fail(error.code,error.reason) if isinstance(error,TransferError) else self.core.fail(
                        'MAPPING_SAVE_FAILED','지도 묶음을 저장하지 못했습니다. 같은 자료로 다시 저장해 주세요.')
                    self.phase='FAILED'
                    self.services.stop()
                    self.dropped('bundle','upload_failed')
        if (self.save_requested is not None and self.save_future is None and not self.save_failed
                and self.session_services_ready()
                and self.rebuild is None
                and self.source.map_topic not in self.pending_samples
                and self.core.status not in ('SAVED','CANCELLED') and self.core.cells
                # Stop confirmation gates verified dump reads, not the bounded
                # UNKNOWN fallback: a broken user bus must not strand the save.
                and (self.final_received or self.save_timed_out())):
            if self.frozen is None:
                body = dict(session_id=self.core.session_id, revision=self.revision, frame_id=self.frame,
                    resolution=.05, voxels=list(self.core.cells), grid=self.grid_body(),
                    source=self.source.source,odom=self.last_odom,slam_save=('SLAM_SAVED' if self.final_received
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
                self.save_future = self.io.submit(self.store_bundle, self.frozen, self.save_session, self.bundle_cancelled)
        if self.report_future is not None and self.report_future.done():
            future, self.report_future = self.report_future, None
            try:
                response=future.result()
                added, removed, revision, session, tiles, changes, command_id = self.report_changes
                self.finish_remote_report(response,session)
                if (not self.remote_terminal and revision == self.revision
                        and session == self.core.session_id and command_id == self.command_id):
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
        if (self.online and self.core.session_id and self.core.status not in ('SAVED','CANCELLED')
                and not self.remote_terminal
                and self.now()>=self.next_report and self.report_future is None):
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

    def cleanup_disconnected(self):
        if (self.disconnected_since is not None
                and self.now()-self.disconnected_since>=DISCONNECT_GRACE_SECONDS
                and not self.services_disconnected):
            self.raw.stop('observation_unavailable')
            self.services_disconnected=True
            self.services.stop()
            with self.lock:
                self.pending_samples.clear()
            for history in self.pose_histories.values():
                history.clear()
            self.rebuild=None

    def connection(self, connected):
        if not connected:
            self.suspend()
            self.cleanup_disconnected()
        else:
            # Check the old deadline before forgetting it, even if no worker
            # tick ran at the deadline itself.
            self.cleanup_disconnected()
            if not self.online:
                self.next_report=float('-inf')
            self.disconnected_since=None
            self.online=True

    def worker(self):
        try:
            while not self.stopping.wait(.02):
                enabled = self.local_enabled()
                if not enabled:
                    if self.was_enabled:
                        self.stop_observation()
                        self.release_readers()
                    self.was_enabled = False
                    continue
                self.cleanup_disconnected()
                if not self.online and not self.local_recording_allowed():
                    continue
                if not self.was_enabled or not self.handles and self.now() >= getattr(self, 'next_acquire', 0):
                    self.acquire()
                    self.next_acquire = self.now()+1
                    self.was_enabled = True
                try:
                    self.step()
                except Exception:
                    self.raw.stop('mapping_failed')
                    self.phase, self.core.status = 'FAILED', 'FAILED'
                    self.core.error_code,self.core.reason='MAPPING_FAILED','지도 계산 구성요소와 입력 자료를 확인해 주세요.'
                    self.save_failed=True
                    self.services.stop()
                    self.dropped('worker', 'mapping_failed')
        finally:
            self.raw.close()
            self.release_readers()
            self.services.close()

    async def run(self):
        self.thread = threading.Thread(target=self.worker, name='slam-observe', daemon=True)
        self.thread.start()
        try:
            while True:
                connected = bool(self.enabled() and self.observer.connected and not self.observer.link_lost
                                 and not self.observer.reconnect_required)
                self.connection(connected)
                await asyncio.sleep(.02)
        finally:
            self.close()
            if self.raw.thread is not None:
                # Give SIGINT/rosbag metadata flush a bounded shutdown window;
                # joining in a helper thread leaves the control loop runnable.
                await asyncio.to_thread(self.raw.thread.join, 10)
            self.io.shutdown(wait=False, cancel_futures=True)
