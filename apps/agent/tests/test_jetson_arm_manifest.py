"""Synthetic ELF and local metadata only: never load SDK/DDS or join a domain."""
import hashlib
import json
import os
from pathlib import Path
from types import SimpleNamespace

import pytest

from foothold_agent.go2_direct import arm_provenance as arm, preflight
from foothold_agent.setup.view import preflight_message


def elf(machine=183):
    data = bytearray(64)
    data[:7] = b'\x7fELF\x02\x01\x01'
    data[18:20] = machine.to_bytes(2, 'little')
    return bytes(data)


@pytest.fixture
def installed(tmp_path, monkeypatch):
    home = tmp_path/'home'
    root = home/'foothold-robot'
    site = root/'venv/lib/python3.10/site-packages'
    monkeypatch.setenv('HOME', str(home))
    monkeypatch.setattr(arm.sys, 'prefix', str(root/'venv'))
    monkeypatch.setattr(arm.sys, 'version_info', (3, 10, 12))
    monkeypatch.setattr(preflight.platform, 'machine', lambda: 'aarch64')
    monkeypatch.setattr(preflight.platform, 'system', lambda: 'Linux')
    monkeypatch.setattr(preflight, 'INHERITED_LOADER_OVERRIDE', False)
    for key in arm.OVERRIDES:
        monkeypatch.delenv(key, raising=False)
    for name, data in {
        'dds/lib/libddsc.so.0.10.2': elf(),
        'venv/lib/python3.10/site-packages/cyclonedds/_clayer.cpython-310-aarch64-linux-gnu.so': elf(),
        'venv/lib/python3.10/site-packages/cyclonedds/__library__.py': b'in_wheel = True\n',
        'venv/lib/python3.10/site-packages/unitree_sdk2py/__init__.py': b'# fake SDK, never imported\n',
    }.items():
        path = root/name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
    (root/'dds/lib/libddsc.so').symlink_to('libddsc.so.0.10.2')
    # Real pinned archives are not needed by these synthetic fixture tests.
    hashes = {}
    for name in arm.SOURCE_HASHES:
        path = root/'bundle/sources'/name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(('source fixture '+name).encode())
        hashes[name] = arm.digest(path)
    monkeypatch.setattr(arm, 'SOURCE_HASHES', hashes)
    files = {'cyclonedds': ['cyclonedds/_clayer.cpython-310-aarch64-linux-gnu.so',
                           'cyclonedds/__library__.py'],
             'unitree-sdk2py': ['unitree_sdk2py/__init__.py']}
    monkeypatch.setattr(arm.metadata, 'version', lambda name: preflight.PINNED[name])
    monkeypatch.setattr(arm.metadata, 'distribution', lambda name:
        SimpleNamespace(files=files[name], locate_file=lambda name: site/name))
    receipt = dict(schema=1, sources=hashes, machine='aarch64', built_at='fixture', tools={'gcc': 'fixture'},
                   files={name: dict(sha256=arm.digest(root/name),
                        **({'machine': 'aarch64'} if '.so' in Path(name).name else {}))
                        for name in arm.installed_files(root)})
    manifest = root/'dds-build-manifest.json'
    manifest.write_text(json.dumps(receipt))
    manifest.chmod(0o600)
    return root, receipt


def save(root, receipt):
    (root/'dds-build-manifest.json').write_text(json.dumps(receipt))


def test_verified_arm_is_installation_ready_but_never_motion_ready(installed):
    root, _ = installed
    report = preflight.inspect(root/'bundle/wheels')
    assert report['installation_ready'] and report['arm_manifest_verified']
    assert report['sdk_commit_verified']
    assert not report['sdk_imported'] and not report['robot_connected']
    assert not report['motion_enabled'] and not report['field_nic_serial_approval_verified']


@pytest.mark.parametrize('damage', ['source-hash', 'source-bytes', 'so-hash', 'elf-x86', 'elf-not-elf',
                                   'manifest-missing', 'manifest-mode', 'omitted-so', 'python-code',
                                   'extra-so', 'extra-binding-so', 'symlink', 'loader-alias', 'schema', 'malformed', 'bad-pins'])
def test_damaged_arm_receipt_blocks_in_korean(installed, damage, monkeypatch):
    root, receipt = installed
    lib = root/'dds/lib/libddsc.so.0.10.2'
    if damage == 'source-hash':
        receipt['sources'] = {**receipt['sources'], 'cyclonedds-c.tar.gz': '0'*64}
        save(root, receipt)
    elif damage == 'source-bytes':
        (root/'bundle/sources/cyclonedds-c.tar.gz').write_bytes(b'tampered')
    elif damage == 'so-hash':
        lib.write_bytes(elf()+b'tampered')
    elif damage in ('elf-x86', 'elf-not-elf'):
        lib.write_bytes(elf(62) if damage == 'elf-x86' else b'not an ELF')
        receipt['files'][str(lib.relative_to(root))]['sha256'] = arm.digest(lib)
        save(root, receipt)
    elif damage == 'manifest-missing':
        (root/'dds-build-manifest.json').unlink()
    elif damage == 'manifest-mode':
        (root/'dds-build-manifest.json').chmod(0o644)
    elif damage == 'omitted-so':
        del receipt['files'][str(lib.relative_to(root))]
        save(root, receipt)
    elif damage == 'python-code':
        (root/'venv/lib/python3.10/site-packages/cyclonedds/__library__.py').write_text('changed')
    elif damage == 'extra-so':
        (lib.parent/'extra.so').write_bytes(elf())
    elif damage == 'extra-binding-so':
        (root/'venv/lib/python3.10/site-packages/cyclonedds/extra.so').write_bytes(elf())
    elif damage == 'symlink':
        outside = root.parent/'outside.so'
        lib.rename(outside)
        lib.symlink_to(outside)
    elif damage == 'loader-alias':
        alias = lib.parent/'libddsc.so'
        alias.unlink()
        alias.symlink_to('missing.so')
    elif damage == 'schema':
        receipt['schema'] = 99
        save(root, receipt)
    elif damage == 'malformed':
        (root/'dds-build-manifest.json').write_text('not json')
    elif damage == 'bad-pins':
        monkeypatch.setattr(arm.metadata, 'version', lambda name: 'wrong')
    report = preflight.inspect(root/'bundle/wheels')
    assert not report['installation_ready']
    assert any(issue.startswith('Jetson:') for issue in report['issues'])
    assert '조종 차단' in preflight_message(report)


@pytest.mark.parametrize('variable', [*arm.OVERRIDES, 'FH_ALLOW_ARM_DDS', 'FH_SKIP_PREFLIGHT'])
def test_environment_cannot_bypass_missing_manifest(installed, variable, monkeypatch):
    root, _ = installed
    (root/'dds-build-manifest.json').unlink()
    monkeypatch.setenv(variable, '1')
    report = preflight.inspect(root/'bundle/wheels')
    assert not report['installation_ready'] and not report['motion_enabled']


@pytest.mark.parametrize('variable', arm.OVERRIDES)
def test_loader_override_blocks_even_good_receipt(installed, variable, monkeypatch):
    root, _ = installed
    monkeypatch.setenv(variable, '1')
    assert not preflight.inspect(root)['installation_ready']


def test_inherited_loader_override_remains_blocked(installed, monkeypatch):
    root, _ = installed
    monkeypatch.setattr(preflight, 'INHERITED_LOADER_OVERRIDE', True)
    assert not preflight.inspect(root)['installation_ready']
