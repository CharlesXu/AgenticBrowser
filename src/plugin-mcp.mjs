// Plugin entry point: one user-selected capability, never automatic discovery.
import {homedir} from 'node:os';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const connection=process.env.AGENTIC_BROWSER_CONNECTION || resolve(homedir(),'.config/agentic-browser/connection.json');
process.argv=[process.execPath,resolve(dirname(fileURLToPath(import.meta.url)),'mcp.ts'),'--connection',connection];
await import('./mcp.ts');
