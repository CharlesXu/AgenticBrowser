import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn,execFileSync} from 'node:child_process';
import {mkdir,readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';

const [executable,report]=process.argv.slice(2);assert(executable&&report);
const profile=await mkdtemp(join(tmpdir(),'agentic-release-'));
const reports=new Map(),session=randomUUID();let browser,stopped=false,closed=false,loggedOut=false,stderr='',phase='prepare',discovery,failure;
const processResult={exitCode:null,signal:null,spawnError:null};
const server=createServer((req,res)=>{
 const url=new URL(req.url,'http://127.0.0.1');res.setHeader('Cache-Control','no-store');
 if(url.pathname==='/login'){res.setHeader('Set-Cookie',`smoke=${session}; Path=/; HttpOnly; SameSite=Strict`);res.end('ok');}
 else if(url.pathname==='/logout'){res.setHeader('Set-Cookie','smoke=; Path=/; HttpOnly; Max-Age=0');res.end('ok');}
 else if(url.pathname==='/state'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({loggedIn:(req.headers.cookie||'').includes('smoke='+session),logout:loggedOut}));}
 else if(url.pathname==='/report'){
  let body='';req.on('data',chunk=>{body+=chunk;if(body.length>4096)req.destroy();});req.on('end',()=>{try{const value=JSON.parse(body);reports.set(value.space,value);res.end('ok');}catch{res.writeHead(400);res.end();}});
 }else {
  const space=url.searchParams.get('space');if(!['main','task-a','task-b'].includes(space)){res.writeHead(404);res.end();return;}
  res.setHeader('Content-Type','text/html; charset=utf-8');res.end(`<!doctype html><title>Release smoke ${space}</title><h1>${space}</h1><input id="entry"><script>
  const space=${JSON.stringify(space)};sessionStorage.space=space;
  (async()=>{if(space==='main'){await fetch('/login');localStorage.shared=${JSON.stringify(session)};}
  setInterval(async()=>{const state=await(await fetch('/state')).json();if(space==='main'&&state.logout)await fetch('/logout');await fetch('/report',{method:'POST',body:JSON.stringify({space,loggedIn:state.loggedIn,shared:localStorage.shared,session:sessionStorage.space,input:document.querySelector('input').value})});},100);})();</script>`);
 }
});
await new Promise(done=>server.listen(0,'127.0.0.1',done));const base='http://127.0.0.1:'+server.address().port;
async function until(fn,description){phase=description;const deadline=Date.now()+45000;while(!await fn()){assert(!stopped,'Browser exited');assert(Date.now()<deadline,'Timeout: '+description);await new Promise(r=>setTimeout(r,150));}}
const checks={};
async function waitForClose(ms){
 if(!browser||closed)return true;
 return new Promise(done=>{
  const finish=value=>{clearTimeout(timer);browser.removeListener('close',onClose);done(value);};
  const onClose=()=>finish(true),timer=setTimeout(()=>finish(false),ms);
  browser.once('close',onClose);
 });
}
try {
 await mkdir(join(profile,'Default'));
 await writeFile(join(profile,'Default/Preferences'),JSON.stringify({session:{restore_on_startup:4,startup_urls:[base+'/?space=main']}}));
 const args=[`--user-data-dir=${profile}`,'--no-first-run','--no-default-browser-check','--mute-audio','--agentic-poc','--password-store=basic','--use-mock-keychain','--disable-features=DialMediaRouteProvider','--enable-features=TabGroupsFocusing:TabGroupsFocusFreezing/false',`--agentic-poc-task-a-url=${base}/?space=task-a`,`--agentic-poc-task-b-url=${base}/?space=task-b`,base+'/?space=main'];
 phase='launch';
 // Own the POSIX process group so a shutdown timeout can stop only this smoke.
 browser=spawn(executable,args,{stdio:['ignore','ignore','pipe'],detached:process.platform!=='win32'});browser.stderr.on('data',x=>{stderr=(stderr+x).slice(-12000);});
 browser.on('exit',(exitCode,signal)=>{stopped=true;Object.assign(processResult,{exitCode,signal});});
 browser.on('error',error=>{stopped=true;processResult.spawnError={code:error.code,message:error.message};});
 browser.on('close',()=>{closed=true;});
 await until(()=>['main','task-a','task-b'].every(id=>reports.get(id)?.loggedIn&&reports.get(id)?.shared===session&&reports.get(id)?.session===id),'three spaces and shared login');checks.threeSpaces=true;checks.sharedLogin=true;
 phase='discovery';discovery=JSON.parse(await readFile(join(profile,'agentic-poc.json'),'utf8'));assert.deepEqual(Object.keys(discovery.tasks).sort(),['task-a','task-b']);
 const call=async(space,action,fields={},token=discovery.tasks[space],expected=200)=>{
  const res=await fetch(`http://127.0.0.1:${discovery.port}/space`,{method:'POST',headers:{Authorization:'Bearer '+token},body:JSON.stringify({...fields,space,action}),signal:AbortSignal.timeout(5000)});
  assert.equal(res.status,expected,`${space}/${action}`);return res.json();
 };
 phase='main protection';await call('main','claim',{},discovery.tasks['task-a'],403);checks.mainProtected=true;
 phase='scoped input';
 const lease=await call('task-a','claim');const seen=await call('task-a','observe',lease);
 const snapshot=await call('task-a','snapshot',{...lease,tab:seen.tab});const field=snapshot.nodes.find(n=>n.role==='textbox');assert(field?.ref);
 await call('task-a','fillRef',{...lease,tab:seen.tab,ref:field.ref,text:'Agentic smoke'});
 await until(()=>reports.get('task-a')?.input==='Agentic smoke','scoped input');assert.equal(reports.get('main').input,'');assert.equal(reports.get('task-b').input,'');checks.scopedInput=true;
 await call('task-a','release',lease);
 loggedOut=true;await until(()=>['main','task-a','task-b'].every(id=>reports.get(id)?.loggedIn===false),'shared logout');checks.sharedLogout=true;
} catch(error) {
 // Capture startup failures before cleanup sends its own termination signal.
 if(stopped&&!closed)await waitForClose(1000);
 failure={phase,error:error.message,process:{...processResult},stderr};
} finally {
 if(!discovery)try{discovery=JSON.parse(await readFile(join(profile,'agentic-poc.json'),'utf8'));}catch{}
 try {
  let shutdownError;
  if(browser?.pid&&!stopped){
   if(process.platform==='win32'){
    // taskkill may race with normal exit; closure below is the required result.
    try{execFileSync('taskkill',['/pid',String(browser.pid),'/t','/f'],{stdio:'ignore',timeout:5000});}catch(error){shutdownError=error;}
   }else browser.kill('SIGTERM');
  }
  if(!await waitForClose(5000)){
   if(process.platform!=='win32'&&browser?.pid){
    try{process.kill(-browser.pid,'SIGKILL');}catch(error){if(error.code!=='ESRCH')throw error;}
   }
   assert(await waitForClose(5000),shutdownError?.message||'Browser stdio did not close after shutdown');
  }
  // close also waits for inherited stdio; bounded retries cover late file writes.
  await rm(profile,{recursive:true,force:true,maxRetries:10,retryDelay:200});
 }catch(error){
  if(failure)failure.cleanupError=error.message;
  else failure={phase:'cleanup',error:error.message,process:{...processResult},stderr};
  if(!closed){browser?.stderr?.destroy();browser?.unref();}
 }finally{
  server.closeAllConnections();await new Promise(done=>server.close(done));
 }
}
const redact=value=>{
 let text=String(value);
 for(const secret of [profile,session,base,...Object.values(discovery?.tasks||{})])if(typeof secret==='string'&&secret)text=text.replaceAll(secret,'[redacted]');
 return text.replace(/Bearer\s+[^\s"']+/gi,'Bearer [redacted]');
};
const result=JSON.parse(JSON.stringify({status:failure?'failed':'passed',platform:process.platform,arch:process.arch,checks,
 ...(failure||{notVerified:['manual UI','installer execution','signing/notarization','VNC','locked screen','models']})},
 (_key,value)=>typeof value==='string'?redact(value):value));
await mkdir(dirname(report),{recursive:true});await writeFile(report,JSON.stringify(result,null,2)+'\n');
if(failure){console.error('Browser smoke failed:',JSON.stringify(result));process.exitCode=1;}
else console.log(JSON.stringify(checks));
