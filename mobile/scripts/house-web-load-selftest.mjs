// Real, unmodified main.js loader + headless rendering; no listening ports.
// FH_SIM_SRC=<existing dependencies> FH_PLAYWRIGHT=<playwright index.mjs> node ...
// Optional --previous=<PNG-tile asset directory> compares policy height rays.
// Optional --output=<json> and --screenshot=<png> keep local evidence only.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join, dirname, extname, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const arg = name => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
assert.ok(process.env.FH_SIM_SRC && process.env.FH_PLAYWRIGHT, 'FH_SIM_SRC and FH_PLAYWRIGHT required');
const { chromium } = await import(pathToFileURL(resolve(process.env.FH_PLAYWRIGHT)));
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const simRoot = join(repo, 'mobile/sim'), src = resolve(process.env.FH_SIM_SRC);
const assetRoot = join(simRoot, 'assets/collapsed-house-v2');
const previous = arg('previous') && resolve(arg('previous'));
const origin = 'https://house-selftest.invalid';
const mime = { '.html':'text/html', '.js':'text/javascript', '.mjs':'text/javascript', '.json':'application/json', '.wasm':'application/wasm', '.png':'image/png', '.css':'text/css' };
const requests = [], pageErrors = [], failedRequests = [];
const safe = (root, relative) => {
  const file = resolve(root, relative);
  assert.ok(file.startsWith(root + sep), 'request stays inside its fixture root');
  return file;
};
const browser = await chromium.launch({headless:true, executablePath:process.env.FH_CHROME || '/usr/bin/google-chrome',
  args:['--enable-webgl','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
try {
  const context = await browser.newContext({ viewport:{width:1100,height:800}, serviceWorkers:'block' });
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if(url.origin !== origin) { await route.abort(); return; }
    const path = decodeURIComponent(url.pathname);
    requests.push(path);
    if(path === '/sim/__probe.html') { await route.fulfill({contentType:'text/html',body:'<!doctype html><title>House measurements</title>'}); return; }
    let file;
    if(path.startsWith('/sim/__previous/') && previous) file = safe(previous,path.slice('/sim/__previous/'.length));
    else if(path.startsWith('/sim/mujoco/')) file = safe(join(src,'node_modules/@mujoco/mujoco'),path.slice('/sim/mujoco/'.length));
    else if(path.startsWith('/sim/vendor/')) file = safe(join(src,'vendor'),path.slice('/sim/vendor/'.length));
    else if(path.startsWith('/sim/assets/unitree_go2/')) file = safe(join(src,'assets/unitree_go2'),path.slice('/sim/assets/unitree_go2/'.length));
    else if(['/sim/policy_v2.f32','/sim/ame2_actor.f32','/sim/ame2_actor.json'].includes(path)) file = safe(src,path.slice('/sim/'.length));
    else if(path === '/brand/tokens/foothold.tokens.css') file = join(repo,'ui/public/brand/tokens/foothold.tokens.css');
    else if(path.startsWith('/sim/')) file = safe(simRoot,path.slice('/sim/'.length));
    if(!file || !existsSync(file)) {
      failedRequests.push(path);
      await route.fulfill({status:404,body:'Not found'}); return;
    }
    await route.fulfill({contentType:mime[extname(file)] || 'application/octet-stream',body:readFileSync(file)});
  });
  const page = await context.newPage();
  page.on('pageerror', error => pageErrors.push(error.message));
  const start = performance.now();
  await page.goto(origin+'/sim/index.html?map=collapsed-house-v2');
  await page.waitForFunction(() => window.__sim?.ready || window.__sim?.err, null, {timeout:90000});
  const ui = await page.evaluate(() => ({ ready:__sim.ready,err:__sim.err,engine:__sim.policyEngine,
    worldGeoms:__sim.sim ? Array.from(__sim.sim.m.geom_bodyid).filter(b=>b===0).length : 0,
    qpos:__sim.sim ? Array.from(__sim.sim.d.qpos.slice(0,7)) : null,
    canvas:!!document.querySelector('canvas'),busy:!document.getElementById('busy').hidden,
    failed:!document.getElementById('fail').hasAttribute('hidden'),stopped:__sim.stopped?.() }));
  ui.loadMs = performance.now()-start;
  assert.equal(ui.err,null); assert.equal(ui.ready,true); assert.ok(ui.canvas && !ui.busy && !ui.failed,JSON.stringify(ui));
  assert.equal(ui.worldGeoms,JSON.parse(readFileSync(join(assetRoot,'metadata.json'))).collision_geometries);
  assert.ok(ui.qpos.every(Number.isFinite)); assert.equal(ui.stopped,true);
  assert.ok(requests.includes('/sim/main.js') && requests.includes('/sim/assets/collapsed-house-v2/collapsed-house-v2.xml'));
  assert.deepEqual(pageErrors,[]);
  if(arg('screenshot')) await page.screenshot({path:arg('screenshot')});
  await page.close();

  const probe = await context.newPage(); await probe.goto(origin+'/sim/__probe.html');
  const cdp = await context.newCDPSession(probe);
  const measurement = await probe.evaluate(async hasPrevious => {
    const {default:load} = await import('./mujoco/mujoco.js');
    const mj = await load(); mj.FS.mkdir('/w');
    const models = [];
    for(const [label,root] of [...(hasPrevious ? [['previous','./__previous/']] : []),['current','./assets/collapsed-house-v2/']]) {
      const map = await (await fetch(root+'map.json')).json();
      for(const f of map.physics_assets) mj.FS.writeFile('/w/'+f,new Uint8Array(await (await fetch(root+f)).arrayBuffer()));
      mj.FS.writeFile('/w/world.xml',new Uint8Array(await (await fetch(root+'collapsed-house-v2.xml')).arrayBuffer()));
      const t=performance.now(),m=mj.MjModel.from_xml_path('/w/world.xml'),d=new mj.MjData(m);
      mj.mj_forward(m,d); models.push({label,m,d,compileMs:performance.now()-t});
    }
    const {getPolicyAdapter,makeTerrainSampler} = await import('./policy-adapters.js');
    const {makeLidar} = await import('./lidar.js');
    const points=[[3.85,-9.35],[3.85,-6.5],[4.6,-6],[-9,0],[9,4],[0,0],[-5,-8]];
    const hit=new mj.IntBuffer(1), reference=models[0];
    const poses=points.map(([x,y])=>{
      const distance=mj.mj_ray(reference.m,reference.d,[x,y,2],[0,0,-1],[1,1,0,0,1,0],true,-1,hit,null);
      return {x,y,z:(distance<0?0:2-distance)+.4};
    });
    const heights={},samplers=[];let maxHeightDifference=0;
    for(const {label,m,d} of models) {
      const sample=makeTerrainSampler(mj,m,d,getPolicyAdapter().observations.height);
      samplers.push(sample);
      heights[label]=poses.map(({x,y,z})=>{const h=new Float64Array(187);sample([x,y,z-.1,1,0,0,0],h);return Array.from(h);});
    }
    if(heights.previous)for(let p=0;p<poses.length;p++)for(let i=0;i<187;i++)
      maxHeightDifference=Math.max(maxHeightDifference,Math.abs(heights.previous[p][i]-heights.current[p][i]));
    const current=models.find(m=>m.label==='current');
    window.__houseProbe={mj,models,samplers,hit,poses,scan:makeLidar(mj,current.m,current.d)};
    return {poses,maxHeightDifference,heightRays:poses.length*187,compile:models.map(({label,compileMs})=>({label,compileMs}))};
  },!!previous);
  assert.ok(measurement.maxHeightDifference<1e-6,'policy height rays preserved by inline storage/group change');
  const performanceByCpu={};
  for(const rate of [1,4]) {
    await cdp.send('Emulation.setCPUThrottlingRate',{rate});
    performanceByCpu[rate]=await probe.evaluate(() => __houseProbe.poses.map(({x,y,z})=>{
      const {scan}=__houseProbe;scan(x,y,z,Math.PI/2);
      const times=[];let rays;
      for(let i=0;i<10;i++){const t=performance.now();rays=scan(x,y,z,Math.PI/2);times.push(performance.now()-t);}
      const sorted=times.slice().sort((a,b)=>a-b);
      return {x,y,z,meanMs:times.reduce((a,b)=>a+b)/times.length,medianMs:(sorted[4]+sorted[5])/2,maxMs:Math.max(...times),hits:Array.from(rays).filter(Number.isFinite).length};
    }));
    assert.ok(performanceByCpu[rate].every(p=>p.maxMs<100),'lidar fits the 100ms period under CPU throttling');
  }
  await cdp.send('Emulation.setCPUThrottlingRate',{rate:1});
  await probe.evaluate(()=>{const p=__houseProbe;for(const s of p.samplers)s.dispose();p.hit.delete();for(const {m,d} of p.models){d.delete();m.delete();}});
  const result={browser:browser.version(),ui,measurement,performanceByCpu,pageErrors,failedRequests,
    xmlBytes:readFileSync(join(assetRoot,'collapsed-house-v2.xml')).length,
    physicsAssets:JSON.parse(readFileSync(join(assetRoot,'map.json'))).physics_assets,
    mainSha256:createHash('sha256').update(readFileSync(join(simRoot,'main.js'))).digest('hex')};
  if(arg('output'))writeFileSync(arg('output'),JSON.stringify(result,null,2));
  console.log(JSON.stringify(result,null,2));
}finally{await browser.close();}
