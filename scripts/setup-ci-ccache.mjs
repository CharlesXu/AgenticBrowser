import assert from 'node:assert/strict';
import {mkdir,writeFile,appendFile,rm,readdir} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {resolve,join,dirname} from 'node:path';
import {createHash} from 'node:crypto';

assert.equal(process.env.GITHUB_ACTIONS,'true','Only install into an isolated Actions checkout.');
const version='4.14.2';
// Official ccache release asset SHA-256 digests; no package manager or machine-wide install.
const assets={
 'darwin-x64':['darwin.tar.gz','cf240009630b605b775c7c5c7b7105a3b196c79f31af322c1557969aa28003fc'],
 'darwin-arm64':['darwin.tar.gz','cf240009630b605b775c7c5c7b7105a3b196c79f31af322c1557969aa28003fc'],
 'linux-x64':['linux-x86_64-glibc.tar.gz','b1f7fbb60ee24b80a6abae09ec4fcc6554fbf98c933c9bd25a3f53ab685fc00b'],
 'linux-arm64':['linux-aarch64-glibc.tar.gz','bc537a1f29232be50be3219ffe80c7c1955bc80a99c75311d7fb839828c80dd0'],
 'win32-x64':['windows-x86_64.zip','6993ce645e53192cec592ee23186200b574ac4c59097ecde8d9cfd681b47ae84'],
 'win32-arm64':['windows-aarch64.zip','47ea5a0ed661bea53962d8fb8ee9a1769092d979a6f7c73d3081499b3305b2ab'],
};
const [suffix,hash]=assets[`${process.platform}-${process.arch}`]||[];
assert(suffix,'Unsupported runner architecture');
const name=`ccache-${version}-${suffix}`,dir=resolve('.tools/ccache'),archive=join(dir,name);
await mkdir(dir,{recursive:true});
const response=await fetch(`https://github.com/ccache/ccache/releases/download/v${version}/${name}`,{signal:AbortSignal.timeout(120000)});
assert(response.ok,`ccache download failed: HTTP ${response.status}`);
const bytes=Buffer.from(await response.arrayBuffer());
assert.equal(createHash('sha256').update(bytes).digest('hex'),hash,'ccache archive checksum mismatch');
await writeFile(archive,bytes);
execFileSync('tar',['-xf',archive,'-C',dir],{stdio:'inherit'});
await rm(archive);
const executableName=process.platform==='win32'?'ccache.exe':'ccache';
const files=await readdir(dir,{recursive:true});
const candidates=files.filter(file=>file.split(/[\\/]/).at(-1)===executableName);
assert.equal(candidates.length,1,'Expected one ccache executable');
const executable=join(dir,candidates[0]);
execFileSync(executable,['--version'],{stdio:'inherit'});
await appendFile(process.env.GITHUB_PATH,dirname(executable)+'\n');
await appendFile(process.env.GITHUB_ENV,`CCACHE_DIR=${resolve('.runtime/ccache')}\nCCACHE_MAXSIZE=8GiB\nCCACHE_COMPILERCHECK=content\nCCACHE_DEPEND=1\nCCACHE_SLOPPINESS=modules,time_macros\n`);
