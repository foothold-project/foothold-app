"""Formal recovery with synthetic audit files and a real temporary latch/lock."""
import hashlib
import json
import os
from pathlib import Path
import re
from unittest.mock import Mock
import fcntl
import pytest
from deploy import rootfs_build as b


@pytest.fixture
def failed(tmp_path,monkeypatch):
    monkeypatch.setattr(b.shared,'requirements',lambda:{'fixture':'1.0'})
    monkeypatch.setattr(b.planner,'BASE_ROOTS',('libc6',))
    packages=[dict(name=name,version=version,sha256='a'*64,filename='pool/main/f/'+name+'.deb',download_bytes=10,installed_bytes=20)
              for name,version in [('fixture','1.0-1'),('libc6','2.39-1')]]
    plan=dict(schema='foothold-rootfs-apt-plan/1',runnable=False,status_empty=True,host_inventory_used=False,
        snapshot=b.planner.SNAPSHOT,status_sha256=hashlib.sha256(b'').hexdigest(),metadata_sha256='b'*64,
        packages=packages,package_count=2,download_bytes=20,installed_bytes=40)
    wheels=[]
    requirements=Path('apps/server/requirements.txt').read_text().splitlines()+['trimesh==5.1.0']
    for requirement in requirements:
        name,version=re.fullmatch(r'([A-Za-z0-9_-]+)(?:\[[a-z,]+\])?==(.+)',requirement).groups()
        filename=name+'-'+version+'-py3-none-any.whl'
        wheels.append(dict(name=name,version=version,filename=filename,url='https://files.pythonhosted.org/packages/fixture/'+filename,sha256='a'*64,size=10))
    generators=b.generators();generators['rootfs_build.py']='e'*64
    recipe=dict(schema=1,apt_plan=plan,wheels=wheels,
        config=dict(uid=23456,gid=23456,mesh_targets=['/home/example/mesh0.obj','/home/example/mesh1.obj'],library_aliases={}),generators=generators)
    key=b.recipe_identity(recipe);root=tmp_path/'rootfs'/key
    (root/'.archives/audit').mkdir(parents=True);(root/'.stage').mkdir()
    for path in (root.parent,root,*[p for p in root.rglob('*') if p.is_dir()]):path.chmod(0o700)
    audit=dict(host={'protected':'same'},status='status',dpkg='query',usr='tree')
    def save(path,value,mode=0o600):
        path.write_bytes(b.shared.canonical(value));path.chmod(mode)
    source=tmp_path/'approved.json';save(source,recipe);save(root/'RECIPE.json',recipe,0o400)
    save(root/'.archives/audit/build-before.json',audit);save(root/'.stage/before.json',audit)
    save(root/'.archives/build-after.json',audit);save(root/'.archives/build-error.json',dict(type='ValueError',reason='invalid archive path'))
    latch=tmp_path/'pending';latch.write_bytes(b'package-transaction-pending\n');latch.chmod(0o600)
    lock=tmp_path/'deploy.lock';lock.touch(mode=0o600)
    identity=(latch.stat().st_dev,latch.stat().st_ino)
    # Fake only ownership and pre-existing ancestor trust; file bytes/types,
    # modes, inode changes, no-follow opens and flock all stay real.
    original_lstat=Path.lstat;original_stat=os.stat;original_fstat=os.fstat
    ancestors={tmp_path,*tmp_path.parents}
    def owned(info,path=None):
        values=list(info);values[4]=values[5]=0
        if path in ancestors:values[0]&=~0o022
        return os.stat_result(values)
    monkeypatch.setattr(Path,'lstat',lambda path,*a,**k:owned(original_lstat(path,*a,**k),path))
    monkeypatch.setattr(os,'stat',lambda *a,**k:owned(original_stat(*a,**k)))
    monkeypatch.setattr(os,'fstat',lambda *a,**k:owned(original_fstat(*a,**k)))
    monkeypatch.setattr(b.os,'geteuid',lambda:0);monkeypatch.setattr(b.os,'umask',lambda _:0o077)
    monkeypatch.setattr(b,'ROOT',root.parent);monkeypatch.setattr(b,'INSTALL_LATCH',latch)
    monkeypatch.setattr(b.planner,'DEPLOY_LOCK',lock);monkeypatch.setattr(b.planner,'GUARD',tmp_path/'guard')
    observation=Mock(return_value=audit);monkeypatch.setattr(b.shared,'snapshot',observation)
    real_build=b.build
    monkeypatch.setattr(b,'build',Mock(side_effect=AssertionError('recovery must never build')))
    monkeypatch.setattr(b,'download',Mock(side_effect=AssertionError('recovery must never download')))
    def recover(**changes):
        values=dict(recipe_path=source,expected=key,failed_operation='build',device=identity[0],inode=identity[1],audit_sha=b.digest(audit));values.update(changes)
        return b.recover_latch(**values)
    return dict(root=root,key=key,source=source,recipe=recipe,audit=audit,save=save,latch=latch,identity=identity,lock=lock,observation=observation,recover=recover,real_build=real_build)


