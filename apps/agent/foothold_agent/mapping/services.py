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

    @staticmethod
    def systemctl(action,name):
        result=subprocess.run(['systemctl','--user',action,'--quiet',name],stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=5,check=False)
        return result.returncode

    def start(self):
        if self.env.get('FH_MAPPING_SERVICE_CONTROL_ENABLED','').lower()!='true' or not self.allowed() or self.closed:
            self.status='DISABLED'
            return False
        if self.pending or self.status=='STARTING':
            return False
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
        self.pending=False
        self.stop_requested=True
        if self.thread is not None:
            self.wake.set()

    def close(self):
        self.closed=True
        self.stop()

    def cleanup(self):
        for name in tuple(self.owned):
            try:
                result=self.run('stop',name)
                if result==0:
                    self.owned.discard(name)
                else:
                    LOG.warning('SLAM_SERVICE event=stop_failed service=%s returncode=%s',name,result)
            except Exception as error:
                LOG.warning('SLAM_SERVICE event=stop_failed service=%s exception=%s',name,type(error).__name__)
        self.status=('STARTING' if self.pending else 'STOPPED') if not self.owned else 'UNKNOWN'
        if not self.owned:
            self.stop_requested=False
        LOG.warning('SLAM_SERVICE event=cleanup remaining=%d monotonic=%.6f utc=%s',len(self.owned),time.monotonic(),datetime.now(timezone.utc).isoformat())

    def worker(self):
        while True:
            self.wake.wait(1)
            self.wake.clear()
            if self.pending and self.owned:
                self.cleanup()  # a new session must not inherit our old SLAM graph
                if self.owned:
                    self.pending=False
                    self.stop_requested=True
            if self.pending:
                self.pending=False
                try:
                    for name in self.names:
                        if self.stop_requested or not self.allowed():
                            raise PermissionError('mapping observation unavailable')
                        if self.run('is-active',name)==0:
                            continue  # pre-existing services never become ours
                        if self.stop_requested or not self.allowed():
                            raise PermissionError('mapping service start canceled')
                        self.owned.add(name)  # cleanup even if start times out after taking effect
                        if self.run('start',name)!=0:
                            raise OSError('mapping service start failed')
                    self.ready_at=self.now()
                    self.status='STARTED'
                    LOG.warning('SLAM_SERVICE event=started owned=%d monotonic=%.6f utc=%s',len(self.owned),time.monotonic(),datetime.now(timezone.utc).isoformat())
                except Exception:
                    self.status='UNKNOWN'
                    self.stop_requested=True
            if self.stop_requested:
                self.cleanup()
            if self.closed:
                return
