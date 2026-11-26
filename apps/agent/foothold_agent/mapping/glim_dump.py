"""GLIM 1.2.2 shutdown adapter and bounded compact-submap reader.

The service invokes this module with its existing GLIM executable arguments.
Only a successful, signalled child exit can produce the completion receipt.
No ROS, SDK or motion interfaces are imported here.
"""
from decimal import Decimal
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
from types import SimpleNamespace as NS
from uuid import uuid4

from .poses import timestamp


def write_json(path, body):
    temporary=path.with_suffix('.tmp')
    with temporary.open('x', encoding='utf-8') as target:
        json.dump(body,target,allow_nan=False)
        target.flush()
        os.fsync(target.fileno())
    os.replace(temporary,path)


def submap_metadata(value):
    """Read SubMap::save's complete text grammar, rejecting truncated records."""
    import numpy as np
    tokens=iter(value.split())
    def take(label, size=1):
        if next(tokens)!=label:
            raise ValueError('invalid submap metadata')
        return [float(next(tokens)) for _ in range(size)]
    def matrix(label):
        m=np.array(take(label,16)).reshape(4,4)
        if (not np.isfinite(m).all() or not np.allclose(m[3],[0,0,0,1],atol=1e-5)
                or not np.allclose(m[:3,:3].T@m[:3,:3],np.eye(3),atol=1e-4)
                or not np.isclose(np.linalg.det(m[:3,:3]),1,atol=1e-4)):
            raise ValueError('invalid world transform')
        return m
    try:
        take('id:')
        world=matrix('T_world_origin:')
        matrix('T_origin_endpoint_L:');matrix('T_origin_endpoint_R:');matrix('T_lidar_imu:')
        if not np.isfinite(take('imu_bias:',6)).all():
            raise ValueError('invalid imu bias')
        take('frame_id:')
        count=take('num_frames:')[0]
        if not 1<=count<=1000000 or int(count)!=count:
            raise ValueError('invalid frame count')
        for i in range(int(count)):
            if next(tokens)!=f'frame_{i}':
                raise ValueError('missing frame metadata')
            take('id:');take('stamp:')
            matrix('T_odom_lidar:');matrix('T_world_lidar:')
            if not np.isfinite(take('v_world_imu:',3)).all():
                raise ValueError('invalid frame velocity')
        if next(tokens,None) is not None:
            raise ValueError('unexpected submap data')
        return world,int(count)
    except StopIteration as error:
        raise ValueError('incomplete submap metadata') from error


