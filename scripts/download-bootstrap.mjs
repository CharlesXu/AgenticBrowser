import { mkdir, access } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// Explicit bootstrap fallback, not the source-built Chromium product.
if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  throw new Error('This first-stage bootstrap is for macOS arm64 only.');
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtime = resolve(root, '.runtime');
const executable = resolve(runtime, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
if (await access(executable).then(() => true, () => false)) {
  console.log(`Already present: ${executable}`);
} else {
  await mkdir(runtime, { recursive: true });
  const url = 'https://storage.googleapis.com/chrome-for-testing-public/156.0.8078.47/mac-arm64/chrome-mac-arm64.zip';
  const zip = resolve(runtime, 'chrome-mac-arm64-156.0.8078.47.zip');
  if (!await access(zip).then(() => true, () => false)) {
    console.log(`Downloading official bootstrap: ${url}`);
    const response = await fetch(url);
    if (!response.ok || !response.body) throw new Error(`Download failed: ${response.status}`);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(zip, { flags: 'wx' }));
  }
  execFileSync('ditto', ['-x', '-k', zip, runtime], { stdio: 'inherit' });
  console.log(`Ready: ${executable}`);
}
