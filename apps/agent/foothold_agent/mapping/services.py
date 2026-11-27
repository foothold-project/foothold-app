"""Bounded local service lane; never runs systemctl on the control loop."""
import logging
import re
import subprocess
import threading
import time
from datetime import datetime,timezone

LOG=logging.getLogger(__name__)


class Services:
    def __init__(self,env,allowed,*,run=None,now=time.monotonic,fresh=lambda:False):
        self.env,self.allowed=env,allowed
        self.now,self.ready_at=now,None
        self.names=tuple(env.get(key,default).removesuffix('.service') for key,default in (
            ('FH_MAPPING_POINT_LIO_SERVICE','foothold-pointlio'),('FH_MAPPING_GLIM_SERVICE','foothold-glim')))
        forbidden = {'foothold-robot', 'foothold-policy-cpp', 'foothold-depth'}
        if len(set(self.names))!=2 or any(n in forbidden or not re.fullmatch(r'foothold-[A-Za-z0-9_-]{1,64}',n) for n in self.names):
            LOG.error('SLAM_SERVICE event=invalid_configuration reason=invalid_mapping_service_allowlist')
            raise ValueError('invalid mapping service allowlist')
        self.run=run or self.systemctl
        self.pointlio,self.glim=self.names
        self.fresh=fresh
        self.pointlio_active=False
        self.pointlio_checked=False
        self.pointlio_was_down=False
        self.pointlio_restarted=False
        self.pointlio_identity=None
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
        self.start_error=None

    @staticmethod
    def systemctl(action,name):
        if action=='show':
            result=subprocess.run(['systemctl','--user','show','-p','InvocationID','-p','NRestarts','-p','MainPID',name],
                stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,
                timeout=5,check=False,text=True)
            if result.returncode!=0:
                raise OSError(f'mapping service identity query failed: {result.returncode}')
            return result.stdout
        result=subprocess.run(['systemctl','--user',action,'--quiet',name],stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=5,check=False)
        return result.returncode

    def control_enabled(self):
        return self.env.get('FH_MAPPING_SERVICE_CONTROL_ENABLED','').lower()=='true'

    def pointlio_ready(self):
        return self.pointlio_active and not self.pointlio_restarted and self.fresh()

    def pointlio_run_identity(self):
        try:
            output=self.run('show',self.pointlio)
            properties=dict(line.split('=',1) for line in output.splitlines() if '=' in line)
            invocation=properties.get('InvocationID','')
            if invocation:
                if not re.fullmatch(r'[0-9a-fA-F]{32}',invocation) or int(invocation,16)==0:
                    raise ValueError('invalid InvocationID')
                return ('InvocationID',invocation.lower())
            restarts,pid=properties.get('NRestarts',''),properties.get('MainPID','')
            if not restarts.isdecimal() or not pid.isdecimal() or int(pid)<=0:
                raise ValueError('missing Point-LIO run identity')
            return ('NRestarts+MainPID',int(restarts),int(pid))
        except Exception:
            self.start_error='위치 계산의 실행 기준을 확인하지 못했습니다. 받은 자료를 저장하거나 새로 시작해 주세요.'
            raise

    def receiving_ready(self):
        return self.status=='STARTED' and self.glim in self.owned and self.pointlio_ready()

    def recording_ready(self):
        # Raw sensor recording can span a short Point-LIO output gap. New
        # accumulation still requires receiving_ready(), including freshness.
        return self.status=='STARTED' and self.glim in self.owned and self.pointlio_active

    def check_pointlio(self):
        active=self.run('is-active',self.pointlio)
        self.pointlio_active=active==0
        self.pointlio_checked=True
        if active!=0:
            self.start_error='실시간 위치가 꺼져 있습니다. 실행 상태를 확인해 주세요.'
            raise OSError(f'mapping service state query failed: {active}')
        if not self.fresh():
            self.start_error='실시간 위치와 점 자료가 끊겼습니다. 센서 상태를 확인해 주세요.'
            raise OSError('Point-LIO data unavailable')
        identity=self.pointlio_run_identity()
        if self.pointlio_identity is not None and identity!=self.pointlio_identity:
            self.pointlio_restarted=True
            raise OSError('Point-LIO restarted during mapping start')
        self.pointlio_identity=identity

    def monitor(self):
        """Blocking queries belong exclusively to the service worker."""
        with self.lock:
            job=self.version
        try:
            # Fresh data is mandatory at start, but a running session may wait
            # for it without invalidating ownership of its GLIM process.
            active=self.run('is-active',self.pointlio)==0
            identity=self.pointlio_run_identity() if active else None
            with self.lock:
                if self.version!=job or self.status!='STARTED':
                    return
                self.pointlio_active=active
                self.pointlio_checked=True
                if not active:
                    self.pointlio_was_down=True
                elif self.pointlio_was_down or identity!=self.pointlio_identity:
                    self.pointlio_restarted=True
            if self.run('is-active',self.glim)!=0:
                self.start_error='지도 기록이 꺼졌습니다. 받은 자료를 저장하거나 새로 시작해 주세요.'
                raise OSError('owned GLIM service unavailable')
        except Exception:
            with self.lock:
                if self.version==job and self.status=='STARTED':
                    self.status='UNKNOWN'
                    self.start_error=self.start_error or '지도 서비스 상태를 확인하지 못했습니다.'

    def start(self):
        with self.lock:
            self.start_error=None
            if not self.control_enabled() or not self.allowed() or self.closed:
                self.ready_at=None
                self.stop()  # retain cleanup of the preceding session, even offline
                self.status='UNKNOWN' if self.control_enabled() else 'DISABLED'
                return False
            if self.pending or self.starting or self.status=='STARTING':
                self.stop()  # the replacement must not leave the older job running
                return False
            self.version+=1
            self.pointlio_was_down=self.pointlio_restarted=False
            self.pointlio_identity=None
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
                    self.check_pointlio()
                    for name in (self.glim,):
                        if not self.wanted(job):
                            raise PermissionError('mapping observation unavailable')
                        active=self.run('is-active',name)
                        if active==0:
                            self.start_error='기존 지도 서비스가 이미 실행 중입니다. 실행 상태를 확인한 뒤 새로 시작해 주세요.'
                            raise PermissionError('pre-existing mapping service')
                        if active!=3:
                            raise OSError(f'mapping service state query failed: {active}')
                        if not self.wanted(job):
                            raise PermissionError('mapping service start canceled')
                        self.owned.add(name)  # cleanup even if start times out after taking effect
                        if self.run('start',name)!=0:
                            raise OSError('mapping service start failed')
                    # stop/save/replacement during the last blocking call must
                    # not publish readiness. stop() shares this commit lock.
                    self.check_pointlio()
                    with self.lock:
                        if not self.wanted(job):
                            raise PermissionError('mapping service start canceled')
                        self.ready_at=self.now()
                        self.status='STARTED'
                    LOG.warning('SLAM_SERVICE event=started owned=%d monotonic=%.6f utc=%s',len(self.owned),time.monotonic(),datetime.now(timezone.utc).isoformat())
                except Exception as error:
                    LOG.warning('SLAM_SERVICE event=start_failed reason=%s',error)
                    self.status='UNKNOWN'
                    self.stop_requested=True
                finally:
                    with self.lock:
                        self.starting=False
            if self.stop_requested:
                self.cleanup()
            elif self.status=='STARTED':
                self.monitor()
            if self.closed:
                return

    def wanted(self,job):
        return self.version==job and not self.closed and self.allowed()
