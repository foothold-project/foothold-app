// Reproduce prepare-release's web-only archive with B's exact source, locally.
// No release script execution, server access, checkout, merge, or deployment.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, cpSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const uiRef=process.env.TERRAIN_UI_REF||'76068c3';
const script=readFileSync('deploy/prepare-release.sh','utf8');
assert.match(script,/mobile\/sim\/maps\.json mobile\/sim\/terrain 'mobile\/sim\/assets\/\*\/top\.png'/);
const root=mkdtempSync(join(tmpdir(),'fh-terrain-release-'));
const npm=(...args)=>spawnSync('npm',args,{cwd:join(root,'apps/web'),encoding:'utf8',env:process.env,maxBuffer:8*1024*1024});
try{
  const archive=execFileSync('git',['archive',uiRef,'apps/contracts','apps/web','mobile/sim/maps.json','mobile/sim/assets/*/top.png','mobile/sim/assets/*/top.json'],{maxBuffer:32*1024*1024});
  execFileSync('tar',['-x','-C',root],{input:archive});
  let result=npm('ci','--ignore-scripts');assert.equal(result.status,0,result.stdout+result.stderr);
  result=npm('run','build');assert.equal(result.status,2,result.stdout+result.stderr);
  assert.match(result.stdout+result.stderr,/TS2307.*mobile\/sim\/terrain\/index\.js/);
  const before={exit:result.status,diagnostic:'TS2307'};
  cpSync(resolve('mobile/sim/terrain'),join(root,'mobile/sim/terrain'),{recursive:true});
  result=npm('run','build');assert.equal(result.status,0,result.stdout+result.stderr);
  const report={uiRef,before,after:{exit:result.status},input:'apps/contracts + apps/web + maps.json + top PNG/JSON + mobile/sim/terrain',deployExecuted:false};
  if(process.env.TERRAIN_RELEASE_REPORT)writeFileSync(process.env.TERRAIN_RELEASE_REPORT,JSON.stringify(report,null,2)+'\n');
  console.log(result.stdout);console.log(JSON.stringify(report,null,2));
}finally{rmSync(root,{recursive:true,force:true});}
