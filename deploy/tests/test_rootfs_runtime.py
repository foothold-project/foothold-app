"""Runtime audit and namespace transitions; no real systemd/UID/ROS use."""
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock
import pytest
from deploy import rootfs_runtime as r,sim_control as sim
from apps.simmgr import rootfs_environment as env,proc_proof


def data():return dict(recipe_sha256='a'*64,manifest_sha256='b'*64,asset_source='/opt/foothold-sim/assets/'+'c'*64+'/source',
    asset_manifest_sha256='d'*64,identity=dict(uid=23456,gid=23456,
    mesh_targets=['/home/example/0.obj','/home/example/1.obj'],library_aliases={}))


@pytest.fixture
def prepare_audit(tmp_path,monkeypatch):
    audit=tmp_path/'prepare-audit.json'
    path=Mock(side_effect=lambda value:audit if value=='/var/lib/foothold/rootfs-prepare-audit.json' else Path(value))
    monkeypatch.setattr(r,'Path',path)
    action=Mock();atomic=Mock();snapshot=Mock(return_value={'usr':'same'})
    create=Mock(return_value=(17,29));clear=Mock()
    monkeypatch.setattr(r,'prepare_contents',action)
    monkeypatch.setattr(r,'atomic',atomic)
    monkeypatch.setattr(r.build.shared,'snapshot',snapshot)
    monkeypatch.setattr(r.build.shared,'create_install_latch',create)
    monkeypatch.setattr(r.build.shared,'clear_install_latch',clear)
    return SimpleNamespace(input=tmp_path/'input.json',audit=audit,path=path,action=action,
        atomic=atomic,snapshot=snapshot,create=create,clear=clear)


@pytest.mark.parametrize('error',[None,ValueError('prepare rejected'),OSError('private detail')],
    ids=['success','action-value-error','action-os-error'])
def test_prepare_uses_real_audited_callback_and_binds_failure_to_latch(prepare_audit,error,capsys):
    f=prepare_audit
    f.action.side_effect=error
    if error is None:r.prepare(f.input)
    else:
        with pytest.raises(type(error)) as caught:r.prepare(f.input)
        assert caught.value is error
    f.action.assert_called_once_with(f.input)
    f.create.assert_called_once_with()
    assert f.snapshot.call_count==2
    f.path.assert_called_once_with('/var/lib/foothold/rootfs-prepare-audit.json')
    f.atomic.assert_called_once()
    path,body,mode=f.atomic.call_args.args
    expected=dict(before={'usr':'same'},after={'usr':'same'})
    if error is None:
        f.clear.assert_called_once_with((17,29))
        assert 'setup remains fenced; no runtime started' in capsys.readouterr().out
    else:
        expected.update(error_type=type(error).__name__,latch_device=17,latch_inode=29)
        if type(error) is ValueError:expected['reason']=str(error)
        f.clear.assert_not_called()
        assert capsys.readouterr().out==''
    assert path==f.audit and mode==0o400
    assert json.loads(body)==expected and body.endswith('\n')


@pytest.mark.parametrize('symlink',[False,True],ids=['existing-audit','dangling-audit-link'])
def test_prepare_still_refuses_prior_audit_without_overwrite_or_latch_clear(prepare_audit,symlink):
    f=prepare_audit
    if symlink:f.audit.symlink_to(f.audit.parent/'absent')
    else:f.audit.write_text('prior audit')
    with pytest.raises(ValueError,match='prior prepare audit exists; no automatic retry'):r.prepare(f.input)
    f.action.assert_called_once_with(f.input)
    f.atomic.assert_not_called();f.clear.assert_not_called()
    if symlink:assert f.audit.is_symlink()
    else:assert f.audit.read_text()=='prior audit'


def test_namespace_has_exact_uid_rootfs_code_binds_and_no_host_venv_or_libraries():
    value=data();release=Path('/opt/foothold/releases')/('e'*40)
    props=r.properties(value,release)
    assert props['RootDirectory']=='/opt/foothold-sim/rootfs/'+'a'*64
    assert props['PrivateDevices']==props['PrivateUsers']==props['NoNewPrivileges']=='yes'
    assert props['CapabilityBoundingSet']==props['AmbientCapabilities']==''
    readonly,writable=r.bindings(value,release)
    assert len([source for source,target in readonly if '/apps/' in str(source)])==4
    for source,target in readonly+writable:
        assert '.venv' not in str(source) and not str(source).startswith(('/usr','/lib','/bin','/dev','/opt/ros'))
    assert any(target==r.config.STAGE for _,target in readonly)
    assert (Path('/run/systemd/journal/stdout'),'/run/systemd/journal/stdout') in readonly
    assert (Path('/run/systemd/journal/dev-log'),'/dev/log') in readonly
    assert not any(target=='/run/dbus/system_bus_socket' or target=='/var/log/journal' for _,target in readonly)
    assert any(target==r.config.SPEC for _,target in writable)
    assert props['Restart']=='no'
    text=r.dropin(value,release)
    assert 'ExecStart=/usr/lib/systemd/systemd --user' in text and 'PAMName=\n' in text
    assert 'foothold-simmgr.service' not in text  # no default-target native auto-start


