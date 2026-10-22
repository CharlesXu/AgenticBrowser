#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { TaskSpace } from './page.mjs';
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === 'skill')
  console.log(
    await readFile(new URL('../skills/agentic-browser/SKILL.md', import.meta.url), 'utf8'),
  );
else if (args.length === 4 && args[0] === 'run' && args[1] === '--connection') {
  const script = await import(pathToFileURL(resolve(args[3])).href);
  if (typeof script.default !== 'function')
    throw Error('Script must export default async function(task).');
  const task = await TaskSpace.connect(args[2]);
  try {
    await script.default(task);
  } finally {
    const state = await task.observe().catch(() => null);
    if (!task.closed && state?.owner === 'agent') await task.finish();
  }
} else {
  console.error('Usage: agentic-browser.mjs skill | run --connection <private file> <script.mjs>');
  process.exitCode = 1;
}
