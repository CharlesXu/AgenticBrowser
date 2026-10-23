import assert from 'node:assert/strict';
import {cp,mkdir,readFile,writeFile,statfs,access,readdir,symlink,rename,rm,realpath} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {availableParallelism,totalmem} from 'node:os';
import {resolve,relative,dirname,join,isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';

const [mode,os,arch]=process.argv.slice(2);
assert(['preflight','build'].includes(mode)&&['macos','windows','linux'].includes(os)&&['x64','arm64'].includes(arch),'Usage: chromium-ci.mjs preflight|build macos|windows|linux x64|arm64');
const root=process.cwd(),source=resolve('.chromium/src'),depot=resolve('.tools/depot_tools');
const target=`${os}-${arch}`,reportDir=resolve('.runtime/ci'),dist=resolve('.runtime/release',target);
const upstream=JSON.parse(await readFile('chromium/upstream.json','utf8'));
const version=JSON.parse(await readFile('package.json','utf8')).version;
const sha=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
await mkdir(reportDir,{recursive:true});
function run(cmd,args=[],options={}) {
  // Only static tool names/validated local paths reach cmd.exe for depot_tools.
  const bat=process.platform==='win32'&&cmd.endsWith('.bat');
  if(bat)assert(![cmd,...args].some(s=>/[&|<>^%!"\r\n]/.test(s)),'Unsafe batch argument');
  return execFileSync(bat?`"${cmd}"`:cmd,bat?args.map(s=>`"${s}"`):args,
    {cwd:root,stdio:'inherit',...options,...(bat?{shell:true}:{})});
}
const capture=(cmd,args=[],cwd=root)=>run(cmd,args,{cwd,stdio:['ignore','pipe','pipe'],encoding:'utf8'}).trim();
const disk=await statfs(root),freeGiB=disk.bavail*disk.bsize/1024**3,ramGiB=totalmem()/1024**3;
const errors=[];
if(process.platform!=={macos:'darwin',windows:'win32',linux:'linux'}[os]||process.arch!==arch)errors.push('Runner OS/architecture must match the target natively.');
if(os==='macos'&&process.platform==='darwin'&&process.env.GITHUB_ACTIONS==='true'&&process.env.RUNNER_ENVIRONMENT==='github-hosted') {
 const installed=(await readdir('/Applications')).filter(name=>/^Xcode_\d+\.\d+(\.\d+)?\.app$/.test(name));
 installed.sort((a,b)=>a.localeCompare(b,'en',{numeric:true}));
 assert(installed.length,'No installed Xcode found');
 process.env.DEVELOPER_DIR=join('/Applications',installed.at(-1),'Contents/Developer');
}
// An 8 GiB VM exposes slightly less usable RAM after system reservations.
if(ramGiB<7.5)errors.push('An 8 GiB-class runner is required (32 GiB recommended).');
const probes={};
function probe(name,cmd,args){try{probes[name]=capture(cmd,args).slice(0,1600);}catch{errors.push(`${name} unavailable; install the pinned Chromium toolchain on this runner.`);}}
probe('git','git',['--version']);
probe('python',os==='windows'?'python':'python3',['--version']);
if(os==='macos') {
 probe('xcode','xcodebuild',['-version']);probe('sdk','xcrun',['--sdk','macosx','--show-sdk-version']);probe('metal','xcrun',['metal','--version']);
 try {
  const sdk=capture('xcrun',['--sdk','macosx','--show-sdk-path']);
  for(const file of ['DarwinFoundation1.modulemap','DarwinFoundation2.modulemap','DarwinFoundation3.modulemap','libunwind.modulemap'])
   if(!await access(join(sdk,'usr/include',file)).then(()=>true,()=>false))errors.push('Selected macOS SDK lacks '+file);
 }catch{errors.push('Cannot inspect selected macOS SDK.');}
}
if(os==='windows') {
 const vswhere=join(process.env['ProgramFiles(x86)']||'C:/Program Files (x86)','Microsoft Visual Studio/Installer/vswhere.exe');
 probe('visualStudio',vswhere,['-latest','-products','*','-version','[18.0,19.0)','-requires','Microsoft.VisualStudio.Component.VC.Tools.x86.x64','-property','installationPath']);
 if(!probes.visualStudio)errors.push('Visual Studio 2026 C++ tools required; see pinned docs/windows_build_instructions.md.');
}
const preflight={target,sourceCommit:sha,upstream,freeGiB:Math.round(freeGiB*10)/10,ramGiB:Math.round(ramGiB*10)/10,cpus:availableParallelism(),probes,errors};
await writeFile(join(reportDir,`preflight-${target}.json`),JSON.stringify(preflight,null,2)+'\n');
console.log(JSON.stringify(preflight,null,2));
if(errors.length)throw Error('Runner preflight failed; no Chromium download or build started.');
if(mode==='preflight')process.exit(0);
assert.equal(process.env.GITHUB_ACTIONS,'true','Release build is restricted to an isolated Actions checkout.');
assert.equal(capture('git',['status','--porcelain','--untracked-files=no']),'','Release source must be committed.');
assert(!/[&|<>^%!"\r\n]/.test(root),'Use a simple CI checkout path.');
await access(source).then(()=>{throw Error('Fresh isolated checkout required; will not replace an existing Chromium tree.');},()=>{});
const phase=async name=>{console.log('Build phase:',name);await writeFile(join(reportDir,`phase-${target}.txt`),name);};
await phase('runner-cleanup');
// Only ephemeral GitHub-hosted images: never remove software on a user's machine.
if(process.env.RUNNER_ENVIRONMENT==='github-hosted') {
 let unused=[];
 if(os==='macos') {
  const active=await realpath(process.env.DEVELOPER_DIR||capture('xcode-select',['-p']));
  assert(active.startsWith('/Applications/Xcode'),'Unexpected active Xcode path; refusing runner cleanup.');
  for(const name of await readdir('/Applications'))if(/^Xcode.*\.app$/.test(name)) {
   const app=join('/Applications',name),canonical=await realpath(app);
   if(active!==canonical&&!active.startsWith(canonical+'/'))unused.push(app);
  }
  unused.push('/Library/Developer/CoreSimulator','/Users/runner/Library/Android/sdk');
 }else if(os==='linux')unused=['/usr/local/lib/android','/usr/share/dotnet','/opt/ghc','/usr/local/.ghcup','/opt/hostedtoolcache/CodeQL'];
 else unused=['C:/Android','C:/hostedtoolcache/windows/CodeQL'];
 for(const path of unused) {
  if(!await access(path).then(()=>true,()=>false))continue;
  console.log('Remove unused hosted-runner software:',path);
  if(os==='windows')await rm(path,{recursive:true,force:true}).catch(error=>console.warn(error.message));
  else try{run('sudo',['-n','rm','-rf','--',path]);}catch{console.warn('Could not completely remove optional runner software:',path);}
 }
}
await phase('checkout');
await mkdir('.tools',{recursive:true});await mkdir('.chromium',{recursive:true});
run('git',['clone','--depth','1','https://chromium.googlesource.com/chromium/tools/depot_tools.git',depot]);
process.env.PATH=depot+(process.platform==='win32'?';':':')+process.env.PATH;
process.env.DEPOT_TOOLS_UPDATE='0';process.env.DEPOT_TOOLS_WIN_TOOLCHAIN='0';
process.env.UV_CONCURRENT_DOWNLOADS='4';
const tool=name=>join(depot,name+(os==='windows'?'.bat':''));
// Disabling self-update also skips the first-run Python bootstrap in gclient.
run(os==='windows'?join(depot,'bootstrap/win_tools.bat'):join(depot,'ensure_bootstrap'));
run(tool('python-bin/python3'),['--version']);
run('git',['clone','--depth','1','--single-branch','--branch',upstream.version,upstream.repository,source]);
assert.equal(capture('git',['rev-parse','HEAD'],source),upstream.revision,'Official tag/SHA mismatch');
const jobs=String(Math.max(1,Math.min(availableParallelism(),Math.floor(ramGiB/2))));
await writeFile('.chromium/.gclient',`solutions = [{"name":"src","url":${JSON.stringify(upstream.repository+'@'+upstream.revision)},"managed":False,"custom_deps":{},"custom_vars":{"checkout_configuration":"small"}}]\n`);
run(tool('gclient'),['sync','--no-history','--shallow','--jobs=4'],{cwd:resolve('.chromium')});
await phase('configure');
if(os==='linux')run('sudo',['-n','bash','build/install-build-deps.sh','--no-prompt','--no-arm','--no-chromeos-fonts'],{cwd:source});
run(process.execPath,['scripts/apply-chromium-poc.mjs']);
const output=resolve(source,`out/AgenticRelease-${arch}`),outRelative=relative(source,output).replaceAll('\\','/');
await mkdir(output,{recursive:true});
await writeFile(join(output,'args.gn'),`target_os = "${{macos:'mac',windows:'win',linux:'linux'}[os]}"\ntarget_cpu = "${arch}"\nis_debug = false\nis_component_build = false\nis_official_build = false\nsymbol_level = 0\nblink_symbol_level = 0\nv8_symbol_level = 0\nchrome_pgo_phase = 0\nuse_thin_lto = false\nuse_remoteexec = false\n${os==='macos'?'use_system_xcode = true\n':''}`);
run(tool('gn'),['gen',outRelative],{cwd:source});
const targets=os==='linux'?['chrome','chrome_sandbox']:['chrome'];
await phase('compile');
run(tool('autoninja'),['-C',outRelative,'-j',jobs,...targets],{cwd:source});
await phase('stage');
await mkdir(dist,{recursive:true});
const stage=resolve('.runtime/package',target,'Agentic Browser');await mkdir(stage,{recursive:true});
let executable;
if(os==='macos') {
 const app=join(stage,'Agentic Browser.app');await rename(join(output,'Agentic Browser.app'),app);
 executable=join(app,'Contents/MacOS/Agentic Browser');run('codesign',['--verify','--deep','--strict',app]);
} else {
 const dependencies=capture(tool('gn'),['desc',outRelative,'//chrome:chrome','runtime_deps'],source).split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
 if(os==='linux')dependencies.push('chrome_sandbox');
 for(const dep of new Set(dependencies)) {
  const path=resolve(output,dep),rel=relative(output,path);
  assert(!rel.startsWith('..')&&!isAbsolute(rel),'Runtime dependency outside build output: '+dep);
  await cp(path,join(stage,rel),{recursive:true,verbatimSymlinks:true});
 }
 executable=join(stage,os==='windows'?'chrome.exe':'chrome');
}
// Verify the actual binary header, not just the matrix label or asset name.
const binary=await readFile(executable);let machine;
if(os==='macos') {assert.equal(binary.readUInt32LE(0),0xfeedfacf);machine=binary.readUInt32LE(4);assert.equal(machine,arch==='arm64'?0x100000c:0x1000007);}
else if(os==='linux'){assert.equal(binary.subarray(0,4).toString('hex'),'7f454c46');machine=binary.readUInt16LE(18);assert.equal(machine,arch==='arm64'?183:62);}
else {const offset=binary.readUInt32LE(0x3c);assert.equal(binary.subarray(offset,offset+4).toString('hex'),'50450000');machine=binary.readUInt16LE(offset+4);assert.equal(machine,arch==='arm64'?0xaa64:0x8664);}
const smokeArgs=['scripts/smoke-release.mjs',executable,join(reportDir,`smoke-${target}.json`)];
await phase('smoke');
if(os==='linux')run('xvfb-run',['-a',process.execPath,...smokeArgs]);
else run(process.execPath,smokeArgs);
// Staged runtime passed smoke; intermediate objects are no longer needed for packaging.
await rm(output,{recursive:true,force:true});
await phase('package');
await cp(join(source,'LICENSE'),join(stage,'LICENSE'));
await cp('NOTICE.md',join(stage,'NOTICE.md'));
await cp('licenses',join(stage,'licenses'),{recursive:true});
await writeFile(join(stage,'README.txt'),'Agentic Browser '+version+'\nExperimental PoC. No developer certificate signing or notarization.\nLinux: run ./chrome with a working user-namespace sandbox. Never use --no-sandbox.\nWindows: extract the ZIP and run chrome.exe. No installer or registry integration is included.\nMCP/Skill/Plugin are in the separate integration archive.\n');
const basename=`Agentic-Browser-${version}-${target}`;
let asset;
if(os==='macos') {
 await symlink('/Applications',join(stage,'Applications'));
 asset=join(dist,basename+'.dmg');run('hdiutil',['create','-volname','Agentic Browser','-srcfolder',stage,'-format','UDZO',asset]);run('hdiutil',['verify',asset]);
} else if(os==='windows') {asset=join(dist,basename+'.zip');run('python',['-m','zipfile','-c',asset,'Agentic Browser'],{cwd:dirname(stage)});}
else {asset=join(dist,basename+'.tar.xz');run('tar',['-cJf',asset,'-C',dirname(stage),'Agentic Browser']);}
const contents=await readFile(asset),sha256=createHash('sha256').update(contents).digest('hex');
assert(contents.length>10_000_000,'Unexpectedly small browser package');
await writeFile(join(dist,'manifest.json'),JSON.stringify({target,version,sourceCommit:sha,upstream,asset:asset.split(/[\\/]/).at(-1),bytes:contents.length,sha256,binaryArchitecture:arch,componentBuild:false,smoke:'passed',signed:false},null,2)+'\n');
await writeFile(asset+'.sha256',sha256+'  '+asset.split(/[\\/]/).at(-1)+'\n');
await cp(join(reportDir,`smoke-${target}.json`),join(dist,'smoke.json'));
await phase('complete');
console.log(JSON.stringify({target,asset,sha256,smoke:'passed'}));
