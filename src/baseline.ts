import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { readFile, mkdir, writeFile, access, rm } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { openSync } from 'node:fs';

// No remote-debugging port. --spaces uses the browser's scoped native API.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const verify = process.argv.includes('--verify');
const testing = process.argv.includes('--testing');
const nativeSpaces = process.argv.includes('--spaces');
const extension = process.argv.includes('--extension')
  ? resolve(root, '.runtime/extensions/darkreader-4.9.133-mv3') : undefined;
if (extension) await access(resolve(extension, 'manifest.json'));
const extensionPatch = extension && (await readFile(resolve(extension, 'background/index.js'), 'utf8'))
  .includes('AgenticBrowser sample: serialize registrations.')
  ? 'serialize-document-connect-through-save' : undefined;
if (testing && nativeSpaces) throw new Error('Native Spaces require our Chromium build.');
const app = testing
  ? resolve(root, '.runtime/chrome-mac-arm64/Google Chrome for Testing.app')
  : resolve(root, '.chromium/src/out/AgenticPoC/Agentic Browser.app');
const executable = resolve(app, 'Contents/MacOS', testing ? 'Google Chrome for Testing' : 'Agentic Browser');
await access(executable).catch(() => {
  throw new Error(`Browser not built/downloaded: ${executable}. No implicit fallback is used.`);
});
const version = execFileSync('/usr/libexec/PlistBuddy', [
  '-c', 'Print :CFBundleShortVersionString', resolve(app, 'Contents/Info.plist'),
], { encoding: 'utf8' }).trim();
const runId = randomUUID();
const profile = resolve(root, '.runtime/profiles', runId);
await mkdir(profile, { recursive: true, mode: 0o700 });
const browserLog = openSync(resolve(profile, 'browser.log'), 'wx', 0o600);
await mkdir(resolve(root, 'evidence'), { recursive: true });
const html = await readFile(resolve(root, 'src/fixture.html'), 'utf8');
const probeHtml = await readFile(resolve(root, 'src/stream-fixture.html'), 'utf8');
const iframeHtml = await readFile(resolve(root, 'src/stream-iframe.html'), 'utf8');
type Report = { space: string; account: string | null; shared: string | null; indexed: unknown; session: string; visible: string; input: string; inputFocused: boolean; point: { x: number; y: number }; newTabPoint: { x: number; y: number }; focused: boolean; extensionActive: boolean };
const reports = new Map<string, Report>();
const spaces = ['main', 'task-a', 'task-b'];
let phase = 'login';
let browser: ReturnType<typeof spawn> | undefined;
let stopping = false;

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url!, 'http://127.0.0.1');
    const origin = req.headers.origin;
    if (origin && origin !== base) { res.writeHead(403); res.end(); return; }
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const json = (value: unknown) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); };
    if (req.method === 'GET' && url.pathname === '/') {
      const space = url.searchParams.get('space');
      if (!space || !spaces.includes(space)) { res.writeHead(404); res.end(); return; }
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      const page = url.searchParams.get('probe') === '1' ? probeHtml : html;
      res.end(page.replace('/*CONFIG*/', `const config = ${JSON.stringify({ space, runId, verify, nativeSpaces, base })};`));
    } else if (req.method === 'GET' && url.pathname === '/fixture/iframe') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(iframeHtml);
    } else if (req.method === 'GET' && url.pathname === '/fixture/reports') {
      // Test-fixture telemetry only; never a browser/Harness page-reading API.
      json(Object.fromEntries(reports));
    } else if (req.method === 'POST' && url.pathname === '/fixture/login') {
      res.setHeader('Set-Cookie', `poc_session=${runId}; Path=/; HttpOnly; SameSite=Strict`);
      json({ account: 'poc-local-user' });
    } else if (req.method === 'POST' && url.pathname === '/fixture/logout') {
      res.setHeader('Set-Cookie', 'poc_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
      json({ account: null });
    } else if (req.method === 'GET' && url.pathname === '/fixture/state') {
      const loggedIn = (req.headers.cookie ?? '').split(';').some(c => c.trim() === `poc_session=${runId}`);
      json({ phase, account: loggedIn ? 'poc-local-user' : null });
    } else if (req.method === 'POST' && url.pathname === '/fixture/report') {
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 8192) { res.writeHead(413); res.end(); return; }
      }
      const report = JSON.parse(body) as Report;
      if (spaces.includes(report.space)) reports.set(report.space, report);
      json({ ok: true });
    } else { res.writeHead(404); res.end(); }
  } catch { res.writeHead(400); res.end('Bad request'); }
});
await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
const address = server.address() as { port: number };
const base = `http://127.0.0.1:${address.port}`;

async function waitFor(predicate: () => boolean, description: string) {
  const deadline = Date.now() + 45000;
  while (!predicate()) {
    if (stopping) throw new Error('Browser stopped before the check completed.');
    if (Date.now() > deadline) throw new Error(`Timed out: ${description}`);
    await new Promise(r => setTimeout(r, 150));
  }
}

