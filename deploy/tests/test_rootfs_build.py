"""Recipe/seal denials with synthetic bytes, no APT/download/extract/service calls."""
import copy
import hashlib
import json
import os
from pathlib import Path
from unittest.mock import patch
import pytest
from deploy import rootfs_build as b,rootfs_config as cfg


def wheels():
    rows=[]
    for name,version in [('fastapi','0.146.0'),('pydantic','2.14.1'),('SQLAlchemy','2.1.5'),('alembic','1.20.0'),
                         ('psycopg','3.3.6'),('uvicorn','0.54.0'),('websockets','15.0.1'),('trimesh','5.1.0')]:
        filename=name+'-'+version+'-py3-none-any.whl'
        rows.append(dict(name=name,version=version,filename=filename,
            url='https://files.pythonhosted.org/packages/fixture/'+filename,sha256='a'*64,size=10))
    return rows


def config():return dict(uid=23456,gid=23456,mesh_targets=['/home/example/mesh0.obj','/home/example/mesh1.obj'],library_aliases={})


def test_direct_wheels_hashes_origins_and_abi_are_exact():
    rows=wheels();assert len(b.validate_wheels(rows))==8
    for key,value in [('sha256','bad'),('url','http://files.pythonhosted.org/packages/x'),
                      ('url','https://example.org/wheel.whl'),('version','0.147.0'),
                      ('filename','fastapi-0.146.0-cp313-cp313-linux_x86_64.whl')]:
        bad=copy.deepcopy(rows);bad[0][key]=value
        with pytest.raises(ValueError):b.validate_wheels(bad)
    with pytest.raises(ValueError):b.validate_wheels(rows[:-1])
    with pytest.raises(ValueError):b.validate_wheels(rows+[rows[0]])


def test_empty_status_plan_is_validated_without_host_inventory(monkeypatch):
    monkeypatch.setattr(b.shared,'requirements',lambda:{'fixture':'1.0'})
    monkeypatch.setattr(b.planner,'BASE_ROOTS',('libc6',))
    rows=[dict(name=name,version=version,sha256='a'*64,filename='pool/main/f/'+name+'.deb',download_bytes=10,installed_bytes=20)
          for name,version in [('fixture','1.0-1'),('libc6','2.39-1')]]
    plan=dict(schema='foothold-rootfs-apt-plan/1',runnable=False,status_empty=True,host_inventory_used=False,
        snapshot=b.planner.SNAPSHOT,status_sha256=hashlib.sha256(b'').hexdigest(),metadata_sha256='b'*64,
        packages=rows,package_count=2,download_bytes=20,installed_bytes=40)
    assert set(b.validate_plan(plan))=={'fixture','libc6'}
    for change in ('host','driver','missing','pin','sum'):
        bad=copy.deepcopy(plan)
        if change=='host':bad['host_inventory_used']=True
        if change=='driver':bad['packages'][1]['name']='nvidia-utils'
        if change=='missing':bad['packages']=rows[:1]
        if change=='pin':bad['packages'][0]['version']='2.0-1'
        if change=='sum':bad['download_bytes']=21
        with pytest.raises(ValueError):b.validate_plan(bad)


def test_config_does_not_allow_host_roots_or_unprivileged_mesh_directory_bind():
    cfg.validate_config(config())
    for value in ('/usr/lib/mesh.obj','/home/example/../mesh.obj','/home/example/'):
        bad=config();bad['mesh_targets'][0]=value
        with pytest.raises(ValueError):cfg.validate_config(bad)
    bad=config();bad['uid']=0
    with pytest.raises(ValueError):cfg.validate_config(bad)


def sealed(tmp_path,monkeypatch):
    recipe={'synthetic':'rootfs'};key=b.digest(recipe);root=tmp_path/key;root.mkdir()
    (root/'foothold-runtime').mkdir()
    (root/'foothold-runtime/identity.json').write_bytes(b'')
    (root/'foothold-runtime').chmod(0o555)
    (root/'payload').write_bytes(b'immutable');(root/'payload').chmod(0o444)
    (root/'alias').symlink_to('payload')
    (root/'RECIPE.json').write_bytes(b.shared.canonical(recipe));(root/'RECIPE.json').chmod(0o400)
    # Root ownership is simulated; content, type and mode checks stay real.
    original=Path.lstat
    def rootstat(path,*args,**kwargs):
        data=list(original(path,*args,**kwargs));data[4]=data[5]=0;return os.stat_result(data)
    monkeypatch.setattr(Path,'lstat',rootstat)
    def private(path,mode=0o600):
        assert path.lstat().st_mode&0o777==mode
        return json.loads(path.read_text())
    monkeypatch.setattr(b,'private_json',private)
    rows=b.manifest_rows(root)
    manifest=b.shared.canonical(dict(schema=1,recipe_sha256=key,rows=rows))
    (root/'MANIFEST.json').write_bytes(manifest);(root/'MANIFEST.json').chmod(0o400)
    identity=dict(schema=1,recipe_sha256=key,manifest_sha256=hashlib.sha256(manifest).hexdigest())
    path=root/'foothold-runtime/identity.json';path.write_bytes(b.shared.canonical(identity));path.chmod(0o444)
    complete={**identity,'identity_sha256':b.shared.sha(path)}
    (root/'COMPLETE.json').write_bytes(b.shared.canonical(complete));(root/'COMPLETE.json').chmod(0o400)
    root.chmod(0o555)
    return root,key


