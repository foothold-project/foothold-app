"""Offline guard DAC repair with real modes, no-follow files, flock and fault injection."""
import fcntl
import json
import os
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from deploy import rootfs_runtime as r


@pytest.fixture
def prepared(tmp_path,monkeypatch):
    guard=tmp_path/'guard';guard.mkdir(mode=0o700)
    state=guard/'state';state.mkdir(mode=0o700)
    lock=tmp_path/'deploy.lock';lock.touch(mode=0o600)
    session=guard/'deploy.lock';session.touch();session.chmod(0o660)
    marker=guard/'setup-unproven';marker.write_text('pending');marker.chmod(0o600)
    pin=(guard.stat().st_dev,guard.stat().st_ino)
    setup=[marker.stat().st_dev,marker.stat().st_ino]
    ownership={state.stat().st_ino:(23456,23456),session.stat().st_ino:(0,23456)}
    original_lstat=Path.lstat;original_fstat=os.fstat
    ancestors={tmp_path,*tmp_path.parents}
    def owned(info,path=None):
        values=list(info);values[4],values[5]=ownership.get(info.st_ino,(0,0))
        if path in ancestors:values[0]&=~0o022
        return os.stat_result(values)
    monkeypatch.setattr(Path,'lstat',lambda path,*a,**k:owned(original_lstat(path,*a,**k),path))
    monkeypatch.setattr(os,'fstat',lambda fd:owned(original_fstat(fd)))
    def chown(fd,uid,gid):ownership[original_fstat(fd).st_ino]=(uid,gid)
    monkeypatch.setattr(os,'fchown',chown)
    monkeypatch.setattr(os,'geteuid',lambda:0)
    monkeypatch.setattr(r,'GUARD',guard);monkeypatch.setattr(r,'REFRESH_LOCK',lock)
    monkeypatch.setattr(r,'REFRESH_AUDITS',tmp_path)
    data=dict(setup_identity=setup,identity=dict(uid=23456,gid=23456))
    monkeypatch.setattr(r,'load',Mock(return_value=data))
    monkeypatch.setattr(r,'identity',lambda _:(23456,23456))
    inactive=Mock();monkeypatch.setattr(r,'inactive_namespace',inactive)
    latches=Mock();monkeypatch.setattr(r.shared,'ensure_no_install_latch',latches)
    forbidden=Mock(side_effect=AssertionError('repair may not prepare, start or write fences'))
    for name in ('prepare','prepare_contents','bind_namespace','start_pair','create_install_latch','clear_install_latch'):
        monkeypatch.setattr(r,name,forbidden)
    protected={marker:(marker.read_bytes(),marker.stat().st_ino)}
    for name in ('config.json','rootfs-validation.json','rootfs-prepare-audit.json'):
        path=tmp_path/name;path.write_text('unchanged');protected[path]=(path.read_bytes(),path.stat().st_ino)
    def repair(**kwargs):return r.repair_guard_mode(kwargs.get('device',pin[0]),kwargs.get('inode',pin[1]))
    yield SimpleNamespace(guard=guard,state=state,lock=lock,session=session,marker=marker,pin=pin,
        ownership=ownership,data=data,inactive=inactive,latches=latches,repair=repair)
    forbidden.assert_not_called()
    for path,(body,inode) in protected.items():
        if path.exists():assert path.read_bytes()==body and path.stat().st_ino==inode


def test_repair_changes_only_directory_gid_mode_and_records_audit(prepared):
    f=prepared
    result=f.repair()
    assert f.guard.lstat().st_mode&0o7777==0o710
    assert f.guard.lstat().st_gid==23456
    assert result['changed'] and (result['device'],result['inode'])==f.pin
    record=Path(result['audit']);assert record.stat().st_mode&0o777==0o400
    audit=json.loads(record.read_bytes())
    assert (audit['before_mode'],audit['after_mode'],audit['before_gid'],audit['after_gid'])==(0o700,0o710,0,23456)
    f.inactive.assert_called_once_with(f.data);f.latches.assert_called_once()


