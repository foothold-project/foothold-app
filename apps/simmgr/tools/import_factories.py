"""Offline team draft importer. Read-only sources; texture-free repository assets.

Usage: python3 -m apps.simmgr.tools.import_factories LARGE_SOURCE TWO_LEVEL_SOURCE ADVANCED_SOURCE
No Gazebo/ROS, downloads, source edits or generated build artifacts.
"""
import argparse
import base64
import copy
import hashlib
import heapq
import math
import json
from pathlib import Path
import xml.etree.ElementTree as ET

import numpy as np
from PIL import Image
from scipy.ndimage import distance_transform_edt, label
import trimesh
from trimesh.transformations import quaternion_from_matrix

from .collision_map import generate, pose_matrix, read_collisions
from .collision_normals import add_normals

ROOT = Path(__file__).resolve().parents[3]
WORLDS = ROOT / 'apps/simmgr/worlds'
MOBILE = ROOT / 'mobile/sim'
# Only inspection has a source robot-placement comment. Other placements are
# explicitly selected on supported clear floor, not claimed to be source poses.
SPECS = {
    'factory_inspection': dict(name='큰 공장', source='factory_inspection_noroof.sdf',
        floors={'f1': 0.0}, spawn={'f1': [24., 21.5, 1.5708]},
        spawn_source='SDF robot-placement comment; z=0.45', spawn_z={'f1': .45}),
    'factory_inspection_alt1': dict(name='큰 공장 심화', source='factory_inspection_alt1_noroof.sdf',
        floors={'f1': 0.0}, spawn={'f1': [24., 21.5, 1.5708]},
        spawn_source='SDF robot-placement comment; z=0.45', spawn_z={'f1': .45}),
    'factory_zone': dict(name='2층 공장', source='factory_zone.sdf',
        floors={'f1': 0.0, 'f2': 2.0}, spawn={'f1': [2., 4., 0.], 'f2': [5.65, 4.65, 0.]},
        spawn_source='No robot-placement comment; chosen clear floor; f2 deck_134 top z=1.9+0.2/2',
        spawn_z={'f1': .4, 'f2': 2.4}),
    'element_course': dict(name='요소 코스', source='element_course.sdf',
        floors={'f1': 0.0}, spawn={'f1': [0., 0., 0.]},
        spawn_source='No robot-placement comment; clear +x entry before course obstacles', spawn_z={'f1': .4}),
}


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write_json(path, value, compact=False):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=None if compact else 2,
                               separators=(',', ':') if compact else None) + '\n')


