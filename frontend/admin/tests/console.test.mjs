import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { renderToString } from 'react-dom/server';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { readFileSync } from 'node:fs';

const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
const { AdminLayout } = await server.ssrLoadModule('/src/components/AdminLayout.tsx');
const { CoreAuthGate } = await server.ssrLoadModule('/src/components/CoreAuthGate.tsx');
const { GitHubValidationPage } = await server.ssrLoadModule('/src/pages/GitHubValidationPage.tsx');
test.after(() => server.close());
globalThis.window = { location: { search: '' } };
const status = { configured: true, authenticated: true, coreUrl: 'https://core.test',
  connection: { status: 'approved', fingerprint: '1234567890abcdef' }, user: { id: '1', username: 'operator', appRole: 'admin' } };
function render(component, auth = status, values = []) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(['core', 'auth'], auth);
  client.setQueryData(['admin', 'version'], { version: '0.4.1', nodeEnv: 'development' });
  for (const [key, value] of values) client.setQueryData(key, value);
  const html = renderToString(React.createElement(QueryClientProvider, { client }, React.createElement(MemoryRouter, {}, component)));
  client.clear(); return html;
}
test('the console uses current shared navigation, environment badges and account footer', () => {
  const html = render(React.createElement(AdminLayout, {}, 'PAGE_CONTENT'));
  for (const text of ['W3 Forge', 'v0.4.1', 'Development build', 'Signed in as operator', 'Sign out', 'GitHub Validation', 'File Browser', 'Controls', 'PAGE_CONTENT', 'w3-sidebar', 'md:sticky', 'sticky top-0']) assert.ok(html.includes(text), text);
  assert.ok(html.includes('href="https://core.test"'));
  assert.doesNotMatch(html, /href="\/packages|href="\/backups|href="\/terminal|href="\/command-center/);
});
test('unapproved installation shows fingerprint and browser sign-in without password fields', () => {
  const html = render(React.createElement(CoreAuthGate, {}, 'PRIVATE_CONTENT'), { ...status, authenticated: false, user: null, connection: { ...status.connection, status: 'pending' } });
  assert.match(html, /Sign in with W3 Core/); assert.match(html, /1234567890abcdef/);
  assert.doesNotMatch(html, /PRIVATE_CONTENT|type="password"|name="password"/);
});
test('viewer and editor assignments cannot render the admin console', () => {
  for (const appRole of ['viewer', 'editor']) {
    const html = render(React.createElement(CoreAuthGate, {}, 'PRIVATE_CONTENT'), { ...status, user: { ...status.user, appRole } });
    assert.match(html, /Forge admin access required/); assert.doesNotMatch(html, /PRIVATE_CONTENT/);
  }
  assert.match(render(React.createElement(CoreAuthGate, {}, 'PRIVATE_CONTENT')), /PRIVATE_CONTENT/);
});
test('GitHub Validation shows workspace status and routes execution through existing Controls', () => {
  const html = render(React.createElement(GitHubValidationPage), status, [[['git', 'status'], { branch: 'dev/v0.4.1', workspace: '/review/forge', branchAllowed: true, dirty: false, statusShort: '', devBranches: ['dev/v0.4.1'] }]]);
  for (const text of ['GitHub Validation', 'dev/v0.4.1', 'Allowed branch', 'Clean', 'Open Controls']) assert.ok(html.includes(text), text);
  assert.doesNotMatch(html, /Deploy|Publish|Merge|Create release/);
});
test('existing Controls and File Browser remain routed behind the Core gate', () => {
  const app = readFileSync('src/App.tsx', 'utf8');
  assert.match(app, /<CoreAuthGate><AdminLayout>/);
  assert.match(app, /path="\/files" element={<FileBrowserPage/);
  assert.match(app, /path="\/controls" element={<ControlsPage/);
});
