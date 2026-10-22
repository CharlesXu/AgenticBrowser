import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = resolve(dirname(fileURLToPath(import.meta.url)), '../.runtime/extensions');
await mkdir(directory, { recursive: true });
const zip = resolve(directory, 'darkreader-4.9.133-mv3.zip');
const url = 'https://github.com/darkreader/darkreader/releases/download/v4.9.133/darkreader-chrome-mv3.zip';
let bytes = await readFile(zip).catch(error => {
  if (error.code === 'ENOENT') return null;
  throw error;
});
if (!bytes) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Extension download failed: ${response.status}`);
  bytes = Buffer.from(await response.arrayBuffer());
}
// Pin the bytes retrieved from the official release; not a publisher signature.
if (createHash('sha256').update(bytes).digest('hex') !== 'a5a1a9c78d377fafd8c9190ce9d57b96f89bc95d21f077888601e4c445b20ebf')
  throw new Error('Extension archive does not match the pinned release bytes.');
await writeFile(zip, bytes);
execFileSync('ditto', ['-x', '-k', zip, resolve(directory, 'darkreader-4.9.133-mv3')]);

// Local fix for this pinned sample, not a Chromium compatibility patch.
// Concurrent DOCUMENT_CONNECT handlers can mutate tabs during a pending save;
// StateManager then reloads the older snapshot and forgets connected pages.
const backgroundFile = resolve(directory, 'darkreader-4.9.133-mv3/background/index.js');
let background = await readFile(backgroundFile, 'utf8');
const start = background.indexOf('case MessageTypeCStoBG.DOCUMENT_CONNECT: {');
const end = background.indexOf('case MessageTypeCStoBG.DOCUMENT_FORGET:', start);
if (start < 0 || end < 0) throw new Error('Pinned extension connection handler changed.');
let connect = background.slice(start, end);
const eol = background.includes('\r\n') ? '\r\n' : '\n';
for (const [before, after] of [
  ['TabManager.stateManager.loadState().then(() => {',
    'TabManager.connectionQueue = TabManager.connectionQueue.then(async () => {' + eol +
    '                            await TabManager.stateManager.loadState();'],
  ['TabManager.stateManager.saveState();', 'await TabManager.stateManager.saveState();'],
]) {
  if (connect.split(before).length !== 2) throw new Error('Pinned extension connection handler changed.');
  connect = connect.replace(before, after);
}
background = background.slice(0, start) + connect + background.slice(end);
const key = 'static LOCAL_STORAGE_KEY = "TabManager-state";';
if (background.split(key).length !== 2) throw new Error('Pinned extension TabManager changed.');
background = background.replace(key, key + eol +
  '        static connectionQueue = Promise.resolve(); // AgenticBrowser sample: serialize registrations.');
await writeFile(backgroundFile, background);
console.log('Dark Reader 4.9.133 MV3 prepared with local connection-registration fix; original ZIP retained. No personal browser modified.');
