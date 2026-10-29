"""Synthetic /proc, fixed protocol and authenticated client tests; no host scans."""
import json
import os
from pathlib import Path
import socket
import stat
import struct
import threading
import time
from types import SimpleNamespace
from unittest.mock import patch

import pytest
from deploy import proc_proof_server as server
from apps.simmgr import proc_proof as client

NONCE='a'*32


def row():return dict(pid=42,ppid=1,start_ticks=123,cgroup='0::/user.slice/owned.service',domain='93',partition='fh-srv-'+'a'*12)


def body():return dict(v=1,nonce=NONCE,started_ns=20,finished_ns=30,complete=True,denied=0,rows=[row()])


def test_root_reader_exports_only_selected_keys(tmp_path):
    proc=tmp_path/'42';proc.mkdir()
    fields=['S','1']+['0']*17+['123']+['0']*5
    (proc/'stat').write_text('42 (strange) process) '+' '.join(fields))
    (proc/'environ').write_bytes(b'FH_DATABASE_URL=DO_NOT_EXPORT\0OTHER_SECRET=DO_NOT_EXPORT\0ROS_DOMAIN_ID=93\0GZ_PARTITION=fh-srv-aaaaaaaaaaaa\0')
    (proc/'cgroup').write_text('0::/user.slice/owned.service\n')
    rows,denied=server.process_rows(tmp_path)
    assert denied==0 and rows==[row()] and 'DO_NOT_EXPORT' not in json.dumps(rows)
    with patch.object(Path,'open',side_effect=PermissionError):
        assert server.process_rows(tmp_path)==([],1)


def test_invalid_fields_and_pid_reuse_are_unproven(tmp_path):
    proc=tmp_path/'42';proc.mkdir()
    fields=['S','1']+['0']*17+['123']
    (proc/'stat').write_text('42 (x) '+' '.join(fields));(proc/'cgroup').write_text('0::/x')
    for value in (b'ROS_DOMAIN_ID=abc\0',b'GZ_PARTITION=secret\nline\0'):
        (proc/'environ').write_bytes(value)
        with pytest.raises(ValueError):server.process_rows(tmp_path)
    (proc/'environ').write_bytes(b'')
    original=Path.read_text;calls=[]
    def read(path,*args,**kwargs):
        value=original(path,*args,**kwargs)
        if path.name=='stat':
            calls.append(1)
            if len(calls)==2:value=value.replace('123','124')
        return value
    with patch.object(Path,'read_text',read),pytest.raises(ValueError):server.process_rows(tmp_path)


@pytest.mark.parametrize('change',['nonce','stale','denied','incomplete','extra','duplicate','secret','boolpid','badpartition'])
def test_client_rejects_unbound_partial_and_extra_fields(change):
    document=body()
    if change=='nonce':document['nonce']='b'*32
    if change=='stale':document['started_ns']=9
    if change=='denied':document['denied']=1
    if change=='incomplete':document['complete']=False
    if change=='extra':document['command']='not an RPC'
    if change=='duplicate':document['rows'].append(row())
    if change=='secret':document['rows'][0]['environ']='secret'
    if change=='boolpid':document['rows'][0]['pid']=True
    if change=='badpartition':document['rows'][0]['partition']='a\n'
    with pytest.raises(ValueError):client.validate(document,NONCE,10,40)


def test_valid_snapshot_keeps_existing_schema():
    assert client.validate(body(),NONCE,10,40)==([dict(row(),comm='')],0)


@pytest.mark.parametrize('payload',[{'v':True,'nonce':NONCE},{'v':1,'nonce':NONCE,'path':'/etc/shadow'}, {'v':1,'nonce':'bad'}])
def test_request_cannot_select_paths_commands_or_signals(payload):
    left,right=socket.socketpair()
    try:
        right.sendall(json.dumps(payload).encode()+b'\n')
        with pytest.raises(ValueError):server.request_line(left)
    finally:left.close();right.close()


