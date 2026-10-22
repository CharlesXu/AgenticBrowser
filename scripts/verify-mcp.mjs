import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { readConnection, SpaceClient } from '../src/space-client.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [fileA, fileB, output = resolve(root, 'evidence', `mcp-${Date.now()}.json`)] = process.argv.slice(2);
if (!fileA || !fileB || process.argv.length > 5) {
  console.error('Usage: node scripts/verify-mcp.mjs <task-a.json> <task-b.json> [evidence.json]');
  process.exit(1);
}
const connectionA = await readConnection(resolve(fileA));
const connectionB = await readConnection(resolve(fileB));
assert.equal(connectionA.space, 'task-a');
assert.equal(connectionB.space, 'task-b');
assert.equal(connectionA.port, connectionB.port);
const directA = new SpaceClient(connectionA);
const directB = new SpaceClient(connectionB);
const records = { status: 'running', scope: 'Two real MCP stdio clients; targeted smoke, not full phase-1 acceptance', checks: {} };
const clients = [];

async function connect(file) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve(root, 'src/mcp.ts'), '--connection', resolve(file)],
    cwd: root,
    stderr: 'pipe',
  });
  // Avoid echoing startup paths or any unexpected sensitive stderr.
  transport.stderr?.on('data', () => {});
  const client = new Client({ name: 'agentic-browser-smoke', version: '0.1.0' });
  clients.push(client);
  await client.connect(transport);
  return client;
}
async function call(client, name, args = {}, expectedError = false) {
  const response = await client.callTool({ name, arguments: args });
  assert.equal(Boolean(response.isError), expectedError, `${name} error status`);
  return JSON.parse(response.content.find(item => item.type === 'text').text);
}
async function waitFor(check, description) {
  const until = Date.now() + 5000;
  while (Date.now() < until) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out: ${description}`);
}

try {
  const [a, b] = await Promise.all([connect(fileA), connect(fileB)]);
  const tools = await Promise.all([a.listTools(), b.listTools()]);
  const expectedTools = ['space_list', 'space_observe', 'space_claim', 'space_handoff', 'space_release',
    'space_resume', 'space_navigate', 'space_click', 'space_type', 'space_scroll',
    'space_snapshot', 'space_screenshot', 'space_click_ref', 'space_fill', 'space_tabs',
    'space_new_tab', 'space_select_tab', 'space_close_tab'].sort();
  for (const list of tools) {
    assert.deepEqual(list.tools.map(t => t.name).sort(), expectedTools);
    for (const tool of list.tools) {
      assert.equal(tool.inputSchema.additionalProperties, false);
      assert.equal(tool.inputSchema.properties.space, undefined);
      assert.equal(tool.inputSchema.properties.token, undefined);
    }
  }
  assert.deepEqual(await call(a, 'space_list'), { spaces: ['task-a'] });
  assert.deepEqual(await call(b, 'space_list'), { spaces: ['task-b'] });
  records.checks.initializeListAndScopedDiscovery = true;

  const [seenA, seenB] = await Promise.all([call(a, 'space_observe'), call(b, 'space_observe')]);
  assert.equal(seenA.owner, 'available', 'A must be idle before this test');
  assert.equal(seenB.owner, 'available', 'B must be idle before this test');
  const [leaseA, leaseB] = await Promise.all([call(a, 'space_claim'), call(b, 'space_claim')]);
  const crossTab = await call(a, 'space_type', { ...leaseA, tab: seenB.tab, text: 'MUST-NOT-ARRIVE' }, true);
  assert.equal(crossTab.status, 403);
  records.checks.crossSpaceTabRejected = true;
  let scopeRejected = false;
  try {
    const extra = await a.callTool({ name: 'space_observe', arguments: { space: 'main' } });
    scopeRejected = Boolean(extra.isError);
  } catch { scopeRejected = true; }
  assert.equal(scopeRejected, true);
  const main = await fetch(`http://127.0.0.1:${connectionA.port}/space`, {
    method: 'POST', headers: { Authorization: `Bearer ${connectionA.token}` },
    body: JSON.stringify({ space: 'main', action: 'observe' }),
    signal: AbortSignal.timeout(5000), redirect: 'error',
  });
  assert.equal(main.status, 403);
  records.checks.mainAndScopeOverrideRejected = true;

  const urlA = new URL(seenA.url), urlB = new URL(seenB.url);
  // Only run on the repository's own loopback fixture, never an arbitrary site.
  for (const url of [urlA, urlB]) assert.equal(url.hostname, '127.0.0.1');
  urlA.searchParams.set('mcp-smoke', 'A');
  urlB.searchParams.set('mcp-smoke', 'B');
  await Promise.all([
    call(a, 'space_navigate', { ...leaseA, tab: seenA.tab, url: urlA.href }),
    call(b, 'space_navigate', { ...leaseB, tab: seenB.tab, url: urlB.href }),
  ]);
  await waitFor(async () => {
    const [stateA, stateB] = await Promise.all([call(a, 'space_observe'), call(b, 'space_observe')]);
    return stateA.url === urlA.href && stateB.url === urlB.href;
  }, 'both navigation URLs committed');
  records.checks.independentNavigationObserved = true;

  await call(a, 'space_release', leaseA);
  const stale = await call(a, 'space_type', { ...leaseA, tab: seenA.tab, text: 'STALE' }, true);
  assert.equal(stale.status, 409);
  records.checks.releasedLeaseRejected = true;
  await b.close();
  await waitFor(async () => (await directB.request('observe')).owner === 'available', 'B lease released on stdio close');
  assert.equal((await directA.request('observe')).owner, 'available');
  records.checks.normalClientCloseReleasesOwnLease = true;
  records.status = 'passed';
} catch (error) {
  records.status = 'failed';
  // Assertion messages here name checks only, never credentials.
  records.failure = error.message;
  throw error;
} finally {
  await Promise.allSettled(clients.map(client => client.close()));
  records.timestamp = new Date().toISOString();
  await mkdir(dirname(resolve(output)), { recursive: true });
  await writeFile(resolve(output), JSON.stringify(records, null, 2) + '\n');
  console.log(JSON.stringify({ status: records.status, evidence: resolve(output), checks: records.checks }));
}
