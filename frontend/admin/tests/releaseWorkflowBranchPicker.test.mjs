// =============================================================================
// W3 Core v0.12.10 — UnifiedReleaseWorkflow branch picker rendered tests
// =============================================================================
//
// Mounts the *real* UnifiedReleaseWorkflow (+ DarkSelect, PipelineShared-
// StateProvider, react-query) with react-dom/client inside the dependency-free
// DOM shim from the Command Center suite, feeding it realistic
// /api/admin/git/branches-dev and /api/admin/controls envelopes.
//
// Proves (behaviour, not layout):
//   * default selection is the HIGHEST numeric dev/vX.Y.Z even when the server
//     lists branches in lexical order;
//   * a refetch (manual refresh) does not overwrite the operator's selection;
//   * selecting dev/v0.12.10 keeps that exact value, derives v0.12.10 in the
//     Version field, and seeds the Checkout step's `branch` input once step 1
//     succeeds;
//   * the picker is in `fitOptions` mode, the full option text is in the DOM
//     for every branch and the trigger/options carry title tooltips;
//   * keyboard navigation + Enter still selects.
//
// NOTE: this DOM shim performs no CSS layout. Text-visibility / no-truncation
// is verified separately in a real Chromium (see CHANGELOG 0.12.10 → Admin UI
// corrections → browser verification); these tests do NOT claim to prove it.
//
// Run: node --test frontend/admin/tests/   (also part of root `npm test`)
// =============================================================================

