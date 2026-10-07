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
const { DashboardPage } = await server.ssrLoadModule('/src/pages/DashboardPage.tsx');
const { SettingsPage } = await server.ssrLoadModule('/src/pages/SettingsPage.tsx');
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
  for (const text of ['W3 Forge', 'v0.4.1', 'Development build', 'Signed in as operator', 'Sign out', 'GitHub Validation', 'File Browser', 'Controls', 'Terminal', 'PAGE_CONTENT', 'w3-sidebar', 'md:sticky', 'sticky top-0']) assert.ok(html.includes(text), text);
  assert.ok(html.includes('href="https://core.test"'));
  assert.doesNotMatch(html, /href="\/packages|href="\/backups|href="\/command-center/);
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
  assert.match(app, /path="\/terminal" element={<Suspense/);
  assert.match(app, /lazy\(\(\) => import\('\.\/pages\/TerminalPage'\)/);
});


const connections = {
  core: { configured: true, publicUrl: 'https://core.test' },
  github: { repositoryUrl: 'https://github.com/example/forge', workspace: '/review/forge', defaultDevBranch: 'dev/v0.4.1' },
  terminal: { enabled: true },
  materialPricing: { enabled: true, configured: true, maxProducts: 50, maxRequestChargeCents: 100, maxDailyChargeCents: 1000 },
  ollama: { configured: true, model: 'forge-model' },
  n8n: { configured: true, url: 'https://automation.test' },
  chat: { status: 'planned' }, businessAutomations: { status: 'planned' }
};
const system = { app: 'w3forge', version: '0.4.1', forgeRoot: '/review/forge', host: 'forge', platform: 'linux', nodeVersion: 'v22', uptimeSeconds: 123,
  authority: { mayDeploy: false, mayTagRelease: false, mayModifyProductionData: false } };
const terminal = { available: false, enabled: true, supported: false, message: 'Terminal is not available on this host.', hostname: 'forge', access: 'root-login' };
const appValues = [[['connections'], connections], [['system'], system], [['admin', 'terminal', 'status'], terminal],
  [['overview'], { attention: { message: 'Review configuration before use.', items: [] } }]];

test('workspace links to real admin tools and distinguishes configured services from planned modules', () => {
  const html = render(React.createElement(DashboardPage), status, appValues);
  for (const text of ['W3 Forge Workspace', 'href="/github"', 'href="/terminal"', 'href="/controls"', 'Lowe', 'Forge Chat', 'n8n automation interface', 'Business automations', 'Configured', 'Planned', 'Unavailable', 'do not confirm service health']) assert.ok(html.includes(text), text);
  assert.match(html, /href="https:\/\/automation.test"/);
  assert.doesNotMatch(html, /type="password"|Start Chat|Run Automation|Start Scraping/);
});

test('settings show configuration and pricing limits without claiming untested services are connected', () => {
  const html = render(React.createElement(SettingsPage), status, appValues);
  for (const text of ['Settings &amp; Connections', 'read-only', 'not that a service is reachable', 'forge-model', '$1.00', '$10.00', 'Terminal commands affect the Forge host', 'can change host files', 'does not establish API access']) assert.ok(html.includes(text), text);
  assert.doesNotMatch(html, /type="password"|type="text"|Root shell connected/);
});

test('GitHub shows repository and local tracking metadata without implying a remote connection was checked', () => {
  const html = render(React.createElement(GitHubValidationPage), status, [[['git', 'status'], {
    branch: 'dev/v0.4.1', workspace: '/review/forge', branchAllowed: true, dirty: true, statusShort: ' M README.md', devBranches: ['dev/v0.4.1'],
    repositoryUrl: 'https://github.com/example/forge', remoteConfigured: true, head: '0123456789abcdef', upstream: 'origin/dev/v0.4.1', ahead: 2, behind: 1, defaultDevBranch: 'dev/v0.4.1'
  }]]);
  for (const text of ['Not checked', 'Check Connection', '0123456789ab', 'origin/dev/v0.4.1', '2 ahead', '1 behind', 'Changes present', 'last fetched', 'href="https://github.com/example/forge"']) assert.ok(html.includes(text), text);
  assert.doesNotMatch(html, /type="password"|Save token/);
});

test('GitHub leaves the remote check disabled when the workspace has no remote', () => {
  const html = render(React.createElement(GitHubValidationPage), status, [[['git', 'status'], {
    branch: 'dev/v0.4.1', workspace: '/review/forge', branchAllowed: true, dirty: false, statusShort: '', devBranches: [],
    repositoryUrl: null, remoteConfigured: false, head: '', upstream: null, ahead: null, behind: null, defaultDevBranch: 'dev/v0.4.1'
  }]]);
  assert.match(html, /No repository remote is configured/);
  assert.match(html, /class="btn btn-primary" disabled=""/);
  assert.match(html, /No upstream configured/);
});
