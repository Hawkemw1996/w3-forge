import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

function moduleUrl(source) {
  const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
  return 'data:text/javascript;base64,' + Buffer.from(outputText).toString('base64');
}
const api = moduleUrl(readFileSync(new URL('../src/lib/api.ts', import.meta.url), 'utf8'));
const source = readFileSync(new URL('../src/lib/terminal.ts', import.meta.url), 'utf8').replace("from './api'", `from '${api}'`);
const { TerminalConnection, terminalRequest } = await import(moduleUrl(source));
const tick = () => new Promise(resolve => setTimeout(resolve, 20));
const defer = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

function fixture(overrides = {}) {
  const calls = [], outputs = [], closed = [], connected = [], reads = [];
  const request = async (path, options = {}) => {
    calls.push({ path, options });
    if (overrides.request) { const result = overrides.request(path, options); if (result !== undefined) return result; }
    if (path === '/sessions') return { id: 'owned-session', hostname: 'container', access: 'root-login' };
    if (path.includes('/output?')) {
      const result = defer(); reads.push(result);
      options.signal.addEventListener('abort', () => result.reject(new Error('aborted')), { once: true });
      return result.promise;
    }
    return { accepted: true };
  };
  const client = new TerminalConnection({
    output: async data => { outputs.push(data); if (overrides.output) await overrides.output(data); },
    connected: session => connected.push(session), closed: (reason, error) => closed.push({ reason, error })
  }, request);
  return { client, calls, outputs, closed, connected, reads };
}

test('transport sends same-origin credentials and terminal header, and surfaces API errors', async t => {
  let actual;
  const authEvents = [];
  const previousWindow = globalThis.window;
  globalThis.window = { dispatchEvent: event => authEvents.push(event.type) };
  t.after(() => { globalThis.window = previousWindow; });
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    actual = { url, options };
    return new Response(JSON.stringify({ success: true, data: { available: true } }), { status: 200 });
  });
  await terminalRequest('/sessions', { body: { cols: 80, rows: 24 } });
  assert.equal(actual.url, '/api/admin/terminal/sessions');
  assert.equal(actual.options.credentials, 'same-origin');
  assert.equal(actual.options.headers['X-W3-Terminal'], '1');
  assert.equal(actual.options.method, 'POST');
  assert.deepEqual(JSON.parse(actual.options.body), { cols: 80, rows: 24 });
  globalThis.fetch.mock.mockImplementation(async () => new Response(JSON.stringify({ success: false, error: { code: 'AUTH_REQUIRED', message: 'Sign in again.' } }), { status: 401 }));
  await assert.rejects(terminalRequest('/status'), { code: 'AUTH_REQUIRED', message: 'Sign in again.' });
  assert.deepEqual(authEvents, ['w3-auth-problem']);
});

test('cancelling while session creation is pending closes the returned shell', async () => {
  const pending = defer();
  const f = fixture({ request: path => path === '/sessions' ? pending.promise : undefined });
  const opening = f.client.connect({ cols: 80, rows: 24 });
  f.client.stop();
  pending.resolve({ id: 'late-session', hostname: 'container', access: 'root-shell' });
  await opening;
  assert.equal(f.connected.length, 0);
  assert.equal(f.calls.filter(c => c.path === '/sessions/late-session/close').length, 1);
  assert.equal(f.closed.length, 1);
});

test('output is acknowledged only after terminal rendering completes', async () => {
  const rendering = defer();
  const f = fixture({ output: () => rendering.promise });
  await f.client.connect({ cols: 80, rows: 24 });
  f.reads[0].resolve({ output: 'hello', cursor: 5, closed: false });
  await tick();
  assert.deepEqual(f.outputs, ['hello']);
  assert.equal(f.reads.length, 1);
  rendering.resolve(); await tick();
  assert.equal(f.reads.length, 2);
  assert.ok(f.calls.some(c => c.path.endsWith('output?cursor=5')));
  f.client.stop();
});

test('input is ordered and chunked; control bytes survive; dimensions reach the server', async () => {
  const f = fixture();
  await f.client.connect({ cols: 80, rows: 24 });
  f.client.send('echo hello\r'); f.client.send('x'.repeat(5000)); f.client.send('\u0015\u000b\u000c'); f.client.send('\u0003');
  await tick(); await tick();
  const inputs = f.calls.filter(c => c.path.endsWith('/input'));
  assert.equal(inputs.map(c => c.options.body.data).join(''), 'echo hello\r' + 'x'.repeat(5000) + '\u0015\u000b\u000c\u0003');
  assert.ok(inputs.every(c => c.options.body.data.length <= 4096));
  await f.client.resize({ cols: 120, rows: 35 });
  assert.deepEqual(f.calls.find(c => c.path.endsWith('/resize')).options.body, { cols: 120, rows: 35 });
  f.client.stop();
});

test('failed command submission is never retried and disconnects the session', async () => {
  const f = fixture({ request: path => path.endsWith('/input') ? Promise.reject(new Error('connection lost')) : undefined });
  await f.client.connect({ cols: 80, rows: 24 });
  f.client.send('command\r'); await tick(); await tick();
  assert.equal(f.calls.filter(c => c.path.endsWith('/input')).length, 1);
  assert.equal(f.closed[0].error, true);
  assert.equal(f.calls.filter(c => c.path.endsWith('/close')).length, 1);
  f.client.send('another\r'); await tick();
  assert.equal(f.calls.filter(c => c.path.endsWith('/input')).length, 1);
});

test('closed shell displays final output and closes the connection once', async () => {
  const f = fixture();
  await f.client.connect({ cols: 80, rows: 24 });
  f.reads[0].resolve({ output: 'logout\r\n', cursor: 8, closed: true, reason: 'Shell exited (0).' });
  await tick(); f.client.stop();
  assert.deepEqual(f.outputs, ['logout\r\n']);
  assert.deepEqual(f.closed, [{ reason: 'Shell exited (0).', error: false }]);
  assert.equal(f.calls.filter(c => c.path.endsWith('/close')).length, 1);
  assert.equal(f.calls.find(c => c.path.endsWith('/close')).options.keepalive, true);
});
