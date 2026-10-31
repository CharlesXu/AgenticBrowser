import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,cp,access} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';

// A cross-built package cannot be promoted until this script runs on ARM64.
export async function verifyCandidate(dist,sourceCommit,upstream,version) {
 const manifest=JSON.parse(await readFile(join(dist,'manifest.json'),'utf8'));
 assert.equal(manifest.target,'linux-arm64');
 assert.equal(manifest.sourceCommit,sourceCommit);
 assert.deepEqual(manifest.upstream,upstream);
 assert.equal(manifest.version,version);
 assert.equal(manifest.binaryArchitecture,'arm64');
 assert.equal(manifest.componentBuild,false);
 assert.equal(manifest.smoke,'pending');
 assert.equal(manifest.asset,`Agentic-Browser-${version}-linux-arm64.tar.xz`);
 const bytes=await readFile(join(dist,manifest.asset));
 assert.equal(bytes.length,manifest.bytes);
 assert.equal(createHash('sha256').update(bytes).digest('hex'),manifest.sha256);
 return manifest;
}

async function main() {
 assert.equal(process.env.GITHUB_ACTIONS,'true');
 assert.equal(process.platform,'linux');assert.equal(process.arch,'arm64','Native ARM64 runtime smoke is required.');
 const sha=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
 assert.equal(sha,process.env.GITHUB_SHA);
 const upstream=JSON.parse(await readFile('chromium/upstream.json','utf8'));
 const version=JSON.parse(await readFile('package.json','utf8')).version;
 const candidate=resolve('.runtime/candidate/linux-arm64');
 const manifest=await verifyCandidate(candidate,sha,upstream,version);
 const stage=resolve('.runtime/native-smoke/linux-arm64');
 await access(stage).then(()=>{throw Error('Native smoke requires a fresh extraction directory.');},()=>{});
 await mkdir(stage,{recursive:true});await mkdir('.runtime/ci',{recursive:true});
 execFileSync('tar',['-xJf',join(candidate,manifest.asset),'-C',stage],{stdio:'inherit'});
 const executable=join(stage,'Agentic Browser/chrome'),binary=await readFile(executable);
 assert.equal(binary.subarray(0,4).toString('hex'),'7f454c46');assert.equal(binary.readUInt16LE(18),183);
 const report=resolve('.runtime/ci/smoke-linux-arm64.json');
 execFileSync('xvfb-run',['-a',process.execPath,'scripts/smoke-release.mjs',executable,report],{stdio:'inherit'});
 const smoke=JSON.parse(await readFile(report,'utf8'));
 assert.equal(smoke.status,'passed');assert.equal(smoke.platform,'linux');assert.equal(smoke.arch,'arm64');
 for(const check of ['threeSpaces','sharedLogin','mainProtected','scopedInput','sharedLogout'])assert.equal(smoke.checks[check],true);
 // Keep the exact checked archive bytes. Only the manifest and smoke report change.
 const dist=resolve('.runtime/release/linux-arm64');await cp(candidate,dist,{recursive:true});
 await writeFile(join(dist,'manifest.json'),JSON.stringify({...manifest,smoke:'passed'},null,2)+'\n');
 await cp(report,join(dist,'smoke.json'));
 console.log(JSON.stringify({target:manifest.target,sourceCommit:sha,sha256:manifest.sha256,smoke:'passed'}));
}
if(import.meta.url===pathToFileURL(process.argv[1]).href)await main();