def test_rootfs_transition_refuses_before_start_when_manifest_or_validation_fails(monkeypatch):
    value=data();monkeypatch.setattr(r,'load',lambda:value)
    monkeypatch.setattr(r,'identity',lambda value:(23456,23456))
    monkeypatch.setattr(r,'inactive_namespace',lambda value:None)
    def invalid(*args):raise ValueError('manifest unproven')
    monkeypatch.setattr(r.build,'verify',invalid)
    start=Mock()
    with pytest.raises(ValueError,match='manifest unproven'):r.start_pair(start)
    start.assert_not_called()


def test_namespaced_stop_checks_all_four_child_families_before_stopping_parent(monkeypatch):
    value=data();monkeypatch.setattr(r,'load',lambda:value)
    monkeypatch.setattr(r,'identity',lambda value:(23456,23456))
    monkeypatch.setattr(r,'unit_state',lambda unit:dict(ActiveState='active',MainPID='42'))
    marker=Mock();monkeypatch.setattr(r,'create_install_latch',marker)
    monkeypatch.setattr(r,'GUARD',Path('/nonexistent-synthetic-rootfs-guard'))
    host=Mock();monkeypatch.setattr(r,'run',host)
    stop=Mock();userctl=Mock(return_value='fh-simmgr-observer-old.service loaded active\n')
    with pytest.raises(ValueError,match='child units remain'):r.stop_pair(stop,userctl)
    stop.assert_called_once();host.assert_not_called()
    assert set(r.FAMILIES)<=set(userctl.call_args.args)
    marker.assert_called_once()


def test_rootfs_public_helpers_never_use_legacy_cwd_or_host_manager_path(tmp_path,monkeypatch):
    path=tmp_path/'rootfs.json';path.write_text('{}');monkeypatch.setattr(sim,'ROOTFS_CONFIG',path)
    monkeypatch.setattr(sim,'no_latch',lambda:None)
    runtime=SimpleNamespace(stop_pair=Mock(),start_pair=Mock(),load=Mock(return_value={}),attest=Mock(return_value=True))
    monkeypatch.setattr(sim,'rootfs_runtime',lambda:runtime)
    sim.start();sim.stop();assert sim.same_release(42)
    runtime.start_pair.assert_called_once_with(sim.start_manager)
    runtime.stop_pair.assert_called_once_with(sim.stop_manager,sim.userctl)
    runtime.attest.assert_called_once_with(42,{})


def test_rootfs_client_profile_is_bound_and_has_only_internal_software_paths(monkeypatch):
    identity=dict(schema=1,recipe_sha256='a'*64,manifest_sha256='b'*64)
    profile=dict(schema=1,env=dict(env.FIXED,PATH='/usr/bin:/bin',LD_LIBRARY_PATH='/foothold-runtime/lib:/usr/lib/x86_64-linux-gnu',
        PYTHONPATH='/opt/ros/jazzy/lib/python3.12/site-packages',AMENT_PREFIX_PATH='/opt/ros/jazzy',
        GZ_CONFIG_PATH='/opt/ros/jazzy/share/gz',__EGL_VENDOR_LIBRARY_DIRS='/foothold-runtime/egl_vendor.d',
        LIBGL_DRIVERS_PATH='/usr/lib/x86_64-linux-gnu/dri'))
    monkeypatch.setattr(env,'readonly',lambda path:identity if path==env.IDENTITY else profile)
    values={'FH_SIM_ROOTFS_LOCK':'a'*64}
    assert env.load(values)['GALLIUM_DRIVER']=='llvmpipe'
    profile['env']['LD_LIBRARY_PATH']='/opt/foothold-sim/sysroot/'+'c'*64+'/usr/lib'
    with pytest.raises(ValueError,match='escapes'):env.load(values)
    with pytest.raises(ValueError,match='mixed'):env.load({**values,'FH_SIM_SYSROOT_PROFILE':'legacy'})


def test_rootfs_admission_requires_host_proof_before_opening_guard(tmp_path,monkeypatch):
    from apps.simmgr.deploy_guard import DeploymentLease
    monkeypatch.setenv('FH_SIM_ROOTFS_LOCK','a'*64)
    def denied():raise RuntimeError('host package latch unproven')
    monkeypatch.setattr(proc_proof,'processes',denied)
    with pytest.raises(RuntimeError,match='host package'):DeploymentLease(tmp_path).acquire()
    assert list(tmp_path.iterdir())==[]


