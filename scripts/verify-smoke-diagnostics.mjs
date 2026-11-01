import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';

// Exercise real subprocess failures without opening a browser or user Profile.
const dir=await mkdtemp(join(tmpdir(),'agentic-smoke-diagnostics-'));
try {
 for(const [name,executable] of [['missing',join(dir,'absent-browser')],['exited',process.execPath]]) {
  const report=join(dir,name+'.json');
  const child=spawnSync(process.execPath,[resolve('scripts/smoke-release.mjs'),executable,report],{encoding:'utf8',timeout:10000});
  assert.equal(child.error,undefined);assert.notEqual(child.status,0);
  const failure=JSON.parse(await readFile(report,'utf8'));
  assert.equal(failure.status,'failed');assert.equal(failure.phase,'three spaces and shared login');
  assert.deepEqual(failure.checks,{});assert(failure.stderr.length<=12000);
  if(name==='missing')assert.equal(failure.process.spawnError.code,'ENOENT');
  else {assert.notEqual(failure.process.exitCode,null);assert.notEqual(failure.process.exitCode,0);assert(failure.stderr.length>0);}
  assert(!JSON.stringify(failure).includes('--user-data-dir='+tmpdir()),'Temporary Profile path must be redacted');
 }
 // A protocol fixture exercises cleanup/report ordering, not browser features.
 // Injection is confined to this verifier's subprocess; production has no bypass.
 const fixture=join(dir,'fixture.mjs'),preload=join(dir,'preload.mjs');
 await writeFile(fixture,`
import {createServer} from 'node:http';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
const profile=process.argv.find(a=>a.startsWith('--user-data-dir=')).split('=').slice(1).join('=');
const base=new URL(process.argv.at(-1)).origin;
const login=await fetch(base+'/login');
const cookie=login.headers.get('set-cookie').split(';')[0],session=cookie.slice('smoke='.length);
let input='',loggedIn=true;
const api=createServer((req,res)=>{let body='';req.on('data',x=>body+=x);req.on('end',()=>{
 const q=JSON.parse(body);let result={};
 if(q.space==='main')res.statusCode=403;
 else if(q.action==='claim')result={lease:'fixture-lease'};
 else if(q.action==='observe')result={tab:'fixture-tab'};
 else if(q.action==='snapshot')result={nodes:[{role:'textbox',ref:'fixture-ref'}]};
 else if(q.action==='fillRef')input=q.text;
 res.end(JSON.stringify(result));
});});
await new Promise(done=>api.listen(0,'127.0.0.1',done));
writeFileSync(join(profile,'agentic-poc.json'),JSON.stringify({port:api.address().port,tasks:{'task-a':'token-a','task-b':'token-b'}}));
async function report(){
 const state=await(await fetch(base+'/state',{headers:{cookie}})).json();
 if(state.logout)loggedIn=false;
 for(const space of ['main','task-a','task-b'])await fetch(base+'/report',{method:'POST',body:JSON.stringify({space,loggedIn,shared:session,session:space,input:space==='task-a'?input:''})});
}
await report();setInterval(()=>report().catch(()=>{}),60);
process.on('SIGTERM',()=>{
 if(process.env.SMOKE_FIXTURE_MODE==='stubborn')return;
 // Parent exits first; a descendant keeps stderr open and accesses the Profile.
 spawn(process.execPath,['-e',\`setTimeout(()=>{const fs=require('node:fs');fs.appendFileSync(process.env.SMOKE_TRACE,JSON.stringify({lateWriterSawProfile:fs.existsSync(process.argv[1])})+String.fromCharCode(10));},300);\`,profile],{stdio:['ignore','ignore',process.stderr]});
 process.exit(0);
});
`);
 await writeFile(preload,`
import cp from 'node:child_process';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {syncBuiltinESMExports} from 'node:module';
const spawn=cp.spawn,rm=fs.promises.rm;
cp.spawn=(exe,args,options)=>exe===process.env.SMOKE_FAKE_EXECUTABLE?
 spawn(process.execPath,[process.env.SMOKE_FIXTURE,...args],{...options,env:{...process.env,NODE_OPTIONS:''}}):spawn(exe,args,options);
fs.promises.rm=async(path,options)=>{
 if(String(path).includes('agentic-release-')){
  fs.appendFileSync(process.env.SMOKE_TRACE,JSON.stringify({profile:String(path)})+'\\n');
  assert(!fs.existsSync(process.env.SMOKE_REPORT),'A success report was written before cleanup');
  assert(options.maxRetries>0&&options.maxRetries<=10&&options.retryDelay>0);
  if(process.env.SMOKE_FIXTURE_MODE==='cleanup-failure')throw Object.assign(new Error('ENOTEMPTY: '+path+'/Default'),{code:'ENOTEMPTY'});
 }
 return rm(path,options);
};
syncBuiltinESMExports();
`);
 for(const mode of ['delayed-close','cleanup-failure',...(process.platform==='win32'?[]:['stubborn'])]){
  const report=join(dir,mode+'.json'),trace=join(dir,mode+'.trace');
  const executable=join(dir,'fixture-browser');
  const child=spawnSync(process.execPath,[resolve('scripts/smoke-release.mjs'),executable,report],{
   encoding:'utf8',timeout:20000,env:{...process.env,NODE_OPTIONS:'--import='+pathToFileURL(preload).href,
    SMOKE_FAKE_EXECUTABLE:executable,SMOKE_FIXTURE:fixture,SMOKE_FIXTURE_MODE:mode,SMOKE_REPORT:report,SMOKE_TRACE:trace}});
  const events=(await readFile(trace,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  try{
   assert.equal(child.error,undefined);const result=JSON.parse(await readFile(report,'utf8'));
   assert.equal(Object.keys(result.checks).length,5);assert(Object.values(result.checks).every(Boolean));
   if(mode==='cleanup-failure'){
    assert.notEqual(child.status,0);assert.equal(result.status,'failed');assert.equal(result.phase,'cleanup');
    assert(result.error.includes('ENOTEMPTY'));assert(result.error.includes('[redacted]'));assert(!result.error.includes(tmpdir()));
   }else{assert.equal(child.status,0,child.stderr);assert.equal(result.status,'passed');}
   if(mode!=='stubborn'&&process.platform!=='win32')assert(events.some(e=>e.lateWriterSawProfile),JSON.stringify({mode,events,result,stderr:child.stderr}));
  }finally{
   for(const event of events)if(event.profile)await rm(event.profile,{recursive:true,force:true});
  }
 }
 console.log('Smoke launch/exit, delayed closure, forced shutdown and cleanup-failure reporting passed; no browser launched.');
}finally{await rm(dir,{recursive:true,force:true});}