def test_already_correct_repair_writes_nothing(prepared,monkeypatch):
    f=prepared;f.repair()
    snapshot={p:(p.stat().st_ino,p.stat().st_mtime_ns,p.stat().st_ctime_ns) for p in f.guard.parent.rglob('*')}
    forbidden=Mock(side_effect=AssertionError('no-op must not write'))
    for name in ('fchown','fchmod','link','fsync'):monkeypatch.setattr(os,name,forbidden)
    monkeypatch.setattr(r.tempfile,'mkdtemp',forbidden)
    assert f.repair()==dict(changed=False,device=f.pin[0],inode=f.pin[1])
    assert snapshot=={p:(p.stat().st_ino,p.stat().st_mtime_ns,p.stat().st_ctime_ns) for p in snapshot}


@pytest.mark.parametrize('change',[
    'device','inode','missing-pin','nonroot','owner','gid','mode-755','mode-750','mode-writable',
    'guard-link','state-link','state-mode','state-owner','lock-link','lock-fifo','lock-mode','lock-owner',
    'session','session-pending','setup-pending','setup-identity','setup-link','install','install-pending',
    'active-manager','live-uid','audit-collision','guard-swap'])
def test_refusals_preserve_mode_and_fences(prepared,monkeypatch,change):
    f=prepared;kwargs={}
    if change=='device':kwargs['device']=f.pin[0]+1
    elif change=='inode':kwargs['inode']=f.pin[1]+1
    elif change=='missing-pin':kwargs['inode']=None
    elif change=='nonroot':monkeypatch.setattr(os,'geteuid',lambda:1000)
    elif change in ('owner','gid'):f.ownership[f.pin[1]]=(1000,0) if change=='owner' else (0,1000)
    elif change.startswith('mode-'):f.guard.chmod({'mode-755':0o755,'mode-750':0o750,'mode-writable':0o770}[change])
    elif change in ('guard-link','state-link','lock-link','setup-link'):
        path={'guard-link':f.guard,'state-link':f.state,'lock-link':f.session,'setup-link':f.marker}[change]
        saved=path.with_name(path.name+'.saved');path.rename(saved);path.symlink_to(saved)
    elif change=='lock-fifo':f.session.unlink();os.mkfifo(f.session)
    elif change=='state-mode':f.state.chmod(0o750)
    elif change=='state-owner':f.ownership[f.state.stat().st_ino]=(0,0)
    elif change=='lock-mode':f.session.chmod(0o600)
    elif change=='lock-owner':f.ownership[f.session.stat().st_ino]=(23456,23456)
    elif change in ('session','session-pending','setup-pending'):
        path=f.guard/{'session':'state/unproven','session-pending':'state/unproven.release-pending','setup-pending':'setup-unproven.release-pending'}[change]
        path.symlink_to('absent')  # dangling barriers must refuse as well
    elif change=='setup-identity':f.data['setup_identity']=[0,0]
    elif change in ('install','install-pending'):f.latches.side_effect=ValueError('package fence remains')
    elif change in ('active-manager','live-uid'):
        # Exercise the real absence check without querying systemd or /proc.
        monkeypatch.setattr(r,'inactive_namespace',REAL_INACTIVE)
        monkeypatch.setattr(r,'unit_state',lambda _:dict(ActiveState='active' if change=='active-manager' else 'inactive',MainPID='0'))
        monkeypatch.setattr(r,'dedicated_pids',lambda _:[123] if change=='live-uid' else [])
    elif change=='audit-collision':(f.guard.parent/('rootfs-guard-mode-'+str(f.pin[0])+'-'+str(f.pin[1])+'.json')).touch()
    elif change=='guard-swap':
        def swap(_):
            f.guard.rename(f.guard.with_name('retained'));f.guard.mkdir(mode=0o700)
        f.inactive.side_effect=swap
    mode=f.guard.lstat().st_mode
    with pytest.raises((ValueError,OSError)):f.repair(**kwargs)
    assert f.guard.lstat().st_mode==mode
    assert not list(f.guard.parent.glob('.rootfs-guard-mode-*'))