def test_equal_audits_release_only_explicit_inode_and_preserve_failed_files(failed):
    f=failed;root=f['root'];before={str(p.relative_to(root)):p.read_bytes() for p in root.rglob('*') if p.is_file()}
    with pytest.raises(ValueError,match='generator differs'):b.validate_recipe(f['recipe'])
    f['recover']()
    assert not f['latch'].exists()
    assert all((root/p).read_bytes()==body for p,body in before.items())
    records=list((root/'.archives').glob('recover-latch-*.json'));assert len(records)==1
    record=json.loads(records[0].read_bytes())
    assert record['latch_inode']==f['identity'][1] and record['observed_audit_sha256']==b.digest(f['audit'])
    assert records[0].stat().st_mode&0o777==0o600
    b.build.assert_not_called();b.download.assert_not_called()


@pytest.mark.parametrize('change',['live','after','approved_digest','inode','device','recipe'])
def test_any_audit_recipe_or_latch_mismatch_preserves_latch(failed,change):
    f=failed;args={}
    if change=='live':f['observation'].return_value={**f['audit'],'usr':'CHANGED'}
    if change=='after':f['save'](f['root']/'.archives/build-after.json',{**f['audit'],'usr':'CHANGED'})
    if change=='approved_digest':args['audit_sha']='f'*64
    if change=='inode':args['inode']=f['identity'][1]+1
    if change=='device':args['device']=f['identity'][0]+1
    if change=='recipe':args['expected']='f'*64
    with pytest.raises(ValueError):f['recover'](**args)
    assert f['latch'].exists()
    if change=='live':f['observation'].assert_called_once_with()
    else:f['observation'].assert_not_called()
    b.build.assert_not_called();b.download.assert_not_called()


@pytest.mark.parametrize('path',['.archives/audit/build-before.json','.archives/build-after.json','.archives/build-error.json'])
def test_missing_failure_evidence_cannot_clear_latch(failed,path):
    f=failed;(f['root']/path).unlink()
    with pytest.raises(FileNotFoundError):f['recover']()
    assert f['latch'].exists();f['observation'].assert_not_called()


@pytest.mark.parametrize('seal',['COMPLETE.json','MANIFEST.json'])
def test_sealed_recipe_recovery_never_audits_or_writes(failed,seal):
    f=failed;(f['root']/seal).symlink_to('absent')
    before=sorted(str(p) for p in f['root'].rglob('*'))
    with pytest.raises(ValueError,match='sealed'):f['recover']()
    assert f['latch'].exists() and before==sorted(str(p) for p in f['root'].rglob('*'))
    f['observation'].assert_not_called()


def test_busy_deployment_lock_refuses_without_observation_or_record(failed):
    f=failed
    with f['lock'].open('r+') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        with pytest.raises(BlockingIOError):f['recover']()
    assert f['latch'].exists();f['observation'].assert_not_called()
    assert not list((f['root']/'.archives').glob('recover-latch-*'))


