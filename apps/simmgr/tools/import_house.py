"""Export the local terrain-v2 layout with loose rubble and sampled house colors.

Usage: python3 -m apps.simmgr.tools.import_house /path/to/terrain-v2
Inputs stay outside Git. The CC0 building is flattened to derived OBJ geometry;
MuJoCo receives loose convex rubble, clustered chip boxes, a dust/porch
heightfield and conservative 10cm wall columns. No services are started.
"""
import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
import trimesh

from .collision_map import clip_z, polygon_cells

ROOT = Path(__file__).resolve().parents[3]
WORLD_ID = 'collapsed_house_v2'
MOBILE_ID = 'collapsed-house-v2'
NAME = '붕괴 주택 · 초안'
LICENSE_URL = 'https://creativecommons.org/publicdomain/zero/1.0/'
SOURCE_URL = 'https://fuel.gazebosim.org/1.0/OpenRobotics/models/Collapsed%20house'


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, separators=(',', ':'))+'\n')


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def mesh_from(triangles):
    vertices, inverse = np.unique(np.round(triangles.reshape(-1, 3), 5), axis=0, return_inverse=True)
    return trimesh.Trimesh(vertices, inverse.reshape(-1, 3), process=False)


def obj(path, mesh):
    # Shared position/normal indices: small assets with finite normals for DART.
    vertices, faces, normals = mesh.vertices, mesh.faces, mesh.vertex_normals
    text = '# Terrain v2 derived geometry; Collapsed House CC0-1.0; local rubble.\n'
    text += ''.join('v '+' '.join(f'{v:.5f}' for v in p)+'\n' for p in vertices)
    text += ''.join('vn '+' '.join(f'{v:.5f}' for v in p)+'\n' for p in normals)
    text += ''.join('f '+' '.join(f'{i+1}//{i+1}' for i in f)+'\n' for f in faces)
    path.write_text(text)


def wall_pixels(building, xs, ys, floor):
    occupied = np.zeros((len(ys), len(xs)), bool)
    for tri in building:
        # Vertical faces and furniture only, support floors and overhead roof
        # stay in the visual mesh. The result is a conservative body-height band.
        polygon = clip_z(clip_z(tri, floor+.10, True), floor+.65, False)
        if len(polygon) < 2:
            continue
        iy, ix, hit = polygon_cells(polygon[:, :2], xs, ys, .05)
        occupied[np.ix_(iy, ix)] |= hit
    return occupied


def rectangles(mask):
    """Exact cover of occupied 10cm cells; each becomes a separate wall box."""
    left = mask.copy()
    result = []
    while left.any():
        row, col = np.argwhere(left)[0]
        end = col
        while end < left.shape[1] and left[row, end]:
            end += 1
        bottom = row+1
        while bottom < left.shape[0] and left[bottom, col:end].all():
            bottom += 1
        left[row:bottom, col:end] = False
        result.append((row, bottom, col, end))
    return result


def export(source):
    # Keep the command stable; the separate generator owns the loose-piece export.
    from .house_look import export_loose_house
    return export_loose_house(source)


if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source',type=Path)
    export(parser.parse_args().source)
