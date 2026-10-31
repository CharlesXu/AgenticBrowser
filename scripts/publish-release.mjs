import assert from 'node:assert/strict';
import {readFile,writeFile,readdir,stat} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';

const repository='CharlesXu/AgenticBrowser',source=process.env.GITHUB_SHA;
assert(process.env.GITHUB_ACTIONS==='true'&&/^[a-f0-9]{40}$/.test(source||''),'Publish only from the checked Actions commit');
const gh=(args)=>execFileSync('gh',args,{encoding:'utf8',maxBuffer:4*1024*1024});
assert.equal(JSON.parse(gh(['api',`repos/${repository}`])).private,false,'Public repository required');
const version=JSON.parse(await readFile('package.json','utf8')).version;
const upstream=JSON.parse(await readFile('chromium/upstream.json','utf8'));
const artifacts=resolve('.runtime/release-artifacts'),assets=[],manifests=[];
assert.equal((await readdir(artifacts)).length,6,'Expected exactly six browser artifacts');
for(const os of ['macos','windows','linux'])for(const arch of ['x64','arm64']) {
 const target=`${os}-${arch}`,dir=join(artifacts,'browser-'+target);
 const manifest=JSON.parse(await readFile(join(dir,'manifest.json'),'utf8'));
 const smoke=JSON.parse(await readFile(join(dir,'smoke.json'),'utf8'));
 assert.equal(manifest.target,target);assert.equal(manifest.version,version);assert.equal(manifest.sourceCommit,source);assert.deepEqual(manifest.upstream,upstream);
 assert.equal(manifest.componentBuild,false);assert.equal(manifest.binaryArchitecture,arch);assert.equal(manifest.smoke,'passed');assert.equal(smoke.status,'passed');
 assert.equal(smoke.platform,{macos:'darwin',windows:'win32',linux:'linux'}[os]);assert.equal(smoke.arch,arch);
 for(const key of ['threeSpaces','sharedLogin','mainProtected','scopedInput','sharedLogout'])assert.equal(smoke.checks[key],true);
 const expected=`Agentic-Browser-${version}-${target}.${{macos:'dmg',windows:'zip',linux:'tar.xz'}[os]}`;
 assert.equal(manifest.asset,expected);
 const path=join(dir,expected),bytes=await readFile(path);
 assert.equal(bytes.length,manifest.bytes);assert.equal(createHash('sha256').update(bytes).digest('hex'),manifest.sha256);
 assets.push(path);manifests.push(manifest);
}
const integrationVersion=JSON.parse(await readFile('integrations/package.json','utf8')).version;
assets.push(resolve(`.runtime/dist/agentic-browser-integration-${integrationVersion}.tgz`));
assets.push(resolve('licenses/Chromium-LICENSE'),resolve('NOTICE.md'));
const checksums=[];
for(const file of assets)checksums.push(createHash('sha256').update(await readFile(file)).digest('hex')+'  '+file.split(/[\\/]/).at(-1));
const checksumFile=resolve('.runtime/SHA256SUMS.txt'),manifestFile=resolve('.runtime/release-manifest.json');
await writeFile(checksumFile,checksums.join('\n')+'\n');await writeFile(manifestFile,JSON.stringify(manifests,null,2)+'\n');assets.push(checksumFile,manifestFile);
const tag=`v${version}-poc.${source.slice(0,16)}`;
const releases=JSON.parse(gh(['api',`repos/${repository}/releases?per_page=100`]));assert(!releases.some(r=>r.tag_name===tag),'Release already exists; refusing to overwrite');
const notes=resolve('.runtime/release-notes.md');
await writeFile(notes,`Agentic Browser ${version} · ${source.slice(0,16)}\n\nChromium ${upstream.version} · ${upstream.revision}\n\nWindows/macOS/Linux × x64/arm64，全部使用独立非 component 构建。已通过原生架构、三个空间、共享登录/退出、主空间保护、空间输入冒烟。\n\n这是公开 PoC 预发布版。macOS 为临时签名，尚无 Developer ID 签名或公证；Windows 未做 Authenticode 签名。Windows 为免安装 ZIP，解压后运行 chrome.exe，不做安装器或注册表集成。Linux tar.xz 要求系统支持用户命名空间沙箱。\n\n未将跨平台人工 UI、VNC、锁屏或真实模型验收计作通过。Skill/Plugin/MCP 接入套件单独附带。\n\nPublic PoC pre-release; no developer certificate signing/notarization. Runtime smoke checks are not a full cross-platform feature certification.\n\nSource: ${source}\nActions: https://github.com/${repository}/actions/runs/${process.env.GITHUB_RUN_ID}\n`);
// Keep the release a draft until every expected asset is uploaded and read back.
gh(['release','create',tag,...assets,'--repo',repository,'--target',source,'--title',`Agentic Browser ${version} PoC`,'--notes-file',notes,'--draft','--prerelease']);
const result=JSON.parse(gh(['release','view',tag,'--repo',repository,'--json','assets,isDraft,url']));
assert.equal(result.isDraft,true);assert.equal(result.assets.length,assets.length);
for(const file of assets){const name=file.split(/[\\/]/).at(-1),remote=result.assets.find(a=>a.name===name);assert(remote);assert.equal(remote.size,(await stat(file)).size);}
gh(['release','edit',tag,'--repo',repository,'--draft=false']);
const final=JSON.parse(gh(['release','view',tag,'--repo',repository,'--json','url,isDraft,isPrerelease,assets']));assert.equal(final.isDraft,false);assert.equal(final.isPrerelease,true);
console.log(JSON.stringify({url:final.url,assets:final.assets.map(a=>({name:a.name,size:a.size})),private:false}));
