import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom/server.js';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
const server = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom' });
test.after(() => server.close());
const { default: Workspace } = await server.ssrLoadModule('/src/workspace/ForgeWorkspace.tsx');
const { readChatStream } = await server.ssrLoadModule('/src/workspace/chatStream.ts');
const models = { defaultModel: 'qwen2.5-coder:14b', models: [{ name: 'qwen2.5-coder:14b', size: 9000000000 }] };
const base = { host: 'forge-test-host', observedAt: '2026-10-16T04:00:00Z', available: true, environments: [], pipeline: null, activeControl: null, message: null };
function render(data = base, error = null, pathname = '/environments', options = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } });
  client.setQueryData(['forge-models'], models);
  client.setQueryData(['forge-environments'], data);
  client.setQueryData(['forge-factory'], options.factory ?? { projects: [], requests: [], runs: [], notifications: [], metrics: { queued: 0, active: 0, testing: 0, ready: 0, blocked: 0 }, observedAt: base.observedAt });
  client.setQueryData(['forge-services'], options.services ?? { observedAt: base.observedAt, services: [] });
  if (options.hardware) client.setQueryData(['forge-hardware'], options.hardware);
  if (options.factoryError) client.getQueryCache().find({ queryKey: ['forge-factory'] }).setState({ status: 'error', fetchStatus: 'idle', error: options.factoryError });
  if (error) client.getQueryCache().find({ queryKey: ['forge-environments'] }).setState({ status: 'error', fetchStatus: 'idle', error });
  const result = renderToString(React.createElement(QueryClientProvider, { client }, React.createElement(StaticRouter, { location: pathname }, React.createElement(Workspace, { name: 'operator', signOut: async () => {}, signingOut: false, signOutError: '' }))));
  client.clear(); return result.replaceAll('<!-- -->', '');
}
test('workspace presents model choice, chat composer, admin link and an honest empty inventory', () => {
  const html = render();
  for (const value of ['qwen2.5-coder:14b', 'Message Forge', 'New chat', 'Admin Console', 'Test Environments', 'No matching environments', 'forge-test-host']) assert.ok(html.includes(value), value);
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
  assert.doesNotMatch(render({ ...base, available: false }), /No matching environments/);
  const failed = render(base, new Error('Connection lost'));
  assert.match(failed, /Connection lost/); assert.doesNotMatch(failed, /forge-test-host|No matching environments/);
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

test('factory dashboard uses the W3 shell and shows the observed work queue with evidence labels', () => {
  const factory = {
    projects: [], requests: [{ id: 'request-fixture', sequence: '12', projectId: 'project-fixture', projectName: 'W3 Example',
      title: 'Preserve project rules in prompts', description: 'Rules are versioned.', acceptanceCriteria: 'Rules stay pinned.', status: 'planning',
      revision: 2, rulesVersion: 1, rulesChecksum: 'a'.repeat(64), repositoryUrl: 'https://github.com/w3/example', branch: 'dev/v0.4.4',
      plan: '', planVersion: 0, blockReason: null, createdAt: base.observedAt, updatedAt: base.observedAt, createdBy: 'Fixture owner' }],
    runs: [], notifications: [], metrics: { queued: 0, active: 1, testing: 0, ready: 0, blocked: 0 }, observedAt: base.observedAt
  };
  const html = render(base, null, '/', { factory });
  for (const value of ['Software Factory', 'Projects', 'Agents &amp; AI', 'Forge hardware', 'Work in progress', 'Preserve project rules in prompts', 'W3 Example']) assert.ok(html.includes(value), value);
  assert.ok(html.includes('w3-sidebar'));
  assert.doesNotMatch(html, /All tests passed|Automated development complete/);
});

test('unconfigured AI services and observed test activity never imply a connected coding agent', () => {
  const services = { observedAt: base.observedAt, services: [
    { id: 'codex', name: 'Codex', status: 'observed', message: 'A registered test environment is running. A coding-agent connection has not been verified.', capabilities: ['test_environment_observation'], models: [], lastSeenAt: base.observedAt, activeTasks: 1 },
    ...['Perplexity','Grok','Claude'].map(name => ({ id: name.toLowerCase(), name, status: 'not_configured', message: 'No worker adapter has been configured.', capabilities: [], models: [], lastSeenAt: null, activeTasks: null }))
  ] };
  const html = render(base, null, '/agents', { services });
  for (const value of ['Codex', 'Perplexity', 'Grok', 'Claude', 'Setup needed', 'Test activity observed', 'coding-agent connection has not been verified']) assert.ok(html.includes(value), value);
  assert.doesNotMatch(html, /Claude connected|Grok connected|Perplexity connected/);
});

test('hardware page reports visible VM capacity without substituting the Proxmox host', () => {
  const hardware = { observedAt: base.observedAt, host: 'fixture-vm', scope: 'forge-host',
    os: { platform: 'linux', release: 'fixture-kernel', architecture: 'x64', uptimeSeconds: 3600 },
    cpu: { model: 'Fixture CPU <script>invalid</script>', logicalCores: 12, clockMHz: null, loadAverage: [0.1,0.2,0.3] },
    memory: { totalBytes: 32 * 1024 ** 3, availableBytes: 20 * 1024 ** 3 },
    storage: { available: true, message: null, devices: [{ name: 'vda', model: 'Virtual disk', sizeBytes: 300 * 1024 ** 3, type: 'disk', rotational: false, transport: null }], root: { totalBytes: 100 * 1024 ** 3, availableBytes: 50 * 1024 ** 3 } },
    gpu: { available: true, message: null, devices: [{ name: 'Fixture GPU', memoryTotalMiB: 24576, driverVersion: 'fixture-driver' }] } };
  const html = render(base, null, '/hardware', { hardware });
  for (const value of ['fixture-vm', 'Logical processors', '32.0 GiB', '20.0 GiB', 'Fixture GPU', '24.0 GiB', 'fixture-driver', 'Virtual disk', '300.0 GiB', 'Proxmox physical host inventory is outside this view']) assert.ok(html.includes(value), value);
  assert.ok(html.includes('&lt;script&gt;')); assert.ok(!html.includes('<script>invalid'));
  const unavailable = render(base, null, '/hardware', { hardware: { ...hardware, gpu: { available: false, message: 'GPU observation unavailable', devices: [] }, storage: { ...hardware.storage, available: false, message: 'Storage observation unavailable', devices: [] } } });
  assert.match(unavailable, /GPU observation unavailable/); assert.doesNotMatch(unavailable, /Fixture GPU|All hardware healthy/);
});

test('a failed factory refresh hides cached queue records and current-looking metrics', () => {
  const factory = { projects: [], requests: [{ id: 'cached-request', sequence: '1', title: 'Cached private work item', status: 'queued' }], runs: [], notifications: [], metrics: { queued: 99, active: 0, testing: 0, ready: 0, blocked: 0 }, observedAt: base.observedAt };
  const html = render(base, null, '/', { factory, factoryError: new Error('Factory refresh unavailable') });
  assert.match(html, /Factory refresh unavailable/);
  assert.doesNotMatch(html, /Cached private work item|Queued requests/);
});
