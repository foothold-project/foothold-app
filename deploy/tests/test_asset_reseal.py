"""Real seal/locks/pair rollback; synthetic Go2 bytes and native proof only."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from deploy import asset_reseal as a
from deploy import rootfs_runtime as r


@pytest.fixture
def reseal(tmp_path, monkeypatch):
    # Model root ownership only, as the other privileged filesystem tests do.
    # Actual file types, modes, SHA, no-follow opens and flock remain real.
    real_lstat, real_fstat = Path.lstat, os.fstat
    ancestors = {tmp_path, *tmp_path.parents}
    special = set()
    def owned(info, path=None):
        values = list(info)
        values[4] = values[5] = 23456 if info.st_ino in special else 0
        if path in ancestors:
            values[0] &= ~0o022
        return os.stat_result(values)
    monkeypatch.setattr(Path, 'lstat', lambda p, *args, **kw: owned(real_lstat(p, *args, **kw), p))
    monkeypatch.setattr(os, 'fstat', lambda *args, **kw: owned(real_fstat(*args, **kw)))
    monkeypatch.setattr(os, 'geteuid', lambda: 0)
    assets = tmp_path / 'assets'; assets.mkdir(mode=0o755)
    audits = tmp_path / 'transactions'
    guard = tmp_path / 'guard'; guard.mkdir(mode=0o700)
    (guard / 'state').mkdir(mode=0o700)
    (guard / 'deploy.lock').touch(mode=0o660)
    lock = tmp_path / 'deploy.lock'; lock.touch(mode=0o600)
    monkeypatch.setattr(a, 'ASSETS', assets); monkeypatch.setattr(a, 'AUDITS', audits)
    monkeypatch.setattr(a, 'DEPLOY_LOCK', lock); monkeypatch.setattr(a, 'PACKAGE', tmp_path / 'package')
    monkeypatch.setattr(r, 'GUARD', guard)
    config = tmp_path / 'config.json'; validation = tmp_path / 'validation.json'
    monkeypatch.setattr(r, 'CONFIG', config); monkeypatch.setattr(r, 'VALIDATION', validation)
    old_root = assets / ('a' * 64); old_root.mkdir()
    source = old_root / 'source'; source.mkdir()
    (source / 'unchanged.txt').write_bytes(b'original immutable payload')
    (source / 'unchanged.txt').chmod(0o444); source.chmod(0o555)
    old_manifest = a.encode(dict(schema=1, rows=r.shared.tree_manifest(old_root)))
    (old_root / 'MANIFEST.json').write_bytes(old_manifest)
    (old_root / 'MANIFEST.json').chmod(0o400); old_root.chmod(0o555)
    data = dict(schema=1, recipe_sha256='b'*64, manifest_sha256='c'*64,
                asset_source=str(source), asset_manifest_sha256=a.digest(old_manifest),
                plugin_rel='unchanged.txt', policy_rel='unchanged.txt', setup_identity=[17,29])
    def proof(value):
        return dict(recipe_sha256=value['recipe_sha256'], manifest_sha256=value['manifest_sha256'],
                    asset_manifest_sha256=value['asset_manifest_sha256'], llvmpipe=True,
                    egl_render_readback=True, python_closure=True, native_abi=True, root_attested=True)
    config.write_bytes(a.encode(data)); config.chmod(0o600)
    validation.write_bytes(a.encode(proof(data))); validation.chmod(0o400)
    def load():
        return dict(json.loads(config.read_bytes()), identity={'uid':23456,'gid':23456})
    monkeypatch.setattr(r, 'load', load)
    inactive = Mock(); native_proof = Mock(side_effect=proof); mesh = Mock()
    monkeypatch.setattr(r, 'inactive_namespace', inactive)
    monkeypatch.setattr(r, 'probe_evidence', native_proof); monkeypatch.setattr(r, 'mesh_preflight', mesh)
    monkeypatch.setattr(r, 'CURRENT', tmp_path)
    def verified(value):
        src = Path(value['asset_source']); parent = src.parent
        assert parent.parent == assets and len(parent.name) == 64
        raw = (parent / 'MANIFEST.json').read_bytes()
        if a.digest(raw) != value['asset_manifest_sha256']:
            raise ValueError('synthetic asset manifest SHA differs')
        rows = [x for x in r.shared.tree_manifest(parent) if x['path'] != 'MANIFEST.json']
        if json.loads(raw) != {'schema':1,'rows':rows} or any(x['mode'] & 0o222 for x in rows):
            raise ValueError('synthetic asset changed')
        return src
    monkeypatch.setattr(r, 'assets', verified)
    inputs = tmp_path / 'private-input'; inputs.mkdir(mode=0o700)
    names = ['trunk.dae','hip.dae','thigh.dae','thigh_mirror.dae','calf.dae',
             'LICENSE-Unitree-BSD-3-Clause.txt','LICENSE-quadruped-Apache-2.0.txt']
    files = {name: ('synthetic Go2: ' + name).encode() for name in names}
    pins = dict(schema=1, files={n:dict(size=len(v),sha256=a.digest(v)) for n,v in files.items()})
    for name, body in files.items():
        (inputs/name).write_bytes(body); (inputs/name).chmod(0o600)
    (inputs/'INPUT.json').write_bytes(a.encode(pins)); (inputs/'INPUT.json').chmod(0o600)
    pins_path = tmp_path/'pins.json'; pins_path.write_bytes(a.encode(pins)); monkeypatch.setattr(a,'PINS',pins_path)
    before = {p:p.read_bytes() for p in (config,validation,old_root/'MANIFEST.json',source/'unchanged.txt')}
    args = (inputs,a.digest((inputs/'INPUT.json').read_bytes()),a.digest(before[config]),a.digest(before[validation]))
    return SimpleNamespace(config=config,validation=validation,assets=assets,old_root=old_root,guard=guard,
                           audits=audits,inputs=inputs,args=args,before=before,inactive=inactive,
                           proof=native_proof,mesh=mesh,special=special,files=files)


def test_complete_reseal_preserves_old_tree_and_can_restore_binding_pair(reseal):
    f=reseal; result=a.apply(*f.args)
    assert result['phase']=='switched' and result['namespace_started'] is False
    new=json.loads(f.config.read_bytes()); proof=json.loads(f.validation.read_bytes())
    assert proof['asset_manifest_sha256']==new['asset_manifest_sha256']
    assert f.proof.call_count==1 and f.mesh.call_count==2
    for p in (f.old_root/'MANIFEST.json',f.old_root/'source/unchanged.txt'):
        assert p.read_bytes()==f.before[p]
    for name,body in f.files.items():
        assert (Path(new['asset_source']).parent/a.MESH_REL/name).read_bytes()==body
    transaction=f.audits/result['transaction']
    assert (transaction/'old-config.json').stat().st_mode&0o777==0o600
    assert a.restore(result['transaction'])['phase']=='restored'
    assert f.config.read_bytes()==f.before[f.config]
    assert f.validation.read_bytes()==f.before[f.validation]
    assert Path(new['asset_source']).is_dir()  # Retained for audit, never erased.


@pytest.mark.parametrize('marker',['state/unproven','setup-unproven','state/unproven.release-pending','setup-unproven.release-pending','package'])
def test_existing_fences_block_before_copy_or_probe(reseal,marker):
    f=reseal; p=a.PACKAGE if marker=='package' else f.guard/marker; p.touch()
    with pytest.raises(ValueError,match='fence'):a.apply(*f.args)
    assert not f.audits.exists() and f.config.read_bytes()==f.before[f.config]
    f.proof.assert_not_called()


def test_unknown_live_namespace_cannot_reseal(reseal):
    f=reseal; f.inactive.side_effect=ValueError('live UID')
    with pytest.raises(ValueError,match='live UID'):a.apply(*f.args)
    assert not f.audits.exists()
    f.proof.assert_not_called()


@pytest.mark.parametrize('defect',['wrong_robot','different_bytes','symlink','hardlink','world_readable'])
def test_private_source_pins_and_nofollow_before_mutation(reseal,defect):
    f=reseal; path=f.inputs/'hip.dae'
    if defect=='wrong_robot':
        doc=json.loads((f.inputs/'INPUT.json').read_bytes());doc['files']['a1.dae']=doc['files'].pop('hip.dae')
        (f.inputs/'INPUT.json').write_bytes(a.encode(doc));f.args=(f.inputs,a.digest((f.inputs/'INPUT.json').read_bytes()),*f.args[2:])
    elif defect=='different_bytes':path.write_bytes(b'other robot')
    elif defect=='symlink':
        target=f.inputs.parent/'copy';target.write_bytes(path.read_bytes());target.chmod(0o600)
        path.unlink();path.symlink_to(target)
    elif defect=='hardlink':os.link(path,f.inputs.parent/'copy')
    else:path.chmod(0o644)
    with pytest.raises((ValueError,OSError)):a.apply(*f.args)
    assert f.config.read_bytes()==f.before[f.config] and not f.audits.exists()


def test_partial_probe_never_updates_config_or_reuses_candidate(reseal):
    f=reseal
    def incomplete(value):
        return dict(recipe_sha256=value['recipe_sha256'],manifest_sha256=value['manifest_sha256'],
                    asset_manifest_sha256=value['asset_manifest_sha256'],native_abi=False)
    f.proof.side_effect=incomplete
    with pytest.raises(ValueError,match='validation'):a.apply(*f.args)
    assert f.config.read_bytes()==f.before[f.config] and f.validation.read_bytes()==f.before[f.validation]
    records=list(f.audits.glob('*/STATE.json'));assert len(records)==1
    assert json.loads(records[0].read_bytes())['phase']=='preparation-failed'
    with pytest.raises(FileExistsError):a.apply(*f.args)
    assert f.proof.call_count==1


def test_second_atomic_replace_failure_restores_both_original_documents(reseal,monkeypatch):
    f=reseal; replace=a.replace_bytes; failed=[]
    def fault(path,body,mode):
        if path==f.validation and body!=f.before[path] and not failed:
            failed.append(True);raise OSError('synthetic replacement failure')
        return replace(path,body,mode)
    monkeypatch.setattr(a,'replace_bytes',fault)
    with pytest.raises(OSError):a.apply(*f.args)
    assert failed and f.config.read_bytes()==f.before[f.config]
    assert f.validation.read_bytes()==f.before[f.validation]
    assert json.loads(next(f.audits.glob('*/STATE.json')).read_bytes())['phase']=='restored'


def test_after_publish_fsync_failure_also_restores_pair(reseal,monkeypatch):
    f=reseal; replace=a.replace_bytes; failed=[]
    def fault(path,body,mode):
        replace(path,body,mode)
        if path==f.config and body!=f.before[path] and not failed:
            failed.append(True);raise OSError('synthetic directory fsync failure')
    monkeypatch.setattr(a,'replace_bytes',fault)
    with pytest.raises(OSError):a.apply(*f.args)
    assert failed and f.config.read_bytes()==f.before[f.config]
    assert f.validation.read_bytes()==f.before[f.validation]


def test_crash_between_pair_writes_is_recoverable_with_preserved_episode_fence(reseal):
    f=reseal; result=a.apply(*f.args); tx=f.audits/result['transaction']
    a.replace_bytes(f.validation,f.before[f.validation],0o400)  # Simulated crash/mixed pair.
    marker=f.guard/'state/unproven';marker.write_bytes(b'failed episode');marker.chmod(0o600);f.special.add(marker.stat().st_ino)
    before=(marker.stat().st_ino,marker.read_bytes())
    assert a.restore(result['transaction'])['phase']=='restored'
    assert (marker.stat().st_ino,marker.read_bytes())==before
    assert f.config.read_bytes()==f.before[f.config] and f.validation.read_bytes()==f.before[f.validation]


def test_restore_never_overwrites_an_unrelated_runtime_change(reseal):
    f=reseal; result=a.apply(*f.args)
    doc=json.loads(f.config.read_bytes());doc['plugin_rel']='unrelated'
    a.replace_bytes(f.config,a.encode(doc),0o600);before=f.config.read_bytes()
    with pytest.raises(ValueError,match='another transaction'):a.restore(result['transaction'])
    assert f.config.read_bytes()==before


def test_held_session_lock_is_not_bypassed_or_replaced(reseal):
    f=reseal;p=f.guard/'deploy.lock';ino=p.stat().st_ino
    with p.open('rb') as held:
        fcntl.flock(held,fcntl.LOCK_SH|fcntl.LOCK_NB)
        with pytest.raises(BlockingIOError):a.apply(*f.args)
    assert p.stat().st_ino==ino and not f.audits.exists()


def test_prepare_guard_is_unchanged_and_not_a_reseal_entrypoint(tmp_path,monkeypatch):
    monkeypatch.setattr(r,'CONFIG',tmp_path/'existing-config');r.CONFIG.touch()
    with pytest.raises(ValueError,match='already provisioned'):r.prepare_contents(tmp_path/'unused')


def test_mesh_preflight_failure_cannot_reuse_old_native_validation(reseal):
    f=reseal; f.mesh.side_effect=ValueError('unresolved mesh')
    with pytest.raises(ValueError,match='unresolved mesh'):a.apply(*f.args)
    f.proof.assert_not_called()
    assert f.config.read_bytes()==f.before[f.config]
    assert f.validation.read_bytes()==f.before[f.validation]
    state=json.loads(next(f.audits.glob('*/STATE.json')).read_bytes())
    assert state['phase']=='preparation-failed' and state['operation_stage']=='mesh-preflight'


def test_changed_old_seal_never_publishes_a_new_runtime_pair(reseal):
    f=reseal;p=f.old_root/'source/unchanged.txt';p.chmod(0o644);p.write_bytes(b'corruption');p.chmod(0o444)
    with pytest.raises(ValueError,match='asset changed'):a.apply(*f.args)
    f.proof.assert_not_called()
    assert f.config.read_bytes()==f.before[f.config] and f.validation.read_bytes()==f.before[f.validation]


@pytest.mark.parametrize('document',['old-config','new-validation'])
def test_transaction_document_tamper_refuses_restore(reseal,document):
    f=reseal; result=a.apply(*f.args);tx=f.audits/result['transaction']
    before=(f.config.read_bytes(),f.validation.read_bytes())
    a.replace_bytes(tx/(document+'.json'),b'{}',0o600 if document.endswith('config') else 0o400)
    with pytest.raises(ValueError,match='document SHA'):a.restore(result['transaction'])
    assert (f.config.read_bytes(),f.validation.read_bytes())==before


def test_restore_does_not_bypass_unproven_setup_transaction(reseal):
    f=reseal; result=a.apply(*f.args);marker=f.guard/'setup-unproven';marker.touch()
    before=f.config.read_bytes()
    with pytest.raises(ValueError,match='fence'):a.restore(result['transaction'])
    assert marker.exists() and f.config.read_bytes()==before


def test_new_validation_is_asset_bound_not_just_success_booleans(reseal):
    f=reseal; real=f.proof.side_effect
    def stale(data):
        value=real(data);value['asset_manifest_sha256']='0'*64;return value
    f.proof.side_effect=stale
    with pytest.raises(ValueError,match='validation'):a.apply(*f.args)
    assert f.config.read_bytes()==f.before[f.config] and f.validation.read_bytes()==f.before[f.validation]


def test_initial_probe_still_refuses_existing_validation_without_mutation(tmp_path,monkeypatch):
    path=tmp_path/'validation';path.touch();monkeypatch.setattr(r,'VALIDATION',path)
    monkeypatch.setattr(r,'load',lambda:{})
    proof=Mock();run=Mock();monkeypatch.setattr(r,'probe_evidence',proof);monkeypatch.setattr(r,'run',run)
    with pytest.raises(ValueError,match='validation already exists'):r.probe()
    proof.assert_not_called();run.assert_not_called()