async function stop() {
  if (stopping) return;
  stopping = true;
  browser?.kill('SIGTERM');
  server.closeAllConnections();
  server.close();
  if (browser?.pid && browser.exitCode === null && browser.signalCode === null)
    await new Promise<void>(done => browser!.once('exit', () => done()));
  await rm(resolve(profile, 'agentic-poc.json'), { force: true });
  for (const space of ['task-a', 'task-b'])
    await rm(resolve(profile, `${space}.json`), { force: true });
}
process.on('SIGINT', () => { void stop(); });
process.on('SIGTERM', () => { void stop(); });

console.log(JSON.stringify({ browser: testing ? 'Chrome for Testing (bootstrap, not our Chromium build)' : 'Chromium source build', version, profile, base }));
try {
  for (const space of nativeSpaces ? ['main'] : spaces) {
    const child = spawn(executable, [
      `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
      '--use-mock-keychain', '--disable-features=DialMediaRouteProvider', '--new-window', '--mute-audio',
      ...(extension ? [`--load-extension=${extension}`] : []),
      ...(nativeSpaces ? ['--agentic-poc', '--enable-features=TabGroupsFocusing:TabGroupsFocusFreezing/false', `--agentic-poc-task-a-url=${base}/?space=task-a`, `--agentic-poc-task-b-url=${base}/?space=task-b`] : []),
      `${base}/?space=${space}`,
    ], { stdio: ['ignore', 'ignore', browserLog] });
    child.on('error', error => { console.error(error.message); void stop(); });
    if (!browser) {
      browser = child;
      child.once('exit', () => { if (!stopping) void stop(); });
    }
    await waitFor(() => reports.has(space), `${space} page ready`);
  }
  await waitFor(() => spaces.every(id => reports.has(id)), 'all three pages ready');
  if (nativeSpaces) {
    const discovery = JSON.parse(await readFile(resolve(profile, 'agentic-poc.json'), 'utf8'));
    for (const space of ['task-a', 'task-b']) {
      await writeFile(resolve(profile, `${space}.json`), JSON.stringify({
        port: discovery.port, space, token: discovery.tasks[space],
      }), { mode: 0o600, flag: 'wx' });
    }
    console.log('Scoped MCP connections: task-a.json / task-b.json inside this test Profile.');
  }
  if (verify) {
    await waitFor(() => spaces.every(id => {
      const r = reports.get(id)!;
      return r.account === 'poc-local-user' && r.shared === runId && r.indexed === runId && r.session === id;
    }), 'same-profile Cookie / localStorage / IndexedDB, separate sessionStorage');
    if (extension) await waitFor(() => spaces.every(id => reports.get(id)?.extensionActive), 'MV3 extension modifies all three pages');
    const loggedIn = Object.fromEntries(reports);
    const controls = nativeSpaces ? await verifyControls() : undefined;
    phase = 'logout';
    await waitFor(() => spaces.every(id => reports.get(id)?.account === null), 'shared logout');
    const processes = execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' })
      .split('\n').filter(line => line.includes(`--user-data-dir=${profile}`) && !line.includes('--type='));
    if (processes.length !== 1) throw new Error(`Expected one browser root process, found ${processes.length}`);
    const result = {
      status: 'passed', scope: nativeSpaces ? 'native Space and storage smoke; not full A01-A09 acceptance' : 'baseline storage smoke only; not A01-A09 acceptance',
      timestamp: new Date().toISOString(), platform: process.platform, arch: process.arch,
      browser: testing ? 'official Chrome for Testing bootstrap' : 'Chromium source build',
      version, executable, profile, oneBrowserProcess: true, spaces,
      spacePresentation: nativeSpaces ? 'single-window' : 'three-window bootstrap',
      loggedIn, loggedOut: Object.fromEntries(reports),
      controls,
      extension: extension ? { name: 'Dark Reader', version: '4.9.133', manifestVersion: 3, localPatch: extensionPatch, stylesAppliedToThreePages: true } : undefined,
      notVerified: [...(nativeSpaces ? [] : ['native Space ownership / main protection']), ...(extension ? ['manual extension toggle'] : ['MV3 extension sample']), '60-second human concurrent input', 'MCP', 'VNC', 'model loop', 'locked-screen rendering and control'],
    };
    const file = resolve(root, 'evidence', `baseline-${runId}.json`);
    await writeFile(file, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
    console.log(`PASS: ${nativeSpaces ? 'native Space and storage' : 'baseline storage'} smoke. Evidence: ${file}`);
    phase = 'done';
    if (!process.argv.includes('--keep-open')) await stop();
  } else {
    console.log(`${nativeSpaces ? 'Three native Spaces' : 'Three window placeholders'} ready. Ctrl+C stops this test browser only.`);
  }
} catch (error) {
  console.error(error);
  console.error('Fixture input state:', Object.fromEntries([...reports].map(([id, r]) =>
    [id, { input: r.input, inputFocused: r.inputFocused, focused: r.focused, point: r.point }])));
  process.exitCode = 1;
  await stop();
}

async function verifyControls() {
  const discovery = JSON.parse(await readFile(resolve(profile, 'agentic-poc.json'), 'utf8'));
  async function call(space: string, action: string, fields: Record<string, unknown> = {}, token = discovery.tasks[space], expected = 200) {
    const response = await fetch(`http://127.0.0.1:${discovery.port}/space`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ space, action, ...fields }), signal: AbortSignal.timeout(5000),
    });
    const result = await response.json();
    assert.equal(response.status, expected, `${space}/${action}: ${result.error ?? 'unexpected status'}`);
    return result;
  }
  const a = await call('task-a', 'observe'), b = await call('task-b', 'observe');
  assert.equal(a.url, `${base}/?space=task-a`, 'Task A must show the controlled fixture before input');
  assert.equal(b.url, `${base}/?space=task-b`, 'Task B must show the controlled fixture before input');
  assert.notEqual(a.tab, b.tab);
  await call('main', 'observe', {}, discovery.tasks['task-a'], 403);
  await call('main', 'claim', {}, discovery.tasks['task-a'], 403);
  await call('task-b', 'observe', {}, discovery.tasks['task-a'], 403);
  await call('task-a', 'observe', {}, 'incorrect-token', 403);
  const leaseA = await call('task-a', 'claim'), leaseB = await call('task-b', 'claim');
  await call('task-a', 'claim', {}, undefined, 409);
  const boundA = { ...leaseA, tab: a.tab }, boundB = { ...leaseB, tab: b.tab };
  await call('task-a', 'type', { ...boundA, tab: b.tab, text: 'wrong' }, undefined, 403);
  await call('task-a', 'navigate', { ...boundA, url: 'chrome://settings' }, undefined, 400);
  await call('task-a', 'Runtime.evaluate', boundA, undefined, 400);
  const mainBefore = reports.get('main')!.input;
  const focusBefore = { 'task-a': a.windowActive, 'task-b': b.windowActive };
  const expected = new Map<string, string>();
  await Promise.all([['task-a', boundA], ['task-b', boundB]].map(async ([id, binding]) => {
    const space = id as string, fields = binding as Record<string, unknown>;
    await call(space, 'click', { ...fields, ...reports.get(space)!.point });
    await waitFor(() => reports.get(space)?.inputFocused === true, `${space} textarea focused after click`);
    let text = '';
    for (let i = 0; i < 10; i++) {
      const chunk = `${space === 'task-a' ? 'A' : 'B'}${i}|`;
      await call(space, 'type', { ...fields, text: chunk });
      text += chunk;
    }
    expected.set(space, text);
  }));
  await waitFor(() => [...expected].every(([id, text]) => reports.get(id)?.input === text), 'independent native input');
  assert.equal(reports.get('main')!.input, mainBefore);
  const focusAfter = { 'task-a': (await call('task-a', 'observe')).windowActive,
    'task-b': (await call('task-b', 'observe')).windowActive };
  for (const id of ['task-a', 'task-b'] as const) {
    assert.ok(focusBefore[id] || !focusAfter[id], 'Native input activated a background window');
  }
  assert.equal(a.visible, false);
  assert.equal(b.visible, false);
  await call('task-a', 'click', { ...boundA, ...reports.get('task-a')!.newTabPoint });
  let popup = await call('task-a', 'observe');
  const popupDeadline = Date.now() + 10000;
  while (popup.tabCount !== 2 || !String(popup.url).includes('tab=child')) {
    assert.ok(Date.now() < popupDeadline, 'Background new tab did not stay in its Space');
    await new Promise(r => setTimeout(r, 150));
    popup = await call('task-a', 'observe');
  }
  assert.notEqual(popup.tab, a.tab);
  assert.equal(popup.visible, false, 'Background tab changed the visible Space');
  assert.equal((await call('task-b', 'observe')).tab, b.tab);
  await call('task-a', 'release', boundA);
  const next = await call('task-a', 'claim');
  await call('task-a', 'type', { ...boundA, text: 'stale' }, undefined, 409);
  await call('task-a', 'release', next);
  await call('task-b', 'release', boundB);
  return { mainRejected: true, crossSpaceRejected: true, wrongTabRejected: true,
    duplicateClaimRejected: true, staleLeaseRejected: true, unrestrictedCommandsRejected: true,
    independentInputs: Object.fromEntries(expected), mainInputUnchanged: true, focusBefore, focusAfter,
    backgroundNewTabStayedInSpace: true, backgroundNewTabDidNotSwitchSpace: true,
    limitation: 'Controlled fixture check; not a substitute for the 60-second human-input acceptance.' };
}
