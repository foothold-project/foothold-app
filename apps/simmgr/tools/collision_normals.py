"""Add indexed unit vertex normals to the imported AWS MIT-0 collision OBJs.

Only vn records and face normal references change; vertex text, triangle indices,
winding, comments and source/license attribution are retained. No mesh repair,
welding, coordinate rounding or simulator invocation is performed.
"""
import argparse
import math
from pathlib import Path


def add_normals(text, *, allow_degenerate=False):
    """Keep zero-area visual faces only when opted in; collisions stay strict.

    Zero-area faces contribute no normal. Vertices without a usable adjacent
    face receive unit +Z, keeping the output finite without altering geometry.
    """
    lines = text.splitlines(keepends=True)
    vertices = [tuple(map(float, line.split()[1:])) for line in lines if line.startswith('v ')]
    if not vertices or any(len(v) != 3 or not all(map(math.isfinite, v)) for v in vertices):
        raise ValueError('finite XYZ vertices required')
    normals = [[0., 0., 0.] for _ in vertices]
    fallback = [None] * len(vertices)
    faces = []
    for line in lines:
        if not line.startswith('f '):
            continue
        corners = [token.split('/') for token in line.split()[1:]]
        indices = [int(corner[0]) - 1 for corner in corners]
        if len(indices) != 3 or any(i < 0 or i >= len(vertices) for i in indices):
            raise ValueError('positive indexed triangles required')
        a, b, c = (vertices[i] for i in indices)
        u, v = [b[k]-a[k] for k in range(3)], [c[k]-a[k] for k in range(3)]
        normal = [u[1]*v[2]-u[2]*v[1], u[2]*v[0]-u[0]*v[2], u[0]*v[1]-u[1]*v[0]]
        if math.hypot(*normal) == 0 and not allow_degenerate:
            raise ValueError('degenerate triangle; geometry repair is out of scope')
        for i in indices:
            normals[i] = [normals[i][k] + normal[k] for k in range(3)]
            if math.hypot(*normal) > 0:
                fallback[i] = fallback[i] or normal
        faces.append(corners)
    if not faces:
        raise ValueError('triangles required')
    records = []
    for i, normal in enumerate(normals):
        if math.hypot(*normal) < 1e-15:
            normal = fallback[i] or [0., 0., 1.]  # cancellation or unused vertex
        length = math.hypot(*normal)
        records.append('vn ' + ' '.join(f'{n / length:.17g}' for n in normal) + '\n')
    output, inserted, face_index = [], False, 0
    for line in lines:
        if line.startswith('vn '):
            continue
        if line.startswith('f '):
            if not inserted:
                output.extend(records)
                inserted = True
            corners = faces[face_index]
            output.append('f ' + ' '.join(c[0] + '/' + (c[1] if len(c) > 1 else '') + '/' + c[0]
                                          for c in corners) + '\n')
            face_index += 1
        else:
            output.append(line)
    return ''.join(output)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('meshes', type=Path, help='directory containing *_collision.obj')
    args = parser.parse_args()
    paths = sorted(args.meshes.glob('*_collision.obj'))
    if not paths:
        parser.error('no collision OBJs found')
    # Validate every input before replacing any file.
    converted = [(path, add_normals(path.read_text())) for path in paths]
    for path, text in converted:
        path.write_text(text)
    print(f'Added indexed normals to {len(paths)} collision OBJs')