def import_sdf(source, world_id):
    spec = SPECS[world_id]
    original = source / spec['source']
    source_date = '2026-10-28' if world_id == 'factory_inspection_alt1' else '2026-10-26'
    resources = source / world_id
    out = WORLDS / world_id
    out.mkdir(parents=True, exist_ok=True)
    (out / 'meshes').mkdir(exist_ok=True)
    root = ET.parse(original).getroot()
    used = {spec['source']: digest(original), f'{world_id}/model.config': digest(resources/'model.config')}
    author = ET.parse(resources/'model.config').findtext('author/name')
    # Keep OBJ geometry and primitive collisions. Replace heavyweight textured
    # imported visuals with their collision proxy (at the collision's own pose).
    # Decorative imported visuals without collision are omitted.
    for model in root.findall('.//model'):
        for link in list(model.findall('link')):
            if link.get('name') == 'roof':
                model.remove(link)
                continue
            for visual in list(link.findall('visual')):
                uri = visual.find('geometry/mesh/uri')
                if uri is not None and Path(uri.text).suffix.lower() != '.obj':
                    collision = link.find('collision')
                    if collision is None:
                        link.remove(visual)
                        continue
                    for tag in ('geometry', 'pose'):
                        old = visual.find(tag)
                        if old is not None:
                            visual.remove(old)
                        replacement = collision.find(tag)
                        if replacement is not None:
                            visual.append(copy.deepcopy(replacement))
                material = visual.find('material')
                if material is not None:
                    for item in list(material):
                        if item.tag not in ('ambient', 'diffuse', 'specular', 'emissive'):
                            material.remove(item)
    conversions = {}
    for uri in root.findall('.//uri'):
        prefix = f'model://{world_id}/'
        if not uri.text.startswith(prefix):
            raise ValueError(f'Unexpected external asset: {uri.text}')
        relative = uri.text[len(prefix):]
        src = resources / relative
        if src.suffix != '.obj':
            raise ValueError('Only local OBJ geometry may remain')
        used[f'{world_id}/{relative}'] = digest(src)
        if relative not in conversions:
            # Texture/material records may carry private paths. Preserve only
            # positions and face indices; normals are regenerated deterministically.
            lines = []
            vertex_count = 0
            for line in src.read_text().splitlines():
                if line.startswith('v '):
                    lines.append('v ' + ' '.join(line.split()[1:4]))
                    vertex_count += 1
                elif line.startswith('f '):
                    face = [int(p.split('/')[0]) for p in line.split()[1:]]
                    count = vertex_count
                    face = [v if v > 0 else count+v+1 for v in face]
                    for i in range(1,len(face)-1):
                        lines.append('f ' + ' '.join(map(str,[face[0],face[i],face[i+1]])))
            text = '# Team draft geometry; metres; texture-free\n' + '\n'.join(lines) + '\n'
            name = hashlib.sha256(text.encode()).hexdigest()[:16] + '.obj'
            (out/'meshes'/name).write_text(add_normals(text, allow_degenerate=True))
            conversions[relative] = 'meshes/' + name
        uri.text = conversions[relative]
    ET.indent(root)
    ET.ElementTree(root).write(out/f'{world_id}.sdf', encoding='utf-8', xml_declaration=True)
    write_json(out/'sources.json', dict(revision='team-draft-'+source_date, author=author,
        draft=True, imported='2026-10-28', inputs=used, spawn_source=spec['spawn_source'],
        conversion='No roof; no textures; OBJ geometry deduplicated; DAE/GLB visuals use collision proxy or are omitted. Collisions unchanged.'))
    (out/'NOTICE').write_text(f'{spec["name"]} — 초안\n작성: 팀원 {author} (model.config author)\n원본 작성: {source_date}; 저장소 변환: 2026-10-28.\n팀 제공 시뮬 설계의 경량 파생 자산. 개인 경로·원본 텍스처 없음.\n충돌 형상 보존; 지붕 제외; DAE/GLB visual은 collision 대체 또는 생략.\n실행·Gazebo·ROS·보행·센서·실폰 프레임 미검증.\n')
    return out