def test_replaced_latch_during_observation_cannot_be_cleared(failed):
    f=failed
    def replace():
        replacement=f['latch'].with_name('replacement');replacement.write_bytes(b'package-transaction-pending\n');replacement.chmod(0o600)
        replacement.replace(f['latch']);return f['audit']
    f['observation'].side_effect=replace
    with pytest.raises(ValueError,match='latch identity'):f['recover']()
    assert f['latch'].exists() and f['latch'].stat().st_ino!=f['identity'][1]


@pytest.mark.parametrize('kind',['symlink','wrong_content','wrong_mode','guard'])
def test_untrusted_latch_or_active_guard_refuses(failed,kind):
    f=failed
    if kind=='symlink':f['latch'].unlink();f['latch'].symlink_to(f['source'])
    if kind=='wrong_content':f['latch'].write_bytes(b'other transaction')
    if kind=='wrong_mode':f['latch'].chmod(0o644)
    if kind=='guard':b.planner.GUARD.mkdir()
    with pytest.raises((ValueError,OSError)):f['recover']()
    assert os.path.lexists(f['latch']);f['observation'].assert_not_called()


def test_failure_to_persist_observation_preserves_latch(failed,monkeypatch):
    monkeypatch.setattr(b.os,'fsync',Mock(side_effect=OSError('synthetic fsync failure')))
    with pytest.raises(OSError):failed['recover']()
    assert failed['latch'].exists()


def test_symlink_evidence_parent_is_not_followed(failed):
    f=failed;directory=f['root']/'.archives';outside=f['root'].parent/'outside';directory.rename(outside);directory.symlink_to(outside)
    before=sorted(str(p) for p in outside.rglob('*'))
    with pytest.raises(ValueError,match='untrusted'):f['recover']()
    assert f['latch'].exists() and before==sorted(str(p) for p in outside.rglob('*'))


def test_download_failure_uses_its_own_recorded_audits(failed):
    f=failed;archive=f['root']/'.archives'
    f['save'](archive/'download-after.json',f['audit'])
    f['save'](archive/'download-error.json',dict(type='ValueError',reason='metadata refusal'))
    f['recover'](failed_operation='download')
    assert not f['latch'].exists()
    record=json.loads(next(archive.glob('recover-latch-*.json')).read_text())
    assert record['failed_operation']=='download'


def test_non_root_recovery_cannot_observe_or_clear(failed,monkeypatch):
    monkeypatch.setattr(b.os,'geteuid',lambda:1000)
    with pytest.raises(ValueError,match='server root only'):failed['recover']()
    assert failed['latch'].exists();failed['observation'].assert_not_called()


def test_final_parent_sync_failure_preserves_a_blocking_name(failed,monkeypatch):
    import stat
    from deploy import install_sim_packages as package
    original_sync=os.fsync
    def sync(fd):
        if stat.S_ISDIR(os.fstat(fd).st_mode) and not os.path.lexists(failed['latch']):
            raise OSError('last parent fsync failed')
        return original_sync(fd)
    monkeypatch.setattr(os,'fsync',sync)
    with pytest.raises(OSError,match='last parent fsync'):failed['recover']()
    assert failed['latch'].stat().st_ino==failed['identity'][1]
    guard=package.release_guard(failed['latch']);assert guard.exists()
    # The extra barrier alone also refuses admission when rollback cannot put
    # the original name back; this removes only a synthetic test file.
    failed['latch'].unlink()
    with pytest.raises(ValueError,match='unproven'):package.ensure_no_install_latch(failed['latch'])


def test_last_stat_swap_never_unlinks_the_new_latch(failed,monkeypatch):
    original=os.stat;replacement=failed['latch'].with_name('new-transaction')
    replacement.write_bytes(b'package-transaction-pending\n');replacement.chmod(0o600)
    new_inode=replacement.stat().st_ino;swapped=[]
    def swap(path,*args,**kwargs):
        info=original(path,*args,**kwargs)
        if path==failed['latch'].name and kwargs.get('dir_fd') is not None and not swapped:
            swapped.append(True);replacement.replace(failed['latch'])
        return info
    monkeypatch.setattr(os,'stat',swap)
    with pytest.raises(ValueError,match='changed'):failed['recover']()
    assert swapped and failed['latch'].stat().st_ino==new_inode
    assert failed['latch'].read_bytes()==b'package-transaction-pending\n'


