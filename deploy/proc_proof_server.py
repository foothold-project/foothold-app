"""Socket-activated, fixed-field /proc reader. No path/command/signal RPC."""
import sys
sys.dont_write_bytecode=True
import json
import os
from pathlib import Path
import pwd
import re
import socket
import struct
import time

MAX_REPLY=4*1024*1024
FIELDS=frozenset(('pid','ppid','start_ticks','cgroup','domain','partition'))


def process_rows(root=Path('/proc')):
    rows=[];denied=0;budget=0
    for path in root.iterdir():
        if not path.name.isascii() or not path.name.isdigit():continue
        try:
            before=(path/'stat').read_text().rsplit(')',1)[1].split()
            with (path/'environ').open('rb') as stream:
                raw=stream.read(4*1024*1024+1)
            if len(raw)>4*1024*1024:raise ValueError('environment exceeds proof bound')
            # Never retain/export full env or argv, including DB/pass/service keys.
            selected={}
            for item in raw.split(b'\0'):
                key,separator,value=item.partition(b'=')
                if separator and key in (b'ROS_DOMAIN_ID',b'GZ_PARTITION'):
                    selected[key]=value.decode('ascii')
            domain=selected.get(b'ROS_DOMAIN_ID','')
            partition=selected.get(b'GZ_PARTITION','')
            if ((domain and not re.fullmatch('[0-9]{1,3}',domain))
                    or len(partition)>256 or any(ord(c)<32 or ord(c)>126 for c in partition)):
                raise ValueError('invalid isolation field')
            group=(path/'cgroup').read_text().strip()
            if len(group)>4096 or '\x00' in group:raise ValueError('invalid cgroup field')
            after=(path/'stat').read_text().rsplit(')',1)[1].split()
            if before[19]!=after[19]:raise ValueError('PID identity changed during proof')
            row=dict(pid=int(path.name),ppid=int(after[1]),start_ticks=int(after[19]),
                     cgroup=group,domain=domain,partition=partition)
            budget+=len(json.dumps(row))
            if len(rows)>=8192 or budget>MAX_REPLY-1024:raise ValueError('proof snapshot too large')
            rows.append(row)
        except PermissionError:
            denied+=1
        except (FileNotFoundError,ProcessLookupError):
            continue  # process exited; no cached identity is reused
    return rows,denied


def request_line(connection):
    data=b''
    while b'\n' not in data:
        chunk=connection.recv(257-len(data))
        if not chunk:raise ValueError('request incomplete')
        data+=chunk
        if len(data)>256:raise ValueError('request too large')
    first,remainder=data.split(b'\n',1)
    if remainder:raise ValueError('multiple requests forbidden')
    body=json.loads(first)
    if (not isinstance(body,dict) or set(body)!={'v','nonce'} or type(body['v']) is not int
            or body['v']!=1 or not isinstance(body['nonce'],str) or not re.fullmatch('[0-9a-f]{32}',body['nonce'])):
        raise ValueError('invalid fixed proof request')
    return body


def serve(connection,allowed_uid,reader=process_rows):
    connection.settimeout(3)
    peer_pid,peer_uid,peer_gid=struct.unpack('3i',connection.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12))
    if allowed_uid<=0 or peer_uid not in (0,allowed_uid):raise PermissionError('proof peer denied')
    request=request_line(connection)
    started=time.monotonic_ns()
    rows,denied=reader()
    response=dict(v=1,nonce=request['nonce'],started_ns=started,finished_ns=time.monotonic_ns(),
                  complete=denied==0,denied=denied,rows=rows if denied==0 else [])
    encoded=json.dumps(response,separators=(',',':')).encode()+b'\n'
    if len(encoded)>MAX_REPLY:raise ValueError('proof response too large')
    connection.sendall(encoded)


def main():
    if os.geteuid()!=0:raise PermissionError('root proof service required')
    uid=pwd.getpwnam('foothold-sim').pw_uid
    with socket.socket(fileno=os.dup(0)) as connection:
        try:
            serve(connection,uid)
        except Exception:
            # Never echo request bytes, env, filenames, PID contents or traceback.
            try:connection.sendall(b'{"v":1,"complete":false,"error":"unavailable"}\n')
            except OSError:pass
            return 1
    return 0


if __name__=='__main__':
    try:raise SystemExit(main())
    except Exception:raise SystemExit('OS proof unavailable') from None