def mobile_assets(out, world_id, floor, meta, spawn, points):
    spec = SPECS[world_id]
    # Browser IDs intentionally use hyphens to follow existing URL validation.
    mobile_id = world_id.replace('_', '-') + ('-'+floor if world_id == 'factory_zone' else '')
    target = MOBILE/'assets'/mobile_id
    target.mkdir(parents=True, exist_ok=True)
    pixels = np.array(Image.open(out/'maps'/f'{floor}.png'))
    z = spec['floors'][floor]
    write_json(target/'map.json', dict(res=meta['resolution'], origin=meta['origin'],
        w=meta['size_pixels'][0], h=meta['size_pixels'][1], floor_z=z,
        spawn_xyyaw=spawn, spawn_z=spec['spawn_z'][floor], px=base64.b64encode(pixels.tobytes()).decode()), True)
    write_json(target/'scenarios.json', [dict(id='short-loop', name='짧은 한 바퀴 · 초안', points=points)])
    tree = ET.parse(out/f'{world_id}.sdf')
    scene = dict(meshes={}, models=[])
    xml = ET.Element('mujoco', model=mobile_id)
    asset = ET.SubElement(xml, 'asset')
    body = ET.SubElement(xml, 'worldbody')
    mesh_cache = {}
    triangles = 0
    for model in tree.findall('.//model'):
        model_t = pose_matrix(model.find('pose'))
        for link in model.findall('link'):
            link_t = model_t @ pose_matrix(link.find('pose'))
            for c in link.findall('collision'):
                transform = link_t @ pose_matrix(c.find('pose'))
                shape = c.find('geometry')[0]
                q = quaternion_from_matrix(transform)
                if shape.tag == 'box':
                    size = np.fromstring(shape.findtext('size'), sep=' ')
                    ET.SubElement(body, 'geom', group='1', type='box', size=' '.join(f'{v/2:.8g}' for v in size),
                        pos=' '.join(map(str, transform[:3,3])), quat=' '.join(map(str,q)))
                else:
                    # Disjoint rough-surface meshes become conservative boxes in
                    # mobile physics, never an optimistic convex hull or invisible hole.
                    mesh = trimesh.load(out/shape.findtext('uri'), force='mesh', process=False)
                    mesh.apply_scale(np.fromstring(shape.findtext('scale','1 1 1'),sep=' '))
                    lo, hi = mesh.bounds
                    centre = transform[:3,:3] @ ((lo+hi)/2) + transform[:3,3]
                    ET.SubElement(body, 'geom', group='1', type='box', size=' '.join(map(str,(hi-lo)/2)),
                        pos=' '.join(map(str,centre)), quat=' '.join(map(str,q)))
            for v in link.findall('visual'):
                transform = link_t @ pose_matrix(v.find('pose'))
                shape = v.find('geometry')[0]
                key = ET.tostring(shape).decode()
                if key not in mesh_cache:
                    if shape.tag == 'box':
                        mesh = trimesh.creation.box(extents=np.fromstring(shape.findtext('size'),sep=' '))
                    elif shape.tag == 'mesh':
                        mesh = trimesh.load(out/shape.findtext('uri'),force='mesh',process=False)
                        mesh.apply_scale(np.fromstring(shape.findtext('scale','1 1 1'),sep=' '))
                    else:
                        raise ValueError(shape.tag)
                    # Visual-only gravel: same conservative box as mobile physics.
                    if len(mesh.faces) > 2000:
                        box = trimesh.creation.box(extents=mesh.extents)
                        box.apply_translation(mesh.bounds.mean(axis=0))
                        mesh = box
                    mesh_cache[key] = mesh
                mesh = mesh_cache[key]
                bounds = trimesh.transform_points(mesh.vertices, transform)
                # Each layer shows its own walking band. Hide ceilings/decks over
                # f1 and lower-storey geometry below f2 for a readable top view.
                if bounds[:,2].min() > z+1.8 or (floor == 'f2' and bounds[:,2].max() < z-.21):
                    continue
                if floor == 'f1' and world_id == 'factory_zone' and bounds[:,2].min() >= 1.79:
                    continue
                mid = hashlib.sha256(key.encode()).hexdigest()[:12]
                scene['meshes'][mid] = dict(p=np.round(mesh.vertices,6).flatten().tolist(),i=mesh.faces.flatten().tolist())
                color = list(map(float,v.findtext('material/diffuse','0.5 0.55 0.6 1').split()))[:3]
                scene['models'].append(dict(name=link.get('name'),mesh=mid,pos=transform[:3,3].tolist(),
                    quat=quaternion_from_matrix(transform).tolist(),color=color))
                triangles += len(mesh.faces)
    # Batch static visuals by colour so phones draw a few groups instead of
    # hundreds of separate meshes/materials. Triangle geometry is unchanged.
    groups = {}
    for model in scene['models']:
        data = scene['meshes'][model['mesh']]
        transform = trimesh.transformations.quaternion_matrix(model['quat'])
        transform[:3,3] = model['pos']
        vertices = trimesh.transform_points(np.array(data['p']).reshape(-1,3),transform)
        faces = np.array(data['i']).reshape(-1,3)
        groups.setdefault(tuple(model['color']),[]).append((vertices,faces))
    scene = dict(meshes={},models=[])
    for index,(color,parts) in enumerate(sorted(groups.items())):
        vertices=[];faces=[];offset=0
        for v,f in parts:
            vertices.append(v);faces.append(f+offset);offset+=len(v)
        vertices,indices=np.unique(np.round(np.concatenate(vertices),6),axis=0,return_inverse=True)
        faces=indices[np.concatenate(faces)]
        key='color-'+str(index)
        scene['meshes'][key]=dict(p=vertices.flatten().tolist(),i=faces.flatten().tolist())
        scene['models'].append(dict(name=key,mesh=key,pos=[0,0,0],quat=[1,0,0,0],color=list(color)))
    xml.remove(asset)  # All mobile collision proxies are boxes; no mesh files needed.
    ET.indent(xml)
    ET.ElementTree(xml).write(target/f'{mobile_id}.xml',encoding='utf-8',xml_declaration=True)
    write_json(target/'scene.json',scene,True)
    write_json(target/'metadata.json', dict(draft=True, source=f'{world_id}/{floor}',
        triangles=triangles, meshes=len(scene['meshes']), models=len(scene['models']),
        scene_bytes=(target/'scene.json').stat().st_size,
        physics='SDF boxes exact; rough mesh collision uses conservative local AABB; no stair transit between maps',
        readiness='offline_prepared; real phone FPS unverified'))
    name = spec['name'] + (f' {1 if floor == "f1" else 2}층' if world_id == 'factory_zone' else '')
    return dict(id=mobile_id,name=name+' · 초안')