import test, { before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { buildHarness } from './helpers/buildHarness.mjs';
import { installMiniDom, byTestId, fire, textOf, query, queryAll } from './helpers/miniDom.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const adminRoot = path.resolve(here, '..');
const repoRoot = path.resolve(here, '..', '..', '..');

// The DOM must exist before react-dom/client is evaluated.
const dom = installMiniDom();
const React = (await import('react')).default;
const { createRoot } = await import('react-dom/client');
const { act } = React;

let harness;
before(async () => {
  harness = await buildHarness('releaseWorkflowHarness', { appRoot: adminRoot });
});

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

// Deliberately in the *lexical* order an un-fixed backend would return, so the
// client-side default proves it does not trust response order.
const LEXICAL_BRANCHES = [
  { name: 'dev/v0.12.9', sha: '9999999999999999999999999999999999999999' },
  { name: 'dev/v0.12.2', sha: '2222222222222222222222222222222222222222' },
  { name: 'dev/v0.12.10', sha: '1010101010101010101010101010101010101010' }
];
const WITH_LONG = [
  { name: 'dev/v1.100.100', sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
  ...LEXICAL_BRANCHES
];
// Zero-padded identifiers the allowlist already accepts; the UI must never
// rewrite them (dev/v01.002.003 is NOT v1.2.3).
const ZERO_PADDED = [
  { name: 'dev/v01.002.003', sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
  { name: 'dev/v1.00.00', sha: 'cccccccccccccccccccccccccccccccccccccccc' },
  ...LEXICAL_BRANCHES
];

function branchesEnvelope(branches) {
  return {
    success: true,
    data: {
      ok: true,
      listedAt: '2026-09-20T12:00:00.000Z',
      branches,
      count: branches.length,
      message: `Found ${branches.length} dev branch(es).`,
      status: 'list_ok'
    }
  };
}

// Real registry → public controls payload (same shape GET /controls returns).
function controlsEnvelope() {
  const distRegistry = path.join(repoRoot, 'backend', 'dist', 'console', 'controls', 'registry.js');
  assert.ok(existsSync(distRegistry), 'backend/dist must be built (root npm test builds it via backend pretest)');
  const reg = createRequire(import.meta.url)(distRegistry);
  const byCat = new Map();
  for (const c of reg.ADMIN_CONTROLS) {
    if (!byCat.has(c.category)) byCat.set(c.category, []);
    byCat.get(c.category).push(reg.toPublic(c));
  }
  const categories = [...byCat.entries()].map(([id, controls]) => ({
    id,
    label: reg.CATEGORY_META[id].label,
    description: reg.CATEGORY_META[id].description,
    controls
  }));
  return {
    success: true,
    data: {
      generatedAt: '2026-09-20T12:00:00.000Z',
      version: '0.12.10',
      release: 'v0.12.10',
      categories,
      counts: { total: reg.ADMIN_CONTROLS.length, byStatus: {}, byEffectiveStatus: {}, byRisk: {} }
    }
  };
}

// -----------------------------------------------------------------------------
// fetch stub
// -----------------------------------------------------------------------------

let requests = [];
let branchesNow = LEXICAL_BRANCHES;
function jsonResponse(status, body) {
  return {
    ok: status < 400,
    status,
    statusText: status < 400 ? 'OK' : 'Error',
    headers: { get: (h) => (h.toLowerCase() === 'content-type' ? 'application/json' : null) },
    json: async () => body,
    text: async () => JSON.stringify(body)
  };
}
function installFetch() {
  requests = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const method = (init.method || 'GET').toUpperCase();
    requests.push({ method, url, body: init.body ?? null });
    if (method === 'GET' && url === '/api/admin/git/branches-dev') return jsonResponse(200, branchesEnvelope(branchesNow));
    if (method === 'GET' && url === '/api/admin/controls') return jsonResponse(200, controlsEnvelope());
    if (method === 'POST' && url === '/api/admin/controls/pipeline-check-remote/run') {
      return jsonResponse(200, {
        success: true,
        data: {
          controlId: 'pipeline-check-remote',
          accepted: true,
          reason: 'ok',
          runStatus: 'success',
          requestId: 'test-req-1',
          exitCode: 0,
          stdoutTail: 'W3_RESULT=success',
          stderrTail: '',
          durationMs: 12,
          logFile: null
        }
      });
    }
    if (method !== 'GET') {
      return jsonResponse(500, { success: false, error: { code: 'UNEXPECTED_MUTATION', message: `unexpected ${method} ${url}` } });
    }
    return jsonResponse(404, { success: false, error: { code: 'NOT_FOUND', message: `no stub for ${url}` } });
  };
}

// -----------------------------------------------------------------------------
// Mount helpers
// -----------------------------------------------------------------------------

const settle = () => new Promise((r) => setTimeout(r, 30));
let root = null;
let queryClient = null;
let consoleErrors = [];
const originalConsoleError = console.error;

async function mount() {
  installFetch();
  consoleErrors = [];
  console.error = (...args) => { consoleErrors.push(args.map(String).join(' ')); };
  queryClient = new harness.QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: 0 } } });
  root = createRoot(dom.root);
  await act(async () => {
    root.render(harness.withProviders(React.createElement(harness.UnifiedReleaseWorkflow), queryClient));
  });
  for (let i = 0; i < 10; i += 1) {
    await act(async () => { await settle(); });
    if (trigger() && !textOf(trigger()).includes('Loading')) break;
  }
}
async function unmount() {
  if (root) await act(async () => { root.unmount(); });
  root = null;
  console.error = originalConsoleError;
}
const picker = () => query(dom.root, '#release-workflow-branch');
const trigger = () => (picker() ? query(picker(), '[role="combobox"]') : null);
const triggerLabel = () => (picker() ? query(picker(), '[data-darkselect-label]') : null);
const optionNodes = () => (picker() ? queryAll(picker(), '[role="option"]') : []);
const versionField = () => byTestId(dom.root, 'release-workflow-version');
const sharedBranch = () => textOf(byTestId(dom.root, 'shared-branch-probe'));

async function openMenu() {
  await act(async () => { fire(trigger(), 'click'); });
  assert.equal(trigger().getAttribute('aria-expanded'), 'true');
}
async function chooseOption(label) {
  await openMenu();
  const opt = optionNodes().find((o) => textOf(o) === label);
  assert.ok(opt, `option "${label}" present in open menu (have: ${optionNodes().map(textOf).join(', ')})`);
  await act(async () => { fire(opt, 'mousedown'); });
}

afterEach(async () => { await unmount(); branchesNow = LEXICAL_BRANCHES; });
after(() => { dom.uninstall(); });

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

test('default selection is the highest numeric version, not the first (lexically-sorted) server row', async () => {
  await mount();
  assert.equal(textOf(triggerLabel()), 'dev/v0.12.10');
  assert.equal(sharedBranch(), 'dev/v0.12.10', 'shared pipeline context receives the exact branch');
  assert.equal(textOf(versionField()), 'v0.12.10');
  assert.deepEqual(consoleErrors, []);
});

