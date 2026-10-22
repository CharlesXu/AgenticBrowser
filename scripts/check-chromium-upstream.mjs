import { readFile } from 'node:fs/promises';

// Read-only: checking a release must not move the working browser checkout.
const pinned = JSON.parse(await readFile(new URL('../chromium/upstream.json', import.meta.url), 'utf8'));
const endpoint = new URL('https://chromiumdash.appspot.com/fetch_releases');
endpoint.search = new URLSearchParams({channel:pinned.channel, platform:pinned.platform, num:'1'}).toString();
const response = await fetch(endpoint, {signal:AbortSignal.timeout(30000)});
if (!response.ok) throw new Error(`ChromiumDash HTTP ${response.status}`);
const [latest] = await response.json();
if (!/^\d+\.\d+\.\d+\.\d+$/.test(latest?.version) ||
    !/^[a-f0-9]{40}$/.test(latest?.hashes?.chromium) ||
    latest.channel !== pinned.channel || latest.platform !== pinned.platform)
  throw new Error('Unexpected upstream release metadata');
const compare = (a,b) => {
  const left=a.split('.').map(Number),right=b.split('.').map(Number);
  for(let i=0;i<4;i++) if(left[i]!==right[i]) return Math.sign(left[i]-right[i]);
  return 0;
};
const delta=compare(latest.version,pinned.version);
if(delta===0 && latest.hashes.chromium!==pinned.revision)
  throw new Error('Same upstream version has a different commit; manual inspection required');
console.log(JSON.stringify({
  status:delta>0?'update_available':delta===0?'up_to_date':'pinned_is_newer',
  pinned:{version:pinned.version,revision:pinned.revision},
  latest:{version:latest.version,revision:latest.hashes.chromium},
  compareUrl:`https://chromium.googlesource.com/chromium/src/+log/${pinned.revision}..${latest.hashes.chromium}`,
},null,2));
