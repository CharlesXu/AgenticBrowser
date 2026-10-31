import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile,copyFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';

assert(process.env.GITHUB_ACTIONS==='true'&&process.platform==='linux'&&process.arch==='arm64',
 'This fallback is only for an isolated native Linux ARM64 Actions build.');
const version='3.2',sha256='e0ddadebb396906a3e3e4cac2f697c8d6ab92dffa5d365a5bc23c7d41d30ef62';
const url=`https://ftp.gnu.org/gnu/gperf/gperf-${version}.tar.gz`;
const deps=await readFile('.chromium/src/DEPS','utf8');
assert(/'src\/third_party\/gperf\/cipd':\s*\{[\s\S]*?'version': 'version:3@3\.2'/.test(deps),
 'Review the gperf fallback when the upstream dependency version changes.');
const dir=resolve('.tools/gperf'),source=join(dir,`gperf-${version}`);
const prefix=resolve('.chromium/src/third_party/gperf/cipd');
await mkdir(dir,{recursive:true});
const response=await fetch(url,{signal:AbortSignal.timeout(120000)});
assert(response.ok,`gperf download failed: HTTP ${response.status}`);
const bytes=Buffer.from(await response.arrayBuffer());
assert.equal(createHash('sha256').update(bytes).digest('hex'),sha256,'gperf source checksum mismatch');
const archive=join(dir,`gperf-${version}.tar.gz`);await writeFile(archive,bytes);
execFileSync('tar',['-xzf',archive,'-C',dir],{stdio:'inherit'});
execFileSync('./configure',[`--prefix=${prefix}`],{cwd:source,stdio:'inherit'});
execFileSync('make',['-j2','install'],{cwd:source,stdio:'inherit'});
const executable=join(prefix,'bin/gperf'),binary=await readFile(executable);
assert.equal(binary.subarray(0,4).toString('hex'),'7f454c46');
assert.equal(binary.readUInt16LE(18),183,'gperf must be a native ARM64 executable');
const actualVersion=execFileSync(executable,['--version'],{encoding:'utf8'}).split('\n')[0];
assert.equal(actualVersion,`GNU gperf ${version}`);
await copyFile(join(source,'COPYING'),join(prefix,'COPYING'));
const report={version,url,sha256,platform:process.platform,arch:process.arch,actualVersion};
await mkdir('.runtime/ci',{recursive:true});
await writeFile('.runtime/ci/gperf-linux-arm64.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report));
