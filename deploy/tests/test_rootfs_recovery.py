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
    monkeypatch.setattr(b,'build',Mock(side_effect=AssertionError('recovery must never build')))
    monkeypatch.setattr(b,'download',Mock(side_effect=AssertionError('recovery must never download')))
    def recover(**changes):
        values=dict(recipe_path=source,expected=key,failed_operation='build',device=identity[0],inode=identity[1],audit_sha=b.digest(audit));values.update(changes)
        return b.recover_latch(**values)
    return dict(root=root,key=key,source=source,recipe=recipe,audit=audit,save=save,latch=latch,identity=identity,lock=lock,observation=observation,recover=recover)


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
