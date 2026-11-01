import assert from 'node:assert/strict';
import {readFile,writeFile,stat} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {dirname,join} from 'node:path';
import {createHash} from 'node:crypto';

// The helper comes from this exact build, never from an installed browser.
// Install it only on disposable CI hosts, outside the runner-writable tree.
export async function runLinuxSmoke(executable,report) {
 assert.equal(process.platform,'linux');
 assert(['x64','arm64'].includes(process.arch));
 assert.equal(process.env.GITHUB_ACTIONS,'true');
 assert.equal(process.env.RUNNER_ENVIRONMENT,'github-hosted');
 const run=(cmd,args,options={})=>execFileSync(cmd,args,{stdio:'inherit',...options});
 const capture=(cmd,args)=>run(cmd,args,{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
 const helper=join(dirname(executable),'chrome_sandbox');
 const bytes=await readFile(helper);
 assert.equal(bytes.subarray(0,4).toString('hex'),'7f454c46');
 assert.equal(bytes.readUInt16LE(18),process.arch==='arm64'?183:62);
 const hash=buffer=>createHash('sha256').update(buffer).digest('hex');
 const diagnostics={arch:process.arch,helperSha256:hash(bytes),status:'preparing'};
 for(const key of ['kernel.unprivileged_userns_clone','kernel.apparmor_restrict_unprivileged_userns']) {
  try{diagnostics[key]=capture('sysctl',['-n',key]);}catch{diagnostics[key]='unavailable';}
 }
 let directory;
 try {
  directory=capture('sudo',['-n','mktemp','-d','/opt/agentic-browser-sandbox.XXXXXXXX']);
  assert(/^\/opt\/agentic-browser-sandbox\.[A-Za-z0-9]+$/.test(directory));
  const installed=join(directory,'chrome-sandbox');
  run('sudo',['-n','install','-o','root','-g','root','-m','4755','--',helper,installed]);
  run('sudo',['-n','chmod','0755',directory]);
  const dirInfo=await stat(directory),fileInfo=await stat(installed);
  assert.equal(dirInfo.uid,0);assert.equal(dirInfo.mode&0o777,0o755);
  assert.equal(fileInfo.uid,0);assert.equal(fileInfo.mode&0o7777,0o4755);
  assert.equal(hash(await readFile(installed)),diagnostics.helperSha256);
  diagnostics.status='configured';diagnostics.mode='4755';diagnostics.owner=0;
  await writeFile(join(dirname(report),`sandbox-linux-${process.arch}.json`),JSON.stringify(diagnostics,null,2)+'\n');
  run('xvfb-run',['-a',process.execPath,'scripts/smoke-release.mjs',executable,report],
   {env:{...process.env,CHROME_DEVEL_SANDBOX:installed}});
 } catch(error) {
  diagnostics.status='failed';diagnostics.error=String(error.message).slice(-2000);
  await writeFile(join(dirname(report),`sandbox-linux-${process.arch}.json`),JSON.stringify(diagnostics,null,2)+'\n');
  throw error;
 } finally {
  if(directory&&/^\/opt\/agentic-browser-sandbox\.[A-Za-z0-9]+$/.test(directory)) {
   run('sudo',['-n','rm','-f','--',join(directory,'chrome-sandbox')]);
   run('sudo',['-n','rmdir','--',directory]);
  }
 }
}
