"""The one approved host-path exception: owned atomic /opt/ros/jazzy alias."""
import json
import os
from pathlib import Path
import stat

PARENT=Path('/opt/ros')
STATE=Path('/opt/foothold-sim/ros-link.json')


def snapshot(parent=PARENT):
    if not parent.exists() and not parent.is_symlink():return {'present':False}
    info=parent.lstat()
    if not stat.S_ISDIR(info.st_mode):return dict(present=True,invalid_parent=True)
    link=parent/'jazzy'
    result=dict(present=True,uid=info.st_uid,mode=stat.S_IMODE(info.st_mode),dev=info.st_dev,ino=info.st_ino,entries=sorted(path.name for path in parent.iterdir()))
    if link.is_symlink():
        item=link.lstat()
        result.update(link_uid=item.st_uid,target=os.readlink(link))
    elif link.exists():result['foreign_entry']=True
    return result


def activate(target,lock_sha,*,parent=PARENT,state=STATE):
    target=Path(target)
    before=snapshot(parent)
    if before['present']:
        # Never adopt a pre-existing host ROS directory. Only our recorded inode
        # and current link can be changed by a subsequent explicit transition.
        fd=os.open(state,os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC)
        with os.fdopen(fd) as stream:
            info=os.fstat(stream.fileno())
            if info.st_uid!=0 or stat.S_IMODE(info.st_mode)!=0o600 or not stat.S_ISREG(info.st_mode):
                raise ValueError('ROS alias ownership record untrusted')
            previous=json.load(stream)
        if previous.get('snapshot')!=before:
            raise ValueError('existing /opt/ros is not the recorded owned alias')
    else:
        if state.exists() or state.is_symlink():raise ValueError('recorded ROS alias disappeared; audit required')
        parent.mkdir(mode=0o755)
        parent.chmod(0o755)
    info=parent.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid!=0 or stat.S_IMODE(info.st_mode)!=0o755:
        raise ValueError('ROS alias parent untrusted')
    directory=os.open(parent,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC)
    temporary='jazzy.next-'+str(os.getpid())
    try:
        os.symlink(str(target),temporary,dir_fd=directory)
        os.rename(temporary,'jazzy',src_dir_fd=directory,dst_dir_fd=directory)
        os.fsync(directory)
    finally:
        os.close(directory)
    after=snapshot(parent)
    if after.get('target')!=str(target) or after.get('link_uid')!=0:
        raise ValueError('ROS alias activation unproven')
    record=dict(schema=1,lock_sha256=lock_sha,snapshot=after)
    next_state=state.with_name(state.name+'.next')
    fd=os.open(next_state,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
    with os.fdopen(fd,'w') as stream:
        json.dump(record,stream,sort_keys=True);stream.flush();os.fsync(stream.fileno())
    next_state.replace(state)
    parent_fd=os.open(state.parent,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    try:os.fsync(parent_fd)
    finally:os.close(parent_fd)
    return {'before':before,'after':after}