def test_peer_denial_precedes_reader_and_request():
    class Connection:
        def settimeout(self,value):pass
        def getsockopt(self,*args):return struct.pack('3i',42,54321,54321)
    with pytest.raises(PermissionError):server.serve(Connection(),12345,lambda:pytest.fail('reader called'))


def test_server_denied_snapshot_never_exports_partial_rows():
    left,right=socket.socketpair()
    errors=[]
    def serve():
        try:server.serve(left,os.getuid() or 12345,lambda:([row()],1))
        except Exception as error:errors.append(type(error).__name__)
        finally:left.close()
    thread=threading.Thread(target=serve);thread.start()
    try:
        right.sendall(json.dumps(dict(v=1,nonce=NONCE)).encode()+b'\n')
        data=json.loads(right.recv(server.MAX_REPLY))
        assert data['rows']==[] and data['complete'] is False and data['denied']==1
    finally:right.close();thread.join(3)
    assert not errors and not thread.is_alive()


def test_client_failure_never_falls_back_to_host_proc(monkeypatch):
    # Real scanner import only; its host reader must never run under the server key.
    import sys
    monkeypatch.syspath_prepend(str(Path(__file__).resolve().parents[2]/'apps/agent/tools/sim'))
    import isolation
    monkeypatch.setenv('FH_SIM_PROC_PROOF_SOCKET',str(client.SOCKET))
    monkeypatch.setattr(client,'processes',lambda:(_ for _ in ()).throw(RuntimeError('unproven')))
    with patch.object(Path,'iterdir',side_effect=AssertionError('local proc fallback forbidden')):
        with pytest.raises(RuntimeError,match='unproven'):isolation.processes()
    monkeypatch.setenv('FH_SIM_PROC_PROOF_SOCKET','/tmp/untrusted.sock')
    with pytest.raises(RuntimeError,match='unapproved'):isolation.processes()


def test_client_rejects_fake_socket_before_connect():
    with patch.object(Path,'lstat',return_value=SimpleNamespace(st_mode=stat.S_IFSOCK|0o666,st_uid=0,st_gid=123)), \
            patch.object(client.grp,'getgrnam',return_value=SimpleNamespace(gr_gid=123)), \
            patch.object(socket,'socket',side_effect=AssertionError('must not connect')):
        with pytest.raises(RuntimeError,match='retain slot lock'):client.processes()


def test_root_service_has_no_signal_or_mutating_rpc():
    root=Path(__file__).resolve().parents[1]
    text=(root/'foothold-sim-proof@.service').read_text()
    for required in ('-I -B','CAP_SYS_PTRACE CAP_DAC_READ_SEARCH','ProtectSystem=strict','ProtectHome=yes','RestrictAddressFamilies=AF_UNIX','Restart=no','~ptrace process_vm_readv process_vm_writev kill tkill tgkill'):
        assert required in text
    socket_text=(root/'foothold-sim-proof.socket').read_text()
    assert 'SocketMode=0660' in socket_text and 'SocketGroup=foothold-sim' in socket_text and 'Accept=yes' in socket_text
    assert 'FH_SIM_PROC_PROOF_SOCKET=/run/foothold-sim-proof.sock' in (root/'foothold-simmgr.service').read_text()


@pytest.mark.parametrize('change',['valid','wrong_peer','wrong_nonce','incomplete','trailing'])
def test_client_authenticated_transport_and_failure(change):
    class Connection:
        def __enter__(self):return self
        def __exit__(self,*args):pass
        def settimeout(self,value):pass
        def connect(self,path):assert path==str(client.SOCKET)
        def getsockopt(self,*args):return struct.pack('3i',42,123 if change=='wrong_peer' else 0,0)
        def sendall(self,data):
            request=json.loads(data)
            value=body();value['nonce']=request['nonce'] if change!='wrong_nonce' else 'b'*32
            value['started_ns']=time.monotonic_ns();value['finished_ns']=time.monotonic_ns()
            if change=='incomplete':value['complete']=False
            self.data=json.dumps(value).encode()+b'\n'+(b'extra' if change=='trailing' else b'')
        def recv(self,size):
            data,self.data=self.data[:size],self.data[size:]
            return data
    with patch.object(Path,'lstat',return_value=SimpleNamespace(st_mode=stat.S_IFSOCK|0o660,st_uid=0,st_gid=123)), \
            patch.object(client.grp,'getgrnam',return_value=SimpleNamespace(gr_gid=123)), \
            patch.object(socket,'socket',return_value=Connection()):
        if change=='valid':assert client.processes()==([dict(row(),comm='')],0)
        else:
            with pytest.raises(RuntimeError,match='retain slot lock'):client.processes()


