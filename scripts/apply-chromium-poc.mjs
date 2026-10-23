import { readFile, copyFile } from 'node:fs/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(root, '.chromium/src');
const upstream = JSON.parse(await readFile(resolve(root, 'chromium/upstream.json'), 'utf8'));
const revision = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (revision !== upstream.revision) throw new Error('Unexpected Chromium revision; not applying PoC hooks.');

// Keep the actual upstream source diff reviewable in Git. A conflicting or
// partially applied patch stops without resetting the checkout.
const patch = resolve(root, 'chromium/upstream.patch');
const alreadyApplied = spawnSync('git', ['-C', source, 'apply', '--reverse', '--check', patch], {stdio:'ignore'}).status === 0;
if (!alreadyApplied) {
  execFileSync('git', ['-C', source, 'apply', '--check', patch], {stdio:'inherit'});
  execFileSync('git', ['-C', source, 'apply', patch], {stdio:'inherit'});
}
execFileSync(process.execPath, [resolve(root, 'scripts/prepare-product.mjs')], { stdio: 'inherit' });
execFileSync(process.execPath, [resolve(root, 'scripts/prepare-branding.mjs')], { stdio: 'inherit' });
for (const name of ['agentic_poc.h', 'agentic_poc.cc', 'agentic_space_controls.h', 'agentic_space_controls.cc', 'agentic_model_handler.cc', 'agentic_model_handler.h']) {
  const from = resolve(root, 'chromium', name);
  const to = resolve(source, 'chrome/browser', name);
  const current = await readFile(to, 'utf8').catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (current !== null && current !== await readFile(from, 'utf8'))
    throw new Error(`${to} differs from the project overlay; refusing to overwrite.`);
  if (current === null) await copyFile(from, to);
}
console.log('Native PoC hooks applied to the pinned source. No commit created.');

for (const name of ['agentic_models.ts','agentic_models.html.ts','agentic_model_api.ts','agentic_decision.ts','agentic_xiangqi.ts']) {
  const from=resolve(root,'chromium/settings',name);
  const to=resolve(source,'chrome/browser/resources/settings/ai_page',name);
  const current=await readFile(to,'utf8').catch(error=>{if(error.code==='ENOENT')return null;throw error;});
  if(current!==null && current!==await readFile(from,'utf8'))throw new Error(`${to} differs from the project overlay; refusing to overwrite.`);
  if(current===null)await copyFile(from,to);
}
