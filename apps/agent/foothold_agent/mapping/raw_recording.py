"""Optional local rosbag lane. No discovery, uploads, or recording deletion.

Only the Popen handle created here owns a process group. All filesystem work,
process launch, size polling and SIGINT finalization stay off the control loop.
"""
import logging
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import threading
import time
from uuid import UUID

LOG = logging.getLogger(__name__)
MAX_BYTES = 2_000_000_000
MIN_FREE_BYTES = 10_000_000_000


def recording_size(folder):
    total = 0
    for root, _, files in os.walk(folder, followlinks=False):
        for index, name in enumerate(files):
            info = os.stat(Path(root) / name, follow_symlinks=False)
            total += info.st_size
            if index % 256 == 255:
                time.sleep(0)
    return total


class RawRecorder:
    def __init__(self, env, allowed, services, *, popen=None,
                 disk_usage=shutil.disk_usage, size=recording_size,
                 killpg=os.killpg, poll_interval=.25):
        self.env, self.allowed, self.services = env, allowed, services
        self.popen = popen or subprocess.Popen
        self.disk_usage, self.size, self.killpg = disk_usage, size, killpg
        self.poll_interval = poll_interval
        self.lock = threading.Lock()
        self.wake = threading.Event()
        self.thread = None
        self.closed = False
        self.version = 0
        self.desired = None
        self.stop_reason = 'session_ended'
        self.state = dict(session_id=None, status='DISABLED', cause='disabled', bytes=0, path=None)

    def start(self, session, *, services_requested=True):
        session = str(UUID(session))
        with self.lock:
            if self.closed:
                return
            self.version += 1
            version = self.version
            enabled = self.env.get('FH_MAPPING_RAW_RECORD_ENABLED', '').lower() == 'true'
            requested = enabled and services_requested
            self.desired = (session, version) if requested else None
            self.state = dict(session_id=session,
                              status='STARTING' if requested else 'SKIPPED' if enabled else 'DISABLED',
                              cause='waiting_services' if requested else 'services_unavailable' if enabled else 'disabled',
                              bytes=0, path=None)
            if enabled and not services_requested:
                LOG.warning('SLAM_RAW session_id=%s status=SKIPPED cause=services_unavailable bytes=0 path=None', session)
            if requested and self.thread is None:
                self.thread = threading.Thread(target=self.worker, name='slam-raw-record', daemon=True)
                try:
                    self.thread.start()
                except RuntimeError:
                    self.thread = None
                    self.desired = None
                    self.state.update(status='FAILED', cause='worker_start_failed')
                    LOG.warning('SLAM_RAW session_id=%s status=FAILED cause=worker_start_failed bytes=0 path=None', session)
        self.wake.set()

    def stop(self, cause='session_ended'):
        with self.lock:
            self.desired = None
            self.stop_reason = cause
            if self.state['status'] == 'STARTING':
                self.state.update(status='STOPPED', cause=cause)
        self.wake.set()

    def close(self):
        with self.lock:
            self.closed = True
        self.stop('agent_closed')

    def snapshot(self):
        with self.lock:
            return dict(self.state)

    def reason(self, session):
        state = self.snapshot()
        if state['session_id'] != session or state['status'] == 'DISABLED':
            return None
        labels = dict(STARTING='원본 녹화 준비', RECORDING='원본 녹화 켜짐',
                      SKIPPED='원본 녹화 건너뜀', STOPPING='원본 녹화 종료 중',
                      STOPPED='원본 녹화 종료', LIMIT='원본 녹화 2 GB 상한 도달',
                      FAILED='원본 녹화 실패')
        return f"{labels[state['status']]} ({state['cause']}, {state['bytes']} bytes)"

    def wanted(self, job):
        with self.lock:
            return not self.closed and self.desired == job

    def publish(self, job, status, cause, size=0, path=None):
        with self.lock:
            if self.version == job[1]:
                self.state = dict(session_id=job[0], status=status, cause=cause,
                                  bytes=size, path=str(path) if path else None)
        LOG.warning('SLAM_RAW session_id=%s status=%s cause=%s bytes=%d path=%s',
                    job[0], status, cause, size, path)

    def worker(self):
        previous = None
        while True:
            self.wake.wait(self.poll_interval)
            self.wake.clear()
            with self.lock:
                job, closed = self.desired, self.closed
            if closed:
                return
            if job is None or job == previous:
                continue
            previous = job
            try:
                self.record(job)
            except Exception:
                # Recorder faults never propagate into mapping/control workers.
                self.publish(job, 'FAILED', 'recorder_error')

    def record(self, job):
        while self.wanted(job) and self.allowed() and self.services.status == 'STARTING':
            self.wake.wait(self.poll_interval)
            self.wake.clear()
        if not self.wanted(job) or not self.allowed():
            self.publish(job, 'STOPPED', 'observation_unavailable')
            return
        if not self.services.receiving_ready():
            self.publish(job, 'SKIPPED', 'services_not_owned')
            return
        process, path, size = None, None, 0
        status, cause = 'FAILED', 'start_failed'
        try:
            topics = tuple(self.env.get(key, default) for key, default in (
                ('FH_MAPPING_RAW_CLOUD_TOPIC', '/utlidar/cloud'),
                ('FH_MAPPING_RAW_IMU_TOPIC', '/utlidar/imu')))
            if any(not re.fullmatch(r'/[A-Za-z0-9_/]{1,199}', topic) for topic in topics):
                self.publish(job, 'SKIPPED', 'invalid_topics')
                return
            root = Path(self.env.get('FH_MAPPING_RAW_RECORD_DIR', '~/foothold-slam/sessions')).expanduser()
            root.mkdir(parents=True, exist_ok=True, mode=0o700)
            if self.disk_usage(root).free < MIN_FREE_BYTES:
                self.publish(job, 'SKIPPED', 'free_space_below_10GB')
                return
            # Never reuse or remove a prior session directory, including failed bags.
            folder = root / ('map-' + job[0])
            try:
                folder.mkdir(mode=0o700)
            except FileExistsError:
                self.publish(job, 'SKIPPED', 'session_path_exists', path=folder)
                return
            path = folder / 'raw'
            if not self.wanted(job) or not self.allowed():
                status, cause = 'STOPPED', 'observation_unavailable'
                return
            with (folder / 'recorder.log').open('xb') as output:
                process = self.popen(['taskset', '--cpu-list', '0-3', 'nice', '-n', '10',
                    'ros2', 'bag', 'record', '--storage', 'sqlite3', '--output', str(path), *topics],
                    stdin=subprocess.DEVNULL, stdout=output, stderr=subprocess.STDOUT,
                    start_new_session=True)
            status, cause = 'RECORDING', 'recording'
            self.publish(job, status, cause, size, folder)
            last_log = time.monotonic()
            while process.poll() is None:
                size = self.size(folder)  # includes bag sidecars and recorder log
                if size >= MAX_BYTES:
                    status, cause = 'LIMIT', 'size_limit'
                    break
                if not self.wanted(job):
                    with self.lock:
                        cause = self.stop_reason
                    status = 'STOPPED'
                    break
                if not self.allowed():
                    status, cause = 'STOPPED', 'observation_unavailable'
                    break
                if not self.services.receiving_ready():
                    status, cause = 'STOPPED', 'services_ended'
                    break
                # Progress reads the size without walking disk on the mapping lane.
                with self.lock:
                    if self.version == job[1]:
                        self.state['bytes'] = size
                if time.monotonic() - last_log >= 10:
                    self.publish(job, status, cause, size, folder)
                    last_log = time.monotonic()
                self.wake.wait(self.poll_interval)
                self.wake.clear()
            else:
                status, cause = 'FAILED', 'recorder_exited'
        except Exception:
            status, cause = 'FAILED', 'recorder_error'
            if path is None:
                self.publish(job, status, cause)
        finally:
            if process is not None:
                if process.poll() is None:
                    self.publish(job, 'STOPPING', cause, size, path.parent)
                    try:
                        self.killpg(process.pid, signal.SIGINT)
                    except ProcessLookupError:
                        pass
                    except OSError:
                        # Retain the handle even if signalling failed. Never
                        # launch another bag while this child remains alive.
                        status, cause = 'FAILED', 'sigint_failed'
                        self.publish(job, 'STOPPING', cause, size, path.parent)
                    # Keep the owned handle until reaped; no process discovery or
                    # forced kill. A slow flush cannot block STOP or start a second bag.
                    while process.poll() is None:
                        try:
                            process.wait(timeout=10)
                        except subprocess.TimeoutExpired:
                            self.publish(job, 'STOPPING', 'sigint_flush_pending', size, path.parent)
                process.wait()
                try:
                    size = self.size(path.parent)
                except OSError:
                    pass
            if path is not None:
                self.publish(job, status, cause, size, path.parent)
