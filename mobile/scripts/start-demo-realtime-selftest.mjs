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
    res.end(readFileSync(file));
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
  for (let run=0;run<Number(process.env.START_DEMO_BENCH_RUNS??2);run++) for (const policy of ['nvidia-demo','start-demo']) {
    const page = await browser.newPage({viewport:{width:520,height:900}});
    try {
      await page.goto(`http://127.0.0.1:${server.address().port}/sim/index.html?policy=${policy}`);
      await page.waitForFunction(() => window.__sim?.ready||window.__sim?.err,undefined,{timeout:90000});
      assert.equal(await page.evaluate(() => __sim.err),null);
      await page.click('#go');await page.waitForTimeout(1500);await page.keyboard.down('ArrowUp');
      const engineAtStart=await page.locator('#policyEngine').textContent();
      const result = await page.evaluate(async () => {
        const sim=__sim.sim,stepSync=[],roundtrip=[],depth=[],map=[],long=[],frames=[];
        let accepted=0,discarded=0;
        for (const [key,times] of [['heightScanner',map],['depthScanner',depth]]) {
          const original=sim[key]; if(!original)continue;
          const wrapped=(...args) => {const t=performance.now(),out=original(...args);times.push(performance.now()-t);return out;};
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
        const t0=performance.now(),sim0=sim.t;let last=t0;
        await new Promise((done)=>{
          const frame=(now)=>{frames.push(now-last);last=now;if(now-t0<6000)requestAnimationFrame(frame);else done();};requestAnimationFrame(frame);
        });
        observer.disconnect();
        return {wallSeconds:(performance.now()-t0)/1000,simSeconds:sim.t-sim0,accepted,discarded,stepSync,roundtrip,depth,map,long,frames,error:__sim.err};
      });
      assert.equal(result.error,null);
      const engine=await page.locator('#policyEngine').textContent();
      const row={run:run+1,policy,engineAtStart,engine,workerStayed:engineAtStart.includes(' · Worker · ')&&engine.includes(' · Worker · '),renderFps:await page.evaluate(()=>__sim.fps()),wallSeconds:result.wallSeconds,simSeconds:result.simSeconds,speed:result.simSeconds/result.wallSeconds,
        accepted:result.accepted,discarded:result.discarded,stepSyncMs:summary(result.stepSync),roundtripMs:summary(result.roundtrip),depthMs:summary(result.depth),mapMs:summary(result.map),longtaskMs:summary(result.long),frameMs:summary(result.frames)};
      rows.push(row);console.log(JSON.stringify(row));await page.keyboard.up('ArrowUp');
    } finally { await page.close(); }
  }
  if(process.env.START_DEMO_REALTIME_REPORT)writeFileSync(process.env.START_DEMO_REALTIME_REPORT,JSON.stringify({node:process.version,browser:browser.version(),rows},null,2));
} finally {await browser?.close();await new Promise((r)=>server.close(r));}
