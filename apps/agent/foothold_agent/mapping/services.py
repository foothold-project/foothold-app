"""Bounded local service lane; never runs systemctl on the control loop."""
import logging
import re
import subprocess
import threading
import time
from datetime import datetime,timezone

LOG=logging.getLogger(__name__)


class Services:
    def __init__(self,env,allowed,*,run=None,now=time.monotonic):
        self.env,self.allowed=env,allowed
        self.now,self.ready_at=now,None
        self.names=tuple(env.get(key,default).removesuffix('.service') for key,default in (
            ('FH_MAPPING_POINT_LIO_SERVICE','foothold-pointlio'),('FH_MAPPING_GLIM_SERVICE','foothold-glim')))
        forbidden = {'foothold-robot', 'foothold-policy-cpp', 'foothold-depth'}
        if len(set(self.names))!=2 or any(n in forbidden or not re.fullmatch(r'foothold-[A-Za-z0-9_-]{1,64}',n) for n in self.names):
            LOG.error('SLAM_SERVICE event=invalid_configuration reason=invalid_mapping_service_allowlist')
            raise ValueError('invalid mapping service allowlist')
        self.run=run or self.systemctl
        self.owned=set()
        self.status='IDLE'
        self.pending=False
        self.stop_requested=False
        self.closed=False
        self.wake=threading.Event()
        self.thread=None
        self.stop_failures={}
        self.lock=threading.RLock()
        self.version=0
        self.starting=False

    @staticmethod
    def systemctl(action,name):
        result=subprocess.run(['systemctl','--user',action,'--quiet',name],stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=5,check=False)
        return result.returncode

    def control_enabled(self):
        return self.env.get('FH_MAPPING_SERVICE_CONTROL_ENABLED','').lower()=='true'

    def start(self):
        with self.lock:
            if not self.control_enabled() or not self.allowed() or self.closed:
                self.ready_at=None
                self.stop()  # retain cleanup of the preceding session, even offline
                self.status='UNKNOWN' if self.control_enabled() else 'DISABLED'
                return False
            if self.pending or self.starting or self.status=='STARTING':
                self.stop()  # the replacement must not leave the older job running
                return False
            self.version+=1
            self.pending=True
            self.ready_at=None
            self.stop_requested=False
            self.status='STARTING'
            LOG.warning('SLAM_SERVICE event=start_requested monotonic=%.6f utc=%s',time.monotonic(),datetime.now(timezone.utc).isoformat())
            self.launch()
            self.wake.set()
            return True

    def launch(self):
        if self.thread is None:
            self.thread=threading.Thread(target=self.worker,name='slam-services',daemon=True)
            self.thread.start()

    def stop(self):
        with self.lock:
            self.version+=1
            self.pending=False
            self.stop_requested=True
            if self.thread is not None:
                self.wake.set()

    def close(self):
        self.closed=True
        self.stop()

    def cleanup(self):
        report=False
        for name in tuple(self.owned):
            try:
                result=self.run('stop',name)
                if result==0:
                    self.owned.discard(name)
                    self.stop_failures.pop(name,None)
                    report=True
                else:
                    report=self.stop_failed(name,('returncode',result)) or report
            except Exception as error:
                report=self.stop_failed(name,('exception',type(error).__name__)) or report
        with self.lock:
            self.status=('STARTING' if self.pending or self.starting else 'STOPPED') if not self.owned else 'UNKNOWN'
            if not self.owned:
                self.stop_requested=False
        if report or not self.owned:
            LOG.warning('SLAM_SERVICE event=cleanup remaining=%d monotonic=%.6f utc=%s',len(self.owned),time.monotonic(),datetime.now(timezone.utc).isoformat())

    def stop_failed(self,name,failure):
        previous=self.stop_failures.get(name)
        at=self.now()
        if previous is not None and previous[0]==failure and at-previous[1]<30:
            return False
        self.stop_failures[name]=failure,at
        LOG.warning('SLAM_SERVICE event=stop_failed service=%s %s=%s',name,*failure)
        return True

    def worker(self):
        while True:
            self.wake.wait(1)
            self.wake.clear()
            with self.lock:
                job=self.version if self.pending else None
                if job is not None:
                    self.pending=False
                    self.starting=True
            if job is not None:
                try:
                    if self.owned:
                        self.cleanup()  # never inherit the preceding SLAM graph
                        if self.owned:
                            raise OSError('previous mapping services still owned')
                    for name in self.names:
                        if not self.wanted(job):
                            raise PermissionError('mapping observation unavailable')
                        if self.run('is-active',name)==0:
                            raise PermissionError('pre-existing mapping service')
                        if not self.wanted(job):
                            raise PermissionError('mapping service start canceled')
                        self.owned.add(name)  # cleanup even if start times out after taking effect
                        if self.run('start',name)!=0:
                            raise OSError('mapping service start failed')
                    # stop/save/replacement during the last blocking call must
                    # not publish readiness. stop() shares this commit lock.
                    with self.lock:
                        if not self.wanted(job):
                            raise PermissionError('mapping service start canceled')
                        self.ready_at=self.now()
                        self.status='STARTED'
                    LOG.warning('SLAM_SERVICE event=started owned=%d monotonic=%.6f utc=%s',len(self.owned),time.monotonic(),datetime.now(timezone.utc).isoformat())
                except Exception:
                    self.status='UNKNOWN'
                    self.stop_requested=True
                finally:
                    with self.lock:
                        self.starting=False
            if self.stop_requested:
                self.cleanup()
            if self.closed:
                return

    def wanted(self,job):
        return self.version==job and not self.closed and self.allowed()
