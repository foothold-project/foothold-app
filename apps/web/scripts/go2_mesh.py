"""Unitree 공개 Go2 메시(BSD-3-Clause) 5개 → 웹용 GLB 하나(apps/web/public/go2/go2.glb).

받기: unitree_ros 고정 커밋에서 받거나(--src 없음) 같은 파일이 있는 폴더(--src). 어느 쪽이든 SHA-256 이
deploy/go2-mesh-pins.json 과 다르면 멈춘다. 상표 글자 부품(흰 로고·검은 스티커)은 둘레와 같은 색으로 합쳐 드러나지 않게 한다.
부품마다 색 묶음(light·mid·dark)별로 꼭짓점을 합치고 이차 오차 줄이기로 삼각형을 줄여 위치·인덱스만 넣는다(법선은 브라우저가 계산).

  python3 -m venv /tmp/v && /tmp/v/bin/pip install pycollada==0.9 fast-simplification==0.1.9 numpy
  /tmp/v/bin/python apps/web/scripts/go2_mesh.py [--src 폴더]
"""
import argparse, hashlib, io, json, struct, urllib.request
from pathlib import Path

import collada, fast_simplification, numpy as np

ROOT = Path(__file__).resolve().parents[3]
COMMIT = '157ff950351e5f535e03c5d85a16b7d594b3dbcc'
URL = f'https://raw.githubusercontent.com/unitreerobotics/unitree_ros/{COMMIT}/robots/go2_description/meshes/'
PARTS = ('trunk', 'hip', 'thigh', 'thigh_mirror', 'calf')
UPSTREAM = {'trunk': 'base'}   # unitree_ros 에서는 몸통 파일 이름이 base.dae(바이트 같음)
KEEP = 0.3    # 남길 삼각형 비율(합계 약 5만 4천 — 1 MB 아래)


def tone(mat):
    """원본 재질 → 색 묶음. 黑色(검정)·足端(발끝)·diffuse 어두움 = dark, 深色(짙은 회색 몸) = mid, 나머지(흰 판) = light.
    상표 글자(몸통 옆 흰 로고·앞 검은 글자 스티커)는 빼면 몸에 글자 모양 홈이 남아, 둘레와 같은 색 묶음에 합쳐 글자가 드러나지 않게 한다"""
    name, d = mat.id, mat.effect.diffuse
    if 'logo' in name.lower():
        return 'mid'
    if '黑色' in name or (isinstance(d, tuple) and max(d[:3]) < 0.1):
        return 'dark'
    return 'mid' if '深色' in name else 'light'


def load(part, src):
    data = (Path(src) / f'{part}.dae').read_bytes() if src else urllib.request.urlopen(URL + f'{UPSTREAM.get(part, part)}.dae', timeout=60).read()
    pin = json.loads((ROOT / 'deploy/go2-mesh-pins.json').read_text())['files'][f'{part}.dae']
    sha = hashlib.sha256(data).hexdigest()
    if sha != pin['sha256'] or len(data) != pin['size']:
        raise SystemExit(f'{part}.dae SHA 불일치: {sha}')
    groups = {}
    for g in collada.Collada(io.BytesIO(data)).scene.objects('geometry'):
        for p in g.primitives():
            t = tone(p.material)
            groups.setdefault(t, []).append(p.vertex[p.vertex_index].reshape(-1, 3))
    return sha, groups


def reduce(tris):
    v, idx = np.unique(np.round(np.concatenate(tris), 6), axis=0, return_inverse=True)
    f = idx.reshape(-1, 3)
    f = f[(f[:, 0] != f[:, 1]) & (f[:, 1] != f[:, 2]) & (f[:, 0] != f[:, 2])]
    v, f = fast_simplification.simplify(v.astype(np.float32), f.astype(np.int32), target_reduction=1 - KEEP)
    return v.astype(np.float32), f.astype(np.uint16 if len(v) < 65536 else np.uint32)


def glb(meshes):
    """meshes = [(이름, 꼭짓점, 면)] → 노드 하나에 메시 하나인 GLB 바이트"""
    bin_, views, acc, gm, nodes = bytearray(), [], [], [], []
    def put(arr, target):
        while len(bin_) % 4: bin_.append(0)
        views.append({'buffer': 0, 'byteOffset': len(bin_), 'byteLength': arr.nbytes, 'target': target})
        bin_.extend(arr.tobytes())
        return len(views) - 1
    for name, v, f in meshes:
        acc.append({'bufferView': put(v, 34962), 'componentType': 5126, 'count': len(v), 'type': 'VEC3',
                    'min': v.min(0).tolist(), 'max': v.max(0).tolist()})
        acc.append({'bufferView': put(f.ravel(), 34963), 'componentType': 5123 if f.dtype == np.uint16 else 5125,
                    'count': f.size, 'type': 'SCALAR'})
        gm.append({'name': name, 'primitives': [{'attributes': {'POSITION': len(acc) - 2}, 'indices': len(acc) - 1}]})
        nodes.append({'name': name, 'mesh': len(gm) - 1})
    while len(bin_) % 4: bin_.append(0)
    doc = {'asset': {'version': '2.0', 'generator': 'foothold go2_mesh.py'}, 'scene': 0, 'scenes': [{'nodes': list(range(len(nodes)))}],
           'nodes': nodes, 'meshes': gm, 'accessors': acc, 'bufferViews': views, 'buffers': [{'byteLength': len(bin_)}]}
    js = json.dumps(doc, separators=(',', ':')).encode()
    js += b' ' * (-len(js) % 4)
    body = struct.pack('<II', len(js), 0x4E4F534A) + js + struct.pack('<II', len(bin_), 0x004E4942) + bytes(bin_)
    return struct.pack('<III', 0x46546C67, 2, 12 + len(body)) + body


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--src', help='원본 .dae 가 있는 폴더(없으면 unitree_ros 고정 커밋에서 받음)')
    a = ap.parse_args()
    meshes, tris = [], 0
    for part in PARTS:
        sha, groups = load(part, a.src)
        for t in sorted(groups):
            v, f = reduce(groups[t])
            meshes.append((f'{part}-{t}', v, f)); tris += len(f)   # 이름 구분자 '-'(three 가 ':' 를 '_' 로 바꿈)
        print(part, sha[:12], {t: len(g) for t, g in groups.items()})
    out = ROOT / 'apps/web/public/go2/go2.glb'
    out.write_bytes(glb(meshes))
    print(out.relative_to(ROOT), out.stat().st_size, 'bytes', tris, 'tris')


if __name__ == '__main__':
    main()
