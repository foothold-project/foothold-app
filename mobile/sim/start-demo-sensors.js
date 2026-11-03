const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
// RayCaster ordering='yx': y varies fastest; ONNX shape [32,16].
export const startDemoGrid = Array.from({ length: 512 }, (_, i) => [-.475 + .05*Math.floor(i/16), -.375 + .05*(i%16)]);
function terrainOnly(m, run) {
  const groups = m.geom_group, excluded = [];
  for (let g = 0; g < m.ngeom; g++) if (m.geom_bodyid[g] !== 0 || (!m.geom_contype[g] && !m.geom_conaffinity[g])) { excluded.push([g, groups[g]]); groups[g] = 5; }
  try { return run(); } finally { for (const [g, group] of excluded) groups[g] = group; }
}
export function makeStartDemoMap(mj, m, d, makeTerrainSampler) {
  const cfg = { grid: startDemoGrid, rayOffset: 20 }, sample = makeTerrainSampler(mj,m,d,cfg);
  const heights = new Float64Array(512), hit = new mj.IntBuffer(1), normal = new mj.DoubleBuffer(3);
  const scan = (q, out = new Float32Array(512)) => {
    const t = performance.now(), point = Float64Array.from(q.slice(0,3)); cfg.rayOffset = 20;
    terrainOnly(m, () => {
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
function rotate(q, x,y,z) {
  const [w,a,b,c] = q.slice(3,7);
  return [(1-2*(b*b+c*c))*x+2*(a*b-w*c)*y+2*(a*c+w*b)*z,
    2*(a*b+w*c)*x+(1-2*(a*a+c*c))*y+2*(b*c-w*a)*z,
    2*(a*c-w*b)*x+2*(b*c+w*a)*y+(1-2*(a*a+b*b))*z];
}
export function makeStartDemoDepth(mj,m,d) {
  const n = 3600, vec = new Float64Array(n*3), local = new Float64Array(n*3), axial = new Float64Array(n);
  const dist = new mj.DoubleBuffer(n), gid = new mj.IntBuffer(n), out = new Float32Array(n);
  const angle = 35*Math.PI/180, c = Math.cos(angle), s = Math.sin(angle);
  for (let v = 0; v < 60; v++) for (let u = 0; u < 60; u++) {
    const i = v*60+u, y = -(u-30)/55.9, z = -(v-30)/54.1, len = Math.hypot(1,y,z);
    // Optical forward is body +x, image right is body -y, image down is -z.
    local.set([(c+s*z)/len,y/len,(-s+c*z)/len],i*3); axial[i] = 1/len;
  }
  const scan = (q) => {
    const t = performance.now(), offset = rotate(q,.25,0,.12), origin = offset.map((x,i) => x+q[i]);
    for (let i = 0; i < n; i++) vec.set(rotate(q,...local.subarray(i*3,i*3+3)),i*3);
    terrainOnly(m, () => mj.mj_multiRay(m,d,origin,vec,[1,1,0,0,1,0],true,-1,gid,dist,null,n,4));
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