def test_host_package_marker_blocks_before_reader_and_when_created_during_snapshot(tmp_path,monkeypatch):
    marker=tmp_path/'package-pending';monkeypatch.setattr(server,'PACKAGE_LATCH',marker)
    class Connection:
        def settimeout(self,value):pass
        def getsockopt(self,*args):return struct.pack('3i',42,0,0)
        def recv(self,size):return json.dumps(dict(v=1,nonce=NONCE)).encode()+b'\n'
        def sendall(self,data):pytest.fail('must not return a complete proof')
    marker.touch()
    with pytest.raises(ValueError,match='host package'):
        server.serve(Connection(),12345,lambda:pytest.fail('reader must not run'))
    marker.unlink()
    def reader():marker.touch();return [row()],0
    with pytest.raises(ValueError,match='host package'):server.serve(Connection(),12345,reader)


def test_rootfs_v2_cannot_downgrade_or_use_different_manifest():
    binding=dict(recipe_sha256='a'*64,manifest_sha256='b'*64)
    document=body();document.update(v=2,**binding)
    assert client.validate(document,NONCE,10,40,binding)==([dict(row(),comm='')],0)
    for change in ('downgrade','recipe','manifest','missing'):
        bad=dict(document)
        if change=='downgrade':bad['v']=1
        if change=='recipe':bad['recipe_sha256']='c'*64
        if change=='manifest':bad['manifest_sha256']='c'*64
        if change=='missing':del bad['manifest_sha256']
        with pytest.raises(ValueError):client.validate(bad,NONCE,10,40,binding)


def test_v2_rootfs_seal_failure_never_calls_process_reader(monkeypatch):
    class Connection:
        def settimeout(self,value):pass
        def getsockopt(self,*args):return struct.pack('3i',42,0,0)
        def recv(self,size):return json.dumps(dict(v=2,nonce=NONCE,recipe_sha256='a'*64)).encode()+b'\n'
    monkeypatch.setattr(server,'package_fence',lambda:None)
    def reject(recipe):raise ValueError('manifest absent')
    monkeypatch.setattr(server,'rootfs_binding',reject)
    with pytest.raises(ValueError,match='manifest absent'):
        server.serve(Connection(),12345,lambda:pytest.fail('reader must not run'))


def test_v2_binding_change_during_snapshot_cannot_return_complete_proof(monkeypatch):
    class Connection:
        sent=[]
        def settimeout(self,value):pass
        def getsockopt(self,*args):return struct.pack('3i',42,0,0)
        def recv(self,size):return json.dumps(dict(v=2,nonce=NONCE,recipe_sha256='a'*64)).encode()+b'\n'
        def sendall(self,data):self.sent.append(data)
    calls=[]
    def binding(recipe):
        calls.append(recipe)
        return dict(recipe_sha256=recipe,manifest_sha256=('b' if len(calls)==1 else 'c')*64)
    monkeypatch.setattr(server,'package_fence',lambda:None)
    monkeypatch.setattr(server,'rootfs_binding',binding)
    connection=Connection()
    with pytest.raises(ValueError,match='binding changed during proof'):
        server.serve(connection,12345,lambda:([],0))
    assert calls==['a'*64,'a'*64] and connection.sent==[]


def test_release_pending_barrier_blocks_package_proof_without_original_name(tmp_path,monkeypatch):
    marker=tmp_path/'package-pending';monkeypatch.setattr(server,'PACKAGE_LATCH',marker)
    marker.with_name(marker.name+'.release-pending').touch()
    with pytest.raises(ValueError,match='unproven'):server.package_fence()
