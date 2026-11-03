const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
// RayCaster ordering='yx': y varies fastest; ONNX shape [32,16].
export const startDemoGrid = Array.from({ length: 512 }, (_, i) => [-.475 + .05*Math.floor(i/16), -.375 + .05*(i%16)]);
function terrainOnly(m, d, run, origin = null, cutoff = Infinity, planes = []) {
  // Each embind property access creates a WASM view. Acquire once per scan,
  // rather than three fresh model views for every geometry.
  const groups = m.geom_group, body = m.geom_bodyid, contype = m.geom_contype, affinity = m.geom_conaffinity, types = m.geom_type, excluded = [];
  const pos = origin ? d.geom_xpos : null, mat = origin ? d.geom_xmat : null, aabb = origin ? m.geom_aabb : null;
  for (let g = 0; g < m.ngeom; g++) {
    let skip = body[g] !== 0 || (!contype[g] && !affinity[g]);
    if (!skip && origin && aabb && types[g] !== 0 && types[g] !== 1) {
      // Conservative world AABB vs the ray cutoff sphere. Infinite planes
      // and heightfields stay eligible (MuJoCo's heightfield bounds use a
      // different convention). Surviving rays use exact native intersections.
      const a = 6*g, r = 9*g, center = [], extent = []; let distance2 = 0;
      for (let axis = 0; axis < 3; axis++) {
        const t = r+axis*3;
        center[axis] = pos[3*g+axis]+mat[t]*aabb[a]+mat[t+1]*aabb[a+1]+mat[t+2]*aabb[a+2]-origin[axis];
        extent[axis] = Math.abs(mat[t])*aabb[a+3]+Math.abs(mat[t+1])*aabb[a+4]+Math.abs(mat[t+2])*aabb[a+5];
        const delta = Math.max(0,Math.abs(center[axis])-extent[axis]-1e-9);
        distance2 += delta*delta;
      }
      skip = distance2 > cutoff*cutoff;
      // AABB wholly outside a camera half-space cannot meet any of its rays.
      if (!skip) skip = planes.some((p) => p.reduce((sum,x,i) => sum+x*center[i]-Math.abs(x)*extent[i],0) > 1e-9);
    }
    if (skip && groups[g] !== 5) { excluded.push([g,groups[g]]); groups[g] = 5; }
  }
  try { return run(); } finally { for (const [g, group] of excluded) groups[g] = group; }
}
export function makeStartDemoMap(mj, m, d, makeTerrainSampler) {
  const cfg = { grid: startDemoGrid, rayOffset: 20 }, sample = makeTerrainSampler(mj,m,d,cfg);
  const heights = new Float64Array(512), hit = new mj.IntBuffer(1), normal = new mj.DoubleBuffer(3);
  const scan = (q, out = new Float32Array(512)) => {
    const t = performance.now(), point = Float64Array.from(q.slice(0,3)); cfg.rayOffset = 20;
    terrainOnly(m, d, () => {
      for (let i = 0; i <= m.ngeom && point[2] < q[2]+20; i++) {
        const distance = mj.mj_ray(m,d,point,[0,0,1],[1,1,0,0,1,0],true,-1,hit,normal);
        if (!Number.isFinite(distance) || distance < 0 || point[2]+distance > q[2]+20) break;
        if (normal.GetView()[2] < 0) { cfg.rayOffset = point[2]+distance-q[2]-.001; break; }
        point[2] += distance+.001;
      }
    });
    sample(q,heights);
    for (let i = 0; i < 512; i++) out[i] = Number.isFinite(heights[i]) ? clamp(heights[i]-q[2],-1,1) : -1;
    scan.ms = performance.now()-t;
    return out;
  };
  scan.dispose = () => { sample.dispose(); hit.delete(); normal.delete(); };
  return scan;
}
export function makeStartDemoDepth(mj,m,d,{ cull = true } = {}) {
  const n = 3600, vec = new Float64Array(n*3), local = new Float64Array(n*3), axial = new Float64Array(n);
  const dist = new mj.DoubleBuffer(n), gid = new mj.IntBuffer(n), out = new Float32Array(n);
  const angle = 35*Math.PI/180, c = Math.cos(angle), s = Math.sin(angle);
  for (let v = 0; v < 60; v++) for (let u = 0; u < 60; u++) {
    const i = v*60+u, y = -(u-30)/55.9, z = -(v-30)/54.1, len = Math.hypot(1,y,z);
    // Optical forward is body +x, image right is body -y, image down is -z.
    local.set([(c+s*z)/len,y/len,(-s+c*z)/len],i*3); axial[i] = 1/len;
  }
  const scan = (q) => {
    const t = performance.now(), [qw,qx,qy,qz] = q.slice(3,7);
    const R = [1-2*(qy*qy+qz*qz),2*(qx*qy-qw*qz),2*(qx*qz+qw*qy),2*(qx*qy+qw*qz),1-2*(qx*qx+qz*qz),2*(qy*qz-qw*qx),2*(qx*qz-qw*qy),2*(qy*qz+qw*qx),1-2*(qx*qx+qy*qy)];
    const origin = [q[0]+R[0]*.25+R[2]*.12,q[1]+R[3]*.25+R[5]*.12,q[2]+R[6]*.25+R[8]*.12];
    const forward = [R[0]*c-R[2]*s,R[3]*c-R[5]*s,R[6]*c-R[8]*s];
    const right = [-R[1],-R[4],-R[7]], down = [-R[0]*s-R[2]*c,-R[3]*s-R[5]*c,-R[6]*s-R[8]*c];
    const planes = [forward.map((x)=>-x)];
    for (const [axis,extent] of [[right,30/55.9],[down,30/54.1]]) for (const sign of [-1,1]) planes.push(axis.map((x,i)=>sign*x-extent*forward[i]));
    for (let i = 0; i < n*3; i+=3) {
      const x=local[i],y=local[i+1],z=local[i+2];
      vec[i]=R[0]*x+R[1]*y+R[2]*z;vec[i+1]=R[3]*x+R[4]*y+R[5]*z;vec[i+2]=R[6]*x+R[7]*y+R[8]*z;
    }
    terrainOnly(m,d,() => mj.mj_multiRay(m,d,origin,vec,[1,1,0,0,1,0],true,-1,gid,dist,null,n,4),cull?origin:null,4,planes);
    const distances = dist.GetView();
    for (let i = 0; i < n; i++) {
      // MuJoCo returns ray length; training uses distance to the image plane.
      const depth = distances[i]*axial[i];
      out[i] = Number.isFinite(depth) && distances[i] >= 0 ? clamp((depth-.2)/2.8,0,1) : 1;
    }
    scan.ms = performance.now()-t;
    return out;
  };
  scan.dispose = () => { dist.delete(); gid.delete(); };
  return scan;
}
