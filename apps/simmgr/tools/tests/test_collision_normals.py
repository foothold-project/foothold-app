"""Original imported coordinates/connectivity are invariant under normal generation."""
import hashlib
import math
from pathlib import Path

import pytest

from apps.simmgr.tools.collision_normals import add_normals

MESHES = Path(__file__).resolve().parents[2] / 'worlds/warehouse/meshes'
# Geometry-only SHA256 of the original origin/dev 231b36a collision meshes.
ORIGINAL = {
    "Bucket_01_collision.obj": "a854b0342976a8467e97eb8bf405bbe17ce14a1fd60bf26c78cc9adad07c70b7",
    "ClutteringA_01_collision.obj": "13edcc80b44bbfe02a13b4791ec1cce9153aba615d6bd487dbe85f55f4574773",
    "ClutteringC_01_collision.obj": "96b6bd89ff5f2f452a299772a42d578cad0f810e8af96fe3de0de1fd88d818e1",
    "ClutteringD_01_collision.obj": "d63057518b8717b7ef49c10fda85e14ea6fb5f6653a6adb0bf3b0ce258c6a9bd",
    "GroundB_01_collision.obj": "ec56907686d4d0f01e725c4e9c67a107d84f95fc503a059dbe25b38ea459fa8a",
    "Lamp_01_collision.obj": "26fb2d17344bd7b6c1e1a83e4395090531a501737e962a9b8ca8ebcb24fe21b3",
    "PalletJackB_01_collision.obj": "3b4bbcbd6588da5f9d06cead7f8c14716d92e69dcd08c007857750744e2c833e",
    "ShelfD_01_collision.obj": "0b248b21ca2e3b00337d1ef52baea0b1e122a6916c4356a8c7ccdfa452225d6f",
    "ShelfE_01_collision.obj": "0b248b21ca2e3b00337d1ef52baea0b1e122a6916c4356a8c7ccdfa452225d6f",
    "ShelfF_01_collision.obj": "ed4f3b3d852b8d08f6aa9b8da0cf03104eb40c25c0a8976ef6acc4efaa65ea75",
    "TrashCanC_01_collision.obj": "beec2743de8c7b379438476e8c6797ebeeffe40510dccfa6a61d4122faec5c22",
    "WallB_01_collision.obj": "ecb2edae403e00bd65fc98d806f5da8d3e5620d9af66af21c8f5d0d5e80563b1"
}


@pytest.mark.parametrize('name,digest', sorted(ORIGINAL.items()))
def test_all_collision_geometry_and_indexed_normals(name, digest):
    text = (MESHES / name).read_text()
    lines = text.splitlines()
    geometry = ''.join(line+'\n' if line.startswith('v ') else
                       'f '+' '.join(c.split('/')[0] for c in line.split()[1:])+'\n'
                       for line in lines if line.startswith(('v ', 'f ')))
    assert hashlib.sha256(geometry.encode()).hexdigest() == digest
    vertices = [line for line in lines if line.startswith('v ')]
    normals = [tuple(map(float, line.split()[1:])) for line in lines if line.startswith('vn ')]
    assert len(vertices) == len(normals)
    assert all(math.isclose(math.hypot(*n), 1., abs_tol=1e-12) for n in normals)
    for line in lines:
        if line.startswith('f '):
            for corner in line.split()[1:]:
                v, _, n = corner.split('/')
                assert v == n and 1 <= int(n) <= len(normals)
    assert text.startswith('# AWS warehouse; MIT-0;')
    assert add_normals(text) == text  # reproducible and idempotent


def test_triangle_winding_and_texture_references_are_preserved():
    original = '# attribution\nv 0 0 0\nv 1 0 0\nv 0 1 0\nvt 0 0\nf 3/1 2/1 1/1\n'
    result = add_normals(original)
    assert 'f 3/1/3 2/1/2 1/1/1\n' in result
    assert result.count('vn 0 0 -1\n') == 3
    assert result.startswith('# attribution\n')


@pytest.mark.parametrize('face', ['1 2 4', '-1 2 3', '1 2', '1 1 2'])
def test_unsupported_geometry_is_rejected_without_repair(face):
    with pytest.raises(ValueError):
        add_normals('v 0 0 0\nv 1 0 0\nv 0 1 0\nf '+face+'\n')


def test_visual_zero_area_faces_keep_geometry_and_finite_normals():
    original = 'v 0 0 0\nv 1 0 0\nv 0 1 0\nv 2 0 0\nf 1 2 3\nf 1 2 4\n'
    result = add_normals(original, allow_degenerate=True)
    assert 'f 1//1 2//2 3//3\nf 1//1 2//2 4//4\n' in result
    assert result.count('vn 0 0 1\n') == 4
    assert add_normals(result, allow_degenerate=True) == result
