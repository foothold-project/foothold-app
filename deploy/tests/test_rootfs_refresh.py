"""Offline helper repair: real temp files/flock/rollback, no server/ROS actions."""
import hashlib
import json
import os
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import fcntl
import pytest
from deploy import rootfs_runtime as r
REAL_INACTIVE=r.inactive_namespace


@pytest.fixture
def prepared(tmp_path,monkeypatch):
    source=tmp_path/'source';tools=tmp_path/'tools';audits=tmp_path/'audits';guard=tmp_path/'guard'
    for directory in (source,source/'deploy',tools,audits,guard,guard/'state'):
        directory.mkdir(mode=0o700)
    commit='a'*40;body=b'# reviewed replacement\n';old=b'# original installed helper\n'
    (source/'COMMIT').write_text(commit+'\n')
    (source/'deploy/rootfs_runtime.py').write_bytes(body)
    (source/'COMMIT').chmod(0o644);(source/'deploy/rootfs_runtime.py').chmod(0o644)
    target=tools/'rootfs_runtime.py';target.write_bytes(old);target.chmod(0o644)
    lock=audits/'deploy.lock';lock.touch(mode=0o600)
    (guard/'deploy.lock').touch(mode=0o660)
    marker=guard/'setup-unproven';marker.write_bytes(b'package-transaction-pending\n');marker.chmod(0o600)
    identity=[marker.stat().st_dev,marker.stat().st_ino]
    # Model root ownership only; filesystem types, permissions, no-follow opens,
    # inode identities, source SHA validation and lock exclusion remain real.
    original_lstat=Path.lstat;original_fstat=os.fstat
    ancestors={tmp_path,*tmp_path.parents}
    def owned(info,path=None):
        values=list(info);values[4]=values[5]=0
        if path in ancestors:values[0]&=~0o022
        return os.stat_result(values)
    monkeypatch.setattr(Path,'lstat',lambda path,*a,**k:owned(original_lstat(path,*a,**k),path))
    monkeypatch.setattr(os,'fstat',lambda *a,**k:owned(original_fstat(*a,**k)))
    monkeypatch.setattr(os,'fchown',lambda *_:None)
    monkeypatch.setattr(os,'geteuid',lambda:0)
    monkeypatch.setattr(r,'REFRESH_TOOLS',tools);monkeypatch.setattr(r,'REFRESH_AUDITS',audits)
    monkeypatch.setattr(r,'REFRESH_LOCK',lock);monkeypatch.setattr(r,'GUARD',guard)
    load=Mock(return_value=dict(setup_identity=identity));inactive=Mock();latches=Mock()
    monkeypatch.setattr(r,'load',load);monkeypatch.setattr(r,'inactive_namespace',inactive)
    monkeypatch.setattr(r.shared,'ensure_no_install_latch',latches)
    forbidden=Mock(side_effect=AssertionError('refresh must not invoke prepare, runtime start or latch writers'))
    for name in ('prepare','prepare_contents','bind_namespace','start_pair','create_install_latch','clear_install_latch'):
        monkeypatch.setattr(r,name,forbidden)
    monkeypatch.setattr(r.build,'audited',forbidden)
    # Sentinel files are preserved byte-for-byte and inode-for-inode.
    protected={}
    for name in ('config.json','rootfs-prepare-audit.json','rootfs-validation.json'):
        path=audits/name;path.write_text('keep '+name);protected[path]=(path.read_bytes(),path.stat().st_ino)
    protected[marker]=(marker.read_bytes(),marker.stat().st_ino)
    def refresh(**kwargs):
        return r.refresh_tools(kwargs.get('source',source),kwargs.get('commit',commit),
            kwargs.get('sha256',hashlib.sha256(body).hexdigest()))
    return SimpleNamespace(source=source,tools=tools,audits=audits,guard=guard,commit=commit,body=body,
        old=old,target=target,lock=lock,protected=protected,load=load,inactive=inactive,
        latches=latches,forbidden=forbidden,refresh=refresh)


def preserved(f):
    for path,(body,inode) in f.protected.items():
        assert path.read_bytes()==body and path.stat().st_ino==inode
    assert not list(f.tools.glob('.rootfs-refresh-*'))
    assert not list(f.audits.glob('.rootfs-refresh-*'))
    f.forbidden.assert_not_called()


def test_replace_exactly_one_helper_and_record_both_hashes_without_repreparing(prepared):
    f=prepared;unrelated=f.tools/'sim_control.py';unrelated.write_bytes(b'unchanged')
    result=f.refresh()
    assert result['changed'] and f.target.read_bytes()==f.body
    assert unrelated.read_bytes()==b'unchanged'
    assert f.target.stat().st_mode&0o777==0o644
    audit=Path(result['audit']);assert audit.stat().st_mode&0o777==0o400
    record=json.loads(audit.read_bytes())
    assert record['commit']==f.commit and record['file']=='rootfs_runtime.py'
    assert record['before_sha256']==hashlib.sha256(f.old).hexdigest()
    assert record['after_sha256']==hashlib.sha256(f.body).hexdigest()
    f.inactive.assert_called_once_with(f.load.return_value);f.latches.assert_called_once()
    preserved(f)


