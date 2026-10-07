// Render the production widget with its query/router providers. Only HTTP is
// stubbed; no backend build, browser, or new test dependency is required.
import test, { before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildHarness } from './helpers/buildHarness.mjs';
import { installMiniDom, fire, textOf, query, queryAll } from './helpers/miniDom.mjs';

const adminRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dom = installMiniDom();
const React = (await import('react')).default;
const { createRoot } = await import('react-dom/client');
const { act } = React;
let harness;
before(async () => { harness = await buildHarness('attentionRequiredHarness', { appRoot: adminRoot }); });

const SOURCE_LABELS = {
  git: 'Git checkout',
  system: 'System resources',
  backup: 'Backups',
  packages: 'Release packages',
  database: 'Database',
  'admin-exposure': 'Admin exposure',
  operations: 'Operations'
};
const sources = () => Object.entries(SOURCE_LABELS).map(([id, label]) => ({
  id, label, status: 'ok', detail: `${label}: verified fixture detail.`
}));
function overview({ items = [], sourceStatuses = sources(), coverageComplete = true, allClear = items.length === 0 && coverageComplete } = {}) {
  return {
    generatedAt: '2026-10-04T18:30:00.000Z',
    attention: {
      acknowledged: false,
      message: allClear ? 'All monitored checks are clear.' : 'Review the attention items below.',
      allClear, coverageComplete, items, sources: sourceStatuses
    }
  };
}
const ALERTS = [
  { id: 'disk-critical', label: 'Disk usage is critical', detail: 'Deploy volume is 96% full.', severity: 'red', href: '/system', source: 'system' },
  { id: 'git-dirty', label: 'Working tree has local changes', detail: 'Two tracked files are modified.', severity: 'amber', href: '/github', source: 'git' },
  { id: 'package-ready', label: 'A package is ready for review', detail: 'The staged package differs from the installed release.', severity: 'gold', href: '/packages', source: 'packages' },
  { id: 'operation-running', label: 'An operation is running', detail: 'A backup operation is in progress.', severity: 'info', href: '/controls', source: 'operations' }
];
function unknownOverview() {
  const sourceStatuses = sources().map((source) => source.id === 'backup'
    ? { ...source, status: 'unknown', detail: 'Backup status could not be checked.' }
    : source);
  return overview({
    coverageComplete: false,
    sourceStatuses,
    items: [{ id: 'backup-unavailable', label: 'Backup check unavailable', detail: 'Backup status could not be checked.', severity: 'info', href: '/backups', source: 'backup' }]
  });
}
const response = (data) => ({ ok: true, status: 200, json: async () => ({ success: true, data }) });
const failure = () => ({
  ok: false, status: 503, statusText: 'Service Unavailable',
  json: async () => ({ success: false, error: { code: 'CHECKS_UNAVAILABLE', message: 'Attention checks could not be refreshed.' } })
});

let root;
let queryClient;
let requests;
let respond;
let consoleErrors = [];
const originalFetch = globalThis.fetch;
const originalConsoleError = console.error;
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
const header = () => textOf(query(dom.root, '.card-header'));
const allClearVisible = () => /all\s*clear/i.test(header());
const refreshButton = () => queryAll(dom.root, 'button').find((node) => node.getAttribute('aria-label') === 'Refresh attention checks');
const statusChecks = () => queryAll(dom.root, 'details').find((node) => /status checks/i.test(textOf(query(node, 'summary'))));

async function mount(responder = () => response(overview()), density = 'standard') {
  requests = [];
  respond = responder;
  consoleErrors = [];
  console.error = (...args) => { consoleErrors.push(args.map(String).join(' ')); };
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    requests.push({ url, method: init.method ?? 'GET' });
    assert.equal(url, '/api/admin/overview', 'widget uses the consolidated overview endpoint');
    assert.equal(init.method ?? 'GET', 'GET', 'attention checks are read-only');
    return respond();
  };
  queryClient = new harness.QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: 0 } } });
  root = createRoot(dom.root);
  await act(async () => { root.render(harness.widget(queryClient, density)); });
}
async function until(predicate, message) {
  for (let i = 0; i < 20; i += 1) {
    if (predicate()) return;
    await act(async () => { await settle(); });
  }
  assert.ok(predicate(), message);
}
async function loaded() {
  await until(() => queryClient.getQueryState(['admin', 'overview'])?.fetchStatus === 'idle', 'overview request completed');
  await act(async () => { await settle(); });
}
async function refresh() {
  const button = refreshButton();
  assert.ok(button, 'refresh button has its descriptive accessible label');
  const before = requests.length;
  await act(async () => { fire(button, 'click'); });
  await until(() => requests.length === before + 1, 'refresh made one new overview request');
  await loaded();
}
function assertAlertLinks(items) {
  for (const item of items) {
    const link = queryAll(dom.root, 'a').find((node) => node.getAttribute('aria-label') === `View ${item.label}`);
    assert.ok(link, `descriptive link rendered for ${item.label}`);
    assert.equal(link.getAttribute('href'), item.href);
    assert.ok(textOf(dom.root).includes(item.label));
  }
}