test('a refetch with new data does not overwrite the operator\'s existing valid selection', async () => {
  await mount();
  await chooseOption('dev/v0.12.2');
  assert.equal(textOf(triggerLabel()), 'dev/v0.12.2');
  assert.equal(textOf(versionField()), 'v0.12.2');

  // Simulate "Refresh": a newer branch appears and the list is refetched.
  branchesNow = WITH_LONG;
  const before = requests.filter((r) => r.url === '/api/admin/git/branches-dev').length;
  await act(async () => { await queryClient.invalidateQueries({ queryKey: ['admin', 'git', 'branches-dev'] }); });
  for (let i = 0; i < 10; i += 1) {
    await act(async () => { await settle(); });
    if (requests.filter((r) => r.url === '/api/admin/git/branches-dev').length > before) break;
  }
  await act(async () => { await settle(); });
  assert.ok(requests.filter((r) => r.url === '/api/admin/git/branches-dev').length > before, 'branches were refetched');
  assert.equal(textOf(triggerLabel()), 'dev/v0.12.2', 'selection preserved across refresh');
  assert.equal(sharedBranch(), 'dev/v0.12.2');
  // …but the new branch is offered in the menu, with its full text.
  await openMenu();
  assert.ok(optionNodes().some((o) => textOf(o) === 'dev/v1.100.100'));
  assert.deepEqual(consoleErrors, []);
});

test('selecting dev/v0.12.10 preserves the exact branch and derives v0.12.10 for the Version field and the Checkout step input', async () => {
  await mount();
  await chooseOption('dev/v0.12.9');
  assert.equal(textOf(versionField()), 'v0.12.9');
  await chooseOption('dev/v0.12.10');
  assert.equal(textOf(triggerLabel()), 'dev/v0.12.10');
  assert.equal(sharedBranch(), 'dev/v0.12.10');
  assert.equal(textOf(versionField()), 'v0.12.10');
  assert.equal(trigger().getAttribute('aria-expanded'), 'false', 'menu closes after selection');
  // Selected option is marked when the menu reopens.
  await openMenu();
  const selectedOpt = optionNodes().find((o) => o.getAttribute('aria-selected') === 'true');
  assert.equal(textOf(selectedOpt), 'dev/v0.12.10');
  await act(async () => { fire(trigger(), 'keydown', { key: 'Escape' }); });

  // Step 1 (Check Remote) is the only ungated step; run it so Step 2 renders
  // its ControlCard and we can read the seeded `branch` input.
  const runButtons = queryAll(dom.root, 'button').filter((b) => textOf(b).trim() === 'Run');
  assert.ok(runButtons.length >= 1, 'Step 1 exposes a Run button');
  await act(async () => { fire(runButtons[0], 'click'); });
  for (let i = 0; i < 10; i += 1) {
    await act(async () => { await settle(); });
    if (queryAll(dom.root, 'input').some((inp) => inp.value === 'dev/v0.12.10')) break;
  }
  assert.ok(requests.some((r) => r.method === 'POST' && r.url === '/api/admin/controls/pipeline-check-remote/run'));
  const branchInput = queryAll(dom.root, 'input').find((inp) => inp.value === 'dev/v0.12.10');
  assert.ok(branchInput, 'Checkout step branch input is pre-filled with the exact selected branch');
  assert.deepEqual(consoleErrors, []);
});

async function runStepOneMocked() {
  // Step 1 (Check Remote) is the only ungated step. Its run is served by the
  // fetch stub above (mocked execution only — no real release operation).
  const runButtons = queryAll(dom.root, 'button').filter((b) => textOf(b).trim() === 'Run');
  assert.ok(runButtons.length >= 1, 'Step 1 exposes a Run button');
  await act(async () => { fire(runButtons[0], 'click'); });
  for (let i = 0; i < 10; i += 1) {
    await act(async () => { await settle(); });
    if (queryAll(dom.root, 'input').length > 0) break;
  }
  assert.ok(requests.some((r) => r.method === 'POST' && r.url === '/api/admin/controls/pipeline-check-remote/run'));
  assert.equal(requests.filter((r) => r.method === 'POST').length, 1, 'only the mocked step-1 run was posted');
}

