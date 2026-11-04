// Sync www first. Headless localhost only; TERRAIN_BASE_REF is the pre-change
// main.js commit. Run under the shared heavy-test flock.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildTerrain, SCHEMA } from '../sim/terrain/index.js';

assert.ok(process.env.TERRAIN_BASE_REF,'TERRAIN_BASE_REF must identify pre-change main.js');
const baseline=execFileSync('git',['show',`${process.env.TERRAIN_BASE_REF}:mobile/sim/main.js`],{encoding:'utf8'});
assert.ok(!baseline.includes('loadCustomTerrain'),'baseline must precede custom-terrain branch');
const root=resolve('mobile/www'),forbidden=[8453,8792,5190,5191,5195,8870,9430,9761];
const server=createServer((req,res)=>{
  let pathname=new URL(req.url,'http://localhost').pathname;
  const before=pathname.startsWith('/before/');if(before)pathname=pathname.slice('/before'.length);
  const file=resolve(root,'.'+pathname);
  if(!file.startsWith(root+sep))return res.writeHead(403).end();
  try{const body=before&&pathname==='/sim/main.js'?baseline:readFileSync(file);
    res.setHeader('Content-Type',({'.js':'text/javascript','.mjs':'text/javascript','.wasm':'application/wasm','.json':'application/json','.html':'text/html','.css':'text/css','.png':'image/png','.svg':'image/svg+xml'})[extname(file)]??'application/octet-stream');res.end(body);
  }catch{res.writeHead(404).end();}
});
do{await new Promise(r=>server.listen(0,'127.0.0.1',r));if(!forbidden.includes(server.address().port))break;await new Promise(r=>server.close(r));}while(true);
const origin=`http://127.0.0.1:${server.address().port}`;
const {chromium}=await import(pathToFileURL(process.env.FH_PLAYWRIGHT));
let browser;const records=[],pageErrors=[];
const spec={schema:SCHEMA,id:'browser-terrain',name:'브라우저 시험',size:[12,10],spawn:[-4,-3,.3],items:[{kind:'box',x:0,y:0,yaw:.4,sx:1,sy:1,h:.3}]};
try{
  browser=await chromium.launch({executablePath:process.env.FH_CHROME||'/usr/bin/google-chrome',headless:true,args:['--no-sandbox','--enable-webgl','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  async function pageFor(query,{raw=JSON.stringify(spec),id=spec.id,before=false,blocked=false}={}){
    const page=await browser.newPage({viewport:{width:1100,height:800}}),requests=[];
    page.on('pageerror',e=>pageErrors.push(e.message));page.on('request',r=>requests.push(new URL(r.url()).pathname));
    await page.addInitScript(({raw,id,blocked})=>{
      requestAnimationFrame=cb=>{window.__frame=cb;return 1;};Math.random=()=>0;
      if(raw!==null)localStorage.setItem('fh.customTerrain.'+id,raw);
      if(blocked)Object.defineProperty(Storage.prototype,'getItem',{value(){throw Error('blocked');}});
    },{raw,id,blocked});
    await page.goto(`${origin}${before?'/before':''}/sim/index.html?policyBackend=f32&${query}`);
    await page.waitForFunction(()=>window.__sim?.ready||window.__sim?.err,null,{timeout:60000,polling:100});
    return {page,requests};
  }
  for(const item of [spec.items,{kind:'stairs',x:0,y:0,yaw:.3,width:1.5,steps:4,rise:.12,run:.3},{kind:'ramp',x:-1,y:0,yaw:.25,length:2,width:1.3,h:.6}]){
    const current={...spec,items:Array.isArray(item)?item:[item,...(item.kind==='ramp'?[{kind:'gap',x:2,y:0,yaw:.4,length:.5,width:2}]:[])]};
    const {page,requests}=await pageFor(`from=web&map=custom&terrain=${spec.id}`,{raw:JSON.stringify(current)});
    try{
      assert.equal(await page.evaluate(()=>__sim.err),null);
      const result=await page.evaluate(()=>({start:__sim.start(),geoms:__sim.sim.m.ngeom,xml:__sim.sim.m.nmesh}));
      assert.deepEqual(result.start.xy,current.spawn.slice(0,2));assert.equal(result.start.yaw,.3);assert.equal(result.start.floorZ,0);
      assert.ok(!requests.some(p=>/assets\/(custom|warehouse)\//.test(p)),'custom never fetches fallback/static terrain');
      assert.equal(await page.locator('canvas').count(),1);
      records.push({case:current.items[0].kind,ready:true,geoms:result.geoms});
    }finally{await page.close();}
  }
  const failures=[
    ['missing','map=custom&terrain=browser-terrain',{raw:null},/저장된 지형이 없습니다/],
    ['missing-id','map=custom',{},/id가/],
    ['bad-id','map=custom&terrain=../xml',{},/id가/],
    ['json','map=custom&terrain=browser-terrain',{raw:'{'},/JSON/],
    ['invalid','map=custom&terrain=browser-terrain',{raw:JSON.stringify({...spec,size:[1,1]})},/바닥/],
    ['mismatch','map=custom&terrain=browser-terrain',{raw:JSON.stringify({...spec,id:'other'})},/다릅니다/],
    ['storage-blocked','map=custom&terrain=browser-terrain',{blocked:true},/저장소/],
  ];
  for(const [name,query,options,pattern]of failures){
    const {page,requests}=await pageFor(query,options);
    try{const result=await page.evaluate(()=>({ready:__sim.ready,error:__sim.err,text:document.getElementById('policyReason').textContent}));
      assert.equal(result.ready,false);assert.match(result.error,pattern);assert.match(result.text,pattern);assert.equal(await page.locator('#fail').isVisible(),true);
      assert.ok(!requests.some(p=>/assets\/(custom|warehouse)\//.test(p)));records.push({case:name,visibleFailure:true});
    }finally{await page.close();}
  }
  // Existing maps use identical resources and exact default URL, differing only
  // in main.js served from the immutable base commit vs the current bundle.
  for(const map of ['warehouse','factory-inspection','element-course']){
    const trajectories=[];
    for(const before of [true,false]){
      const {page}=await pageFor(`map=${map}`,{before,raw:null});
      try{assert.equal(await page.evaluate(()=>__sim.err),null);
        trajectories.push(await page.evaluate(async()=>{const rows=[],sim=__sim.sim;for(let k=0;k<150;k++){sim.cmd=k<100?[.6,0,0]:[.6,0,.5];await sim.step();rows.push([...sim.d.qpos,...sim.d.qvel,...sim.d.ctrl,...sim.grav,sim.t]);}return rows;}));
      }finally{await page.close();}
    }
    let maxAbs=0;for(let k=0;k<150;k++)for(let j=0;j<trajectories[0][k].length;j++){const delta=Math.abs(trajectories[0][k][j]-trajectories[1][k][j]);assert.ok(Number.isFinite(delta));maxAbs=Math.max(maxAbs,delta);}
    assert.equal(maxAbs,0,`${map}: default trajectory exact`);records.push({case:'default-parity',map,seconds:3,maxAbs});
  }
  // A real browser can consume the top SVG with no external resources.
  const page=await browser.newPage();try{const svg=buildTerrain(spec).top.svg;
    const pixels=await page.evaluate(async svg=>{const image=new Image();image.src=URL.createObjectURL(new Blob([svg],{type:'image/svg+xml'}));await image.decode();URL.revokeObjectURL(image.src);return [image.naturalWidth,image.naturalHeight];},svg);
    assert.ok(pixels.every(x=>x>0));records.push({case:'top-svg',decoded:true});
  }finally{await page.close();}
  assert.deepEqual(pageErrors,[]);
  if(process.env.TERRAIN_BROWSER_REPORT)writeFileSync(process.env.TERRAIN_BROWSER_REPORT,JSON.stringify({base:process.env.TERRAIN_BASE_REF,records},null,2)+'\n');
  console.log(JSON.stringify(records,null,2));console.log('custom terrain browser PASS: real page custom loading, visible failures, SVG, 3 maps × exact default trajectory');
}finally{await browser?.close();await new Promise(r=>server.close(r));}
