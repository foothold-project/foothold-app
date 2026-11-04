// REVIEW-270 conditions: real app, default warehouse, headless SwiftShader,
// 520x900, 1.5 s warmup after Run, then ArrowUp held for a 6 s RAF window.
// Same process/port/environment for nvidia and start; never relax Worker 20 ms.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
const { chromium } = await import(pathToFileURL(process.env.FH_PLAYWRIGHT));
const root = resolve(process.env.START_DEMO_BENCH_WWW ?? 'mobile/www');
const server = createServer((req,res) => {
  const file = resolve(root,'.'+new URL(req.url,'http://localhost').pathname);
  if (!file.startsWith(root+sep)) return res.writeHead(403).end();
  try {
    res.setHeader('Content-Type',({'.js':'text/javascript','.mjs':'text/javascript','.wasm':'application/wasm','.json':'application/json','.html':'text/html','.css':'text/css','.png':'image/png'})[extname(file)]??'application/octet-stream');
    let body=readFileSync(file);
    if(file.endsWith(sep+'sim'+sep+'main.js')){
      // Test-only hooks: normal submission cost and a separate fixed-camera
      // GPU-complete probe. No timing hooks are shipped in the app bundle.
      body=body.toString().replace('renderer.render(scene, camera);','const renderStarted=performance.now(); renderer.render(scene, camera); window.__renderSubmitMs?.push(performance.now()-renderStarted);');
      body=body.replace('  let lastDrawAt = -Infinity;',`  let lastDrawAt = -Infinity;
  st.measureFixedDraw = () => {
    sim.cancelPolicyStep(); clock.reset(); sim.reset(); sim.hold(.5); draw();
    const probe=followCamera.clone(); probe.position.set(-3,0,2); probe.lookAt(0,0,.3); probe.updateProjectionMatrix();
    const gl=renderer.getContext(), samples=[];
    for(let k=0;k<10;k++){const t=performance.now();renderer.render(scene,probe);gl.finish();if(k>=2)samples.push(performance.now()-t);}
    return samples;
  };`);
    }
    if(file.endsWith(sep+'sim'+sep+'policy-worker-client.js')) body=body.toString().replace('const late = performance.now() - request.started', "if(request.reply==='result')globalThis.__policyRoundtripMs?.push(performance.now()-request.started);\n    const late = performance.now() - request.started");
    res.end(body);
  } catch { res.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0,'127.0.0.1',r));
let browser; const rows = [];
const summary = (a) => {
  a.sort((x,y) => x-y);
  const at = (p) => a.length ? a[Math.min(a.length-1,Math.floor(a.length*p))] : null;
  return { n:a.length,p50:at(.5),p95:at(.95),max:at(1) };
};
try {
  browser = await chromium.launch({executablePath:process.env.FH_CHROME??'/usr/bin/google-chrome',headless:true,args:['--no-sandbox','--enable-webgl','--use-gl=angle','--use-angle=swiftshader']});
  for (const cpu of (process.env.START_DEMO_CPU_RATES??'1,3').split(',').map(Number)) for (let run=0;run<Number(process.env.START_DEMO_BENCH_RUNS??2);run++) for (const policy of (process.env.START_DEMO_BENCH_POLICIES??'nvidia-demo,start-demo').split(',')) {
    const page = await browser.newPage({viewport:{width:520,height:900}});
    try {
      await page.addInitScript(() => {
        window.__renderFrameId=0;window.__renderedFrames=new Set();window.__renderSubmitMs=[];window.__policyRoundtripMs=[];
        for(const C of [WebGLRenderingContext,WebGL2RenderingContext])for(const key of ['drawElements','drawArrays','drawElementsInstanced','drawArraysInstanced']){
          const original=C.prototype[key];if(original)C.prototype[key]=function(...args){__renderedFrames.add(__renderFrameId);return original.apply(this,args);};
        }
      });
      if(cpu!==1){const cdp=await page.context().newCDPSession(page);await cdp.send('Emulation.setCPUThrottlingRate',{rate:cpu});}
      await page.goto(`http://127.0.0.1:${server.address().port}/sim/index.html?policy=${policy}`);
      await page.waitForFunction(() => window.__sim?.ready||window.__sim?.err,undefined,{timeout:90000});
      assert.equal(await page.evaluate(() => __sim.err),null);
      await page.click('#go');await page.waitForTimeout(1500);await page.keyboard.down('ArrowUp');
      const engineAtStart=await page.locator('#policyEngine').textContent();
      const result = await page.evaluate(async () => {
        const sim=__sim.sim,stepSync=[],roundtrip=[],depth=[],depthMain=[],depthRoundtrip=[],map=[],long=[],frames=[];
        let accepted=0,discarded=0;
        for (const [key,times] of [['heightScanner',map],['depthScanner',depth]]) {
          const original=sim[key]; if(!original)continue;
          const wrapped=(...args) => {
            const t=performance.now(),out=original(...args),ms=performance.now()-t;
            if(key==='depthScanner')depthMain.push(ms);
            if(out?.then)out.then(()=>{times.push(original.ms);depthRoundtrip.push(original.roundtripMs);});
            else times.push(ms);
            return out;
          };
          Object.assign(wrapped,original);sim[key]=wrapped;
        }
        const original=sim.step;
        sim.step=(...args) => {
          const t=performance.now(),out=original(...args);stepSync.push(performance.now()-t);
          if(out?.then)out.then((applied)=>{if(applied===false)discarded++;else accepted++;roundtrip.push(performance.now()-t);});
          return out;
        };
        const observer=new PerformanceObserver((list)=>{for(const entry of list.getEntries())long.push(entry.duration);});
        observer.observe({type:'longtask'});
        const t0=performance.now(),sim0=sim.t;let last=t0;__renderedFrames.clear();__renderSubmitMs.length=0;__policyRoundtripMs.length=0;
        await new Promise((done)=>{
          const frame=(now)=>{__renderFrameId++;frames.push(now-last);last=now;if(now-t0<6000)requestAnimationFrame(frame);else done();};requestAnimationFrame(frame);
        });
        observer.disconnect();
        return {wallSeconds:(performance.now()-t0)/1000,drawFrames:__renderedFrames.size,renderSubmitMs:__renderSubmitMs.slice(),policyRoundtrip:__policyRoundtripMs.slice(),depthAsync:sim.depthScanner?.async,simSeconds:sim.t-sim0,accepted,discarded,stepSync,roundtrip,depth,depthMain,depthRoundtrip,map,long,frames,error:__sim.err};
      });
      assert.equal(result.error,null);
      if(result.depthAsync)assert.ok(result.depthRoundtrip.length>0&&result.depthRoundtrip.every((ms)=>ms>0),'depth Worker stays active');
      const engine=await page.locator('#policyEngine').textContent();
      await page.keyboard.up('ArrowUp');
      const fixedDraw=await page.evaluate(()=>__sim.measureFixedDraw());
      const row={cpu,run:run+1,policy,engineAtStart,engine,workerStayed:engineAtStart.includes(' · Worker · ')&&engine.includes(' · Worker · '),renderFps:result.drawFrames/result.wallSeconds,drawFrames:result.drawFrames,wallSeconds:result.wallSeconds,simSeconds:result.simSeconds,speed:result.simSeconds/result.wallSeconds,
        accepted:result.accepted,discarded:result.discarded,stepSyncMs:summary(result.stepSync),roundtripMs:summary(result.roundtrip),policyRoundtripMs:summary(result.policyRoundtrip),depthMs:summary(result.depth),depthMainMs:summary(result.depthMain),depthRoundtripMs:summary(result.depthRoundtrip),mapMs:summary(result.map),longtaskMs:summary(result.long),frameMs:summary(result.frames),renderSubmitMs:summary(result.renderSubmitMs),fixedDrawFinishedMs:summary(fixedDraw)};
      rows.push(row);console.log(JSON.stringify(row));await page.keyboard.up('ArrowUp');
    } finally { await page.close(); }
  }
  if(process.env.START_DEMO_REALTIME_REPORT)writeFileSync(process.env.START_DEMO_REALTIME_REPORT,JSON.stringify({node:process.version,browser:browser.version(),rows},null,2));
} finally {await browser?.close();await new Promise((r)=>server.close(r));}
