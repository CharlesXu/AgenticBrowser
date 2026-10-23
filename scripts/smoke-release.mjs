import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn,execFileSync} from 'node:child_process';
import {mkdir,readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';

const [executable,report]=process.argv.slice(2);assert(executable&&report);
const profile=await mkdtemp(join(tmpdir(),'agentic-release-'));
const reports=new Map(),session=randomUUID();let browser,stopped=false,loggedOut=false;
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
async function until(fn,description){const deadline=Date.now()+45000;while(!await fn()){assert(!stopped,'Browser exited');assert(Date.now()<deadline,'Timeout: '+description);await new Promise(r=>setTimeout(r,150));}}
const checks={};
try {
 await mkdir(join(profile,'Default'));
 await writeFile(join(profile,'Default/Preferences'),JSON.stringify({session:{restore_on_startup:4,startup_urls:[base+'/?space=main']}}));
 const args=[`--user-data-dir=${profile}`,'--no-first-run','--no-default-browser-check','--mute-audio','--agentic-poc','--password-store=basic','--use-mock-keychain','--disable-features=DialMediaRouteProvider','--enable-features=TabGroupsFocusing:TabGroupsFocusFreezing/false',`--agentic-poc-task-a-url=${base}/?space=task-a`,`--agentic-poc-task-b-url=${base}/?space=task-b`,base+'/?space=main'];
 browser=spawn(executable,args,{stdio:['ignore','ignore','pipe']});let stderr='';browser.stderr.on('data',x=>{stderr=(stderr+x).slice(-12000);});browser.on('exit',()=>{stopped=true;});browser.on('error',()=>{stopped=true;});
 await until(()=>['main','task-a','task-b'].every(id=>reports.get(id)?.loggedIn&&reports.get(id)?.shared===session&&reports.get(id)?.session===id),'three spaces and shared login');checks.threeSpaces=true;checks.sharedLogin=true;
 const discovery=JSON.parse(await readFile(join(profile,'agentic-poc.json'),'utf8'));assert.deepEqual(Object.keys(discovery.tasks).sort(),['task-a','task-b']);
 const call=async(space,action,fields={},token=discovery.tasks[space],expected=200)=>{
  const res=await fetch(`http://127.0.0.1:${discovery.port}/space`,{method:'POST',headers:{Authorization:'Bearer '+token},body:JSON.stringify({...fields,space,action}),signal:AbortSignal.timeout(5000)});
  assert.equal(res.status,expected,`${space}/${action}`);return res.json();
 };
 await call('main','claim',{},discovery.tasks['task-a'],403);checks.mainProtected=true;
 const lease=await call('task-a','claim');const seen=await call('task-a','observe',lease);
 const snapshot=await call('task-a','snapshot',{...lease,tab:seen.tab});const field=snapshot.nodes.find(n=>n.role==='textbox');assert(field?.ref);
 await call('task-a','fillRef',{...lease,tab:seen.tab,ref:field.ref,text:'Agentic smoke'});
 await until(()=>reports.get('task-a')?.input==='Agentic smoke','scoped input');assert.equal(reports.get('main').input,'');assert.equal(reports.get('task-b').input,'');checks.scopedInput=true;
 await call('task-a','release',lease);
 loggedOut=true;await until(()=>['main','task-a','task-b'].every(id=>reports.get(id)?.loggedIn===false),'shared logout');checks.sharedLogout=true;
 await mkdir(dirname(report),{recursive:true});await writeFile(report,JSON.stringify({status:'passed',platform:process.platform,arch:process.arch,checks,notVerified:['manual UI','installer execution','signing/notarization','VNC','locked screen','models']},null,2)+'\n');
 console.log(JSON.stringify(checks));
} finally {
 if(browser?.pid&&!stopped){if(process.platform==='win32')execFileSync('taskkill',['/pid',String(browser.pid),'/t','/f'],{stdio:'ignore'});else browser.kill('SIGTERM');await Promise.race([new Promise(done=>browser.once('exit',done)),new Promise(done=>setTimeout(done,5000))]);}
 server.closeAllConnections();server.close();
 if(stopped)await rm(profile,{recursive:true,force:true});
}