class DumpSession:
    def __init__(self, root, session, revision, frame, *, now=time.monotonic):
        self.root=Path(root).expanduser().resolve()
        self.path=self.root/(session+'-r'+str(revision))
        self.binding=dict(session_id=session,revision=revision,frame_id=frame,nonce=str(uuid4()))
        self.now=now
        self.previous=None
        self.stable_since=None

    def prepare(self):
        self.root.mkdir(parents=True,exist_ok=True,mode=0o700)
        self.path.mkdir(mode=0o700)  # never reuse another invocation's output
        write_json(self.path/'request.json',self.binding)
        write_json(self.root/'request.json',dict(self.binding,directory=self.path.name))

    def fingerprint(self):
        if not self.path.is_dir() or self.path.is_symlink():
            raise ValueError('missing dump session')
        entries=[]
        for path in sorted(self.path.rglob('*')):
            if len(entries)>100000 or path.is_symlink():
                raise ValueError('invalid dump entries')
            if path.is_file():
                stat=path.stat()
                entries.append((str(path.relative_to(self.path)),stat.st_size,stat.st_mtime_ns,stat.st_ino))
        return tuple(entries)

    def ready(self, *, stopped):
        if not stopped:
            self.previous=self.stable_since=None
            return False
        try:
            for name in ('request.json','started.json','completed.json'):
                path=self.path/name
                if path.is_symlink() or path.stat().st_size>4096 or json.loads(path.read_text())!=self.binding:
                    raise ValueError('dump session/revision mismatch')
            current=self.fingerprint()
            completed_at=(self.path/'completed.json').stat().st_mtime_ns
            if any(modified>completed_at for _,_,modified,_ in current):
                raise ValueError('dump changed after successful exit')
            if current!=self.previous:
                self.previous,self.stable_since=current,self.now()
                return False
            return self.now()-self.stable_since>=1.
        except FileNotFoundError:
            self.previous=self.stable_since=None
            return False

    def chunks(self, source):
        """Validate the entire layout, then stream all points in 512-point chunks."""
        import numpy as np
        if source.source!='glim' or source.frame!=self.binding['frame_id']:
            raise ValueError('dump source/frame mismatch')
        dump=self.path/'dump'
        before=self.fingerprint()
        def text(path, limit=16*1024*1024):
            if path.stat().st_size>limit:
                raise ValueError('dump text limit')
            return path.read_text()
        for name in ('graph.bin','values.bin','graph.txt','traj_imu.txt','traj_lidar.txt','odom_imu.txt','odom_lidar.txt'):
            if (dump/name).stat().st_size<=0:
                raise ValueError('incomplete dump')
        if not (dump/'config').is_dir() or not any((dump/'config').glob('*.json')):
            raise ValueError('missing saved configuration')
        graph=text(dump/'graph.txt').splitlines()
        counts=dict(line.split(': ',1) for line in graph[:2])
        count,total=int(counts['num_submaps']),int(counts['num_all_frames'])
        if not 1<=count<=10000 or not count<=total<=1000000:
            raise ValueError('invalid submap counts')
        directories=sorted(p.name for p in dump.iterdir() if p.is_dir() and p.name.isdigit())
        if directories!=[f'{i:06d}' for i in range(count)]:
            raise ValueError('incomplete submaps')
        frames=0
        for name in directories:
            _,frame_count=submap_metadata(text(dump/name/'data.txt'))
            frames+=frame_count
            points=dump/name/'points_compact.bin'
            if not 0<points.stat().st_size<=2_000_000_000 or points.stat().st_size%12:
                raise ValueError('incomplete compact points')
            point_count=points.stat().st_size//12
            for attribute,stride in (('covs_compact.bin',24),('normals_compact.bin',12),
                    ('times_compact.bin',4),('intensities_compact.bin',4)):
                path=dump/name/attribute
                if path.exists() and path.stat().st_size!=point_count*stride:
                    raise ValueError('incomplete compact attributes')
        if frames!=total:
            raise ValueError('incomplete frame metadata')
        # Optimized IMU trajectory is in the same world frame as the submaps;
        # an odom-frame topic is never substituted for this final pose.
        last=None
        rows=0
        previous=0
        with (dump/'traj_imu.txt').open() as trajectory:
            for line in trajectory:
                if len(line)>1024:
                    raise ValueError('invalid trajectory')
                values=line.split()
                if len(values)!=8:
                    raise ValueError('invalid trajectory')
                try:
                    ns=int(Decimal(values[0])*1_000_000_000)
                except ArithmeticError as error:
                    raise ValueError('invalid trajectory timestamp') from error
                position=list(map(float,values[1:4]))
                x,y,z,w=map(float,values[4:])
                message=NS(header=NS(frame_id=source.frame,stamp=NS(sec=ns//10**9,nanosec=ns%10**9)),
                    pose=NS(position=NS(**dict(zip('xyz',position))),orientation=NS(w=w,x=x,y=y,z=z)))
                if source.pose_type=='Odometry':
                    message.child_frame_id=source.child_frame
                    message.pose=NS(pose=message.pose)
                p,q,body=source.decode_pose(message)
                timestamp(message.header.stamp)
                if ns<=previous:
                    raise ValueError('non increasing trajectory')
                previous=ns
                last=(p,q,body,ns)
                rows+=1
        if rows!=total or last is None:
            raise ValueError('incomplete trajectory')
        for name in directories:
            transform,_=submap_metadata(text(dump/name/'data.txt'))
            with (dump/name/'points_compact.bin').open('rb') as points:
                while data:=points.read(512*12):
                    if len(data)%12:
                        raise ValueError('incomplete points')
                    local=np.frombuffer(data,dtype='<f4').reshape(-1,3)
                    if not np.isfinite(local).all():
                        raise ValueError('invalid points')
                    world=local@transform[:3,:3].T+transform[:3,3]
                    yield world,last
        if before!=self.fingerprint():
            raise ValueError('dump changed during read')


def run_service(root, argv):
    """Called by the opt-in user service, on its own process main thread."""
    root=Path(root).expanduser().resolve()
    request=json.loads((root/'request.json').read_text())
    directory=request.pop('directory')
    if Path(directory).name!=directory or directory in ('.','..'):
        raise ValueError('invalid dump directory')
    path=root/directory
    if path.is_symlink() or json.loads((path/'request.json').read_text())!=request:
        raise ValueError('invalid dump request')
    if (path/'dump').exists() or (path/'started.json').exists():
        raise ValueError('dump invocation already used')
    write_json(path/'started.json',request)
    stopped=False
    child=None
    def stop(signum, _frame):
        nonlocal stopped
        stopped=True
        if child is not None and child.poll() is None:
            child.send_signal(signal.SIGINT)
    old={sig:signal.signal(sig,stop) for sig in (signal.SIGINT,signal.SIGTERM)}
    try:
        child=subprocess.Popen([*argv,'--ros-args','-p','dump_path:='+str(path/'dump')],start_new_session=True)
        if stopped:
            child.send_signal(signal.SIGINT)
        code=child.wait()
        if code==0 and stopped:
            write_json(path/'completed.json',request)
        return code
    finally:
        for sig,handler in old.items():
            signal.signal(sig,handler)


if __name__=='__main__':
    if len(sys.argv)<2:
        raise SystemExit('usage: python -m foothold_agent.mapping.glim_dump GLIM_EXECUTABLE [ARGS...]')
    raise SystemExit(run_service(os.environ['FH_MAPPING_GLIM_DUMP_ROOT'],sys.argv[1:]))
