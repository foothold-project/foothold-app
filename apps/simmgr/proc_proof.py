"""Authenticated local read-only OS snapshot; unknown/incomplete is never absent."""
import grp
import json
import os
from pathlib import Path
import re
import secrets
import socket
import stat
import struct
import time

SOCKET=Path('/run/foothold-sim-proof.sock')
MAX_REPLY=4*1024*1024
FIELDS=frozenset(('pid','ppid','start_ticks','cgroup','domain','partition'))


def validate(body,nonce,begin,end):
    expected={'v','nonce','started_ns','finished_ns','complete','denied','rows'}
    if (not isinstance(body,dict) or set(body)!=expected or type(body['v']) is not int or body['v']!=1
            or body['nonce']!=nonce or body['complete'] is not True or type(body['denied']) is not int or body['denied']!=0
            or type(body['started_ns']) is not int or type(body['finished_ns']) is not int
            or not begin<=body['started_ns']<=body['finished_ns']<=end
            or not isinstance(body['rows'],list) or len(body['rows'])>8192):
        raise ValueError('OS snapshot incomplete, stale or unbound')
    seen=set();result=[]
    for row in body['rows']:
        if (not isinstance(row,dict) or set(row)!=FIELDS
                or any(type(row[key]) is not int or row[key]<0 for key in ('pid','ppid','start_ticks'))
                or row['pid']==0 or row['pid'] in seen
                or not isinstance(row['cgroup'],str) or len(row['cgroup'])>4096 or '\x00' in row['cgroup']
                or not isinstance(row['domain'],str) or not re.fullmatch('[0-9]{0,3}',row['domain'])
                or not isinstance(row['partition'],str) or len(row['partition'])>256
                or any(ord(c)<32 or ord(c)>126 for c in row['partition'])):
            raise ValueError('OS proof field invalid')
        seen.add(row['pid'])
        result.append(dict(row,comm=''))  # established schema, no process names exported
    return result,0


def processes():
    try:
        info=SOCKET.lstat()
        group=grp.getgrnam('foothold-sim').gr_gid
        if not stat.S_ISSOCK(info.st_mode) or info.st_uid!=0 or info.st_gid!=group or stat.S_IMODE(info.st_mode)!=0o660:
            raise ValueError('OS proof socket ownership invalid')
        nonce=secrets.token_hex(16);begin=time.monotonic_ns()
        with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as connection:
            connection.settimeout(3)
            connection.connect(str(SOCKET))
            pid,uid,gid=struct.unpack('3i',connection.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12))
            if uid!=0:raise ValueError('OS proof server must be root')
            connection.sendall(json.dumps(dict(v=1,nonce=nonce)).encode()+b'\n')
            response=b''
            while b'\n' not in response:
                chunk=connection.recv(min(65536,MAX_REPLY+1-len(response)))
                if not chunk:raise ValueError('OS proof response incomplete')
                response+=chunk
                if len(response)>MAX_REPLY:raise ValueError('OS proof response too large')
            first,remainder=response.split(b'\n',1)
            if remainder:raise ValueError('OS proof response framing invalid')
            return validate(json.loads(first),nonce,begin,time.monotonic_ns())
    except Exception:
        raise RuntimeError('OS isolation proof unavailable; retain slot lock') from None
