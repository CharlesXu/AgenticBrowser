// Small acceptance helper: real RFB decoding over the same authenticated WS
// endpoint used by noVNC. Callers decide assertions and evidence scope.
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export async function connectVnc(profile) {
  const session = JSON.parse(await readFile(resolve(profile, 'vnc-session.json'), 'utf8'));
  const url = new URL(session.url);
  const token = url.hash.slice(1);
  const api = async (path, method = 'GET') => {
    const response = await fetch(new URL(path, url.origin), {
      method, headers: { Authorization: `Bearer ${token}`, Origin: url.origin },
      signal: AbortSignal.timeout(5000),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(`${path}: ${response.status} ${body.error}`);
    return body;
  };
  const { password } = await api('/credentials');
  let websocket, tcp;
  const proxy = createServer(socket => {
    tcp = socket;
    socket.pause();
    websocket = new WebSocket(`${url.origin.replace('http', 'ws')}/rfb?token=${encodeURIComponent(token)}`, { origin: url.origin });
    websocket.on('open', () => socket.resume());
    websocket.on('message', data => socket.write(data));
    socket.on('data', data => websocket.send(data));
    socket.on('close', () => websocket.close());
    websocket.on('close', () => socket.destroy());
    socket.on('error', () => websocket.close());
    websocket.on('error', () => socket.destroy());
  });
  await new Promise(done => proxy.listen(0, '127.0.0.1', done));
  const child = spawn(resolve(root, '.runtime/bin/vnc-probe'), [`127.0.0.1:${proxy.address().port}`], { stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.write(password);
  const frames = [], events = [], errors = [];
  child.stderr.on('data', data => errors.push(data.toString()));
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    const event = JSON.parse(line);
    events.push(event);
    if (event.type === 'frame') frames.push(event);
  });
  const waitFor = async (predicate, description, timeout = 10000) => {
    const until = Date.now() + timeout;
    while (!predicate()) {
      if (child.exitCode !== null || child.signalCode) throw new Error(`RFB probe exited during ${description}: ${errors.join('').slice(-1200)}`);
      if (Date.now() >= until) throw new Error(`Timed out: ${description}`);
      await new Promise(done => setTimeout(done, 25));
    }
  };
  const close = async () => {
    child.stdin.end('quit\n');
    child.kill('SIGTERM');
    websocket?.close(); tcp?.destroy(); proxy.close();
    if (child.exitCode === null && !child.signalCode) await new Promise(done => child.once('exit', done));
  };
  try {
    await waitFor(() => events.some(event => event.type === 'connected'), 'RFB handshake');
    await waitFor(() => frames.length > 1, 'decoded RFB frame');
  } catch (error) { await close(); throw error; }
  return {
    api, frames, events, waitFor, close,
    pointer: (x, y, mask) => child.stdin.write(`pointer ${x} ${y} ${mask}\n`),
    key: (keysym, down) => child.stdin.write(`key ${keysym} ${down ? 1 : 0}\n`),
    snapshot: async path => {
      const before = events.filter(event => event.type === 'snapshot').length;
      child.stdin.write(`snapshot ${resolve(path)}\n`);
      await waitFor(() => events.filter(event => event.type === 'snapshot').length > before, 'RFB snapshot');
      if (!events.filter(event => event.type === 'snapshot').at(-1).ok) throw new Error('RFB snapshot failed');
    },
  };
}
