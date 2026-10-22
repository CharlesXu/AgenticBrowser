// Anonymous API lookup: private assets must never become public download links.
import {writeFile} from 'node:fs/promises';
const repo=process.env.RELEASE_REPOSITORY || 'CharlesXu/AgenticBrowser';
if(!/^CharlesXu\/[A-Za-z0-9_.-]+$/.test(repo))throw Error('Use an official CharlesXu distribution repository.');
const response=await fetch(`https://api.github.com/repos/${repo}/releases/latest`,{headers:{Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2026-03-10'},signal:AbortSignal.timeout(15000)});
let manifest={version:null,assets:[],integration:null};
if(response.status!==404){
 if(!response.ok)throw Error(`Public release lookup failed: ${response.status}`);
 const release=await response.json();
 if(release.draft||release.prerelease)throw Error('Expected a published stable release.');
 const assets=[];let integration=null;
 for(const asset of release.assets??[]){
  if(asset.state!=='uploaded'||asset.size<=0||!/^sha256:[a-f0-9]{64}$/.test(asset.digest??''))continue;
  const url=new URL(asset.browser_download_url);
  if(url.origin!=='https://github.com'||!url.pathname.startsWith(`/${repo}/releases/download/`))continue;
  const details={url:url.href,sha256:asset.digest.slice(7),bytes:asset.size};
  const match=/^Agentic-Browser-[\d.]+-(macos|windows|linux)-(arm64|x64)\.(dmg|pkg|exe|msi|deb|AppImage|tar\.xz)$/.exec(asset.name);
  if(match)assets.push({os:match[1],arch:match[2],...details});
  if(/^agentic-browser-integration-[\d.]+\.tgz$/.test(asset.name))integration=details;
 }
 manifest={version:assets.length?release.tag_name:null,assets,integration};
}
await writeFile('website/releases.json',JSON.stringify(manifest,null,2)+'\n');
console.log(JSON.stringify({publicInstallers:manifest.assets.length,integration:!!manifest.integration,version:manifest.version}));
