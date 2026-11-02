"""Portable episode models and pre-native rejection, entirely offline."""
import asyncio
from dataclasses import replace
from pathlib import Path
from unittest.mock import Mock
import xml.etree.ElementTree as ET

import pytest

from apps.simmgr import launcher
from apps.simmgr.mesh_resources import (MODEL, PROFILE, MESHES, bind_model,
    check_world, episode_model, portable_model, preflight)
from apps.simmgr.native_catalogue import WorldValidationError
from test_native_catalogue import catalogue
from test_repo_worlds import repo
from test_manager import settings


def test_relocation_ignores_old_machine_and_resource_environment(catalogue, tmp_path, monkeypatch):
    root, source, _ = catalogue
    world = tmp_path / 'world.sdf'
    world.write_text('<sdf><world/></sdf>')
    monkeypatch.setenv('GZ_SIM_RESOURCE_PATH', '/unrelated/host/resources')
    before = (source / f'out/{PROFILE}/model/{MODEL}/model.sdf').read_bytes()
    assert preflight(source, world) == dict(schema=1, mesh_files=5, model_uris=5,
                                           build_paths=0, native_started=False)
    model = episode_model(source, tmp_path / 'episode')
    output = model.read_text()
    assert 'file://' not in output and '/build/' not in output
    assert {u.text for u in ET.fromstring(output).findall('.//uri')} == {'meshes/'+n for n in MESHES}
    for name in MESHES:
        copied = model.parent / 'meshes' / name
        assert copied.is_file() and not copied.is_symlink()
        assert copied.read_bytes() == (root.parent / 'gz/model/out/meshes' / name).read_bytes()
    assert (source / f'out/{PROFILE}/model/{MODEL}/model.sdf').read_bytes() == before
    result = bind_model(f'<sdf><world><include><uri>model://{MODEL}</uri>'
                        '<name>go2_v2</name><pose>0 0 .4 0 0 0</pose></include></world></sdf>', model)
    assert ET.fromstring(result).findtext('.//include/name') == 'go2_v2'
    # The final world recursively checks meshes inside the included model.
    (model.parent / 'meshes/trunk.dae').unlink()
    with pytest.raises(WorldValidationError, match='does not resolve'):
        check_world(result, tmp_path)


@pytest.mark.parametrize('value', [
    'file:///build/other/trunk.dae', 'file://host/gz/model/out/meshes/trunk.dae',
    'https://example.invalid/trunk.dae', 'model://trunk.dae',
    'file:///build/gz/model/out/meshes/unknown.dae',
    'file:///build/gz/model/out/meshes/../meshes/trunk.dae',
    'file:///build/gz/model/out/meshes/trunk.dae?x=1',
])
def test_no_basename_guess_network_or_traversal(catalogue, value):
    _, source, _ = catalogue
    path = source / f'out/{PROFILE}/model/{MODEL}/model.sdf'
    tree = ET.parse(path)
    tree.find('.//uri').text = value
    tree.write(path)
    with pytest.raises(WorldValidationError, match='unapproved'):
        portable_model(source)


@pytest.mark.parametrize('failure', ['missing', 'empty', 'escape', 'private-path'])
def test_missing_and_build_path_fail_closed(catalogue, tmp_path, failure):
    root, source, _ = catalogue
    path = root.parent / 'gz/model/out/meshes/trunk.dae'
    if failure == 'missing':
        path.unlink()
    elif failure == 'empty':
        path.write_bytes(b'')
    elif failure == 'escape':
        outside = tmp_path / 'outside.dae'; outside.write_text('outside')
        path.unlink(); path.symlink_to(outside)
    else:
        model = source / f'out/{PROFILE}/model/{MODEL}/model.sdf'
        model.write_text(model.read_text().replace('<model name="go2">',
            '<model name="go2"><plugin filename="/home/private/plugin.so"/>'))
    with pytest.raises(WorldValidationError):
        portable_model(source)


def test_mesh_rejection_precedes_evidence_and_supervisor(repo, catalogue, tmp_path, monkeypatch):
    _, _, world = repo
    root, source, _ = catalogue
    (root.parent / 'gz/model/out/meshes/trunk.dae').unlink()
    monkeypatch.setenv('FH_SIM_RUN', '1')
    monkeypatch.setattr(launcher, 'ROOT', tmp_path)
    forbidden = Mock(side_effect=AssertionError('native operation before mesh rejection'))
    monkeypatch.setattr(launcher, 'startup_preflight', forbidden)
    from apps.simmgr import native_simulation
    monkeypatch.setattr(native_simulation, 'CataloguedSimulation', forbidden)
    cfg = replace(settings(), source=str(source), ros_setup='unused',
                  run_dir=str(tmp_path/'runs/new'), worlds={world.id: world})
    launch = launcher.NativeLauncher(cfg)
    with pytest.raises(WorldValidationError, match='mesh resources invalid'):
        asyncio.run(launch.start_world(world))
    forbidden.assert_not_called()
    assert not (tmp_path/'runs/new').exists()
    assert launch.sim is launch.folder is None and not launch.failed


@pytest.mark.parametrize('uri', ['model://missing', 'https://example.invalid/model', '../outside', 'absent.obj'])
def test_world_uri_cannot_fall_back_to_gazebo_search(tmp_path, uri):
    with pytest.raises(WorldValidationError):
        check_world(f'<sdf><world><uri>{uri}</uri></world></sdf>', tmp_path)
