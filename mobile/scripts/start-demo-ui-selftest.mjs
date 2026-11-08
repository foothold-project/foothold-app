// sync-web first; Chrome headless and a fresh loopback port. No external servers.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
const { chromium }=await import(pathToFileURL(process.env.FH_PLAYWRIGHT));
const root=resolve('mobile/www'),schema=JSON.parse(readFileSync('apps/contracts/schema/OrgSettings.json'));
const defaults=Object.fromEntries(Object.entries(schema.properties).filter(([,p])=>'default'in p).map(([k,p])=>[k,p.default]));
let settingsFetches=0;
const server=createServer((req,res)=>{
  const pathname=new URL(req.url,'http://localhost').pathname;
  if(pathname==='/api/v1/org/settings'){settingsFetches++;res.setHeader('Content-Type','application/json');res.end(JSON.stringify(defaults));return;}
  const [variant,...parts]=pathname.slice(1).split('/'),name=parts.join('/');
  const file=resolve(root,name);
  if(!file.startsWith(root+sep)||(variant==='missing'&&name.includes('start-demo_'))){res.writeHead(404).end();return;}
  try{
    let body=readFileSync(file);
    if(name==='sim/main.js'&&variant==='js')body=body.toString().replace("const DEFAULT_POLICY_BACKEND = 'wasm';","const DEFAULT_POLICY_BACKEND = 'f32';");
    res.setHeader('Content-Type',({'.js':'text/javascript','.mjs':'text/javascript','.wasm':'application/wasm','.json':'application/json','.html':'text/html','.css':'text/css','.png':'image/png'})[extname(file)]??'application/octet-stream');res.end(body);
  }catch{res.writeHead(404).end();}
});
await new Promise((r)=>server.listen(0,'127.0.0.1',r));
let browser;const report=[];
try{
  browser=await chromium.launch({executablePath:process.env.FH_CHROME||'/usr/bin/google-chrome',headless:true,args:['--no-sandbox','--enable-webgl','--use-gl=angle','--use-angle=swiftshader']});
  const page=await browser.newPage({hasTouch:true,viewport:{width:520,height:900}});
  await page.addInitScript(()=>{
    window.__startFirst=null;window.__startLast=null;
    const send=Worker.prototype.postMessage;
    Worker.prototype.postMessage=function(packet,...rest){
      if(packet.type==='init')this.__isStart=packet.contract?.inputs[0]?.name==='obs45';
      if(this.__isStart&&packet.type==='infer'){
        const p=packet.inputs,call={cmd:Array.from(p[0].slice(6,9)),zeroState:p[3].every((x)=>x===0)&&p[4].every((x)=>x===0),first:!!p[6][0],useGt:!!p[7][0],tick:!!p[5][0]};
        window.__startFirst??=call;window.__startLast=call;window.__startWorker=this;
      }
      return send.call(this,packet,...rest);
    };
  });
  const base=`http://127.0.0.1:${server.address().port}`;
  const open=async(variant,query='policy=start-demo')=>{
    await page.goto(`${base}/${variant}/sim/index.html?${query}`);
    await page.waitForFunction(()=>window.__sim?.ready||window.__sim?.err,undefined,{timeout:60000});
  };
  for(const variant of ['wasm','js'])for(const web of [false,true]){
    const fetched=settingsFetches;
    await open(variant,`policy=start-demo${web?'&from=web':''}`);
    assert.equal(await page.evaluate(()=>__sim.err),null);
    await page.waitForFunction(()=>window.__startFirst);
    assert.deepEqual(await page.evaluate(()=>[__startFirst.zeroState,__startFirst.first,__startFirst.useGt]),[true,true,true]);
    assert.match(await page.locator('#policyEngine').textContent(),/start · ONNX WASM/);
    assert.match(await page.locator('#modeCaps').textContent(),/앞1.5 뒤1 옆0.5.*회전1.2\/이동1/);
    await page.click('#go');await page.waitForFunction(()=>!__sim.stopped());
    const check=async(axis,value)=>page.waitForFunction(([i,v])=>Math.abs((window.__startLast?.cmd[i]??Infinity)-v)<1e-5,[axis,value]);
    for(const [key,stick,x,y,axis,value]of [['ArrowUp','stickL',0,-1,0,1.5],['ArrowDown','stickL',0,1,0,-1],['ArrowLeft','stickL',-1,0,1,.5],['ArrowRight','stickL',1,0,1,-.5],['KeyA','stickR',-1,0,2,1.2],['KeyD','stickR',1,0,2,-1.2]]){
      await page.keyboard.down(key);await check(axis,value);await page.keyboard.up(key);
      const r=await page.locator('#'+stick).boundingBox(),cx=r.x+r.width/2,cy=r.y+r.height/2;
      await page.mouse.move(cx,cy);await page.mouse.down();await page.mouse.move(cx+x*(r.width/2+10),cy+y*(r.height/2+10));await check(axis,value);await page.mouse.up();
    }
    await page.click('#stop');assert.equal(await page.evaluate(()=>__sim.stopped()),true);
    assert.equal(settingsFetches>fetched,web,'web receives real organization defaults; offline does not fetch');
    report.push({variant,web,first:await page.evaluate(()=>__startFirst),caps:[1.5,-1,.5,-.5,1.2,-1.2]});
    if(variant==='wasm'&&!web){
      const timing=await page.evaluate(()=>{
        const sim=__sim.sim,values={map:[],depth:[]};
        for(let k=0;k<20;k++)for(const [name,scan]of [['map',sim.heightScanner],['depth',sim.depthScanner]]){
          // Worker depth has one in-flight capture owned by sim.step. Its
          // timings are measured by start-demo-realtime-selftest, not by
          // issuing concurrent captures from this synchronous UI probe.
          if(scan.async)continue;
          scan(sim.d.qpos,name==='map'?sim.mapping:undefined);values[name].push(scan.ms);
        }
        return Object.fromEntries(Object.entries(values).map(([name,times])=>{times.sort((a,b)=>a-b);return[name,{median:times[10],max:times.at(-1)}];}));
      });
      report.push({browserWarehouseSensorMs:timing});
    }
  }
  // A full document/session replacement must zero GRUs even for map_on -> map_on.
  for(const map of ['reconstruction','off','gt']){
    await page.click('#scenarioMenu');await page.selectOption('#startMapSelect',map);
    await page.waitForFunction(()=>window.__sim?.ready&&window.__startFirst,undefined,{timeout:60000});
    assert.equal(await page.locator('#startMapSelect').inputValue(),map);
    assert.deepEqual(await page.evaluate(()=>[__startFirst.zeroState,__startFirst.first,__startFirst.useGt]),[true,true,map==='gt']);
    report.push({map,first:await page.evaluate(()=>__startFirst)});
  }
  await page.click('#reset');await page.waitForFunction(()=>__sim.sim.t>.02);
  assert.equal(await page.evaluate(()=>__sim.stopped()),true);
  // Registry menu selection, with global JS default and no explicit backend.
  await open('js','policy=nvidia-demo');await page.click('#scenarioMenu');await page.selectOption('#policySelect','start-demo');
  await page.waitForFunction(()=>window.__sim?.ready&&window.__startFirst,undefined,{timeout:60000});assert.match(page.url(),/policy=start-demo/);
  await open('missing','policy=nvidia-demo');
  assert.equal(await page.locator('#policySelect option[value="start-demo"]').isDisabled(),true);
  assert.match(await page.locator('#policySelect option[value="start-demo"]').textContent(),/ONNX 파일 없음/);
  await open('missing');assert.match(await page.locator('#policyEngine').textContent(),/정책 잠금.*ONNX 파일 없음/);assert.equal(await page.evaluate(()=>__sim.ready),false);
  await open('wasm','policy=start-demo&policyBackend=f32');assert.match(await page.locator('#policyEngine').textContent(),/정책 잠금.*JS f32 직접 선택/);
  await open('wasm','policy=start-demo&startMap=unknown');assert.match(await page.locator('#policyEngine').textContent(),/알 수 없는 start 지도 모드/);
  // Fatal runtime failure after initialization: recover attempt fails visibly,
  // no subsequent frames/inferences, and Run cannot unlock the failed policy.
  await open('wasm');await page.waitForFunction(()=>window.__startWorker);
  await page.route('**/ort/ort.wasm.min.mjs',(route)=>route.abort());
  await page.evaluate(()=>__startWorker.onerror({message:'test runtime failure',preventDefault(){}}));
  await page.waitForFunction(()=>__sim.err&&!__sim.ready,undefined,{timeout:60000});
  const t=await page.evaluate(()=>__sim.sim.t);await page.waitForTimeout(100);
  assert.equal(await page.evaluate(()=>__sim.sim.t),t);assert.equal(await page.locator('#go').isVisible(),false);
  assert.match(await page.locator('#policyEngine').textContent(),/정책 잠금/);
  await page.close();
  if(process.env.START_DEMO_UI_REPORT)writeFileSync(process.env.START_DEMO_UI_REPORT,JSON.stringify(report,null,2));
  console.log('start-demo UI PASS: default engines × offline/web, actual stick/key caps, menu/URL, map reload+zero GRU/reset flags, missing models, explicit f32 and fatal runtime lock');
}finally{await browser?.close();await new Promise((r)=>server.close(r));}