def patrol(source, out, floor, meta, spawn):
    """Keep source waypoint order; route clear joins instead of cutting walls."""
    path = source/'route.json'
    pixels = np.array(Image.open(out/'maps'/f'{floor}.png'))
    res = meta['resolution']
    ox,oy,_ = meta['origin']
    h,w = pixels.shape
    def cell(x,y):
        return (h-1-math.floor((y-oy)/res),math.floor((x-ox)/res))
    # Additional margin covers square body clearance, controller reach radius,
    # and conservative pixel-area boundaries. Same mask for every join.
    safe = distance_transform_edt(np.pad(pixels==254,1))[1:-1,1:-1]*res >= .8
    components,_ = label(safe)
    start = cell(*spawn[:2])
    component = components[start]
    if not component:
        raise ValueError('Patrol spawn lacks clearance')
    rejected=[]
    accepted=[]
    for index,(x,y) in enumerate(json.loads(path.read_text())['waypoints'],1):
        row,col=cell(x,y)
        reason = None
        if not (0<=row<h and 0<=col<w) or pixels[row,col]!=254:
            reason='occupied/unknown'
        elif not safe[row,col]:
            reason='less than 0.8m conservative clearance'
        elif components[row,col]!=component:
            reason='not connected to spawn with clearance'
        if reason:
            rejected.append(dict(index=index,x=x,y=y,reason=reason))
        else:
            accepted.append((x,y))
    def astar(a,b):
        queue=[(0,a)]; costs={a:0}; prev={}
        while queue:
            _,cur=heapq.heappop(queue)
            if cur==b:
                result=[b]
                while result[-1]!=a:
                    result.append(prev[result[-1]])
                return result[::-1]
            for dr,dc in ((0,1),(1,0),(0,-1),(-1,0)):
                nxt=(cur[0]+dr,cur[1]+dc)
                if not (0<=nxt[0]<h and 0<=nxt[1]<w) or not safe[nxt]:
                    continue
                cost=costs[cur]+1
                if cost<costs.get(nxt,math.inf):
                    costs[nxt]=cost;prev[nxt]=cur
                    heapq.heappush(queue,(cost+abs(nxt[0]-b[0])+abs(nxt[1]-b[1]),nxt))
        raise ValueError('No clear patrol join')
    def visible(a,b):
        count=max(1,math.ceil(math.dist(a,b)*2))
        return all(safe[round(a[0]+(b[0]-a[0])*i/count),round(a[1]+(b[1]-a[1])*i/count)] for i in range(count+1))
    points=[]; current=start
    for x,y in accepted:
        goal=cell(x,y)
        route=astar(current,goal)
        # Greedy line-of-sight compression keeps the route light and avoids
        # thousands of tiny turns. Every segment remains in the clear mask.
        index=0
        while index<len(route)-1:
            end=len(route)-1
            while end>index+1 and not visible(route[index],route[end]):
                end-=1
            row,col=route[end]
            if end < len(route)-1:
                points.append(dict(x=round(ox+(col+.5)*res,4),y=round(oy+(h-row-.5)*res,4)))
            index=end
        # Preserve valid handwritten coordinates, not just the grid centres.
        points.append(dict(x=x,y=y))
        current=goal
    # Remove near-duplicate helper turns without removing source waypoints.
    source_points=set(accepted)
    changed=True
    while changed:
        changed=False
        for i,p in enumerate(points):
            if (p['x'],p['y']) in source_points:
                continue
            prev=points[i-1] if i else dict(x=spawn[0],y=spawn[1])
            nxt=points[i+1] if i+1<len(points) else p
            if min(math.dist((p['x'],p['y']),(prev['x'],prev['y'])),math.dist((p['x'],p['y']),(nxt['x'],nxt['y']))) < .65 and visible(cell(prev['x'],prev['y']),cell(nxt['x'],nxt['y'])):
                points.pop(i);changed=True;break
    write_json(out/'route-review.json',dict(source_sha256=digest(path),input_points=len(json.loads(path.read_text())['waypoints']),
        retained=accepted,rejected=rejected,join='clearance-constrained A*; additional intermediate points, not Nav2 validation'))
    return dict(id='patrol-1',name='순찰 1안 · 초안',points=points)


