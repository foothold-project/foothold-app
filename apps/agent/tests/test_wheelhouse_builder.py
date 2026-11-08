"""Bundle construction tests: local archives/wheels, no network or installation."""
import hashlib
import io
import tarfile
import zipfile

import pytest

from test_jetson_preparation import load, preflight

builder = load('build_wheelhouse')
approval = load('make_approval')


def test_plan_does_not_create_output_or_run_commands(tmp_path, monkeypatch):
    def forbidden(*args, **kwargs):
        raise AssertionError('plan must be read-only')
    monkeypatch.setattr(builder.subprocess, 'run', forbidden)
    monkeypatch.setattr(builder.urllib.request, 'urlopen', forbidden)
    output = tmp_path/'runs/bundle'
    assert builder.main(['--output', str(output), '--python-version', '3.10']) == 0
    assert not output.exists()
    assert builder.main(['--output', str(tmp_path/'outside'), '--python-version', '3.10']) == 2


def test_download_environment_disables_inherited_pip_options(tmp_path, monkeypatch):
    monkeypatch.setenv('PIP_TARGET', '/not/the/bundle')
    monkeypatch.setenv('PYTHONPATH', '/not/the/source')
    env = builder.clean_env(tmp_path)
    assert 'PIP_TARGET' not in env and 'PYTHONPATH' not in env
    assert env['PIP_CONFIG_FILE'] == builder.os.devnull
    assert env['TMPDIR'] == str(tmp_path/'tmp')


@pytest.mark.parametrize('name,link', [('../escape', False), ('/absolute', False), ('sdk/link', True)])
def test_source_archive_rejects_traversal_and_links(tmp_path, name, link):
    archive = tmp_path/'sdk.tar.gz'
    with tarfile.open(archive, 'w:gz') as source:
        member = tarfile.TarInfo(name)
        if link:
            member.type = tarfile.SYMTYPE
            member.linkname = '/outside'
            source.addfile(member)
        else:
            member.size = 1
            source.addfile(member, io.BytesIO(b'x'))
    with pytest.raises(ValueError):
        builder.unpack_source(archive, tmp_path/'source')
    assert not (tmp_path/'escape').exists()


def test_requirements_are_exact_wheel_metadata_and_digest(tmp_path):
    path = tmp_path/'example-1.2.3-py3-none-any.whl'
    with zipfile.ZipFile(path, 'w') as wheel:
        wheel.writestr('example-1.2.3.dist-info/METADATA', 'Name: example\nVersion: 1.2.3\n')
    assert builder.lock_wheels(tmp_path) == []
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    assert (tmp_path/'requirements.txt').read_text() == f'example==1.2.3 --hash=sha256:{digest}\n'


def test_dependency_markers_use_target_python_not_preparing_host(tmp_path):
    path = tmp_path/'example-1.2.3-py3-none-any.whl'
    with zipfile.ZipFile(path, 'w') as wheel:
        wheel.writestr('example-1.2.3.dist-info/METADATA',
            'Name: example\nVersion: 1.2.3\nRequires-Dist: exceptiongroup>=1; python_version < "3.11"\n'
            'Requires-Dist: windows-only; sys_platform == "win32"\n')
    assert builder.target_dependencies(tmp_path, '3.10') == ['exceptiongroup>=1']
    assert builder.target_dependencies(tmp_path, '3.12') == []


def test_supplied_cyclonedds_requires_reviewed_hash_pin_and_arm64(tmp_path):
    path = tmp_path/'cyclonedds-0.10.2-cp310-cp310-manylinux2014_aarch64.whl'
    with zipfile.ZipFile(path, 'w') as wheel:
        wheel.writestr('cyclonedds-0.10.2.dist-info/METADATA', 'Name: cyclonedds\nVersion: 0.10.2\n')
        wheel.writestr('cyclonedds/binding.so', b'fixture only; full ELF audit still required')
    assert builder.provided_cyclonedds(path, builder.digest(path)) == path
    with pytest.raises(ValueError):
        builder.provided_cyclonedds(path, '0'*64)
    path.rename(tmp_path/'cyclonedds-0.10.2-cp310-cp310-linux_x86_64.whl')
    with pytest.raises(ValueError):
        other = tmp_path/'cyclonedds-0.10.2-cp310-cp310-linux_x86_64.whl'
        builder.provided_cyclonedds(other, builder.digest(other))


def test_preflight_reports_missing_external_dds_without_loading_it(tmp_path, monkeypatch):
    from types import SimpleNamespace
    dist = SimpleNamespace(files=['binding.so'], locate_file=lambda p: tmp_path/p)
    monkeypatch.setattr(preflight.importlib.metadata, 'distribution', lambda _: dist)
    monkeypatch.setattr(preflight.subprocess, 'run', lambda *a, **kw:
                        SimpleNamespace(stdout='(NEEDED) Shared library: [libddsc.so.0]\n'))
    monkeypatch.setattr(preflight, 'find_library', lambda _: None)
    result = preflight.dds_dependencies()
    assert not result['metadata_complete'] and not result['loaded']
    assert result['missing'] == ['libddsc.so.0']
    monkeypatch.setattr(preflight, 'find_library', lambda _: 'libddsc.so.0')
    assert preflight.dds_dependencies()['metadata_complete']


def test_preflight_rejects_missing_inspection_tool(monkeypatch):
    from types import SimpleNamespace
    monkeypatch.setattr(preflight.importlib.metadata, 'distribution', lambda _:
                        SimpleNamespace(files=['binding.so'], locate_file=preflight.Path))
    def missing(*a, **kw):
        raise FileNotFoundError()
    monkeypatch.setattr(preflight.subprocess, 'run', missing)
    assert not preflight.dds_dependencies()['metadata_complete']


def test_marker_is_private_expiring_and_does_not_overwrite(tmp_path):
    from foothold_agent.go2_direct.approval import validate
    tmp_path.chmod(0o700)
    path = tmp_path/'field.json'
    argv = ['--output', str(path), '--nic', 'fake0', '--serial', '1234-5678',
            '--approve-field-motion']
    assert approval.main(argv) == 0
    assert path.stat().st_mode & 0o777 == 0o600
    result = validate(dict(FH_GO2_DIRECT_ENABLED='1', FH_GO2_DIRECT_NIC='fake0',
                           FH_GO2_FIELD_APPROVAL=str(path)))
    assert result.robot_serial == '1234-5678'
    before = path.read_bytes()
    assert approval.main(argv) == 2 and path.read_bytes() == before
    tmp_path.chmod(0o755)
    assert approval.main([*argv[:2], *argv[2:]]) == 2
