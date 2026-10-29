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


def generator_fixture(root):
    for name in ('usr/bin','usr/share/ca-certificates','opt/ros/jazzy/opt','etc'):
        (root/name).mkdir(parents=True,exist_ok=True)
    for name in ('dash','python3.12','ruby3.2','gawk'):
        path=root/'usr/bin'/name;path.write_bytes(b'synthetic');path.chmod(0o555)
    (root/'usr/share/ca-certificates/root.crt').write_bytes(b'ROOT_CERT')


@pytest.mark.parametrize('parent',['etc/systemd','etc/systemd/user'])
def test_generator_absolute_write_parent_stays_under_root(tmp_path,monkeypatch,parent):
    root=tmp_path/'root';root.mkdir();generator_fixture(root)
    outside=tmp_path/'host-etc';outside.mkdir();(outside/'sentinel').write_bytes(b'HOST')
    link=root/parent;link.parent.mkdir(parents=True,exist_ok=True);link.symlink_to(outside)
    monkeypatch.setattr(cfg,'_profile',lambda *_:{})
    cfg.generate(root,config(),'a'*64)
    assert sorted(p.name for p in outside.iterdir())==['sentinel']
    assert (outside/'sentinel').read_bytes()==b'HOST'
    with cfg.RootTree(root) as tree:
        expected=root/tree.relative('/etc/systemd/user/sockets.target.wants/dbus.socket',follow_final=False)
    assert expected.is_relative_to(root) and expected.is_symlink()
    assert os.readlink(expected)=='/usr/lib/systemd/user/dbus.socket'


@pytest.mark.parametrize('parent',['usr/share/ca-certificates','usr/share/ca-certificates/mozilla'])
def test_generator_absolute_ca_parent_never_reads_host(tmp_path,monkeypatch,parent):
    root=tmp_path/'root';root.mkdir();generator_fixture(root)
    outside=tmp_path/'host-certs';outside.mkdir();(outside/'foreign.crt').write_bytes(b'HOST_CERT_SENTINEL')
    link=root/parent
    if link.exists():
        (link/'root.crt').unlink();link.rmdir()
    link.symlink_to(outside)
    # Give the future root's absolute target different, non-host bytes.
    internal=root/str(outside).lstrip('/');internal.mkdir(parents=True)
    (internal/'internal.crt').write_bytes(b'INTERNAL_CERT')
    monkeypatch.setattr(cfg,'_profile',lambda *_:{})
    cfg.generate(root,config(),'a'*64)
    bundle=cfg.inside(root,'/etc/ssl/certs/ca-certificates.crt').read_bytes()
    assert b'HOST_CERT_SENTINEL' not in bundle
    if parent.endswith('mozilla'):assert b'ROOT_CERT' in bundle
    else:assert bundle==b'INTERNAL_CERT\n'


def test_generator_nofollow_parent_swap_is_refused(tmp_path,monkeypatch):
    root=tmp_path/'root';(root/'etc/systemd').mkdir(parents=True)
    outside=tmp_path/'host-etc';outside.mkdir()
    with cfg.RootTree(root) as tree:
        resolve=tree.relative
        def swap(value,**kwargs):
            result=resolve(value,**kwargs)
            (root/'etc/systemd').rmdir();(root/'etc/systemd').symlink_to(outside)
            return result
        monkeypatch.setattr(tree,'relative',swap)
        with pytest.raises(OSError):tree.write('/etc/systemd/generated',b'unsafe')
    assert list(outside.iterdir())==[]


def test_profile_uses_only_root_relative_vendor_and_library_inputs(tmp_path,monkeypatch):
    root=tmp_path/'root';root.mkdir()
    vendor='opt/ros/jazzy/opt/vendor'
    for name in ('usr/lib/x86_64-linux-gnu','usr/lib/python3/dist-packages',
            vendor+'/lib',vendor+'/bin',vendor+'/share/gz',vendor+'/share/resources'):
        (root/name).mkdir(parents=True,exist_ok=True)
    for name in ('usr/lib/x86_64-linux-gnu/libEGL_mesa.so.0',vendor+'/share/gz/vendor.yaml',
            vendor+'/lib/libgz-sim8-fixture.so',vendor+'/lib/libgz-rendering8-ogre2.so'):
        (root/name).write_bytes(b'synthetic')
    payload=b'\x7fELF'+b'x'*64
    provider=root/vendor/'lib/native-provider';provider.write_bytes(payload)
    outside=tmp_path/'host-libraries';outside.mkdir()
    (outside/'foreign').write_bytes(b'\x7fELF'+b'HOST'*20)
    (root/'usr/lib/foreign').symlink_to(outside)
    inspected=[]
    def soname(data):
        inspected.append(bytes(data));return 'libfixture.so'
    monkeypatch.setattr(cfg,'soname',soname)
    env=cfg.profile(root,{})
    assert inspected==[payload]
    assert os.readlink(root/'foothold-runtime/lib/libfixture.so')=='/'+vendor+'/lib/native-provider'
    assert env['GZ_CONFIG_PATH']=='/'+vendor+'/share/gz'
    assert env['GZ_RENDERING_ENGINE_PATH'].split(':')[0]=='/'+vendor+'/lib'
    assert '/'+vendor+'/share/resources' in env['GZ_SIM_RESOURCE_PATH'].split(':')
    assert env['LD_LIBRARY_PATH'].split(':')[0]=='/foothold-runtime/lib'
    assert all(str(tmp_path) not in value for value in env.values())
    icd=json.loads((root/'foothold-runtime/egl_vendor.d/50_mesa.json').read_bytes())
    assert icd['ICD']['library_path']=='/usr/lib/x86_64-linux-gnu/libEGL_mesa.so.0'