REAL_INACTIVE=r.inactive_namespace


@pytest.mark.parametrize('which',['deploy','session'])
def test_both_existing_locks_exclude_repair(prepared,which):
    f=prepared;path=f.lock if which=='deploy' else f.session
    inode=path.stat().st_ino
    with path.open('rb') as held:
        fcntl.flock(held,fcntl.LOCK_SH|fcntl.LOCK_NB)
        with pytest.raises(BlockingIOError):f.repair()
    assert path.stat().st_ino==inode and f.guard.lstat().st_mode&0o777==0o700


@pytest.mark.parametrize('failure',['stage','chown','chmod','readback','sync-guard','publish','sync-audit'])
def test_repair_failure_restores_exact_permissions_without_success_audit(prepared,monkeypatch,failure):
    f=prepared
    if failure=='stage':monkeypatch.setattr(r.tempfile,'mkdtemp',Mock(side_effect=OSError('stage failed')))
    elif failure in ('chown','chmod','sync-guard'):
        name={'chown':'fchown','chmod':'fchmod','sync-guard':'fsync'}[failure]
        original=getattr(os,name);failed=[]
        def fail(fd,*args):
            if os.fstat(fd).st_ino==f.pin[1] and not failed:
                failed.append(True);raise OSError('synthetic failure')
            return original(fd,*args)
        monkeypatch.setattr(os,name,fail)
    elif failure=='readback':
        original=os.fstat
        def changed(fd):
            info=original(fd)
            if info.st_ino==f.pin[1] and info.st_mode&0o777==0o710:
                values=list(info);values[5]=0;return os.stat_result(values)
            return info
        monkeypatch.setattr(os,'fstat',changed)
    elif failure=='publish':monkeypatch.setattr(os,'link',Mock(side_effect=OSError('publish failed')))
    elif failure=='sync-audit':
        sync=r.refresh_sync;failed=[]
        def fail(path):
            if not failed:failed.append(True);raise OSError('audit sync failed')
            return sync(path)
        monkeypatch.setattr(r,'refresh_sync',fail)
    with pytest.raises((ValueError,OSError)):f.repair()
    assert f.guard.lstat().st_mode&0o7777==0o700 and f.guard.lstat().st_gid==0
    assert not list(f.guard.parent.glob('rootfs-guard-mode-*.json'))


def test_cli_requires_pins_and_bypasses_prepare_or_append_open(prepared,monkeypatch,capsys):
    f=prepared
    monkeypatch.setattr(r.sys,'argv',['runtime','repair-guard-mode','--guard-device',str(f.pin[0]),'--guard-inode',str(f.pin[1])])
    mask=os.umask(0o077)
    try:r.main()
    finally:os.umask(mask)
    assert json.loads(capsys.readouterr().out)['changed']


def test_new_guard_ignores_umask_and_grants_only_group_search(tmp_path,monkeypatch):
    guard=tmp_path/'guard';monkeypatch.setattr(r,'GUARD',guard)
    chown=Mock();monkeypatch.setattr(os,'chown',chown)
    old=os.umask(0o077)
    try:r.create_guard(23456,23456)
    finally:os.umask(old)
    assert guard.stat().st_mode&0o7777==0o710
    assert (guard/'deploy.lock').stat().st_mode&0o7777==0o660
    assert (guard/'state').stat().st_mode&0o7777==0o700
    assert chown.call_args_list[0].args==(guard,0,23456)


