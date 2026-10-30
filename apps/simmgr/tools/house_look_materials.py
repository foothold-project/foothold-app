"""Compact shared source materials and read-only 10-23 perimeter fragments."""
import numpy as np
from PIL import Image
import trimesh


def textured_mesh(mesh, tile=1.):
    """Dominant-axis UVs match the original generator, with seam-only duplication."""
    triangles=np.round(mesh.triangles,4)
    axis=np.abs(mesh.face_normals).argmax(1)
    uv=np.empty((len(triangles),3,2))
    for a in range(3):
        keep=[k for k in range(3) if k!=a]
        uv[axis==a]=triangles[axis==a][:,:,keep]/tile
    attributes=np.c_[triangles.reshape(-1,3),np.round(uv.reshape(-1,2),4)]
    vertices,inverse=np.unique(attributes,axis=0,return_inverse=True)
    return trimesh.Trimesh(vertices[:,:3],inverse.reshape(-1,3),process=False),vertices[:,3:]


def write_textured_obj(path,mesh,uv):
    """Shared positions/UVs plus per-face fracture normals; no 3x normal copy."""
    lines=['# Derived fixed rubble; original albedo attribution in NOTICE.md.']
    lines+=['v '+' '.join(f'{v:.4f}' for v in p) for p in mesh.vertices]
    lines+=['vt '+' '.join(f'{v:.4f}' for v in p) for p in uv]
    lines+=['vn '+' '.join(f'{v:.4f}' for v in n) for n in mesh.face_normals]
    lines+=['f '+' '.join(f'{v+1}/{v+1}/{i+1}' for v in face) for i,face in enumerate(mesh.faces)]
    path.write_text('\n'.join(lines)+'\n')


def copy_materials(reference,folders):
    textures=reference/'models/debris_assets/materials/textures'
    result={}
    for name,filename in [('stone','rough_concrete_diffuse.jpg'),('rubble','rubble_diffuse.jpg'),('wood','wood.png')]:
        image=Image.open(textures/filename).convert('RGB').resize((256,256),Image.Resampling.LANCZOS)
        for folder in folders:image.save(folder/f'{name}-albedo.png',optimize=True)
        result[name]=f'{name}-albedo.png'
    return result


def exterior_fragments(reference,building_floor,route,distance,grid_top):
    """Keep source XY/shape, re-seat on actual ground/earlier rubble, never a hill.

    All original exterior boards/slabs and a deterministic rock subset share
    three visual batches. Contact boxes are created separately by the exporter.
    """
    source=[]
    def indoors(x,y):
        z=grid_top(building_floor,np.array([x]),np.array([y]),np.array([[-np.inf]]))
        return np.isfinite(z[0,0])
    for kind,n in [('rock',20),('wood',12),('concrete',12)]:
        stem='slab' if kind=='concrete' else kind
        candidates=[]
        for path in sorted((reference/'models/debris_assets/meshes').glob(f'house_floor_{stem}_*.obj')):
            ts=trimesh.load_mesh(path,process=False).triangles
            assert len(ts)%n==0
            for t in ts.reshape(-1,n,3,3):
                lo,hi=t.min((0,1)),t.max((0,1));c=(lo+hi)/2
                if indoors(*c[:2]):continue
                probes=np.array([[x,y] for x in np.linspace(lo[0],hi[0],5) for y in np.linspace(lo[1],hi[1],5)])
                if distance(probes[:,0],probes[:,1],route).min()<.95:continue
                candidates.append(t.copy())
        if kind=='rock' and len(candidates)>1100:
            candidates=[candidates[i] for i in np.linspace(0,len(candidates)-1,1100,dtype=int)]
        source.extend((t,kind) for t in candidates)
    # The old source had metre-high continuous mounds below these pieces. Drop
    # pieces onto actual support in source-Z order instead of retaining air gaps.
    source.sort(key=lambda item:float(item[0][:,:,2].min()))
    xs=np.arange(-12.975,13,.05);ys=xs.copy();support=np.full((len(ys),len(xs)),-.02)
    result=[]
    for t,kind in source:
        lo,hi=t.min((0,1)),t.max((0,1))
        c=(lo+hi)/2
        ix=int(np.argmin(abs(xs-c[0])));iy=int(np.argmin(abs(ys-c[1])))
        bottom=float(support[iy,ix])+.002
        height=hi[2]-lo[2]
        if height>.65:t[:,:,2]=lo[2]+(t[:,:,2]-lo[2])*.65/height;height=.65
        if bottom+height>.766:bottom=-.018
        t[:,:,2]+=bottom-float(t[:,:,2].min())
        support=grid_top(t,xs,ys,support)
        result.append((t,kind))
    return result
