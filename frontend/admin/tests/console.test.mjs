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
const { ProductionReadinessPage } = await server.ssrLoadModule('/src/pages/ProductionReadinessPage.tsx');
const { SettingsPage } = await server.ssrLoadModule('/src/pages/SettingsPage.tsx');
const { PackagesPage } = await server.ssrLoadModule('/src/pages/PackagesPage.tsx');
const { BackupsPage } = await server.ssrLoadModule('/src/pages/BackupsPage.tsx');
const { inventoryData, availableInventory, inventoryStatus } = await server.ssrLoadModule('/src/lib/inventory.ts');
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
  for (const text of ['W3 Forge', 'v0.4.1', 'Development build', 'Signed in as operator', 'Sign out', 'GitHub / Releases', 'Packages', 'Backups', 'Production Readiness', 'File Browser', 'Controls', 'Terminal', 'PAGE_CONTENT', 'w3-sidebar', 'md:sticky', 'sticky top-0']) assert.ok(html.includes(text), text);
  assert.ok(html.includes('href="https://core.test"'));
  const labels = ['Dashboard', 'System Status', 'Logs', 'Packages', 'Backups', 'File Browser', 'GitHub / Releases', 'Terminal', 'Controls', 'Production Readiness', 'Settings'];
  const indexes = labels.map(label => html.indexOf('>' + label + '</span>'));
  assert.ok(indexes.every((value, index) => value >= 0 && (!index || value > indexes[index - 1])), 'canonical navigation order');
  assert.doesNotMatch(html, /Engineering console/);
  assert.match(html, /href="\/packages"/);
  assert.match(html, /href="\/backups"/);
  assert.doesNotMatch(html, /href="\/command-center/);
  assert.doesNotMatch(html, /role="dialog"/, 'closed mobile drawer must not leave hidden focusable links');
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
test('GitHub / Releases shows workspace status and routes execution through existing Controls', () => {
  const html = render(React.createElement(GitHubValidationPage), status, [[['git', 'status'], { branch: 'dev/v0.4.1', workspace: '/review/forge', branchAllowed: true, dirty: false, statusShort: '', devBranches: ['dev/v0.4.1'] }]]);
  for (const text of ['GitHub / Releases', 'GitHub Release Standard', 'Current Git Status', 'dev/v0.4.1', 'Allowed branch', 'Clean', 'Open Controls']) assert.ok(html.includes(text), text);
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


const gitIdentity = { appId: 'w3forge', appName: 'W3 Forge', configuredRepositoryUrl: 'https://github.com/example/forge', remoteRepositoryUrl: 'https://github.com/example/forge', repositoryBinding: 'matched', repositoryMessage: 'Workspace origin matches this app.' };
const connections = {
  app: { id: 'w3forge', name: 'W3 Forge', version: '0.4.1' },
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
  [['logs'], { files: ['admin/operations.log'] }],
  [['overview'], { attention: { message: 'Review configuration before use.', items: [] } }]];

test('dashboard uses the common operations tiles and truthful unavailable states', () => {
  const html = render(React.createElement(DashboardPage), status, appValues);
  for (const text of ['Operations Overview', 'System Health', 'Version', 'Attention Required', 'Recent Logs', 'Memory / CPU', 'Disk Usage', 'Staged Packages', 'Installed Packages', 'Backup Summary', 'Unavailable', 'admin/operations.log', 'href="/system"', 'href="/logs"']) assert.ok(html.includes(text), text);
  assert.doesNotMatch(html, /Application modules|W3 Forge Workspace|Forge Chat|Start Chat|Run Automation|Start Scraping|n8n automation interface/);
  assert.match(html, /disabled=""[^>]*>.*?Customize/);
});

test('readiness uses the standard checklist without claiming configuration approves a release', () => {
  const html = render(React.createElement(ProductionReadinessPage), status, [...appValues, [['git', 'status'], { branch: 'dev/v0.4.1', branchAllowed: true, dirty: true }]]);
  for (const text of ['Production Readiness', 'Readiness Checklist', 'Configured', 'Changes present', 'Owner review required', 'Manual review required', 'do not approve a release', 'table-dark', 'mobile-cards']) assert.ok(html.includes(text), text);
  assert.doesNotMatch(html, /All checks pass|Enable Production|production-cutover/);
});

test('settings show configuration and pricing limits without claiming untested services are connected', () => {
  const html = render(React.createElement(SettingsPage), status, appValues);
  for (const text of ['Settings', 'read-only', 'not that a service is reachable', 'forge-model', '$1.00', '$10.00', 'Terminal commands affect the Forge host', 'can change host files', 'does not establish API access']) assert.ok(html.includes(text), text);
  assert.doesNotMatch(html, /type="password"|type="text"|Root shell connected/);
});

test('GitHub shows repository and local tracking metadata without implying a remote connection was checked', () => {
  const html = render(React.createElement(GitHubValidationPage), status, [[['git', 'status'], {
    ...gitIdentity, branch: 'dev/v0.4.1', workspace: '/review/forge', branchAllowed: true, dirty: true, statusShort: ' M README.md', devBranches: ['dev/v0.4.1'],
    repositoryUrl: 'https://github.com/example/forge', remoteConfigured: true, head: '0123456789abcdef', upstream: 'origin/dev/v0.4.1', ahead: 2, behind: 1, defaultDevBranch: 'dev/v0.4.1'
  }]]);
  for (const text of ['Not checked', 'Check Remote', '0123456789ab', 'origin/dev/v0.4.1', '2 ahead', '1 behind', 'Changes present', 'last fetched', 'href="https://github.com/example/forge"']) assert.ok(html.includes(text), text);
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


test('missing session encryption setup is explained without offering sign-in or exposing protected content', () => {
  const html = render(React.createElement(CoreAuthGate, {}, 'PRIVATE_CONTENT'), {
    ...status, configured: false, authenticated: false, user: null,
    setupError: 'Configure a separate FORGE_SESSION_SECRET with at least 32 characters before signing in.'
  });
  assert.match(html, /FORGE_SESSION_SECRET/);
  assert.doesNotMatch(html, /PRIVATE_CONTENT|type="password"/);
  assert.match(html, /disabled=""/);
});

const inventory = { app: { id: 'w3forge', name: 'W3 Forge' }, root: '/review/forge/packages',
  connection: { configured: true, available: true, state: 'ready', message: null }, truncated: false };
const packageInventory = { ...inventory, packages: [{ name: 'w3forge.tar.gz', path: '/review/forge/packages/v0.4.1/w3forge.tar.gz',
  sizeBytes: 1024, mtime: '2026-10-07T01:00:00.000Z', validName: true, parsedVersion: '0.4.1', layout: 'canonical' }] };
const backupInventory = { ...inventory, root: '/review/forge/backups', backups: [{ name: 'w3forge-v0.4.1-fixture.sql.gz',
  sizeBytes: 512, mtime: '2026-10-07T01:00:00.000Z', parsedVersion: '0.4.1', kind: 'database' }], totalSizeBytes: 512 };

test('package and backup pages display app-specific metadata without execution actions', () => {
  const packages = render(React.createElement(PackagesPage), status, [
    [['admin', 'packages', 'staged'], packageInventory], [['admin', 'packages', 'installed'], { ...inventory, packages: [] }]
  ]);
  for (const text of ['W3 Forge', '/review/forge/packages', 'w3forge.tar.gz', 'Staged Packages', 'Installed Packages', 'mobile-cards', 'table-dark']) assert.ok(packages.includes(text), text);
  const backups = render(React.createElement(BackupsPage), status, [[['admin', 'backups'], backupInventory]]);
  for (const text of ['w3forge-v0.4.1-fixture.sql.gz', 'Database file', 'Not verified', 'Latest Backup File', 'Backup History']) assert.ok(backups.includes(text), text);
  assert.doesNotMatch(packages + backups, /<button[^>]*>[^<]*(Install|Restore|Delete|Deploy)/);
});
test('inventory pages distinguish disconnected storage from an empty connected directory', () => {
  for (const [state, label] of [['not_configured', 'Not configured'], ['missing', 'Directory missing'], ['unavailable', 'Unavailable']]) {
    const data = { ...packageInventory, connection: { configured: state !== 'not_configured', available: false, state, message: null } };
    const html = render(React.createElement(PackagesPage), status, [
      [['admin', 'packages', 'staged'], data], [['admin', 'packages', 'installed'], data]
    ]);
    assert.ok(html.includes(label), label); assert.match(html, /Retry/);
    assert.doesNotMatch(html, /w3forge\.tar\.gz<\/div>|No staged packages found/);
  }
  const html = render(React.createElement(PackagesPage), status, [
    [['admin', 'packages', 'staged'], { ...inventory, packages: [] }], [['admin', 'packages', 'installed'], { ...inventory, packages: [] }]
  ]);
  assert.match(html, /No staged packages found/); assert.match(html, /Available/);
});
test('inventory adapters hide cached data on failure and label truncated listings', () => {
  const ready = { isPending: false, isError: false, error: null, data: packageInventory };
  assert.equal(availableInventory(ready), packageInventory);
  for (const state of [{ isError: true, error: new Error('Storage failed') }, { isPending: true }]) {
    const query = { ...ready, ...state };
    assert.equal(inventoryData(query), undefined); assert.equal(availableInventory(query), undefined);
    assert.notEqual(inventoryStatus(query).label, 'Available');
  }
  assert.equal(inventoryStatus({ ...ready, data: { ...packageInventory, truncated: true } }).label, 'Partial listing');
});
test('a mismatched workspace cannot replace the app repository link or enable connection check', () => {
  const html = render(React.createElement(GitHubValidationPage), status, [[['git', 'status'], {
    ...gitIdentity, workspace: '/review/forge', branch: 'dev/v0.4.1', branchAllowed: true, dirty: false,
    repositoryUrl: gitIdentity.configuredRepositoryUrl, remoteConfigured: true,
    remoteRepositoryUrl: 'https://github.com/example/buildcost', repositoryBinding: 'mismatch',
    repositoryMessage: 'Workspace origin points to a different repository.'
  }]]);
  assert.match(html, /href="https:\/\/github.com\/example\/forge"/);
  assert.doesNotMatch(html, /href="https:\/\/github.com\/example\/buildcost"/);
  assert.match(html, /Workspace origin: /); assert.match(html, /Needs attention/);
  assert.match(html, /class="btn btn-primary" disabled=""/);
});
