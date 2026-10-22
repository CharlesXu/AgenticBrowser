import { createServer, type IncomingMessage } from 'node:http';
import { createConnection, isIPv4, type Socket } from 'node:net';
import { spawn } from 'node:child_process';
import { readFile, writeFile, rm, access, open } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createInterface } from 'node:readline';
import WebSocket, { WebSocketServer } from 'ws';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
function option(name: string, fallback?: string) {
  const at = process.argv.indexOf(name);
  if (at < 0) return fallback;
  const value = process.argv[at + 1];
  if (!value || value.startsWith('--')) throw new Error(`Missing ${name} value`);
  return value;
}
const profileArgument = option('--profile');
if (!profileArgument) throw new Error('Usage: node src/vnc.ts --profile <test-profile> [--listen <private IPv4>] [--keep-awake]');
const keepAwake = process.argv.includes('--keep-awake');
if (keepAwake && process.platform !== 'darwin') throw new Error('--keep-awake is implemented only for this Mac PoC.');
const profile = resolve(profileArgument);
const host = option('--listen', '127.0.0.1')!;
const privateAddress = /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;
if (!isIPv4(host) || !privateAddress.test(host)) throw new Error('Use a loopback or explicit private LAN IPv4 address.');
const requestedPort = Number(option('--port', '0'));
if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) throw new Error('Invalid --port');
const discoveryFile = resolve(option('--discovery', resolve(profile, 'agentic-poc.json'))!);
let discovery = JSON.parse(await readFile(discoveryFile, 'utf8'));
let selectedSpace = option('--space', Object.keys(discovery.vnc ?? {}).includes('task-b') ? 'task-b' : Object.keys(discovery.vnc ?? {})[0]);
if (!Number.isInteger(discovery.port) || !selectedSpace || selectedSpace === 'main' || typeof discovery.vnc?.[selectedSpace] !== 'string')
  throw new Error('This browser does not provide the requested non-main Space VNC capability.');
const nativeEndpoint = `http://127.0.0.1:${discovery.port}/space`;
let switching = false;
let connecting = false;
const viewerToken = randomBytes(32).toString('hex');
const rfbPassword = randomBytes(6).toString('base64');
const run = randomUUID();
const connectionFile = resolve(profile, 'vnc-session.json');
const executable = resolve(root, '.runtime/bin/agentic-vnc');
await access(executable).catch(() => { throw new Error('Build the VNC helper with bash scripts/build-vnc.sh'); });
const locales = Object.fromEntries(await Promise.all(['en-US','zh-CN'].map(async locale =>
  [locale, JSON.parse(await readFile(resolve(root, `locales/${locale}.json`), 'utf8'))])));
const html = (await readFile(resolve(root, 'src/viewer.html'), 'utf8')).replace(
  '/*AGENTIC_LOCALES*/', `const locales = ${JSON.stringify(locales).replaceAll('<', '\\u003c')};`);
const novnc = resolve(root, 'node_modules/@novnc/novnc');
const lockFile = resolve(profile, 'vnc-bridge.lock');
const lock = await open(lockFile, 'wx', 0o600).catch(() => { throw new Error('A VNC bridge already owns this profile; stop it before starting another.'); });
await lock.writeFile(String(process.pid));
await lock.close();

type Control = { lease: string; generation: number; tab: string };
type Frame = { png: string; frame: string; width: number; height: number; tab: string; generation: number; viewportVersion: number };
type Viewer = { ws: WebSocket; tcp: Socket; client?: string; nativeReady: boolean; control?: Control; epoch: number; closed: boolean };
let viewer: Viewer | undefined;
let appliedFrame: Frame | undefined;
let frameCount = 0;
let lastFrameTime = 0;
let nativeStatus: Record<string, unknown> = {};
let lastError = '';
let stopping = false;
let streamStarted = false;
let rfbPort = 0;
let queue = Promise.resolve();
let queuedInputs = 0;
let frameTimer: ReturnType<typeof setTimeout> | undefined;
let heartbeat: ReturnType<typeof setInterval> | undefined;
let frameAck: { resolve: () => void; reject: (error: Error) => void } | undefined;
let awakeProcess: ReturnType<typeof spawn> | undefined;