def test_second_call_has_no_writes_even_with_existing_audit(prepared,monkeypatch):
    f=prepared;f.refresh()
    snapshot={path:(path.read_bytes(),path.stat().st_ino,path.stat().st_mtime_ns) for directory in (f.tools,f.audits) for path in directory.iterdir()}
    monkeypatch.setattr(r.tempfile,'mkdtemp',Mock(side_effect=AssertionError('no-op must not stage')))
    assert not f.refresh()['changed']
    assert snapshot=={path:(path.read_bytes(),path.stat().st_ino,path.stat().st_mtime_ns) for path in snapshot}
    preserved(f)


@pytest.mark.parametrize('change',['short-commit','bad-sha','wrong-commit','wrong-source','source-link',
    'commit-link','target-link','source-mode','target-mode','directory-mode','directory-link','session',
    'session-pending','setup-pending','setup-identity','live-uid','active-session','install-latch','audit-collision','nonroot',
    'source-fifo','lock-fifo'])
def test_refusal_conditions_leave_original_helper_and_fences(prepared,monkeypatch,change):
    f=prepared;kwargs={}
    if change=='short-commit':kwargs['commit']='a'*7
    elif change=='bad-sha':kwargs['sha256']='not-a-hash'
    elif change=='wrong-commit':kwargs['commit']='b'*40
    elif change=='wrong-source':(f.source/'deploy/rootfs_runtime.py').write_bytes(b'not reviewed')
    elif change in ('source-link','commit-link','target-link'):
        path={'source-link':f.source/'deploy/rootfs_runtime.py','commit-link':f.source/'COMMIT','target-link':f.target}[change]
        original=path.with_suffix('.retained');path.rename(original);path.symlink_to(original)
    elif change=='source-mode':(f.source/'deploy/rootfs_runtime.py').chmod(0o666)
    elif change=='target-mode':f.target.chmod(0o666)
    elif change=='directory-mode':f.tools.chmod(0o777)
    elif change=='directory-link':
        alias=f.source.parent/'alias';alias.symlink_to(f.source,target_is_directory=True);kwargs['source']=alias
    elif change in ('session','session-pending','setup-pending'):
        (f.guard/{'session':'state/unproven','session-pending':'state/unproven.release-pending','setup-pending':'setup-unproven.release-pending'}[change]).touch()
    elif change=='setup-identity':f.load.return_value['setup_identity']=[0,0]
    elif change in ('live-uid','active-session'):
        monkeypatch.setattr(r,'inactive_namespace',REAL_INACTIVE)
        monkeypatch.setattr(r,'identity',lambda _:(23456,23456))
        monkeypatch.setattr(r,'unit_state',lambda _:dict(ActiveState='active' if change=='active-session' else 'inactive',MainPID='0'))
        monkeypatch.setattr(r,'dedicated_pids',lambda _:[123] if change=='live-uid' else [])
    elif change=='install-latch':f.latches.side_effect=ValueError('previous package transaction unproven')
    elif change=='audit-collision':
        (f.audits/('rootfs-refresh-'+f.commit+'-'+hashlib.sha256(f.body).hexdigest()+'.json')).write_text('prior audit')
    elif change=='nonroot':monkeypatch.setattr(os,'geteuid',lambda:1000)
    elif change in ('source-fifo','lock-fifo'):
        path=f.source/'deploy/rootfs_runtime.py' if change=='source-fifo' else f.lock
        path.unlink();os.mkfifo(path,0o600)
    expected={
        'short-commit':'explicit full commit','bad-sha':'explicit full commit',
        'wrong-commit':'source commit differs','wrong-source':'source SHA256 differs',
        'source-link':'Too many levels','commit-link':'Too many levels','target-link':'Too many levels',
        'source-mode':'untrusted refresh file','target-mode':'untrusted refresh file',
        'directory-mode':'root-owned non-writable','directory-link':'without symlinks',
        'session':'session/setup cleanup','session-pending':'session/setup cleanup','setup-pending':'session/setup cleanup',
        'setup-identity':'setup marker identity differs','live-uid':'namespace/PID absence','active-session':'namespace/PID absence',
        'install-latch':'previous package transaction','audit-collision':'audit already exists','nonroot':'server root only',
        'source-fifo':'untrusted refresh file','lock-fifo':'untrusted existing refresh lock'}
    with pytest.raises((ValueError,OSError),match=expected[change]):f.refresh(**kwargs)
    assert f.target.read_bytes()==f.old
    preserved(f)