def test_completed_recipe_reentry_never_audits_or_changes_seal(tmp_path,monkeypatch):
    from types import SimpleNamespace
    root,key=sealed(tmp_path,monkeypatch)
    assert b.verify(root,key)['recipe_sha256']==key
    before=b.shared.tree_manifest(root)
    source=tmp_path/'approved-recipe.json';source.write_bytes((root/'RECIPE.json').read_bytes());source.chmod(0o600)
    monkeypatch.setattr(b,'ROOT',tmp_path)
    monkeypatch.setattr(b.shared,'ROOT',tmp_path)
    monkeypatch.setattr(b.planner,'DEPLOY_LOCK',tmp_path/'deploy.lock')
    monkeypatch.setattr(b.planner,'GUARD',tmp_path/'absent-guard')
    monkeypatch.setattr(b.os,'geteuid',lambda:0)
    monkeypatch.setattr(b.os,'umask',lambda _:0o077)
    monkeypatch.setattr(b,'validate_recipe',lambda _:key)
    monkeypatch.setattr(b.shared,'ensure_no_install_latch',lambda:None)
    monkeypatch.setattr(b.shutil,'disk_usage',lambda _:SimpleNamespace(free=21*1024**3))
    original=Path.lstat;parents={tmp_path,*tmp_path.parents}
    def trusted_parent(path,*args,**kwargs):
        values=list(original(path,*args,**kwargs))
        if path in parents:values[0]&=~0o022
        return os.stat_result(values)
    monkeypatch.setattr(Path,'lstat',trusted_parent)
    with patch.object(b,'audited',side_effect=AssertionError('sealed recipe must not enter audit')) as audit:
        with pytest.raises(ValueError,match='sealed'):b.run('build',source,key)
        audit.assert_not_called()
    assert b.shared.tree_manifest(root)==before
    assert not (root/'.stage').exists()
    assert b.verify(root,key)['recipe_sha256']==key


@pytest.mark.parametrize('name',['COMPLETE.json','MANIFEST.json'])
def test_partial_seal_or_broken_seal_link_refuses_without_writes(tmp_path,name):
    (tmp_path/name).symlink_to('missing')
    before=sorted(p.name for p in tmp_path.iterdir())
    with pytest.raises(ValueError,match='sealed'):b.require_unsealed(tmp_path)
    assert sorted(p.name for p in tmp_path.iterdir())==before


def test_deb_stderr_temporary_file_uses_explicit_stage(tmp_path,monkeypatch):
    import io
    stage=tmp_path/'recipe/stage';stage.mkdir(parents=True)
    foreign=tmp_path/'outside';foreign.mkdir();monkeypatch.setenv('TMPDIR',str(foreign))
    observed=[]
    class Child:
        stdout=io.BytesIO(b'payload')
        def wait(self,**kwargs):return 0
        def poll(self):return 0
    def popen(args,**kwargs):
        target=os.readlink('/proc/self/fd/'+str(kwargs['stderr'].fileno()))
        observed.append(Path(target.removesuffix(' (deleted)')).parent)
        return Child()
    monkeypatch.setattr(b.subprocess,'Popen',popen)
    with b.deb_stream(tmp_path/'fixture.deb',stage) as stream:assert stream.read()==b'payload'
    assert observed==[stage] and list(foreign.iterdir())==[]


@pytest.mark.parametrize('mode',[0o644,0o4555])
def test_verify_rejects_mutable_or_privileged_mode_even_with_coherent_seal(tmp_path,monkeypatch,mode):
    root,key=sealed(tmp_path,monkeypatch)
    (root/'payload').chmod(mode)
    manifest=b.shared.canonical(dict(schema=1,recipe_sha256=key,rows=b.manifest_rows(root)))
    identity=dict(schema=1,recipe_sha256=key,manifest_sha256=hashlib.sha256(manifest).hexdigest())
    identity_bytes=b.shared.canonical(identity)
    complete={**identity,'identity_sha256':hashlib.sha256(identity_bytes).hexdigest()}
    for path,body,permissions in ((root/'MANIFEST.json',manifest,0o400),
            (root/'foothold-runtime/identity.json',identity_bytes,0o444),
            (root/'COMPLETE.json',b.shared.canonical(complete),0o400)):
        path.chmod(0o600);path.write_bytes(body);path.chmod(permissions)
    assert b.completion(root,key)['manifest_sha256']==identity['manifest_sha256']
    with pytest.raises(ValueError,match='mutable/privileged payload'):b.verify(root,key)


def test_build_archive_refusal_carries_package_filename_and_member(tmp_path,monkeypatch):
    import io
    import tarfile
    from contextlib import contextmanager
    from deploy import verify_gz_abi
    output=io.BytesIO()
    with tarfile.open(fileobj=output,mode='w') as tar:
        item=tarfile.TarInfo('/outside');item.size=1;tar.addfile(item,io.BytesIO(b'x'))
    monkeypatch.setattr(b,'check_debs',lambda *_:{'fixture':tmp_path/'fixture_1_all.deb'})
    monkeypatch.setattr(verify_gz_abi,'verify',lambda _:None)
    @contextmanager
    def stream(*_):yield io.BytesIO(output.getvalue())
    monkeypatch.setattr(b,'deb_stream',stream)
    with pytest.raises(b.archive.ArchiveError) as caught:b.build({},tmp_path,tmp_path)
    assert 'fixture (fixture_1_all.deb)' in str(caught.value) and '/outside' in str(caught.value)
