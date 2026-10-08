import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { renderToString } from 'react-dom/server';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { readFileSync } from 'node:fs';
import { consoleConfiguration } from './helpers/consoleConfiguration.mjs';

const server = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom' });
const load = file => server.ssrLoadModule('/src/' + file);
const config = await load('lib/appConfiguration.ts');
config.setAdminConfiguration(consoleConfiguration('w3forge', '0.4.2'));
const { AdminLayout } = await load('components/AdminLayout.tsx');
const { AdminAuthGate } = await load('components/AdminAuthGate.tsx');
const { GitHubPage } = await load('pages/GitHubPage.tsx');
const { DashboardPage } = await load('pages/DashboardPage.tsx');
const { PackagesPage } = await load('pages/PackagesPage.tsx');
const { BackupsPage } = await load('pages/BackupsPage.tsx');
const { AccessDeniedPage, CoreUnavailablePage, LoginPage, safeNext } = await load('pages/AuthPages.tsx');
const { loadConsoleConfiguration } = await load('bootstrap.ts');
const { adminGet, adminPost, adminPut } = await load('lib/api.ts');
test.after(() => server.close());
globalThis.window = { location: { search: '', pathname: '/admin/' }, dispatchEvent() {}, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) };
const status = { authenticated: true, loginAvailable: true, sessionError: null, user: { displayName: 'operator', permissions: ['forge:read', 'forge:write', 'forge:admin'] } };
function render(component, { auth = status, values = [], errors = [], route = '/' } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false, staleTime: Infinity, gcTime: Infinity } } });
  client.setQueryData(['auth', 'status'], auth);
  client.setQueryData(['admin', 'version'], { app: 'w3forge', version: '0.4.1', nodeEnv: 'development', startedAt: '2026-10-07T00:00:00Z' });
  for (const [key, value] of values) client.setQueryData(key, value);
  for (const [key, error] of errors) {
    client.setQueryData(key, {});
    client.getQueryCache().find({ queryKey: key }).setState({ status: 'error', fetchStatus: 'idle', data: undefined, error });
  }
  const html = renderToString(React.createElement(QueryClientProvider, { client }, React.createElement(MemoryRouter, { initialEntries: [route] }, component)));
  client.clear(); return html.replace(/<!-- -->/g, '');
}
const el = React.createElement;
const git = { deployRoot: '/review/forge', isRepo: true, branch: 'dev/v0.4.1', headSha: '1234567890abcdef', headShortSha: '1234567', describedTag: null, clean: true, uncommittedCount: 0,
  remote: 'https://github.com/example/forge.git', lastCommit: null, releaseVersion: '0.4.1', status: 'ok', repositoryBinding: 'matched', configuredRepositoryUrl: 'https://github.com/example/forge' };
const gitValues = [[['admin', 'git', 'status'], git], [['admin', 'git', 'tags'], { tags: [], count: 0, limit: 20, installedVersion: '0.4.1' }], [['admin', 'git', 'commits'], { commits: [], count: 0, limit: 25 }]];
const packages = { root: '/opt/w3forge-update-packages', packages: [{ name: 'w3forge-v0.4.1.tar.gz', path: '/opt/w3forge-update-packages/w3forge-v0.4.1.tar.gz', sizeBytes: 1024, mtime: '2026-10-07T00:00:00Z', validName: true, parsedVersion: '0.4.1' }] };
const backups = { root: '/opt/backups/w3forge', totalSizeBytes: 2048, backups: [{ pairTimestamp: '2026-10-07_00-00-00', appArchive: { name: 'w3forge_app_2026-10-07_00-00-00.tar.gz', sizeBytes: 1024, mtime: '2026-10-07T00:00:00Z' }, dbArchive: { name: 'w3forge_db_2026-10-07_00-00-00.sql', sizeBytes: 1024, mtime: '2026-10-07T00:00:00Z' }, parsedVersion: '0.4.1', kind: 'paired' }] };
const readiness = { system: { version: '0.4.1', gitCommit: '1234567', environment: 'development' }, migration_version: '1', production_data_mode: false, all_checks_pass: false, pass_count: 0, total_checks: 1,
  checks: [{ key: 'database', label: 'Database', pass: false, detail: 'Database unavailable' }], backup: { exists: false, filename: null, size_bytes: null, mtime: null, age_hours: null, health: 'unknown' }, cutover_record: null };