@pytest.mark.parametrize('which',['deploy','session'])
def test_existing_admission_locks_exclude_refresh_without_replacing_lock_inode(prepared,which):
    f=prepared;path=f.lock if which=='deploy' else f.guard/'deploy.lock'
    with path.open('rb') as held:
        inode=path.stat().st_ino;fcntl.flock(held,fcntl.LOCK_SH|fcntl.LOCK_NB)
        with pytest.raises(BlockingIOError):f.refresh()
        assert path.stat().st_ino==inode
    assert f.target.read_bytes()==f.old
    preserved(f)


@pytest.mark.parametrize('failure',['stage','replace','readback','sync-tools','publish-audit','sync-audit'])
def test_failure_restores_original_inode_and_never_leaves_a_latch_or_success_audit(prepared,monkeypatch,failure):
    f=prepared;inode=f.target.stat().st_ino
    if failure=='stage':
        mkdtemp=r.tempfile.mkdtemp
        def stage(*a,**kw):
            if kw['dir']==f.audits:raise OSError('audit staging failed')
            return mkdtemp(*a,**kw)
        monkeypatch.setattr(r.tempfile,'mkdtemp',stage)
    elif failure=='replace':
        replace=os.replace
        def fail_new(source,target):
            if Path(source).name=='new':raise OSError('replace failed')
            return replace(source,target)
        monkeypatch.setattr(os,'replace',fail_new)
    elif failure=='readback':
        read=r.refresh_read;calls=0
        def corrupt(path):
            nonlocal calls
            if path==f.target:
                calls+=1
                if calls==2:return b'bad readback',path.stat()
            return read(path)
        monkeypatch.setattr(r,'refresh_read',corrupt)
    elif failure=='publish-audit':
        link=os.link
        def fail_audit(source,target,**kw):
            if Path(source).name=='audit':raise OSError('audit publish failed')
            return link(source,target,**kw)
        monkeypatch.setattr(os,'link',fail_audit)
    else:
        sync=r.refresh_sync;failed=False
        def fail_once(path):
            nonlocal failed
            if not failed and path==(f.tools if failure=='sync-tools' else f.audits):
                failed=True;raise OSError('directory sync failed')
            return sync(path)
        monkeypatch.setattr(r,'refresh_sync',fail_once)
    with pytest.raises((OSError,ValueError)):f.refresh()
    assert f.target.read_bytes()==f.old and f.target.stat().st_ino==inode
    assert not list(f.audits.glob('rootfs-refresh-*.json'))
    preserved(f)


def test_existing_prepare_still_refuses_an_already_provisioned_runtime(tmp_path,monkeypatch):
    config=tmp_path/'runtime.json';config.write_text('{}')
    monkeypatch.setattr(r,'CONFIG',config)
    with pytest.raises(ValueError,match='runtime already provisioned; no bootstrap/retry'):
        r.prepare_contents(tmp_path/'input.json')


def test_cli_routes_refresh_before_prepare_transaction_or_append_open(prepared,monkeypatch,capsys):
    f=prepared
    monkeypatch.setattr(r.sys,'argv',['runtime','refresh-tools','--source',str(f.source),
        '--commit',f.commit,'--sha256',hashlib.sha256(f.body).hexdigest()])
    mask=os.umask(0o077)
    try:r.main()
    finally:os.umask(mask)
    assert json.loads(capsys.readouterr().out)['changed']
    preserved(f)


def test_committed_install_reports_cleanup_residue_instead_of_false_failure(prepared,monkeypatch):
    f=prepared
    monkeypatch.setattr(r.shutil,'rmtree',lambda *_a,**_k:None)
    result=f.refresh()
    assert result['changed'] and result['cleanup_pending']
    assert f.target.read_bytes()==f.body and Path(result['audit']).exists()


def test_rollback_failure_keeps_original_inode_evidence_and_reports_uncertainty(prepared,monkeypatch):
    f=prepared;inode=f.target.stat().st_ino;replace=os.replace
    def fail_restore(source,target):
        if Path(source).name=='original':raise OSError('restore unavailable')
        return replace(source,target)
    monkeypatch.setattr(os,'replace',fail_restore)
    monkeypatch.setattr(r,'refresh_sync',Mock(side_effect=OSError('disk unavailable')))
    with pytest.raises(RuntimeError,match='rollback/durability unproven'):f.refresh()
    backups=list(f.tools.glob('.rootfs-refresh-*/original'))
    assert len(backups)==1 and backups[0].read_bytes()==f.old and backups[0].stat().st_ino==inode
    assert not list(f.audits.glob('rootfs-refresh-*.json'))