def test_swap_at_atomic_capture_restores_foreign_inode_without_removal(failed,monkeypatch):
    original=os.rename;replacement=failed['latch'].with_name('new-transaction')
    replacement.write_bytes(b'package-transaction-pending\n');replacement.chmod(0o600)
    new_inode=replacement.stat().st_ino
    def swap(*args,**kwargs):
        replacement.replace(failed['latch']);return original(*args,**kwargs)
    monkeypatch.setattr(os,'rename',swap)
    with pytest.raises(ValueError,match='capture'):failed['recover']()
    assert failed['latch'].stat().st_ino==new_inode


def test_stored_recipe_mismatch_never_observes_or_releases(failed):
    f=failed;(f['root']/'RECIPE.json').chmod(0o600);f['save'](f['root']/'RECIPE.json',{**f['recipe'],'schema':2},0o400)
    with pytest.raises(ValueError,match='stored failed recipe differs'):f['recover']()
    f['observation'].assert_not_called();assert f['latch'].exists()


def test_new_failure_latch_binding_must_match_approved_inode(failed):
    f=failed;f['save'](f['root']/'.archives/build-error.json',dict(type='ArchiveError',latch_device=f['identity'][0],latch_inode=f['identity'][1]+1))
    with pytest.raises(ValueError,match='another latch'):f['recover']()
    f['observation'].assert_not_called();assert f['latch'].exists()


@pytest.mark.parametrize('kind',['graph','reserved','canonical_reserved'])
def test_actual_build_cli_and_failure_json_preserve_origin_and_latch(failed,monkeypatch,kind):
    import io
    import shutil
    from contextlib import contextmanager
    from types import SimpleNamespace
    from deploy import verify_gz_abi
    from deploy.tests.test_rootfs_archive import archive
    f=failed
    if kind=='graph':entries=[('./usr/lib/unit','link','../../../../outside')];member='./usr/lib/unit';target='../../../../outside'
    elif kind=='reserved':entries=[('./foothold-runtime/surprise','file',b'x')];member='./foothold-runtime/surprise';target=None
    else:entries=[('./opt/a','link','/.stage'),('./opt/a/member','file',b'x')];member='./opt/a/member';target=None
    data=archive(entries)
    shutil.rmtree(f['root']/'.stage');shutil.rmtree(f['root']/'.archives/audit')
    # Ownership/host observation are synthetic; run/build/scan/graph/persist/CLI
    # are real, including their control flow and filesystem evidence.
    monkeypatch.setattr(b,'validate_recipe',lambda _:f['key'])
    monkeypatch.setattr(b.shared,'ROOT',f['root'].parent)
    monkeypatch.setattr(b.shared,'ensure_no_install_latch',lambda:None)
    monkeypatch.setattr(b.shared,'create_install_latch',lambda:f['identity'])
    clear=Mock();monkeypatch.setattr(b.shared,'clear_install_latch',clear)
    monkeypatch.setattr(b.shutil,'disk_usage',lambda _:SimpleNamespace(free=21*1024**3))
    monkeypatch.setattr(b,'build',f['real_build'])
    monkeypatch.setattr(b,'check_debs',lambda *_:{'fixture':Path('fixture_1_all.deb')})
    monkeypatch.setattr(verify_gz_abi,'verify',lambda _:None)
    @contextmanager
    def stream(*_):yield io.BytesIO(data)
    monkeypatch.setattr(b,'deb_stream',stream)
    monkeypatch.setattr(b.resource,'setrlimit',lambda *_:None)
    with pytest.raises(SystemExit) as caught:b.main(['build',str(f['source']),f['key']])
    assert 'fixture_1_all.deb' in str(caught.value) and member in str(caught.value)
    if target:assert target in str(caught.value)
    error=json.loads((f['root']/'.archives/build-error.json').read_bytes())
    assert error['type']=='ArchiveError'
    assert error['archive']=='fixture (fixture_1_all.deb)' and error['member']==member and error['target']==target
    assert (error['latch_device'],error['latch_inode'])==f['identity']
    assert not (f['root']/'.stage/tree').exists()
    assert f['latch'].exists();clear.assert_not_called()