class NativeError extends Error {
  status: number;
  constructor(status: number, reason: string) { super(reason); this.status = status; }
}
async function native(action: string, fields: Record<string, unknown> = {}, space = selectedSpace!) {
  if (space === 'main' || !discovery.vnc?.[space]) throw new NativeError(403, 'space_not_authorized');
  const response = await fetch(nativeEndpoint, {
    method: 'POST', headers: { Authorization: `Bearer ${discovery.vnc[space]}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...fields, space, action }), signal: AbortSignal.timeout(4000),
  });
  const data = await response.json();
  if (!response.ok) throw new NativeError(response.status, data.error ?? `native_${response.status}`);
  return data;
}
function enqueue<T>(operation: () => Promise<T>): Promise<T> {
  const next = queue.then(operation);
  queue = next.then(() => {}, () => {});
  return next;
}
function sameSecret(value: string | undefined) {
  if (!value || !/^[0-9a-f]{64}$/.test(value)) return false;
  return timingSafeEqual(Buffer.from(value), Buffer.from(viewerToken));
}
function clearControl(session: Viewer) {
  session.control = undefined;
  session.epoch++;
}
function sessionState() {
  const connected = !!viewer?.nativeReady && !viewer.closed;
  return {
    space: selectedSpace, name: nativeStatus.name, number: nativeStatus.number,
    connected, controlling: connected && !!viewer?.control,
    owner: nativeStatus.owner ?? 'unknown', viewers: nativeStatus.viewers ?? 0,
    width: 1280, height: 720, frames: frameCount, lastFrameTime,
    error: lastError,
  };
}
async function disconnect(session: Viewer) {
  if (session.closed) return;
  session.closed = true;
  clearControl(session);
  session.tcp.destroy();
  session.ws.close();
  if (session.client) await enqueue(() => native('vncDisconnect', { client: session.client })).catch(() => {});
  if (viewer === session) viewer = undefined;
}

const helper = spawn(executable, [], { stdio: ['pipe', 'pipe', 'pipe'] });
helper.stdin.write(rfbPassword);
helper.stderr.on('data', data => process.stderr.write(data));
helper.stdin.on('error', () => { void stop(); });
helper.on('error', error => { console.error(error.message); void stop(); });
helper.once('exit', () => { frameAck?.reject(new Error('VNC helper stopped')); if (!stopping) void stop(); });
let readyResolve: () => void;
const helperReady = new Promise<void>(done => { readyResolve = done; });
const lines = createInterface({ input: helper.stdout });
lines.on('line', line => {
  let event: any;
  try { event = JSON.parse(line); } catch { return; }
  if (event.type === 'ready') { rfbPort = event.port; readyResolve(); return; }
  if (event.type === 'frame') { frameAck?.resolve(); return; }
  const session = viewer;
  if (!session || session.closed) return;
  const client = `${run}-${event.client}`;
  if (event.type === 'connect') {
    session.client = client;
    void enqueue(async () => {
      if (session.closed) return;
      await native('vncConnect', { client });
      if (!session.closed) {
        nativeStatus = await native('observe');
        session.nativeReady = true;
      }
    }).catch(() => { void disconnect(session); });
    return;
  }
  if (session.client !== client) return;
  if (event.type === 'disconnect') { void disconnect(session); return; }
  if (!session.nativeReady || !session.control || !appliedFrame || !['key', 'pointer'].includes(event.type)) return;
  // Snapshot the authority and frame at arrival. Queued old input must never
  // be relabelled with a replacement lease after takeover/reconnection.
  const control = { ...session.control };
  const frame = appliedFrame;
  const epoch = session.epoch;
  if (frame.generation !== control.generation || frame.tab !== control.tab) return;
  if (queuedInputs >= 64) { void disconnect(session); return; }
  queuedInputs++;
  void enqueue(async () => {
    if (session.closed || epoch !== session.epoch || viewer !== session) return;
    const fields = event.type === 'pointer'
      ? { x: event.x, y: event.y, mask: event.mask }
      : { keysym: event.keysym, down: event.down };
    await native(event.type, { client, ...control, frame: frame.frame, viewportVersion: frame.viewportVersion, ...fields });
  }).catch(error => {
    if (error instanceof NativeError && ['stale_control', 'remote_not_controller', 'vnc_session_unavailable'].includes(error.message)) clearControl(session);
    lastError = error instanceof NativeError ? error.message : '输入连接中断';
  }).finally(() => { queuedInputs--; });
});

async function sendFrame() {
      const frame = await native('frame') as Frame;
      if (frame.width !== 1280 || frame.height !== 720 || typeof frame.png !== 'string') throw new Error('Unexpected frame size');
      const png = Buffer.from(frame.png, 'base64');
      if (png.length > 16 * 1024 * 1024) throw new Error('Frame too large');
      const header = Buffer.alloc(4);
      header.writeUInt32BE(png.length);
      await new Promise<void>((done, fail) => {
        const timeout = setTimeout(() => {
          fail(new Error('VNC frame decode timeout'));
          void stop();
        }, 4000);
        frameAck = { resolve: () => { clearTimeout(timeout); done(); }, reject: error => { clearTimeout(timeout); fail(error); } };
        helper.stdin.write(Buffer.concat([header, png]));
      });
      frameAck = undefined;
      appliedFrame = frame;
      frameCount++;
      lastFrameTime = Date.now();
      lastError = '';
}

async function capture() {
  const started = Date.now();
  try {
    if (!stopping && viewer?.nativeReady && !viewer.closed) {
      await enqueue(sendFrame);
    }
  } catch (error) {
    frameAck = undefined;
    lastError = error instanceof NativeError ? error.message : '画面暂不可用';
  }
  if (!stopping) frameTimer = setTimeout(capture, Math.max(1, 67 - (Date.now() - started)));
}

let origin = '';
function requestAllowed(req: IncomingMessage, requireOrigin = false) {
  if (req.headers.host !== new URL(origin).host) return false;
  return requireOrigin ? req.headers.origin === origin : !req.headers.origin || req.headers.origin === origin;
}
const server = createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob:; frame-ancestors 'none'");
  const json = (status: number, body: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  try {
    if (!requestAllowed(req)) { json(403, { error: 'origin_rejected' }); return; }
    const url = new URL(req.url!, origin);
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(html); return;
    }
    if (req.method === 'GET' && url.pathname.startsWith('/novnc/')) {
      const path = resolve(novnc, '.' + decodeURIComponent(url.pathname.slice('/novnc'.length)));
      if (!path.startsWith(novnc + sep) || !path.endsWith('.js')) { json(404, {}); return; }
      const script = await readFile(path);
      res.writeHead(200, { 'Content-Type': 'text/javascript' }); res.end(script); return;
    }
    if (!sameSecret(req.headers.authorization?.replace(/^Bearer /, ''))) { json(403, { error: 'not_authorized' }); return; }
    if (req.method === 'GET' && url.pathname === '/spaces') {
      const fresh = JSON.parse(await readFile(discoveryFile, 'utf8'));
      if (fresh.port !== discovery.port) throw new NativeError(409, 'browser_restarted');
      discovery = fresh;
      const spaces = [];
      for (const id of Object.keys(discovery.vnc ?? {}).filter(id => id !== 'main')) {
        try {
          const state = await native('observe', {}, id);
          const preview = await native('preview', {}, id).catch(() => ({}));
          spaces.push({id, number:state.number, name:state.name, title:state.title,
            owner:state.owner, png:preview.png});
        } catch { /* A space may close while collecting the overview. */ }
      }
      json(200, {selected: selectedSpace, spaces}); return;
    }
    if (req.method === 'POST' && url.pathname === '/select') {
      if (!requestAllowed(req, true)) { json(403, {error:'origin_required'}); return; }
      if (viewer || connecting || switching) { json(409, {error:'disconnect_before_switching'}); return; }
      switching = true;
      try {
        let body = '';
        for await (const chunk of req) {
          body += chunk;
          if (body.length > 1024) throw new NativeError(400, 'invalid_request');
        }
        const id = JSON.parse(body).space;
        if (typeof id !== 'string' || id === 'main' || !discovery.vnc?.[id])
          throw new NativeError(403, 'space_not_authorized');
        await enqueue(async () => {
          if (streamStarted) await native('streamStop').catch(() => {});
          streamStarted = false;
          selectedSpace = id;
          appliedFrame = undefined;
          frameCount = 0;
          lastFrameTime = 0;
          await native('streamStart');
          streamStarted = true;
          nativeStatus = await native('observe');
          lastError = '';
        });
        json(200, sessionState());
      } finally { switching = false; }
      return;
    }
    if (req.method === 'GET' && url.pathname === '/credentials') { json(200, { password: rfbPassword }); return; }
    if (req.method === 'GET' && url.pathname === '/status') { json(200, sessionState()); return; }
    if (req.method !== 'POST' || !['/take', '/return'].includes(url.pathname)) { json(404, {}); return; }
    if (!requestAllowed(req, true)) { json(403, { error: 'origin_required' }); return; }
    const session = viewer;
    if (!session?.nativeReady || session.closed || !session.client) { json(409, { error: 'viewer_not_connected' }); return; }
    if (url.pathname === '/take') {
      await enqueue(async () => {
        if (session.closed || viewer !== session) throw new NativeError(409, 'viewer_disconnected');
        const control = await native('vncTake', { client: session.client }) as Control;
        if (session.closed) return;
        session.control = control;
        session.epoch++;
        nativeStatus = await native('observe');
        lastError = '';
      });
    } else {
      const control = session.control;
      if (!control) { json(409, { error: 'not_remote_controller' }); return; }
      clearControl(session);
      try {
        await enqueue(async () => {
          await native('vncReturn', { client: session.client, ...control });
          nativeStatus = await native('observe');
        });
      } catch (error) {
        // An uncertain return must not keep renewing a remote controller.
        await disconnect(session);
        throw error;
      }
    }
    json(200, sessionState());
  } catch (error) {
    json(error instanceof NativeError ? error.status : 500, { error: error instanceof NativeError ? error.message : 'request_failed' });
  }
});
const websockets = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024, perMessageDeflate: false });
server.on('upgrade', async (req, socket, head) => {
  let url: URL;
  try { url = new URL(req.url!, origin); }
  catch { socket.destroy(); return; }
  if (url.pathname !== '/rfb' || !requestAllowed(req, true) || !sameSecret(url.searchParams.get('token') ?? undefined) || viewer || connecting || switching || stopping) {
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
  }
  connecting = true;
  try {
    // Seed RFB with the selected workspace before its first framebuffer update.
    await enqueue(sendFrame);
  } catch {
    connecting = false;
    socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
    return;
  }
  if (socket.destroyed || stopping) { connecting = false; return; }
  websockets.handleUpgrade(req, socket, head, ws => {
    connecting = false;
    const tcp = createConnection({ host: '127.0.0.1', port: rfbPort });
    tcp.setNoDelay(true);
    const session: Viewer = { ws, tcp, nativeReady: false, epoch: 0, closed: false };
    viewer = session;
    ws.on('message', data => {
      if (tcp.writableLength > 1024 * 1024) { void disconnect(session); return; }
      tcp.write(data as Buffer);
    });
    tcp.on('data', data => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (ws.bufferedAmount > 4 * 1024 * 1024) { void disconnect(session); return; }
      ws.send(data);
    });
    for (const emitter of [ws, tcp]) {
      emitter.on('error', () => { void disconnect(session); });
      emitter.on('close', () => { void disconnect(session); });
    }
  });
});

async function stop() {
  if (stopping) return;
  stopping = true;
  clearTimeout(frameTimer);
  clearInterval(heartbeat);
  awakeProcess?.kill('SIGTERM');
  if (viewer) await disconnect(viewer);
  await queue;
  if (streamStarted) await native('streamStop').catch(() => {});
  helper.stdin.end();
  helper.kill('SIGTERM');
  websockets.close();
  server.closeAllConnections();
  server.close();
  await rm(connectionFile, { force: true });
  await rm(lockFile, { force: true });
}
process.on('SIGINT', () => { void stop(); });
process.on('SIGTERM', () => { void stop(); });
try {
  await Promise.race([helperReady, new Promise((_, reject) => setTimeout(() => reject(new Error('VNC helper did not start')), 10000).unref())]);
  await native('streamStart');
  streamStarted = true;
  await new Promise<void>((done, fail) => { server.once('error', fail); server.listen(requestedPort, host, done); });
  const port = (server.address() as { port: number }).port;
  origin = `http://${host}:${port}`;
  await writeFile(connectionFile, JSON.stringify({ url: `${origin}/#${viewerToken}`, port, space: selectedSpace }) + '\n', { mode: 0o600 });
  if (keepAwake) {
    awakeProcess = spawn('/usr/bin/caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' });
    awakeProcess.on('error', () => { console.error('Could not keep this Mac awake'); void stop(); });
  }
  console.log(JSON.stringify({ viewer: `${origin}/`, connectionFile, scope: 'Non-main Spaces; one selected RFB viewer; model disabled' }));
  let polling = false;
  heartbeat = setInterval(async () => {
    if (polling || stopping || switching) return;
    polling = true;
    try {
      await enqueue(async () => {
        await native('streamStart');
        const session = viewer;
        if (session?.nativeReady && !session.closed) await native('vncHeartbeat', { client: session.client });
        nativeStatus = await native('observe');
        if (session?.control && (nativeStatus.owner !== 'remote' || nativeStatus.generation !== session.control.generation)) clearControl(session);
      });
    } catch {
      lastError = '浏览器连接中断';
      if (viewer) await disconnect(viewer);
    } finally { polling = false; }
  }, 1000);
  void capture();
} catch (error) {
  console.error(error instanceof Error ? error.message : 'VNC startup failed');
  await stop();
  process.exitCode = 1;
}