test('the console retains every canonical navigation item and product/account footer', () => {
  const html = render(el(AdminLayout, {}, 'PAGE_CONTENT'));
  for (const text of ['W3 Forge', 'v0.4.1', 'Development build', 'Signed in as operator', 'Sign out', 'PAGE_CONTENT', 'w3-sidebar', 'md:sticky', 'sticky top-0', 'href="/forge"']) assert.ok(html.includes(text), text);
  const labels = ['Dashboard', 'System Status', 'Logs', 'Packages', 'Backups', 'File Browser', 'GitHub / Releases', 'Terminal', 'Controls'];
  const indices = labels.map(label => html.indexOf('>' + label + '</span>'));
  assert.ok(indices.every((value, index) => value >= 0 && (!index || value > indices[index - 1])));
  assert.doesNotMatch(html, /Core-managed|Engineering console|role="dialog"/);
  assert.doesNotMatch(html, /Production Readiness|>Settings<|href="\/settings"|href="\/production-readiness"/);
});
test('unapproved installations cannot render protected content or password fields', () => {
  const html = render(el(AdminAuthGate, {}, 'PRIVATE_CONTENT'), { auth: { ...status, authenticated: false, loginAvailable: false, user: null } });
  assert.match(html, /Redirecting/); assert.doesNotMatch(html, /PRIVATE_CONTENT|type="password"/);
});
test('viewer and editor assignments cannot render the admin console', () => {
  for (const permissions of [['forge:read'], ['forge:read', 'forge:write'], ['buildcost:admin']]) assert.doesNotMatch(render(el(AdminAuthGate, {}, 'PRIVATE_CONTENT'), { auth: { ...status, user: { ...status.user, permissions } } }), /PRIVATE_CONTENT/);
  assert.match(render(el(AdminAuthGate, {}, 'PRIVATE_CONTENT')), /PRIVATE_CONTENT/);
});
test('missing encryption or unavailable Core uses the shared unavailable redirect state', () => {
  const html = render(el(AdminAuthGate, {}, 'PRIVATE_CONTENT'), { auth: { ...status, authenticated: false, loginAvailable: false, user: null, sessionError: { code: 'SESSION_SECRET_MISSING', message: 'Setup incomplete' } } });
  assert.match(html, /Redirecting/); assert.doesNotMatch(html, /PRIVATE_CONTENT|type="password"/);
});
test('all operational routes use the canonical gate and route recovery boundary', () => {
  const app = readFileSync('src/App.tsx', 'utf8');
  assert.match(app, /<AdminAuthGate>/); assert.match(app, /<RouteErrorBoundary>/);
  for (const route of ['files', 'controls', 'terminal', 'github', 'packages', 'backups']) assert.ok(app.includes('path="/' + route + '"'));
  assert.match(app, /lazy\(\(\) => import\('\.\/pages\/TerminalPage'\)/);
});
test('GitHub exposes the complete release workflow, source inventory, and histories', () => {
  const html = render(el(GitHubPage), { values: gitValues });
  for (const text of ['GitHub / Releases', 'GitHub Release Standard', 'Current Source Snapshot', 'Check Remote', 'Fetch Tags', 'Compare Installed', 'Release / Tag History', 'Commit History', 'dev/v0.4.1', '/review/forge']) assert.ok(html.includes(text), text);
  assert.doesNotMatch(html, /type="password"|Save token/);
  const source = readFileSync('src/pages/GitHubPage.tsx', 'utf8');
  for (const component of ['UnifiedReleaseWorkflow', 'PipelineStateSummary', 'SafePreflightButton']) assert.ok(source.includes('<' + component));
});
test('dashboard customization is fully enabled with the canonical persisted-layout contract', () => {
  const layout = { version: '0.4.1', schema: 1, updated_at: '2026-10-07T00:00:00Z', source: 'file', path: '/settings/admin-dashboard.json', hidden_tiles: [], layouts: { lg: [], md: [], sm: [], xs: [] } };
  const html = render(el(DashboardPage), { values: [[['admin', 'dashboard', 'layout'], layout]] });
  assert.match(html, /Operations Overview/); assert.match(html, /Customize/);
  assert.doesNotMatch(html, /disabled=""[^>]*>.*?Customize/);
  const source = readFileSync('src/hooks/useDashboardLayout.ts', 'utf8');
  assert.ok(source.includes("adminPut<DashboardLayoutPayload>('/dashboard/layout'")); assert.ok(source.includes("adminPost<DashboardLayoutPayload>('/dashboard/layout/reset'"));
});
test('dashboard failure shows error rather than fabricated operational data', () => {
  const html = render(el(DashboardPage), { errors: [[['admin', 'dashboard', 'layout'], new Error('Layout unavailable')]] });
  assert.match(html, /Layout unavailable/); assert.doesNotMatch(html, /All monitored checks are clear/);
});
for (const [route, page] of [['production-readiness', 'ProductionReadinessPage'], ['settings', 'SettingsPage']]) {
  test(route + ' is retired from routing without retaining an importable fork', () => {
    assert.doesNotMatch(readFileSync('src/App.tsx', 'utf8'), new RegExp('path="/' + route + '"|' + page));
    assert.throws(() => readFileSync('src/pages/' + page + '.tsx'), { code: 'ENOENT' });
  });
  test(route + ' is not exposed from the navigation or its error state', () => {
    const html = render(el(AdminLayout, {}, 'CONTENT'), { route: '/' + route });
    assert.doesNotMatch(html, new RegExp('href="/' + route + '"'));
    assert.match(html, /CONTENT/);
  });
}
test('packages retain the reference staged/installed table and mobile-card presentation', () => {
  const html = render(el(PackagesPage), { values: [[['admin', 'packages', 'staged'], packages], [['admin', 'packages', 'installed'], packages]] });
  for (const text of ['W3 Forge', 'w3forge-v0.4.1.tar.gz', 'Staged Packages', 'Installed Packages', 'table-dark', 'mobile-cards']) assert.ok(html.includes(text), text);
  assert.doesNotMatch(html, /w3buildcost|Core-managed/);
});
test('backup history retains paired application/database metadata and latest backup view', () => {
  const html = render(el(BackupsPage), { values: [[['admin', 'backups'], backups]] });
  for (const text of ['Latest Backup Set', 'Backup History', 'w3forge_app_2026-10-07_00-00-00.tar.gz', 'w3forge_db_2026-10-07_00-00-00.sql']) assert.ok(html.includes(text), text);
  assert.doesNotMatch(html, /w3buildcost/); assert.match(html, />Clean<\/td>/);
});
test('empty and failed inventory requests remain distinguishable', () => {
  const empty = render(el(PackagesPage), { values: [[['admin', 'packages', 'staged'], { ...packages, packages: [] }], [['admin', 'packages', 'installed'], { ...packages, packages: [] }]] });
  assert.match(empty, /No .*Packages/i);
  const failed = render(el(PackagesPage), { errors: [[['admin', 'packages', 'staged'], new Error('Storage unavailable')], [['admin', 'packages', 'installed'], new Error('Storage unavailable')]] });
  assert.match(failed, /Storage unavailable/); assert.doesNotMatch(failed, /w3forge-v0\.4\.1\.tar\.gz/);
});
test('canonical auth pages explain Core access and contain no local credential form', () => {
  assert.match(render(el(LoginPage)), /Sign in with W3 Core/);
  assert.match(render(el(AccessDeniedPage), { route: '/access-denied?area=admin' }), /W3 Forge administrator access/);
  assert.match(render(el(CoreUnavailablePage)), /W3 Forge verifies every user with W3 Core/);
  assert.doesNotMatch(render(el(LoginPage)), /type="password"|name="password"/);
});
test('auth return targets cannot redirect to another origin or auth loop', () => {
  for (const value of ['https://evil.test', '//evil.test', '/\\evil.test', '/forge/login', '/api/auth/login', '/%2f%2fevil.test']) assert.equal(safeNext(value), '/');
  assert.equal(safeNext('/admin/github'), '/admin/github');
  assert.equal(safeNext('/forge'), '/');
});
test('app configuration owns identity, paths and package validation without changing API routes', () => {
  assert.equal(config.consoleText('W3 BuildCost /opt/w3buildcost-backups w3buildcost.tar.gz buildcost:admin'), 'W3 Forge /opt/backups/w3forge w3forge.tar.gz forge:admin');
  assert.equal(new RegExp(config.consolePattern('^w3buildcost-v\\d+\\.\\d+\\.\\d+\\.tar\\.gz$')).test('w3forge-v0.4.1.tar.gz'), true);
  assert.equal(new RegExp(config.consolePattern('^w3buildcost-v\\d+\\.\\d+\\.\\d+\\.tar\\.gz$')).test('w3buildcost-v0.4.1.tar.gz'), false);
  assert.throws(() => config.setAdminConfiguration({}), /incomplete/i);
});
test('configuration bootstrap blocks operational rendering for a failed or malformed response', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ success: false }), { status: 500 }));
  await assert.rejects(loadConsoleConfiguration());
  globalThis.fetch.mock.mockImplementation(async () => new Response(JSON.stringify({ success: true, data: {} }), { status: 200 }));
  await assert.rejects(loadConsoleConfiguration(), /incomplete/i);
  globalThis.fetch.mock.mockImplementation(async () => new Response('{}', { status: 401 }));
  await assert.rejects(loadConsoleConfiguration(), { status: 401 });
});
test('admin transport preserves structured refusal details and same-origin mutation contracts', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => { calls.push({ url, options }); return new Response(JSON.stringify({ success: true, data: { stored: true } }), { status: 200 }); });
  await adminPut('/dashboard/layout', { layouts: {} }); await adminPost('/controls/pipeline-test-dev/validate', { inputs: {} });
  assert.equal(calls[0].url, '/api/admin/dashboard/layout'); assert.equal(calls[0].options.method, 'PUT'); assert.equal(calls[0].options.credentials, 'same-origin');
  globalThis.fetch.mock.mockImplementation(async () => new Response(JSON.stringify({ success: true, data: { runStatus: 'blocked', reason: 'Repository mismatch' } }), { status: 409 }));
  await assert.rejects(adminGet('/git/status'), /blocked: Repository mismatch/);
});