def test_start_pair_refuses_uid_guard_access_before_any_start_or_marker_change(monkeypatch):
    value=dict(identity=dict(uid=23456,gid=23456),recipe_sha256='a'*64)
    monkeypatch.setattr(r,'load',lambda:value);monkeypatch.setattr(r,'identity',lambda _:(23456,23456))
    for name in ('inactive_namespace','assets','private_settings','validated'):monkeypatch.setattr(r,name,lambda *_:None)
    monkeypatch.setattr(r.build,'verify',lambda *_:None)
    probe=Mock(return_value=SimpleNamespace(returncode=1));monkeypatch.setattr(r.subprocess,'run',probe)
    forbidden=Mock(side_effect=AssertionError('must fail before mutation/start'))
    for name in ('create_install_latch','clear_install_latch','bind_namespace'):monkeypatch.setattr(r,name,forbidden)
    with pytest.raises(ValueError,match='guard_access: dedicated UID'):r.start_pair(forbidden)
    assert probe.call_args.kwargs['user']==23456 and probe.call_args.kwargs['extra_groups']==()
    forbidden.assert_not_called()


def test_full_prepare_under_umask_077_publishes_searchable_guard_without_schema_change(tmp_path,monkeypatch):
    home=tmp_path/'sim-home';etc=tmp_path/'sim-etc';tools=tmp_path/'tools';systemd=tmp_path/'systemd'
    for path in (tools,systemd):path.mkdir()
    guard=home/'guard';config=tmp_path/'runtime.json';source=tmp_path/'input.json'
    monkeypatch.setattr(r,'CONFIG',config);monkeypatch.setattr(r,'GUARD',guard)
    roots={'/var/lib/foothold-sim':home,'/etc/foothold-sim':etc,
        '/opt/foothold/deploy-tools':tools,'/etc/systemd/system':systemd}
    def path(value):
        for prefix,target in roots.items():
            if value==prefix or value.startswith(prefix+'/'):return target/str(value)[len(prefix):].lstrip('/')
        return Path(value)
    monkeypatch.setattr(r,'Path',path)
    body=dict(schema=1,recipe_sha256='a'*64,manifest_sha256='b'*64,asset_source='/synthetic',
        asset_manifest_sha256='c'*64,plugin_rel='plugin',policy_rel='policy')
    monkeypatch.setattr(r.build,'private_json',lambda p,*_:dict(body) if p==source else dict(config=dict(uid=23456,gid=23456)))
    monkeypatch.setattr(r.build,'verify',lambda *_:dict(manifest_sha256='b'*64))
    monkeypatch.setattr(r,'rootfs',lambda _:tmp_path/'rootfs')
    monkeypatch.setattr(r,'assets',lambda _:None);monkeypatch.setattr(r,'identity',lambda _:(23456,23456))
    def absent(_):raise KeyError('synthetic unallocated identity')
    for module,name in ((r.pwd,'getpwnam'),(r.pwd,'getpwuid'),(r.grp,'getgrnam'),(r.grp,'getgrgid')):
        monkeypatch.setattr(module,name,absent)
    monkeypatch.setattr(r,'run',Mock(return_value=''));monkeypatch.setattr(os,'chown',Mock())
    def marker(p):
        p.write_bytes(b'pending');return (p.stat().st_dev,p.stat().st_ino)
    monkeypatch.setattr(r,'create_install_latch',marker)
    old=os.umask(0o077)
    try:r.prepare_contents(source)
    finally:os.umask(old)
    assert guard.stat().st_mode&0o7777==0o710
    assert (guard/'deploy.lock').stat().st_mode&0o7777==0o660
    assert set(json.loads(config.read_text()))==set(body)|{'setup_identity'}
    assert json.loads(config.read_text())['schema']==1


def test_probe_execution_errors_are_safe_guard_access_refusals(monkeypatch):
    monkeypatch.setattr(r.subprocess,'run',Mock(side_effect=PermissionError(13,'private secret','/private/path')))
    with pytest.raises(ValueError) as caught:r.guard_access(23456,23456)
    assert str(caught.value)=='guard_access: dedicated UID access probe could not complete'
