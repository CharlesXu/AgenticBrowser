import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod/v4';
import { readFile } from 'node:fs/promises';
import { readConnection, SpaceClient, SpaceRequestError } from './space-client.ts';

// One stdio process has one Space capability. No global browser/profile API.
if (process.argv.length !== 4 || process.argv[2] !== '--connection') {
  console.error('Usage: node src/mcp.ts --connection <single-space-credential.json>');
  process.exit(1);
}
let client: SpaceClient;
try {
  client = new SpaceClient(await readConnection(process.argv[3]));
} catch {
  console.error('Cannot read a valid private single-Space connection file.');
  process.exit(1);
}

const lease = z.string().min(1).max(256);
const generation = z.number().int().positive();
const control = { lease, generation };
const target = { ...control, tab: z.string().min(1).max(128) };
const coordinate = z.number().finite().nonnegative();
let owned: { lease: string; generation: number } | undefined;
let pending: Promise<unknown> = Promise.resolve();
let closing = false;
let cleanup: Promise<void> | undefined;

const result = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value) }],
});
const guide = await readFile(new URL('../skills/agentic-browser/SKILL.md', import.meta.url), 'utf8');

function releaseOnClose() {
  if (cleanup) return cleanup;
  closing = true;
  cleanup = (async () => {
    // A claim already sent to the browser may finish after stdin closes.
    await pending;
    if (owned) await client.request('release', owned).catch(() => {});
    owned = undefined;
  })();
  return cleanup;
}

async function act(action: string, fields: Record<string, unknown> = {}) {
  if (closing) return { ...result({ error: 'mcp_closing' }), isError: true };
  const request = pending.then(async () => {
    try {
      const value = await client.request(action, fields);
      if ((action === 'claim' || action === 'resume') &&
          typeof value.lease === 'string' && typeof value.generation === 'number') {
        owned = { lease: value.lease, generation: value.generation };
      }
      if (action === 'release' && fields.lease === owned?.lease) owned = undefined;
      return result(value);
    } catch (error) {
      const detail = error instanceof SpaceRequestError
        ? { error: error.message, status: error.status }
        : { error: 'invalid_browser_response' };
      return { ...result(detail), isError: true };
    }
  });
  pending = request.then(() => {});
  return request;
}

const handle = serveStdio(() => {
  const server = new McpServer({ name: 'agentic-browser-space', version: '0.2.0' });
  server.registerResource('space-operation-guide', 'agentic-browser://guide', {
    title: 'Agentic Browser operation guide', mimeType: 'text/markdown',
    description: 'The guide shipped with this adapter. Read before operating for supported tools and the handoff workflow.',
  }, uri => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: guide }] }));
  server.registerTool('space_list', {
    description: 'List the only Space authorized for this MCP connection. Main Space is never exposed.',
    inputSchema: z.strictObject({}),
    annotations: { readOnlyHint: true },
  }, async () => result({ spaces: [client.space] }));
  server.registerTool('space_observe', {
    description: 'Read selected tab metadata and control state, not DOM content or a screenshot. After resume, pass the NEW lease and generation to authorize subsequent actions.',
    inputSchema: z.strictObject({ lease: lease.optional(), generation: generation.optional() })
      .refine(v => (v.lease === undefined) === (v.generation === undefined), 'Provide both lease and generation, or neither.'),
    annotations: { readOnlyHint: true },
  }, fields => act('observe', fields));
  server.registerTool('space_claim', {
    description: 'Acquire this available Space. Returns lease/generation. Does not take over a human or remote controller.',
    inputSchema: z.strictObject({}),
  }, () => act('claim'));
  server.registerTool('space_handoff', {
    description: 'Give this Space to the human without closing tabs. Stop input and keep the previous lease privately. After the human explicitly returns control, resume with that proof and observe the new generation before acting.',
    inputSchema: z.strictObject(control),
  }, fields => act('handOff', fields));
  server.registerTool('space_release', {
    description: 'Release the current lease. An old lease cannot affect the current controller.',
    inputSchema: z.strictObject(control),
  }, fields => act('release', fields));
  server.registerTool('space_resume', {
    description: 'After control is explicitly returned, prove original ownership with the PREVIOUS lease. Then observe using the returned NEW lease/generation before acting.',
    inputSchema: z.strictObject({ lease }),
  }, fields => act('resume', fields));
  server.registerTool('space_navigate', {
    description: 'Navigate the selected tab in this Space to HTTP/HTTPS. Dispatched is not proof of load completion; observe afterward.',
    inputSchema: z.strictObject({ ...target, url: z.url().refine(v => /^https?:\/\//i.test(v), 'HTTP/HTTPS only') }),
  }, fields => act('navigate', fields));
  server.registerTool('space_click', {
    description: 'Click the selected tab at viewport CSS coordinates. Only the current Space lease and tab may receive input.',
    inputSchema: z.strictObject({ ...target, x: coordinate, y: coordinate }),
  }, fields => act('click', fields));
  server.registerTool('space_type', {
    description: 'Insert text into the focused field of this Space. First click the field and verify focus. A takeover invalidates old actions.',
    inputSchema: z.strictObject({ ...target, text: z.string().max(8192) }),
  }, fields => act('type', fields));
  server.registerTool('space_scroll', {
    description: 'Scroll this Space at viewport CSS coordinates. Positive deltaY scrolls down.',
    inputSchema: z.strictObject({ ...target, x: coordinate, y: coordinate, deltaY: z.number().finite().min(-5000).max(5000) }),
  }, fields => act('scroll', fields));
  server.server.onclose = () => { void releaseOnClose(); };
  return server;
}, { onerror: () => console.error('MCP transport error.') });

async function shutdown() {
  await releaseOnClose();
  await handle.close();
}
process.once('SIGINT', () => { void shutdown(); });
process.once('SIGTERM', () => { void shutdown(); });
process.stdin.once('end', () => { void releaseOnClose(); });
