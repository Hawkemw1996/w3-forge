import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
const server = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom' });
test.after(() => server.close());
const { default: Workspace } = await server.ssrLoadModule('/src/workspace/ForgeWorkspace.tsx');
const { readChatStream } = await server.ssrLoadModule('/src/workspace/chatStream.ts');
const models = { defaultModel: 'qwen2.5-coder:14b', models: [{ name: 'qwen2.5-coder:14b', size: 9000000000 }] };
const base = { host: 'forge-test-host', observedAt: '2026-10-16T04:00:00Z', available: true, environments: [], pipeline: null, activeControl: null, message: null };
function render(data = base, error = null) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } });
  client.setQueryData(['forge-models'], models);
  client.setQueryData(['forge-environments'], data);
  if (error) client.getQueryCache().find({ queryKey: ['forge-environments'] }).setState({ status: 'error', fetchStatus: 'idle', error });
  const result = renderToString(React.createElement(QueryClientProvider, { client }, React.createElement(Workspace, { name: 'operator', signOut: async () => {}, signingOut: false, signOutError: '' })));
  client.clear(); return result.replaceAll('<!-- -->', '');
}
test('workspace presents model choice, chat composer, admin link and an honest empty inventory', () => {
  const html = render();
  for (const value of ['qwen2.5-coder:14b', 'Message Forge', 'New chat', 'Admin Console', 'Test environments', 'No Codex test containers', 'forge-test-host']) assert.ok(html.includes(value), value);
  assert.doesNotMatch(html, /workspace is being prepared|All tests passed/);
});
test('container details and pipeline counts come from observations and escape markup', () => {
  const html = render({ ...base, environments: [{ id: 'a'.repeat(64), name: '<script>bad()</script>', image: 'node:22-bookworm', state: 'running', status: 'Up 1 minute', app: 'w3forge', branch: 'dev/v0.4.3', commit: 'abcdef0', createdAt: base.observedAt, ports: [] }],
    pipeline: { requestId: 'req_fixture', status: 'running', progress: { totalElapsedMs: 5000, cacheStatus: 'cold', stages: [{ id: 'tests', status: 'running', durationMs: 1000, counts: { tests: 10, passed: 8, failed: 2, skipped: 0 } }] } } });
  for (const value of ['dev/v0.4.3', 'abcdef0', 'node:22-bookworm', 'req_fixture', '8/10 passed', '2 failed']) assert.ok(html.includes(value), value);
  assert.ok(html.includes('&lt;script&gt;')); assert.ok(!html.includes('<script>bad'));
});
test('unavailable inventory and failed refresh never present cached data as current', () => {
  assert.match(render({ ...base, available: false, message: 'Docker unavailable' }), /Docker unavailable/);
  assert.doesNotMatch(render({ ...base, available: false }), /No Codex test containers/);
  const failed = render(base, new Error('Connection lost'));
  assert.match(failed, /Connection lost/); assert.doesNotMatch(failed, /forge-test-host|No Codex test containers/);
});
test('stream reader handles split UTF-8 and requires explicit successful completion', async () => {
  const text = '{"success":true,"data":{"delta":"héllo"}}\n{"success":true,"data":{"done":true}}\n';
  const bytes = new TextEncoder().encode(text);
  const body = new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(new Uint8Array([byte])); controller.close(); } });
  let output = '';
  await readChatStream(new Response(body, { headers: { 'content-type': 'application/x-ndjson' } }), delta => output += delta);
  assert.equal(output, 'héllo');
  for (const text of ['{"success":true,"data":{"delta":"partial"}}\n', '{"success":false,"error":{"message":"Stopped"}}\n']) {
    await assert.rejects(readChatStream(new Response(text, { headers: { 'content-type': 'application/x-ndjson' } }), () => {}));
  }
  await assert.rejects(readChatStream(new Response('{"success":false,"error":{"code":"AUTH_REQUIRED","message":"Sign in"}}', { status: 401 }), () => {}), { status: 401 });
});

test('completion does not wait for a stalled browser stream cancellation', async () => {
  let cancelled = false, output = '';
  const body = new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('{\"success\":true,\"data\":{\"delta\":\"Done\",\"done\":true}}\n')); },
    cancel() { cancelled = true; return new Promise(() => {}); }
  });
  await readChatStream(new Response(body, { headers: { 'content-type': 'application/x-ndjson' } }), delta => output += delta);
  assert.equal(output, 'Done'); assert.equal(cancelled, true);
});

test('Stop immediately rejects a stalled stream read even if upstream cancellation hangs', async () => {
  const controller = new AbortController();
  const body = new ReadableStream({ cancel() { return new Promise(() => {}); } });
  const result = readChatStream(new Response(body, { headers: { 'content-type': 'application/x-ndjson' } }), () => {}, controller.signal);
  controller.abort();
  await assert.rejects(result, { name: 'AbortError' });
});
