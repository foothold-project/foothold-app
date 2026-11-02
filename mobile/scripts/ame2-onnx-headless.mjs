// Headless Chrome only; ephemeral loopback port; no robot/service endpoints.
// Run sync-web with FH_AME2_SRC first. --walk includes six-map traces; --ui-only skips parity/benchmarks.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync,writeFileSync } from 'node:fs';
import { extname,resolve,sep,join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {cpus,loadavg} from 'node:os';
const {chromium}=await import(pathToFileURL(process.env.FH_PLAYWRIGHT));
const root=resolve('mobile/www'), exported=resolve(process.env.AME2_EXPORT);
const server=createServer((req,res)=>{
  const path=new URL(req.url,'http://localhost').pathname;
  let file=resolve(root,'.'+path);
  if(['/check.json','/ame2_actor_crop_test.onnx','/onnx-observations.json'].some(p=>path==='/sim'+p))file=join(exported,path.split('/').at(-1));
  else if(process.env.AME2_TEST_RUNTIME === '1' && path.startsWith('/sim/ort/'))file=resolve('mobile/node_modules/onnxruntime-web/dist',path.split('/').at(-1));
  else if(process.env.AME2_TEST_RUNTIME === '1' && path==='/sim/ame2_actor.onnx')file=join(exported,'ame2_actor.onnx');
  else if(!file.startsWith(root+sep)){res.writeHead(403);res.end();return;}
  if(path==='/sim/onnx-test.html'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>AME2 offline test</title>');return;}
  try {res.setHeader('Content-Type',({'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.json':'application/json','.wasm':'application/wasm','.png':'image/png','.css':'text/css'})[extname(file)]??'application/octet-stream');res.end(readFileSync(file));}
  catch{res.writeHead(404);res.end();}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const url=`http://127.0.0.1:${server.address().port}/sim/`;
let browser;
try {
  browser=await chromium.launch({executablePath:process.env.FH_CHROME||'/usr/bin/google-chrome',headless:true,args:['--no-sandbox','--enable-webgl','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-webgpu']});
  const browserCdp=await browser.newBrowserCDPSession();
  const processMemory=async()=>{
    const {processInfo}=await browserCdp.send('SystemInfo.getProcessInfo');
    return processInfo.map(({type,id})=>{
      let rssKiB=null;
      try {rssKiB=Number(readFileSync(`/proc/${id}/status`,'utf8').match(/^VmRSS:\s+(\d+)/m)?.[1]);}catch{}
      return {type,rssKiB};
    });
  };
  for(const backend of (process.argv.includes('--ui-only') ? [] : ['wasm','webgpu'])) {
    const page=await browser.newPage();
    await page.goto(url+'onnx-test.html');
    // Separate renderer per EP: each Emscripten build owns its initialization.
    const cdp=await page.context().newCDPSession(page);
    const heapBefore=await cdp.send('Runtime.getHeapUsage');
    const rssBefore=await processMemory();
    const hostLoadBefore=loadavg();
    await page.exposeFunction('__measureAme2Memory',async()=>({heap:await cdp.send('Runtime.getHeapUsage'),rss:await processMemory()}));
    let result;
    try {
      result=await page.evaluate(async({backend,walk})=>{
        const read=async(p)=>{const r=await fetch(p);if(!r.ok)throw Error(p+' '+r.status);return r;};
        const json=async(p)=>(await read(p)).json();
        const buffer=async(p)=>(await read(p)).arrayBuffer();
        const stats=a=>{const s=[...a].sort((a,b)=>a-b);return{n:a.length,p50:s[Math.floor(s.length*.5)],p95:s[Math.floor(s.length*.95)]};};
        const t0=performance.now();
        const ort=await import('./ort/ort.'+(backend==='webgpu'?'webgpu':'wasm')+'.min.mjs');
        ort.env.wasm.numThreads=1;ort.env.wasm.proxy=false;ort.env.wasm.wasmPaths=new URL('./ort/',location.href).href;
        const [{loadAme2Policy},{loadAme2OnnxPolicy},{fixedAme2Cases,compareAme2Cases},model,manifest,f32buf]=await Promise.all([
          import('./ame2-network.js'),import('./ame2-onnx.js'),import('./ame2-onnx-check.js'),buffer('ame2_actor.onnx'),json('ame2_actor.json'),buffer('ame2_actor.f32')]);
        const f32=loadAme2Policy(f32buf,manifest),onnx=await loadAme2OnnxPolicy(ort,model,backend);
        const p=new Float32Array(49),m=new Float32Array(1131);p[8]=-1;p[48]=1;
        const first=performance.now();await onnx(p,m);
        const firstInferenceMs=performance.now()-first,firstLoadMs=performance.now()-t0;
        const times=[],jsTimes=[];
        for(let i=0;i<110;i++) {let t=performance.now();await onnx(p,m);if(i>=10)times.push(performance.now()-t);t=performance.now();f32(p,m);if(i>=10)jsTimes.push(performance.now()-t);}
        const benchmarkMemory=await window.__measureAme2Memory();
        const crop=await buffer('ame2_actor_crop_test.onnx');
        let fixed,recorded;
        try {
          fixed=await compareAme2Cases(ort,model,crop,f32,fixedAme2Cases(await json('check.json')),backend);
          recorded=await compareAme2Cases(ort,model,crop,f32,await json('onnx-observations.json'),backend);
        } catch(e) {if(backend==='wasm')throw e;fixed={error:e.message};}
        let traces;
        if(walk && backend==='wasm') {
          const {default:load}=await import('./mujoco/mujoco.js');
          const {createSim,ISAAC_LIKE}=await import('./sim.js');
          const {compareAme2Walk}=await import('./ame2-onnx-walk.js');
          const mj=await load();mj.FS.mkdir('/go2');mj.FS.mkdir('/go2/assets');
          const meshes=['base_0','base_1','base_2','base_3','base_4','hip_0','hip_1','thigh_0','thigh_1','thigh_mirror_0','thigh_mirror_1','calf_0','calf_1','calf_mirror_0','calf_mirror_1','foot'];
          const bytes=async(p)=>new Uint8Array(await buffer(p));
          mj.FS.writeFile('/go2/go2.xml',await bytes('assets/unitree_go2/go2.xml'));
          for(const f of meshes)mj.FS.writeFile('/go2/assets/'+f+'.obj',await bytes('assets/unitree_go2/assets/'+f+'.obj'));
          traces=await compareAme2Walk(mj,createSim,ISAAC_LIKE,f32,onnx,bytes);
        }
        await onnx.dispose();
        return {backend,firstLoadMs,firstInferenceMs,onnxMs:stats(times),jsMs:stats(jsTimes),benchmarkMemory,fixed,recorded,traces};
      },{backend,walk:process.argv.includes('--walk')});
    } catch(e) {result={backend,error:e.message};if(backend==='wasm')throw e;}
    const heapAfter=await cdp.send('Runtime.getHeapUsage');
    // This reports JS/backing storage, not total GPU or process RSS.
    result.memory={scope:'CDP JS heap/backing storage plus sampled browser processes RSS; GPU allocation not isolated',before:heapBefore,after:heapAfter,rssBefore,rssAfter:await processMemory()};
    result.browser=browser.version();
    result.host={cpu:cpus()[0].model,logicalCpus:cpus().length,loadBefore:hostLoadBefore,loadAfter:loadavg(),gpuMode:'headless ANGLE SwiftShader; WebGPU unsafe flag for comparison'};
    writeFileSync(`runs/ame2-onnx/browser-${backend}.json`,JSON.stringify(result));
    const {traces,...summary}=result;console.log(JSON.stringify({...summary,walk:traces?.records.map(({trajectories,...s})=>s)}));
    await page.close();
  }
  const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(url+'index.html?policy=ame2-demo&ame2Backend=wasm');
  await page.waitForFunction(()=>window.__sim?.ready,null,{timeout:60000});
  assert.match(await page.locator('#ame2Engine').textContent(),/ONNX WASM/);
  await page.screenshot({path:'runs/ame2-onnx/wasm-sim.png'});
  await page.click('#go');await page.waitForFunction(()=>__sim.sim.t>.04);
  await page.dispatchEvent('#stop','pointerdown');
  const at=await page.evaluate(()=>__sim.sim.t);await page.waitForTimeout(100);
  assert.equal(await page.evaluate(()=>__sim.sim.t),at);
  assert.deepEqual(await page.evaluate(()=>__sim.cmd()),[0,0,0,1]);
  // Delay actual session.run, then STOP/reset/lifecycle while an action awaits.
  await page.evaluate(async()=>{
    const ort=await import('./ort/ort.wasm.min.mjs');
    const original=ort.InferenceSession.prototype.run;
    window.__runs={started:0,active:0,max:0,release:null};
    ort.InferenceSession.prototype.run=async function(...args){
      __runs.started++;__runs.active++;__runs.max=Math.max(__runs.max,__runs.active);
      try{await new Promise(r=>{__runs.release=r;});return await original.apply(this,args);}
      finally{__runs.active--;}
    };
  });
  for(const event of ['stop','blur','visibilitychange','pagehide','reset']) {
    await page.click('#go');await page.waitForFunction(()=>__runs.active===1);
    const before=await page.evaluate(()=>({t:__sim.sim.t,started:__runs.started}));
    if(event==='stop')await page.dispatchEvent('#stop','pointerdown');
    else if(event==='reset')await page.click('#reset');
    else await page.evaluate(ev=>{if(ev==='visibilitychange'){Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event(ev));delete document.hidden;}else window.dispatchEvent(new Event(ev));},event);
    assert.equal(await page.evaluate(()=>__sim.stopped()),true);
    assert.deepEqual(await page.evaluate(()=>__sim.cmd()),[0,0,0,1]);
    await page.evaluate(()=>__runs.release());await page.waitForFunction(()=>__runs.active===0);
    await page.waitForTimeout(75);
    assert.equal(await page.evaluate(()=>__sim.sim.t),event==='reset'?0:before.t,'discard late action: '+event);
    assert.equal(await page.evaluate(()=>__runs.max),1);
    assert.equal(await page.evaluate(()=>__runs.started),before.started,'no inference queue');
  }
  await page.close();
  // Initialization missing file/runtime + hash mismatch + runtime-run failure.
  for(const failure of ['model','runtime','wasm','hash','run']) {
    const p=await browser.newPage();p.on('pageerror',e=>errors.push(e.message));
    if(failure==='model')await p.route('**/ame2_actor.onnx',r=>r.fulfill({status:404,body:'missing'}));
    if(failure==='runtime')await p.route('**/ort.wasm.min.mjs',r=>r.fulfill({status:404,body:'missing'}));
    if(failure==='wasm')await p.route('**/ort-wasm-simd-threaded.wasm',r=>r.fulfill({status:404,body:'missing'}));
    if(failure==='hash')await p.route('**/ame2_actor.onnx',r=>r.fulfill({status:200,body:Buffer.from('bad model')}));
    await p.goto(url+'index.html?policy=ame2-demo&ame2Backend=wasm');
    await p.waitForFunction(()=>window.__sim?.ready,null,{timeout:60000});
    if(failure==='run')await p.evaluate(async()=>{const ort=await import('./ort/ort.wasm.min.mjs');ort.InferenceSession.prototype.run=async()=>{throw Error('injected run failure');};});
    await p.click('#go');await p.waitForFunction(()=>__sim.sim.t>.04);
    assert.match(await p.locator('#ame2Engine').textContent(),/f32 되돌림/);
    assert.equal(await p.locator('#ame2Engine').isVisible(),true);
    await p.close();
  }
  const f32=await browser.newPage();await f32.goto(url+'index.html?policy=ame2-demo&ame2Backend=f32');await f32.waitForFunction(()=>window.__sim?.ready);
  assert.match(await f32.locator('#ame2Engine').textContent(),/f32 JS/);await f32.close();
  assert.deepEqual(errors,[]);
  console.log('AME2 ONNX headless PASS: WASM sim execution, one pending run, STOP/blur/hidden/pagehide/reset discard, missing model/runtime/wasm/hash/run failure visible f32 fallback, explicit f32');
} finally {await browser?.close();await new Promise(r=>server.close(r));}
