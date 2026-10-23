"""Synthetic private catalogue; no building/maps or processes are included."""
from copy import deepcopy
import json
from uuid import UUID

import pytest

from apps.simmgr.connected_assets import connected_files, digest, verify_bindings


@pytest.fixture
def connected_catalogue(tmp_path):
    root = tmp_path/'native'; root.mkdir()
    (root/'connected').mkdir()
    worlds, sdf_hashes, bindings = {}, {}, []
    for i, floor in enumerate(('l1', 'l2'), 1):
        d = root/floor; d.mkdir()
        for name, data in [('world.sdf', '<sdf>synthetic '+floor+'</sdf>'), ('heights.npz', 'synthetic height')]:
            (d/name).write_text(data)
        (d/'map.pgm').write_bytes(b'P5\n2 2\n255\n'+b'\xfe'*4)
        (d/'map.yaml').write_text('image: map.pgm\nresolution: 0.05\norigin: [-20, -14, 0]\nnegate: 0\noccupied_thresh: 0.65\nfree_thresh: 0.196\nmode: trinary\n')
        meta = dict(world_id='v5_building', building_id='v5', floor_id=floor, map_frame='map',
            map_source='gt_raster', epoch=None, sha256_pgm=digest(d/'map.pgm'), source_sha256=digest(d/'map.pgm'),
            resolution=.05, origin=[-20, -14, 0], width=2, height=2, map_version='gt-20261012')
        (d/'meta.json').write_text(json.dumps(meta))
        worlds['v5_building/'+floor] = dict(world_id='v5_building', building_id='v5', floor_id=floor,
            world=floor+'/world.sdf', heights=floor+'/heights.npz', gt_map=floor+'/map.yaml')
        sdf_hashes[floor] = digest(d/'world.sdf')
        bindings.append(dict(world_id='v5_building', building_id=str(UUID(int=20)), ros_building_id='v5',
            ros_floor_id=floor, ros_map_version='gt-20261012', floor_id=str(UUID(int=i)),
            map_version_id=str(UUID(int=i+10)), sha256='a'*64, source_pgm_sha256=meta['sha256_pgm'],
            resolution=.05, origin=[-20, -14, 0], width=2, height=2, source='SIMULATION'))
    (root/'worlds.json').write_text(json.dumps(dict(worlds=worlds)))
    (root/'connected/cols.npz').write_bytes(b'synthetic column intervals')
    (root/'connected/geom.json').write_text(json.dumps(dict(schema='v2_building_geom/1',
        world_id='v5_building', building_id='v5', sdf_sha256=sdf_hashes)))
    cat = dict(schema='v2_connected_catalog/1', worlds={'v5_building': dict(building_id='v5', floors=['l1', 'l2'],
        cols='cols.npz', cols_sha256=digest(root/'connected/cols.npz'),
        geom='geom.json', geom_sha256=digest(root/'connected/geom.json'))})
    (root/'connected/connected.json').write_text(json.dumps(cat))
    return root, bindings


def test_clearance_covers_both_floor_assets_and_geometry(connected_catalogue):
    root, bindings = connected_catalogue
    files = verify_bindings(root, bindings)
    assert len(files) == 13
    assert set(files) == {'connected_catalogue', 'connected_cols', 'connected_geom',
        *(f'{floor}_{kind}' for floor in ('l1', 'l2') for kind in ('world', 'heights', 'yaml', 'pgm', 'meta'))}


@pytest.mark.parametrize('relative', ['connected/cols.npz', 'connected/geom.json', 'l1/world.sdf', 'l2/world.sdf',
                                     'l1/map.pgm', 'l2/map.pgm'])
def test_asset_tamper_rejected_before_launch(connected_catalogue, relative):
    root, _ = connected_catalogue
    path = root/relative; path.write_bytes(path.read_bytes()+b'changed')
    with pytest.raises(ValueError):
        connected_files(root)


@pytest.mark.parametrize('change', [dict(source_pgm_sha256='f'*64), dict(origin=[0, 0, 0]),
    dict(width=99), dict(ros_map_version='new'), dict(source='HUMAN')])
def test_approved_registration_cannot_bind_other_grid(connected_catalogue, change):
    root, bindings = connected_catalogue
    bindings[1].update(change)
    with pytest.raises(ValueError, match='differs'):
        verify_bindings(root, bindings)


def test_missing_floor_and_asset_symlink_escape_rejected(connected_catalogue, tmp_path):
    root, bindings = connected_catalogue
    with pytest.raises(ValueError, match='both connected'):
        verify_bindings(root, bindings[:1])
    outside = tmp_path/'outside.pgm'; outside.write_bytes((root/'l1/map.pgm').read_bytes())
    (root/'l1/map.pgm').unlink(); (root/'l1/map.pgm').symlink_to(outside)
    with pytest.raises(ValueError, match='escapes'):
        connected_files(root)