def test_incomplete_or_changed_actual_manifest_never_verifies(tmp_path,monkeypatch):
    root,key=sealed(tmp_path,monkeypatch)
    assert b.verify(root,key)['recipe_sha256']==key
    manifest=root/'MANIFEST.json';manifest.chmod(0o600);manifest.write_bytes(b'{}');manifest.chmod(0o400)
    with pytest.raises(ValueError,match='mismatch'):b.verify(root,key)
    root.chmod(0o755);manifest.unlink();root.chmod(0o555)
    with pytest.raises(FileNotFoundError):b.verify(root,key)


def test_payload_mutation_is_detected_even_with_untouched_seal(tmp_path,monkeypatch):
    root,key=sealed(tmp_path,monkeypatch)
    payload=root/'payload';payload.chmod(0o600);payload.write_bytes(b'changed');payload.chmod(0o444)
    with pytest.raises(ValueError,match='actual manifest'):b.verify(root,key)


def test_generated_rootfs_link_resolution_never_follows_host_absolute_links(tmp_path):
    (tmp_path/'usr/lib').mkdir(parents=True)
    (tmp_path/'lib').symlink_to('/usr/lib')
    cfg.put(tmp_path,'/lib/generated-unique-fixture',b'ROOTFS')
    assert (tmp_path/'usr/lib/generated-unique-fixture').read_bytes()==b'ROOTFS'


def test_failed_or_changed_host_transaction_records_after_and_never_clears_latch(tmp_path,monkeypatch):
    marker=tmp_path/'pending';clear=[];proofs=[]
    def create():marker.write_text('pending');return (1,2)
    monkeypatch.setattr(b.shared,'create_install_latch',create)
    monkeypatch.setattr(b.shared,'clear_install_latch',lambda value:clear.append(value))
    monkeypatch.setattr(b.shared,'snapshot',lambda:{'usr':'same'})
    def failed(before):raise ValueError('archive escape')
    def persist(before,after,error):proofs.append((before,after,type(error).__name__ if error else None))
    with pytest.raises(ValueError,match='archive escape'):b.audited(failed,persist)
    assert marker.read_text()=='pending' and not clear and proofs==[({'usr':'same'},{'usr':'same'},'ValueError')]
    snapshots=iter([{'usr':'same'},{'usr':'changed'}])
    monkeypatch.setattr(b.shared,'snapshot',lambda:next(snapshots))
    with pytest.raises(ValueError,match='identity changed'):b.audited(lambda before:None,persist)
    assert not clear and proofs[-1]==({'usr':'same'},{'usr':'changed'},None)


def test_wheel_payload_cannot_follow_absolute_deb_link_to_host(tmp_path):
    import zipfile
    root=tmp_path/'artifacts';directory=root/'.archives/wheels';directory.mkdir(parents=True)
    tree=tmp_path/'tree';(tree/'opt').mkdir(parents=True)
    outside=tmp_path/'host-sentinel';outside.mkdir();(outside/'sentinel').write_bytes(b'HOST')
    (tree/'opt/foothold-sim').symlink_to(outside)
    path=directory/'trimesh-5.1.0-py3-none-any.whl'
    with zipfile.ZipFile(path,'w') as wheel:
        wheel.writestr('trimesh/__init__.py','value=1\n')
        wheel.writestr('trimesh-5.1.0.dist-info/METADATA','Name: trimesh\nVersion: 5.1.0\n')
    row=dict(name='trimesh',version='5.1.0',filename=path.name,size=path.stat().st_size,sha256=b.shared.sha(path))
    b.install_wheels({'wheels':[row]},root,tree)
    assert [p.name for p in outside.iterdir()]==['sentinel'] and (outside/'sentinel').read_bytes()==b'HOST'
    internal=cfg.inside(tree,'/opt/foothold-sim/python-vendor/trimesh/__init__.py')
    assert internal.is_relative_to(tree) and internal.read_text()=='value=1\n'


def test_symlink_target_mutation_is_manifest_bound(tmp_path,monkeypatch):
    root,key=sealed(tmp_path,monkeypatch)
    assert b.verify(root,key)['recipe_sha256']==key
    root.chmod(0o755);(root/'alias').unlink();(root/'alias').symlink_to('/usr/lib/other');root.chmod(0o555)
    with pytest.raises(ValueError,match='actual manifest'):b.verify(root,key)


def test_skipped_postinst_interpreter_alternatives_stay_inside_root(tmp_path):
    (tmp_path/'usr/bin').mkdir(parents=True)
    provider=tmp_path/'usr/bin/ruby3.2';provider.write_bytes(b'synthetic interpreter');provider.chmod(0o555)
    (tmp_path/'usr/bin/ruby').symlink_to('/etc/alternatives/ruby')
    cfg.executable_alias(tmp_path,'/usr/bin/ruby','/usr/bin/ruby3.2')
    assert os.readlink(tmp_path/'etc/alternatives/ruby')=='/usr/bin/ruby3.2'
    assert cfg.inside(tmp_path,'/usr/bin/ruby')==provider
    cfg.executable_alias(tmp_path,'/usr/bin/ruby','/usr/bin/ruby3.2')
    with pytest.raises(ValueError,match='provider absent'):
        cfg.executable_alias(tmp_path,'/usr/bin/python3','/usr/bin/python3.12')