test('a zero-padded selection keeps the exact branch name and derives the exact version / tag / workflow inputs', async () => {
  branchesNow = ZERO_PADDED;
  await mount();
  // Default is still by NUMERIC ordering: 01.002.003 (= 1.2.3) outranks 1.00.00
  // (= 1.0.0) — but the text shown is the exact identifier, not v1.2.3.
  assert.equal(textOf(triggerLabel()), 'dev/v01.002.003');
  assert.equal(textOf(versionField()), 'v01.002.003', 'default derives exact text, not v1.2.3');
  assert.ok(!textOf(dom.root).includes('v1.2.3'));

  await chooseOption('dev/v1.00.00');
  assert.equal(textOf(triggerLabel()), 'dev/v1.00.00', 'branch name preserved digit for digit');
  assert.equal(sharedBranch(), 'dev/v1.00.00', 'shared pipeline context carries the exact branch');
  assert.equal(textOf(versionField()), 'v1.00.00', 'Version field is the exact identifier, not v1.0.0');
  assert.ok(!textOf(dom.root).includes('v1.0.0'), 'no numerically-reconstructed version anywhere in the UI');

  await runStepOneMocked();
  // Step 2 (Checkout) is now rendered; its `branch` input is seeded exactly.
  const inputs = queryAll(dom.root, 'input');
  assert.ok(inputs.some((inp) => inp.value === 'dev/v1.00.00'), 'Checkout step branch input seeded with the exact branch');
  assert.ok(!inputs.some((inp) => ['dev/v1.0.0', 'v1.0.0', '1.0.0'].includes(inp.value)), 'no rewritten identifier in any workflow input');
  assert.deepEqual(consoleErrors, []);
});

test('picker is in fit-to-options mode with full option text and supplementary tooltips; keyboard selection still works', async () => {
  branchesNow = WITH_LONG;
  await mount();
  assert.equal(picker().getAttribute('data-fit-options'), 'true');
  assert.equal(trigger().getAttribute('title'), textOf(triggerLabel()), 'trigger tooltip mirrors the visible label');
  assert.equal(trigger().getAttribute('aria-label'), 'Dev branch');
  await openMenu();
  const labels = optionNodes().map(textOf);
  assert.deepEqual(labels, ['dev/v1.100.100', 'dev/v0.12.9', 'dev/v0.12.2', 'dev/v0.12.10'], 'full option value/text rendered, server order preserved in the list');
  for (const o of optionNodes()) assert.equal(o.getAttribute('title'), textOf(o));
  // The invisible sizer carries the longest text the trigger can ever show
  // (placeholder or any option label) so the closed trigger reserves that width.
  const sizer = queryAll(trigger(), 'span').find((s) => s.getAttribute('aria-hidden') === 'true');
  assert.ok(sizer, 'sizer span present');
  const longest = ['Select a dev branch', ...labels].reduce((acc, l) => (l.length > acc.length ? l : acc), '');
  assert.equal(textOf(sizer), longest);
  assert.ok(textOf(sizer).length >= 'dev/v1.100.100'.length);

  // Keyboard: ArrowDown moves the active row; Enter commits.
  await act(async () => { fire(trigger(), 'keydown', { key: 'Escape' }); });
  await act(async () => { fire(trigger(), 'keydown', { key: 'ArrowDown' }); });
  assert.equal(trigger().getAttribute('aria-expanded'), 'true');
  await act(async () => { fire(trigger(), 'keydown', { key: 'End' }); });
  await act(async () => { fire(trigger(), 'keydown', { key: 'Enter' }); });
  assert.equal(textOf(triggerLabel()), 'dev/v0.12.10');
  assert.equal(sharedBranch(), 'dev/v0.12.10');
  assert.equal(textOf(versionField()), 'v0.12.10');
  assert.deepEqual(consoleErrors, []);
});

test('existing default-mode DarkSelect call-sites are untouched: no fit attribute, label truncation class retained', async () => {
  root = createRoot(dom.root);
  await act(async () => {
    root.render(
      React.createElement(harness.DarkSelect, {
        id: 'plain-select',
        value: 'a',
        onChange: () => {},
        options: [{ value: 'a', label: 'Alpha' }, { value: 'b', label: 'Beta' }]
      })
    );
  });
  const plain = query(dom.root, '#plain-select');
  assert.equal(plain.getAttribute('data-fit-options'), null);
  assert.equal(plain.style.width, '', 'no max-content sizing in default mode');
  const label = query(plain, '[data-darkselect-label]');
  assert.ok(label.getAttribute('class').includes('truncate'));
  assert.equal(query(plain, '[role="combobox"]').getAttribute('title'), null);
});