def test_failed_root_attestation_retains_setup_marker_without_starting_manager(tmp_path,monkeypatch):
    value=data();monkeypatch.setattr(r,'load',lambda:value)
    monkeypatch.setattr(r,'identity',lambda value:(23456,23456))
    for name in ('inactive_namespace','assets','private_settings','validated'):
        monkeypatch.setattr(r,name,lambda *_:None)
    monkeypatch.setattr(r.build,'verify',lambda *_:None)
    release=Path('/opt/foothold/releases')/('e'*40)
    monkeypatch.setattr(r,'CURRENT',SimpleNamespace(resolve=lambda **kwargs:release))
    read=Path.read_text
    monkeypatch.setattr(Path,'read_text',lambda path,*args,**kwargs:'e'*40+'\n' if path==release/'COMMIT' else read(path,*args,**kwargs))
    monkeypatch.setattr(r,'GUARD',tmp_path)
    def create(path):path.write_text('pending');return (1,2)
    monkeypatch.setattr(r,'create_install_latch',create)
    clear=Mock();monkeypatch.setattr(r,'clear_install_latch',clear)
    monkeypatch.setattr(r,'bind_namespace',Mock())
    monkeypatch.setattr(r,'run',Mock(return_value=''))
    monkeypatch.setattr(r,'unit_state',lambda unit:dict(MainPID='42'))
    def foreign(*args):raise ValueError('foreign RootDirectory')
    monkeypatch.setattr(r,'attest',foreign)
    start=Mock()
    with pytest.raises(ValueError,match='foreign RootDirectory'):r.start_pair(start)
    assert (tmp_path/'setup-unproven').read_text()=='pending'
    start.assert_not_called();clear.assert_not_called()


def test_software_preflight_never_invokes_host_nvidia_shim(tmp_path,monkeypatch):
    import sys
    monkeypatch.syspath_prepend(str(Path(__file__).resolve().parents[2]/'apps/agent/tools/sim'))
    import isolation
    monkeypatch.setenv('FH_SIM_ROOTFS_LOCK','a'*64)
    monkeypatch.setattr(isolation,'processes',lambda:([],0))
    monkeypatch.setattr(isolation,'dds_ports',lambda:([],''))
    monkeypatch.setattr(isolation,'resources',lambda:dict(mem_available_mib=4000,load1=1))
    monkeypatch.setattr(env,'binding',lambda *_:{'recipe_sha256':'a'*64})
    monkeypatch.setattr(env,'load',lambda *_:{'GALLIUM_DRIVER':'llvmpipe'})
    calls=[]
    def command(*args):
        calls.append(args)
        assert args[0]!='nvidia-smi'
        return 'synthetic'
    monkeypatch.setattr(isolation,'command',command)
    isolation.preflight(tmp_path)
    assert 'CPU llvmpipe' in (tmp_path/'gpu-before.txt').read_text()
    def unproven(*args):raise ValueError('rootfs identity absent')
    monkeypatch.setattr(env,'binding',unproven)
    with pytest.raises(ValueError,match='identity absent'):isolation.preflight(tmp_path)


@pytest.mark.parametrize('version,origin,accepted',[
    ('5.1.0','/opt/foothold-sim/python-vendor/trimesh/__init__.py',True),
    ('5.0.0','/opt/foothold-sim/python-vendor/trimesh/__init__.py',False),
    ('5.1.0','/usr/lib/python3/dist-packages/trimesh/__init__.py',False)])
def test_probe_checks_native_geometry_pin_and_origin(version,origin,accepted,monkeypatch):
    from deploy import rootfs_probe
    import sys
    monkeypatch.delitem(sys.modules,'trimesh',raising=False)
    monkeypatch.setattr(sys,'path',list(sys.path))
    monkeypatch.setattr(rootfs_probe.importlib,'import_module',lambda name:SimpleNamespace(__version__=version,__file__=origin))
    if accepted:rootfs_probe.native_geometry()
    else:
        with pytest.raises(ValueError,match='geometry version/origin'):rootfs_probe.native_geometry()


def test_probe_pins_runtime_dir_dependency_and_never_starts_user_manager(tmp_path,monkeypatch):
    import json
    value=data();value.update(plugin_rel='gz/plugin.so',policy_rel='policy.npz')
    for name in ('inactive_namespace','assets','private_settings'):
        monkeypatch.setattr(r,name,lambda *_:None)
    monkeypatch.setattr(r,'load',lambda:value)
    monkeypatch.setattr(r,'identity',lambda value:(23456,23456))
    monkeypatch.setattr(r.build,'verify',lambda *_:None)
    monkeypatch.setattr(r,'rootfs',lambda value:tmp_path)
    monkeypatch.setattr(r,'VALIDATION',tmp_path/'validation.json')
    monkeypatch.setattr(r,'CURRENT',SimpleNamespace(resolve=lambda **kwargs:Path('/opt/foothold/releases')/('e'*40)))
    result=dict(recipe_sha256=value['recipe_sha256'],manifest_sha256=value['manifest_sha256'],
        llvmpipe=True,egl_render_readback=True,python_closure=True,native_abi=True,root_attested=True)
    calls=[]
    def run(args):
        calls.append(args)
        return json.dumps(result) if args[0]=='systemd-run' else ''
    monkeypatch.setattr(r,'run',run);saved=Mock();monkeypatch.setattr(r,'atomic',saved)
    r.probe()
    command=next(args for args in calls if args[0]=='systemd-run')
    assert '--property=Requires=user-runtime-dir@23456.service' in command
    assert '--property=After=user-runtime-dir@23456.service' in command
    assert not any('user@23456.service' in arg for args in calls for arg in args)
    saved.assert_called_once()
