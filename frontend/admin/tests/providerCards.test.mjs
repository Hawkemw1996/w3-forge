import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import React from 'react';
import { renderToString } from 'react-dom/server';
const server = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom' });
test.after(() => server.close());
const { ServiceCards, serviceLabel } = await server.ssrLoadModule('/src/workspace/ProviderCards.tsx');
const base = { id: 'codex', name: 'Codex', status: 'available', message: 'Signed in under the account.', capabilities: [], models: [], lastSeenAt: null, activeTasks: null,
  connection: { id: 'codex', name: 'Codex', state: 'signed_in', account: 'forge-ai', version: '0.120.0', authMethod: 'chatgpt', checkedAt: '2026-10-21T21:00:00Z', test: null } };
const render = service => renderToString(React.createElement(ServiceCards, { services: [service] }));
test('account sign-in and a completed connection test are separate evidence', () => {
  const html = render(base);
  for (const text of ['Signed in', 'forge-ai', '0.120.0', 'ChatGPT account', 'Model access has not been tested', 'Test connection', 'uses your account quota']) assert.ok(html.includes(text), text);
  assert.doesNotMatch(html, /Connection test passed|Running engineering worker/);
  assert.match(render({ ...base, connection: { ...base.connection, test: { status: 'passed', checkedAt: '2026-10-21T21:01:00Z', message: 'The provider completed the fixed connection request.' } } }), /Connection test passed/);
  const failed = render({ ...base, connection: { ...base.connection, test: { status: 'failed', checkedAt: '2026-10-21T21:02:00Z', message: 'Check sign-in and quota.' } } });
  assert.match(failed, /Connection test failed/); assert.doesNotMatch(failed, /Connection test passed/);
});
test('missing or signed-out CLIs cannot be tested and do not claim availability', () => {
  for (const [state,label] of [['signed_out','Sign-in needed'],['not_installed','CLI not installed'],['unavailable','Unavailable']]) {
    const service = { ...base, status: 'unavailable', connection: { ...base.connection, state } };
    assert.equal(serviceLabel(service), label);
    const html = render(service); assert.match(html, /disabled=""/); assert.ok(html.includes(label));
  }
});
test('test environment activity has no account test button and all provider fields escape markup', () => {
  const testCard = render({ ...base, id: 'codex-tests', name: 'Codex test environments', status: 'observed', connection: undefined, activeTasks: 1 });
  assert.match(testCard, /Test activity observed|Running test environments/); assert.doesNotMatch(testCard, /Test connection<\/button>/);
  const html = render({ ...base, name: '<script>bad()</script>', connection: { ...base.connection, account: '<b>private</b>' } });
  assert.ok(html.includes('&lt;script&gt;')); assert.ok(html.includes('&lt;b&gt;')); assert.ok(!html.includes('<script>'));
});