afterEach(async () => {
  if (root) await act(async () => { root.unmount(); });
  root = undefined;
  queryClient?.clear();
  queryClient = undefined;
  globalThis.fetch = originalFetch;
  console.error = originalConsoleError;
  assert.deepEqual(consoleErrors, [], 'no React errors');
});
after(() => { dom.uninstall(); });

test('pending attention checks show Checking and never claim All Clear', async () => {
  let resolveRequest;
  const pending = new Promise((resolve) => { resolveRequest = resolve; });
  await mount(() => pending);
  assert.match(header(), /checking/i);
  assert.equal(allClearVisible(), false);
  assert.equal(requests.length, 1);
  await act(async () => { resolveRequest(response(overview())); });
  await loaded();
  assert.equal(allClearVisible(), true);
});

test('a complete clear snapshot displays All Clear and preserves every source detail', async () => {
  await mount();
  await loaded();
  assert.equal(allClearVisible(), true);
  const checks = statusChecks();
  assert.ok(checks, 'standard density exposes the status-check disclosure');
  for (const source of sources()) {
    assert.ok(textOf(checks).includes(source.label));
    assert.ok(textOf(checks).includes(source.detail), `source detail retained for ${source.id}`);
  }
  assert.equal((textOf(checks).match(/Checked/g) ?? []).length, 7);
  assert.equal(queryAll(dom.root, 'a').filter((node) => node.getAttribute('aria-label')?.startsWith('View ')).length, 0);
  assert.equal(requests.length, 1);
});

test('all severities render actionable alerts with descriptive links and source details', async () => {
  await mount(() => response(overview({ items: ALERTS })));
  await loaded();
  assert.equal(allClearVisible(), false);
  assertAlertLinks(ALERTS);
  for (const item of ALERTS) assert.ok(textOf(dom.root).includes(item.detail));
  assert.ok(statusChecks(), 'status checks remain inspectable alongside alerts');
});

test('an unavailable source remains visible as an informational item and prevents All Clear', async () => {
  const snapshot = unknownOverview();
  await mount(() => response(snapshot));
  await loaded();
  assert.equal(allClearVisible(), false);
  assertAlertLinks(snapshot.attention.items);
  const checks = statusChecks();
  assert.match(textOf(checks), /Unavailable/);
  assert.ok(textOf(checks).includes('Backup status could not be checked.'));
  assert.equal((textOf(checks).match(/Checked/g) ?? []).length, 6);
});

test('a clear flag cannot override missing coverage, unknown sources, or active alerts', async () => {
  await mount(() => response(overview({ allClear: true, coverageComplete: false })));
  await loaded();
  assert.equal(allClearVisible(), false, 'incomplete coverage is never clear');
  for (const snapshot of [
    overview({ allClear: true, sourceStatuses: [] }),
    overview({ allClear: true, sourceStatuses: unknownOverview().attention.sources }),
    overview({ allClear: true, items: [ALERTS[0]] })
  ]) {
    respond = () => response(snapshot);
    await refresh();
    assert.equal(allClearVisible(), false, 'contradictory success flag does not hide missing checks or alerts');
  }
  assertAlertLinks([ALERTS[0]]);
});

test('an initial request failure shows Unavailable without stale success or missing-data crashes', async () => {
  await mount(failure);
  await loaded();
  assert.match(header(), /unavailable/i);
  assert.equal(allClearVisible(), false);
  assert.match(textOf(dom.root), /could not be refreshed/i);
  assert.ok(refreshButton());
});

test('a failed refresh preserves cached alerts and marks the displayed snapshot as previous results', async () => {
  await mount(() => response(overview({ items: ALERTS })));
  await loaded();
  respond = failure;
  await refresh();
  assert.match(header(), /unavailable/i);
  assert.equal(allClearVisible(), false);
  assertAlertLinks(ALERTS);
  assert.match(textOf(dom.root), /last|previous/i);
  assert.match(textOf(dom.root), /could not|unavailable|failed/i);
});

test('a failed refresh invalidates a cached All Clear presentation', async () => {
  await mount();
  await loaded();
  assert.equal(allClearVisible(), true);
  respond = failure;
  await refresh();
  assert.match(header(), /unavailable/i);
  assert.equal(allClearVisible(), false);
  assert.match(textOf(dom.root), /last|previous/i);
});

test('manual refresh retrieves a new snapshot and replaces resolved alerts with All Clear', async () => {
  await mount(() => response(overview({ items: [ALERTS[0]] })));
  await loaded();
  assertAlertLinks([ALERTS[0]]);
  respond = () => response(overview());
  await refresh();
  assert.equal(requests.length, 2);
  assert.equal(allClearVisible(), true);
  assert.equal(textOf(dom.root).includes(ALERTS[0].label), false, 'resolved alert removed');
});

test('compact density hides status checks while retaining alerts and failed-refresh warnings', async () => {
  const snapshot = unknownOverview();
  await mount(() => response(snapshot), 'compact');
  await loaded();
  assert.equal(statusChecks(), undefined);
  assertAlertLinks(snapshot.attention.items);
  assert.equal(allClearVisible(), false);
  respond = failure;
  await refresh();
  assert.equal(statusChecks(), undefined);
  assertAlertLinks(snapshot.attention.items);
  assert.match(header(), /unavailable/i);
  assert.match(textOf(dom.root), /last|previous/i);
});
