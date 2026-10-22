// Plugin entry point: one user-selected capability, never automatic discovery.
import {homedir} from 'node:os';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const args=process.argv.slice(2);
if(args.length && (args.length!==2 || args[0]!=='--harness' || !['codex','claude'].includes(args[1])))
  throw new Error('Usage: plugin-mcp.mjs [--harness codex|claude]');
const binding=args.length?`${args[1]}.json`:'connection.json';
const connection=process.env.AGENTIC_BROWSER_CONNECTION || resolve(homedir(),'.config/agentic-browser',binding);
process.argv=[process.execPath,resolve(dirname(fileURLToPath(import.meta.url)),'mcp.ts'),'--connection',connection];
await import('./mcp.ts');
