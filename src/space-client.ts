import { readFile, stat } from 'node:fs/promises';
import { z } from 'zod/v4';

const connectionSchema = z.strictObject({
  port: z.number().int().min(1).max(65535),
  space: z.enum(['task-a', 'task-b']),
  token: z.string().min(16).max(256),
});

export type SpaceConnection = z.infer<typeof connectionSchema>;

export async function readConnection(file: string): Promise<SpaceConnection> {
  const info = await stat(file);
  if (!info.isFile() || info.size > 4096 ||
      (process.platform !== 'win32' && (info.mode & 0o077) !== 0)) {
    throw new Error('Connection must be a private, single-Space credential file.');
  }
  const parsed = connectionSchema.safeParse(JSON.parse(await readFile(file, 'utf8')));
  if (!parsed.success) throw new Error('Invalid single-Space connection file.');
  return parsed.data;
}

export class SpaceRequestError extends Error {
  status: number;
  constructor(status: number, reason: string) {
    super(reason);
    this.status = status;
  }
}

export class SpaceClient {
  #connection: SpaceConnection;
  constructor(connection: SpaceConnection) { this.#connection = connection; }
  get space() { return this.#connection.space; }

  async request(action: string, fields: Record<string, unknown> = {}) {
    let response: Response;
    try {
      response = await fetch(`http://127.0.0.1:${this.#connection.port}/space`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.#connection.token}` },
        // Fixed last: callers cannot select another endpoint or Space.
        body: JSON.stringify({ ...fields, space: this.space, action }),
        signal: AbortSignal.timeout(5000),
        redirect: 'error',
      });
    } catch {
      throw new SpaceRequestError(503, 'browser_unavailable_or_timeout');
    }
    const body = await response.json() as Record<string, unknown>;
    if (!response.ok) {
      const reason = typeof body.error === 'string' && /^[a-z_]{1,80}$/.test(body.error)
        ? body.error : 'browser_rejected';
      throw new SpaceRequestError(response.status, reason);
    }
    return body;
  }
}
