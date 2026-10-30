"""Deterministic loose rubble export; local source bundles are read only.

10-29 supplies the route, stair boxes, XY fragments and pile envelopes. The
10-28 material palette and the CC0 house's UV albedo supply sampled colors.
Small chips share visual batches and conservative contact boxes; larger pieces
are individual convex meshes in both engines. No source texture is distributed.
"""
import base64
from collections import defaultdict
import json
from pathlib import Path
import xml.etree.ElementTree as ET

import numpy as np
from PIL import Image
from scipy.interpolate import RegularGridInterpolator
from scipy.spatial.transform import Rotation
import trimesh

from .import_house import ROOT, WORLD_ID, MOBILE_ID, mesh_from, obj, rectangles, sha, wall_pixels, write_json


def distance(x, y, route):
    x, y = np.broadcast_arrays(x, y)
    result = np.full(x.shape, np.inf)
    for a, b in zip(route[:-1], route[1:]):
        dx, dy = b-a
        t = np.clip(((x-a[0])*dx+(y-a[1])*dy)/(dx*dx+dy*dy), 0, 1)
        result = np.minimum(result, np.hypot(x-a[0]-t*dx, y-a[1]-t*dy))
    return result


def grid_top(triangles, xs, ys, initial):
    """Highest real triangle intersection, without an interpolated hill envelope."""
    out = initial.copy()
    for a, b, c in triangles:
        det = (b[1]-c[1])*(a[0]-c[0])+(c[0]-b[0])*(a[1]-c[1])
        if abs(det) < 1e-12:
            continue
        lo, hi = np.min([a,b,c], axis=0), np.max([a,b,c], axis=0)
        ix = np.flatnonzero((xs >= lo[0]-1e-8)&(xs <= hi[0]+1e-8))
        iy = np.flatnonzero((ys >= lo[1]-1e-8)&(ys <= hi[1]+1e-8))
        if not len(ix) or not len(iy):
            continue
        X, Y = np.meshgrid(xs[ix], ys[iy])
        u = ((b[1]-c[1])*(X-c[0])+(c[0]-b[0])*(Y-c[1]))/det
        v = ((c[1]-a[1])*(X-c[0])+(a[0]-c[0])*(Y-c[1]))/det
        h = u*a[2]+v*b[2]+(1-u-v)*c[2]
        hit = (u >= -1e-8)&(v >= -1e-8)&(u+v <= 1+1e-8)
        out[np.ix_(iy,ix)] = np.maximum(out[np.ix_(iy,ix)], np.where(hit,h,-np.inf))
    return out


def house_uv(source, building):
    """Keep original CC0 UVs; derived 512px albedo is small enough for phones."""
    ns = {'c':'http://www.collada.org/2005/11/COLLADASchema'}
    dae = ET.parse(source/'models/collapsed_house/meshes/collapsed_house.dae')
    sources = {}
    for node in dae.findall('.//c:source', ns):
        array = node.find('c:float_array', ns)
        if array is not None:
            stride = int(node.find('c:technique_common/c:accessor', ns).get('stride'))
            sources[node.get('id')] = np.fromstring(array.text, sep=' ').reshape(-1,stride)
    uv = []
    for triangles in dae.findall('.//c:triangles', ns):
        inputs = triangles.findall('c:input', ns)
        stride = max(int(i.get('offset')) for i in inputs)+1
        tex = next(i for i in inputs if i.get('semantic') == 'TEXCOORD')
        ids = np.fromstring(triangles.findtext('c:p', namespaces=ns),sep=' ',dtype=int).reshape(-1,3,stride)
        uv.extend(sources[tex.get('source')[1:]][ids[:,:,int(tex.get('offset'))]])
    assert len(uv) == len(building)
    return np.array(uv)[:,:,:2].reshape(-1,2)