def test_recovery_cli_prints_specific_safe_refusal(failed,monkeypatch):
    f=failed;(f['root']/'RECIPE.json').chmod(0o600);f['save'](f['root']/'RECIPE.json',{**f['recipe'],'schema':2},0o400)
    monkeypatch.setattr(b.resource,'setrlimit',lambda *_:None)
    args=['recover-latch',str(f['source']),f['key'],'--failed-operation','build','--latch-device',str(f['identity'][0]),'--latch-inode',str(f['identity'][1]),'--audit-sha256',b.digest(f['audit'])]
    with pytest.raises(SystemExit,match='recovery refused: stored failed recipe differs'):b.main(args)
    assert f['latch'].exists();f['observation'].assert_not_called()


def test_release_protocol_refuses_mixed_installed_fence_versions(failed,monkeypatch):
    from deploy import install_sim_packages as package
    tools=failed['root'].parent/'tools';tools.mkdir(mode=0o700)
    monkeypatch.setattr(package,'FENCE_TOOLS',tools);monkeypatch.setattr(package,'INSTALL_LATCH',failed['latch'])
    for name in ('common.sh','sim_control.py','proc_proof_server.py'):
        path=tools/name;path.write_bytes(Path(package.__file__).with_name(name).read_bytes());path.chmod(0o644)
    package.require_release_fences(failed['latch'])
    (tools/'common.sh').write_bytes(b'old fence')
    with pytest.raises(ValueError,match='reviewed release-pending'):package.clear_install_latch(failed['identity'],failed['latch'])
    assert failed['latch'].exists()
    assert not package.release_guard(failed['latch']).exists()
    # Flat installed-tool packages must reject old readers even when the
    # comparison source happens to be the installed directory itself.
    monkeypatch.setattr(package,'__file__',str(tools/'install_sim_packages.py'))
    with pytest.raises(ValueError,match='reviewed release-pending'):package.require_release_fences(failed['latch'])


def test_failed_original_name_rollback_still_leaves_durable_barrier(failed,monkeypatch):
    import stat
    from deploy import install_sim_packages as package
    rename=os.rename;link=os.link;sync=os.fsync;moved=[]
    def capture(*args,**kwargs):
        result=rename(*args,**kwargs);moved.append(True);return result
    def failed_sync(fd):
        if moved and stat.S_ISDIR(os.fstat(fd).st_mode):raise OSError('directory sync failed')
        return sync(fd)
    def failed_rollback(source,destination,*args,**kwargs):
        if moved and destination==failed['latch'].name:raise OSError('rollback link failed')
        return link(source,destination,*args,**kwargs)
    monkeypatch.setattr(os,'rename',capture);monkeypatch.setattr(os,'fsync',failed_sync);monkeypatch.setattr(os,'link',failed_rollback)
    with pytest.raises(OSError,match='directory sync'):failed['recover']()
    assert not failed['latch'].exists() and package.release_guard(failed['latch']).exists()
    with pytest.raises(ValueError,match='unproven'):package.ensure_no_install_latch(failed['latch'])


def test_recovery_cli_io_refusal_hides_private_exception_details(failed,monkeypatch):
    f=failed;f['observation'].side_effect=OSError('private path and secret detail')
    monkeypatch.setattr(b.resource,'setrlimit',lambda *_:None)
    args=['recover-latch',str(f['source']),f['key'],'--failed-operation','build','--latch-device',str(f['identity'][0]),'--latch-inode',str(f['identity'][1]),'--audit-sha256',b.digest(f['audit'])]
    with pytest.raises(SystemExit) as caught:b.main(args)
    assert 'recovery refused: OSError' in str(caught.value) and 'private path' not in str(caught.value)
    assert f['latch'].exists()