def import_all(large, levels, advanced):
    catalogue = json.loads((WORLDS/'worlds.json').read_text())
    mobile = [e for e in json.loads((MOBILE/'maps.json').read_text()) if not e['id'].startswith(('factory-', 'element-'))]
    for world_id,spec in SPECS.items():
        source = advanced if world_id == 'factory_inspection_alt1' else large if world_id == 'factory_inspection' else levels
        out = import_sdf(source,world_id)
        print('rasterizing',world_id,flush=True)
        meta = generate(out/f'{world_id}.sdf',out/'maps',spec['floors'],resolution=.05)
        for floor,z in spec['floors'].items():
            spawn = spec['spawn'][floor]
            # Short square on the starting patch, no obstacle-course traversal.
            x,y,_ = spawn
            points=[dict(x=x+.8,y=y),dict(x=x+.8,y=y+.8),dict(x=x,y=y+.8),dict(x=x,y=y)]
            scenarios=[dict(id='short-loop',name=spec['name']+' 짧은 한 바퀴 · 초안',
                waypoints=[dict(**p,mission_name=world_id+'-'+floor+'-순찰-'+str(i+1)) for i,p in enumerate(points)])]
            write_json(out/f'scenarios-{floor}.json',scenarios)
            entry=dict(world_id=world_id,floor_id=floor,building_id=world_id,name=spec['name']+' · 초안',
                floor_name=f'{1 if floor == "f1" else 2}층',level=1 if floor=='f1' else 2,
                description='팀원 작성 초안. 정적 자산 준비; 실제 실행 미검증.',floor_z=z,
                spawn_xyyaw=spawn,spawn_z=spec['spawn_z'][floor],spawn_source=spec['spawn_source'],
                world=f'{world_id}/{world_id}.sdf',gt_map=f'{world_id}/maps/{floor}.yaml',
                map_metadata=f'{world_id}/maps/metadata.json',ledger_key=f'{world_id}/{floor}',
                height_source='static_sdf_collision',readiness='offline_prepared',native_supported=False,
                notes='Gazebo·ROS·보행·센서 미검증. 서버 실행 adapter의 새 ID/floor binding 연결 필요. 층간 전이 없음.',
                scenarios=f'{world_id}/scenarios-{floor}.json',
                sha256=dict(world=digest(out/f'{world_id}.sdf'),map=digest(out/'maps'/f'{floor}.yaml'),metadata=digest(out/'maps/metadata.json')),
                mesh_sha256={str(p.relative_to(out)):digest(p) for p in sorted((out/'meshes').glob('*.obj'))})
            catalogue['worlds'][f'{world_id}/{floor}']=entry
            mobile.append(mobile_assets(out,world_id,floor,meta,spawn,points))
            if world_id == 'factory_inspection_alt1':
                route = patrol(source,out,floor,meta,spawn)
                target = MOBILE/'assets'/mobile[-1]['id']/'scenarios.json'
                write_json(target,json.loads(target.read_text())+[route])
                scenarios.append(dict(id=route['id'],name=route['name'],waypoints=[dict(**p,mission_name='심화-순찰') for p in route['points']]))
                write_json(out/f'scenarios-{floor}.json',scenarios)
        print(world_id,'done',flush=True)
    write_json(WORLDS/'worlds.json',catalogue)
    write_json(MOBILE/'maps.json',mobile)


if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('large',type=Path)
    parser.add_argument('levels',type=Path)
    parser.add_argument('advanced',type=Path)
    args=parser.parse_args()
    import_all(args.large,args.levels,args.advanced)