def export_loose_house(source):
    source = Path(source)
    data = np.load(source/'previews/v2_geometry.npz')
    layout = json.loads((source/'layout.json').read_text())
    assert layout['revision'] == 'terrain-v2' and layout['reused_fragments'] == 1085
    floor, route = layout['floor_z'], data['route']
    out = ROOT/'apps/simmgr/worlds'/WORLD_ID
    mobile = ROOT/'mobile/sim/assets'/MOBILE_ID
    for p in (out/'meshes',out/'maps',mobile):
        p.mkdir(parents=True,exist_ok=True)
    rng = np.random.default_rng(20261030)
    original_base = mesh_from(data['base'])
    v = original_base.vertices.copy()
    # Remove the hill envelope completely; retain the porch joining ramp.
    indoor = v[:,2] >= floor-.005
    v[indoor,2] = floor+.006+.002*np.sin(v[indoor,0]*3)*np.sin(v[indoor,1]*2)
    dust = trimesh.Trimesh(v,original_base.faces,process=False)
    # Exact vertical floor raster: height.png contains dust/porch only.
    hx,hy = data['hx'],data['hy']
    base = grid_top(dust.triangles,hx,hy,np.full((len(hy),len(hx)),-.02))
    base_at = RegularGridInterpolator((hy,hx),base,bounds_error=False,fill_value=-.02)
    old_at = RegularGridInterpolator((hy,hx),data['hz'],bounds_error=False,fill_value=-.02)
    batches = defaultdict(list)
    small = []
    offset = 0
    for i, record in enumerate(layout['fragments']):
        n = 20 if i < 1085 else 8
        t = data['stones'][offset:offset+n].copy();offset += n
        cx,cy = record['center']
        # Keep original XY footprint, lift every entire piece above the flat dust.
        z = t[:,:,2];z -= z.min()
        z *= min(.065/max(z.max(),1e-8),1)
        z += .012*(t[:,:,0]-cx)-.018*(t[:,:,1]-cy)
        z -= z.min()
        support = float(base_at([[cy,cx]])[0])
        t[:,:,2] = z+max(support,floor+.008)+.001
        small.append(t)
        kind = 'concrete' if i >=1085 or i%7==0 else 'rock'
        k = (kind,i%4)
        batches[k].append(t)
    assert offset == len(data['stones'])
    pieces = []
    # Restore freestanding, layered piles around the original high-relief areas.
    # Coarse cells control contact count; a second offset layer visibly overlaps.
    for cy in np.arange(-5.35,5.8,1.05):
        for cx in np.arange(-7.05,7.2,1.05):
            target = float(old_at([[cy,cx]])[0])-floor
            if target < .14 or distance(cx,cy,route)<1.20:
                continue
            if float(base_at([[cy,cx]])[0]) < floor:
                continue
            target = min(.79,max(.16,target))
            for layer in range(2):
                kind = 'wood' if (len(pieces)%9==4) else 'concrete' if len(pieces)%4==0 else 'rock'
                if kind=='rock':
                    m = trimesh.creation.icosphere(subdivisions=0,radius=1)
                    m.vertices *= rng.uniform(.82,1.15,(len(m.vertices),1))
                else:
                    m = trimesh.creation.box()
                size = np.array([rng.uniform(.70,1.02),rng.uniform(.48,.80),target*.65])
                if kind=='wood':size=np.array([1.10,.20,.09])
                m.vertices *= size/np.ptp(m.vertices,axis=0)
                rot=Rotation.from_euler('xyz',[rng.uniform(-.24,.24),rng.uniform(-.24,.24),rng.uniform(-np.pi,np.pi)])
                m.vertices = rot.apply(m.vertices)
                m.vertices[:,:2] += [cx+rng.uniform(-.12,.12),cy+rng.uniform(-.12,.12)]
                # Do not spill tall bodies onto the preserved 1.2m route.
                if np.min(distance(m.vertices[:,0],m.vertices[:,1],route)) < .70:
                    continue
                bottom = floor+.009+(target*.35 if layer else 0)
                m.vertices[:,2] += bottom-m.vertices[:,2].min()
                if m.bounds[1,2]>floor+.795:
                    m.vertices[:,2] = bottom+(m.vertices[:,2]-bottom)*(floor+.795-bottom)/(m.bounds[1,2]-bottom)
                pieces.append((m,kind))
    # Ensure the tallest original corner still reads as an approximately .8m pile.
    # Raise its uppermost loose piece, never add a heightfield mound.
    highest = max(pieces,key=lambda item:item[0].bounds[1,2])[0]
    lo = highest.bounds[0,2]
    highest.vertices[:,2] = lo+(highest.vertices[:,2]-lo)*(floor+.786-lo)/(highest.bounds[1,2]-lo)
    for i,(m,kind) in enumerate(pieces):batches[(kind,(i+1)%4)].append(m.triangles)
    # Mean linear albedo of the 10-23 materials multiplied by their SDF tint.
    palette = {'rock':np.array([.294862,.30207812,.30966856])*[.62,.58,.52],
        'concrete':np.array([.294862,.30207812,.30966856])*[.9,.88,.83],
        'wood':np.array([.31823303,.1501873,.04728392])*[.6,.5,.4]}
    uv = house_uv(source,data['building'])
    scene = dict(meshes={},models=[])
    worldtree = ET.parse(source/'house_debris_world.sdf')
    world = worldtree.getroot().find('world')
    for inc in list(world.findall('include')):world.remove(inc)
    for m in list(world.findall('model')):
        if m.get('name') == 'terrain_v2':world.remove(m)
    # Same diffuse palette in both renderers, with the source's neutral daylight.
    world.find('scene/ambient').text='.58 .58 .56 1'
    world.find('light/direction').text='-.4 .3 -1'
    def visual(name,mesh,color,collision=False):
        obj(out/f'meshes/{name}.obj',mesh)
        scene['meshes'][name]=dict(p=np.round(mesh.vertices,5).ravel().tolist(),i=mesh.faces.ravel().tolist())
        scene['models'].append(dict(name=name,mesh=name,pos=[0,0,0],quat=[1,0,0,0],color=list(map(float,color))))
        model=ET.SubElement(world,'model',name=name);ET.SubElement(model,'static').text='true'
        link=ET.SubElement(model,'link',name='body')
        for kind in (('collision','visual') if collision else ('visual',)):
            part=ET.SubElement(link,kind,name=kind)
            ET.SubElement(ET.SubElement(ET.SubElement(part,'geometry'),'mesh'),'uri').text=f'meshes/{name}.obj'
            if kind=='visual':
                mat=ET.SubElement(part,'material')
                for tag in ('ambient','diffuse'):ET.SubElement(mat,tag).text=' '.join(map(str,[*color,1]))
                ET.SubElement(mat,'specular').text='.03 .03 .03 1'
        return link
    house_mesh=trimesh.Trimesh(data['building'].reshape(-1,3),np.arange(len(data['building'])*3).reshape(-1,3),process=False)
    house_link=visual('original_house',house_mesh,[1,1,1],True)
    scene['meshes']['original_house']['uv']=np.round(uv,6).ravel().tolist()
    scene['models'][-1]['texture']='house-albedo.png'
    # OBJ uses the same unmerged position, normal and UV indices.
    path=out/'meshes/original_house.obj'
    lines=path.read_text().splitlines()
    normals=next(i for i,line in enumerate(lines) if line.startswith('vn '))
    lines[normals:normals]=['vt '+' '.join(f'{v:.6f}' for v in p) for p in uv]
    lines=[('f '+' '.join(f'{int(v.split("/")[0])}/{int(v.split("/")[0])}/{int(v.split("/")[0])}' for v in line.split()[1:])) if line.startswith('f ') else line for line in lines]
    path.write_text('\n'.join(lines)+'\n')
    mat=house_link.find('visual/material')
    metal=ET.SubElement(ET.SubElement(mat,'pbr'),'metal')
    ET.SubElement(metal,'albedo_map').text='house-albedo.png'
    ET.SubElement(metal,'roughness').text='.95'
    albedo=Image.open(source/'models/collapsed_house/materials/textures/collapsed_house_diffuse.jpg').convert('RGB')
    albedo.thumbnail((512,512),Image.Resampling.LANCZOS)
    for folder in (out,mobile):albedo.save(folder/'house-albedo.png')
    # Outdoor ground already has an exact box: duplicate coplanar faces flicker.
    dust_visual=dust.submesh([np.flatnonzero(np.max(dust.triangles[:,:,2],axis=1)>0)],append=True)
    visual('dust_floor',dust_visual,[.16104,.14067,.11067])
    for i,(k,ts) in enumerate(sorted(batches.items())):
        if not ts:continue
        color=palette[k[0]]*(.86+k[1]*.08)
        mesh=mesh_from(np.concatenate(ts))
        mesh.unmerge_vertices()  # fractured faces retain hard edges in both renderers
        visual(f'{k[0]}_batch_{k[1]}',mesh,color)
    xml=ET.Element('mujoco',model=MOBILE_ID)
    asset=ET.SubElement(xml,'asset');wb=ET.SubElement(xml,'worldbody')
    hmin,hrange=-.02,float(base.max()+.02)
    image=np.round((base-hmin)/hrange*255).astype('uint8')[::-1]
    for folder in (out,mobile):Image.fromarray(image).save(folder/'height.png')
    ET.SubElement(asset,'hfield',name='dust_floor',file='height.png',size=f'8.5 8.5 {hrange} .1')
    ET.SubElement(wb,'geom',name='dust_floor',group='4',type='hfield',hfield='dust_floor',pos='0 -.5 -.02',friction='.85 .005 .0001')
    model=world.find("model[@name='dust_floor']")
    collision=ET.SubElement(model.find('link'),'collision',name='dust_contact')
    hm=ET.SubElement(ET.SubElement(collision,'geometry'),'heightmap')
    for tag,value in [('uri','height.png'),('size',f'17 17 {hrange}'),('pos','0 -.5 -.02'),('sampling','1')]:ET.SubElement(hm,tag).text=value
    support_triangles=[dust.triangles,*small]
    contact_triangles=[dust.triangles]
    physics_assets=['height.png']
    for i,(m,kind) in enumerate(pieces):
        # World-space vertices are re-centered for stable MuJoCo convex hulls.
        center=m.vertices.mean(0);local=m.copy();local.vertices-=center
        filename=f'piece_{i:03}.obj'
        ET.SubElement(asset,'mesh',name=f'piece_{i}',vertex=' '.join(f'{v:.5f}' for v in local.vertices.ravel()),face=' '.join(map(str,local.faces.ravel())))
        ET.SubElement(wb,'geom',name=f'loose_{kind}_{i}',type='mesh',mesh=f'piece_{i}',group='1',pos=' '.join(map(str,center)),friction='.85 .005 .0001')
        # Reuse exactly the same convex mesh as Gazebo collision.
        obj(out/f'meshes/{filename}',m)
        model=ET.SubElement(world,'model',name=f'contact_{i}');ET.SubElement(model,'static').text='true'
        col=ET.SubElement(ET.SubElement(model,'link',name='body'),'collision',name='piece')
        ET.SubElement(ET.SubElement(ET.SubElement(col,'geometry'),'mesh'),'uri').text=f'meshes/{filename}'
        support_triangles.append(m.triangles);contact_triangles.append(m.triangles)
    # Small source stones keep all XY positions. Their contacts are tight
    # cell-local boxes, explicitly conservative, instead of 1,235 phone geoms.
    clusters=defaultdict(list)
    for t in small:
        center=t.mean((0,1));clusters[tuple(np.floor(center[:2]/1.25).astype(int))].append(t)
    for i,ts in enumerate(clusters.values()):
        vv=np.concatenate(ts).reshape(-1,3);lo,hi=vv.min(0),vv.max(0)
        center=(lo+hi)/2;size=np.maximum((hi-lo)/2,.002)
        ET.SubElement(wb,'geom',name=f'chip_cluster_{i}',type='box',group='1',pos=' '.join(map(str,center)),size=' '.join(map(str,size)))
        m=trimesh.creation.box(size*2);m.vertices+=center;contact_triangles.append(m.triangles)
        model=ET.SubElement(world,'model',name=f'chip_contact_{i}');ET.SubElement(model,'static').text='true'
        ET.SubElement(model,'pose').text=' '.join(map(str,[*center,0,0,0]))
        col=ET.SubElement(ET.SubElement(model,'link',name='body'),'collision',name='chips')
        ET.SubElement(ET.SubElement(ET.SubElement(col,'geometry'),'box'),'size').text=' '.join(map(str,size*2))
    for model in world.findall('model'):
        box=model.findtext('link/visual/geometry/box/size')
        if box is None:continue
        size=np.fromstring(box,sep=' ');pose=np.fromstring(model.findtext('pose'),sep=' ')
        color=np.fromstring(model.findtext('link/visual/material/diffuse'),sep=' ')[:3]
        name=model.get('name');m=trimesh.creation.box(size)
        scene['meshes'][name]=dict(p=m.vertices.ravel().tolist(),i=m.faces.ravel().tolist())
        scene['models'].append(dict(name=name,mesh=name,pos=pose[:3].tolist(),quat=[1,0,0,0],color=color.tolist()))
        ET.SubElement(wb,'geom',name=name,type='box',group='1',pos=' '.join(map(str,pose[:3])),size=' '.join(map(str,size/2)))
        m.vertices+=pose[:3];support_triangles.append(m.triangles);contact_triangles.append(m.triangles)
    wx=np.arange(-8.45,8.5,.1);wy=np.arange(-6.45,6.5,.1)
    cols=rectangles(wall_pixels(data['building'],wx,wy,floor))
    for i,(r0,r1,c0,c1) in enumerate(cols):
        ET.SubElement(wb,'geom',name=f'house_wall_{i}',type='box',group='1',size=f'{(c1-c0)*.05} {(r1-r0)*.05} 1.2',pos=f'{-8.5+(c0+c1)*.05} {-6.5+(r0+r1)*.05} {floor+1.2}')
    assert len(wb)<=3*(139+30),f'{len(wb)} > 507 contact budget'
    ET.indent(xml);ET.ElementTree(xml).write(mobile/f'{MOBILE_ID}.xml',encoding='utf-8',xml_declaration=True)
    ET.indent(worldtree);worldtree.write(out/f'{WORLD_ID}.sdf',encoding='utf-8',xml_declaration=True)
    write_json(mobile/'scene.json',scene)
    xs=np.arange(-8.475,8.5,.05);ys=np.arange(-9.975,8.,.05)
    blank=np.full((len(ys),len(xs)),-.02)
    visible=grid_top(np.concatenate(support_triangles),xs,ys,blank)
    contact=grid_top(np.concatenate(contact_triangles),xs,ys,blank)
    wall=wall_pixels(data['building'],xs,ys,floor)
    occupied=wall|(contact>floor+.15)
    pixels=np.where(occupied,0,254).astype('uint8')[::-1]
    Image.fromarray(pixels).save(out/'maps/f1.png')
    (out/'maps/f1.yaml').write_text('image: f1.png\nmode: trinary\nresolution: 0.05\norigin: [-8.5, -10.0, 0.0]\nnegate: 0\noccupied_thresh: 0.65\nfree_thresh: 0.196\n')
    image_sha=sha(out/'maps/f1.png');origin=[-8.5,-10.,0.]
    write_json(out/'maps/metadata.json',dict(generator_version='house-look-loose/1',resolution=.05,origin=origin,size_pixels=[len(xs),len(ys)],body_band_above_floor_m=[.10,.65],occupancy='house body-band triangles; actual loose convex pieces and conservative chip boxes above floor +15cm',support_samples='5cm vertical triangle intersections of exported pieces and dust/porch',pixel_to_world='x=xmin+(column+0.5)*resolution; y=ymin+(height-row-0.5)*resolution',variable_elevation=True,floors={'f1':dict(floor_z=floor,image='f1.png',yaml='f1.yaml',image_sha256=image_sha)}))
    write_json(mobile/'map.json',dict(res=.05,origin=origin,w=len(xs),h=len(ys),floor_z=-.02,spawn_xyyaw=[*route[0],np.pi/2],spawn_z=.38,physics_assets=physics_assets,px=base64.b64encode(pixels.tobytes()).decode()))
    X,Y=np.meshgrid(xs,ys)
    indoor=grid_top(data['indoor_floor'],xs,ys,np.full(blank.shape,-np.inf))>floor-.1
    corridor=indoor&(distance(X,Y,route)<=.6)
    off=indoor&~corridor
    metrics=dict(corridor_p5_p50_p95_m=np.quantile((visible-floor)[corridor],[.05,.5,.95]).tolist(),corridor_min_max_m=[float((visible-floor)[corridor].min()),float((visible-floor)[corridor].max())],off_path_p5_p50_p95_m=np.quantile((visible-floor)[off],[.05,.5,.95]).tolist(),off_path_15_40cm_fraction=float(((visible[off]-floor>=.15)&(visible[off]-floor<=.4)).mean()),indoor_max_above_floor_m=float((visible-floor)[indoor].max()),chip_contact_visual_error_p95_m=float(np.quantile(np.abs(contact-visible)[corridor],.95)),chip_contact_visual_error_max_m=float(np.max(np.abs(contact-visible)[corridor])))
    write_json(out/'look-metrics.json',metrics)
    metadata=dict(draft=True,source_layout_sha256=sha(source/'layout.json'),generator='house-look-loose/1',source=f'{WORLD_ID}/f1',triangles=sum(len(scene['meshes'][m['mesh']]['i'])//3 for m in scene['models']),house_triangles=len(data['building']),physics='dust/porch heightfield only; individual convex loose pieces; conservative chip-cluster boxes; 10cm house wall columns',collision_geometries=len(wb),ray_only_proxies=0,source_heightmap=sha(out/'height.png'),heightfield_quantization_m=hrange/255,reused_fragments=1085,added_fragments=150,loose_pile_pieces=len(pieces),chip_contact_clusters=len(clusters),house_albedo_resolution=[512,512],metrics=metrics,limitations='small-chip contact boxes fill sub-cell gaps, height scan sees these conservative supports; house walls are body-band columns, roof/furniture visual only; phone unverified')
    write_json(mobile/'metadata.json',metadata)
    # Remove only named obsolete generated outputs, never local source files.
    for i in range(32):
        p=out/f'meshes/house_color_{i:02}.obj'
        if p.exists():p.unlink()
    for i in range(400):
        p=mobile/f'piece_{i:03}.obj'
        if p.exists():p.unlink()
    for name in ['terrain_v2.obj',*[f'fragments_{i}.obj' for i in range(8)],'house.obj']:
        p=out/'meshes'/name
        if p.exists():p.unlink()
    p=out/'dust.png'
    if p.exists():p.unlink()
    catalogue_path=out.parent/'worlds.json'
    catalogue=json.loads(catalogue_path.read_text())
    entry=catalogue['worlds'][f'{WORLD_ID}/f1']
    entry['height_source']='dust_heightfield_and_loose_convex_pieces'
    entry['sha256']=dict(world=sha(out/f'{WORLD_ID}.sdf'),map=sha(out/'maps/f1.yaml'),metadata=sha(out/'maps/metadata.json'))
    catalogue_path.write_text(json.dumps(catalogue,ensure_ascii=False,indent=2)+'\n')
    asset_bytes=sum(p.stat().st_size for folder in (out,mobile) for p in folder.rglob('*') if p.is_file())
    assert asset_bytes<=15_000_000,asset_bytes
    print(json.dumps(dict(image_sha256=image_sha,asset_bytes=asset_bytes,**metadata),indent=2))
    return image_sha
