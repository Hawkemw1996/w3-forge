// =============================================================================
// W3 Core v0.12.10 — Admin Controls UI section map regression tests
// =============================================================================
//
// Proves that every control id registered in the backend Admin Control
// Registry has an EXPLICIT entry in frontend/admin/src/pages/controls/
// uiSections.ts (no fallback, no console warning), and that a genuinely
// unknown id still reaches the diagnostic fallback (developer-tools + warn).
//
// The registry ids are read from backend/src/admin/controls/registry.ts and,
// when the backend has been compiled (root `npm test` runs the backend
// pretest build first), cross-checked against the real
// backend/dist/admin/controls/registry.js ADMIN_CONTROLS export so the
// source-text parse cannot drift from runtime truth.
//
// Run: node --test frontend/admin/tests/   (also part of root `npm test`)
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { consoleConfiguration } from './helpers/consoleConfiguration.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const registrySource = path.join(repoRoot, 'backend', 'src', 'console', 'controls', 'registry.ts');
const registryDist = path.join(repoRoot, 'backend', 'dist', 'console', 'controls', 'registry.js');

// --- load the frontend module under test (TS -> ESM in memory) --------------
const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom' });
const config = await vite.ssrLoadModule('/src/lib/appConfiguration.ts');
config.setAdminConfiguration(consoleConfiguration('w3forge'));
const ui = await vite.ssrLoadModule('/src/pages/controls/uiSections.ts');
test.after(() => vite.close());

// --- registry ids from source text -----------------------------------------
// Control entries are the 4-space-indented `id: '...'` lines inside
// ADMIN_CONTROLS; nested inputSchema/confirmationSchema field ids are
// indented deeper and are not control ids.
function registryIdsFromSource() {
  const src = readFileSync(registrySource, 'utf8');
  const ids = [];
  for (const m of src.matchAll(/^ {4}id: (?:appText\()?['"]([a-z0-9-]+)['"]\)?,$/gm)) ids.push(m[1].replaceAll('w3books', 'w3forge'));
  return ids;
}

function registryFromDist() {
  assert.ok(existsSync(registryDist), 'Build the backend before running integration tests.');
  const require = createRequire(import.meta.url);
  const mod = require(registryDist);
  return mod.ADMIN_CONTROLS.map((c) => ({
    id: c.id,
    category: c.category,
    riskLevel: c.riskLevel,
    runStrategy: c.runStrategy,
    status: c.status,
    enabled: c.enabled
  }));
}

const PIPELINE_IDS_FROM_TASK = [
  'pipeline-check-remote',
  'pipeline-fetch-tags',
  'pipeline-pull-latest',
  'pipeline-checkout-dev',
  'pipeline-push-dev',
  'pipeline-test-dev',
  'pipeline-package-dev',
  'pipeline-verify-dev-pkg',
  'pipeline-deploy-dev',
  'pipeline-rollback',
  'pipeline-reset-tree',
  'pipeline-create-tag',
  'pipeline-delete-tag',
  'pipeline-promote-dev-to-main'
];

function captureWarnings(fn) {
  const calls = [];
  const original = console.warn;
  console.warn = (...args) => { calls.push(args.map(String).join(' ')); };
  try {
    return { result: fn(), warnings: calls };
  } finally {
    console.warn = original;
  }
}

test('registry source parse finds the current control set (16 legacy + 14 pipeline; W3 BuildCost removed hardreset-data, cleanup-list, cleanup-legacy) and matches compiled registry when available', () => {
  const ids = registryIdsFromSource();
  assert.ok(ids.length >= 30, `expected at least 30 control ids, found ${ids.length}`);
  assert.equal(new Set(ids).size, ids.length, 'control ids are unique');
  for (const id of PIPELINE_IDS_FROM_TASK) assert.ok(ids.includes(id), `registry contains ${id}`);
  const dist = registryFromDist();
  if (dist) {
    assert.deepEqual(dist.map((c) => c.id), ids, 'source-text ids equal compiled ADMIN_CONTROLS ids, in order');
  }
});

test('every registered backend control id has an explicit UI section mapping — no fallback, no warning', () => {
  const ids = registryIdsFromSource();
  const validSections = new Set(ui.UI_SECTIONS.map((s) => s.id));
  const { warnings } = captureWarnings(() => {
    for (const id of ids) {
      assert.equal(ui.hasExplicitUiSection(id), true, `explicit mapping for ${id}`);
      const section = ui.controlsUiSectionFor(id);
      assert.ok(validSections.has(section), `${id} maps to a real section (${section})`);
    }
  });
  assert.deepEqual(warnings, [], 'mapping registered ids must not emit console warnings');
});

test('pipeline controls are categorized: forward steps in Release Center, destructive actions in Recovery Center', () => {
  const release = [
    'pipeline-check-remote', 'pipeline-fetch-tags', 'pipeline-pull-latest', 'pipeline-checkout-dev',
    'pipeline-push-dev', 'pipeline-test-dev', 'pipeline-package-dev', 'pipeline-verify-dev-pkg',
    'pipeline-deploy-dev', 'pipeline-create-tag', 'pipeline-promote-dev-to-main'
  ];
  const recovery = ['pipeline-rollback', 'pipeline-reset-tree', 'pipeline-delete-tag'];
  for (const id of release) assert.equal(ui.controlsUiSectionFor(id), 'release-center', id);
  for (const id of recovery) assert.equal(ui.controlsUiSectionFor(id), 'recovery-center', id);
  // Pre-existing mappings are untouched.
  assert.equal(ui.controlsUiSectionFor('restore-w3forge'), 'recovery-center');
  assert.equal(ui.controlsUiSectionFor('deploy-w3forge'), 'release-center');
  assert.equal(ui.controlsUiSectionFor('status-w3forge'), 'main-controls');
  assert.equal(ui.controlsUiSectionFor('backup-create'), 'backup-center');
  assert.equal(ui.controlsUiSectionFor('cleanup-legacy'), 'maintenance-center');
  assert.equal(ui.controlsUiSectionFor('hardreset-data'), 'developer-tools');
});

test('destructive pipeline controls really are the HIGH-risk ones in the compiled registry', () => {
  const byId = new Map(registryFromDist().map((c) => [c.id, c]));
  for (const id of ['pipeline-rollback', 'pipeline-reset-tree', 'pipeline-delete-tag']) {
    assert.equal(byId.get(id).riskLevel, 'HIGH', `${id} is HIGH risk`);
    assert.equal(byId.get(id).runStrategy, 'safe-pipeline');
  }
  for (const id of PIPELINE_IDS_FROM_TASK) {
    assert.equal(byId.get(id).category, 'packages-deploy', `${id} backend category is preserved on the control`);
  }
});

test('an unknown id still hits the diagnostic fallback: developer-tools + one console warning naming the id', () => {
  const { result, warnings } = captureWarnings(() => ui.controlsUiSectionFor('pipeline-not-a-real-control'));
  assert.equal(result, 'developer-tools');
  assert.equal(result, ui.UNMAPPED_CONTROL_FALLBACK_SECTION);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Unmapped control id "pipeline-not-a-real-control"/);
  assert.match(warnings[0], /developer-tools/);
  assert.equal(ui.hasExplicitUiSection('pipeline-not-a-real-control'), false, 'pipeline-* prefix alone is not treated as known');
  // Prototype keys are not "explicit mappings".
  assert.equal(ui.hasExplicitUiSection('toString'), false);
  assert.equal(ui.hasExplicitUiSection('constructor'), false);
  const proto = captureWarnings(() => ui.controlsUiSectionFor('constructor'));
  assert.equal(proto.result, 'developer-tools');
  assert.equal(proto.warnings.length, 1);
});

test('buildUiSections / partitionUiSections place pipeline controls without warnings and keep backend properties on each control', () => {
  const ids = registryIdsFromSource();
  const flat = ids.map((id, i) => ({
    id,
    label: id,
    category: 'packages-deploy',
    riskLevel: id.startsWith('pipeline-') ? 'HIGH' : 'LOW',
    runStrategy: 'safe-pipeline',
    status: 'UI_READY',
    enabled: true,
    effectiveStatus: i % 7 === 0 ? 'TERMINAL_ONLY' : 'UI_READY'
  }));
  const { result, warnings } = captureWarnings(() => ui.partitionUiSections(flat));
  assert.deepEqual(warnings, []);
  const placed = result.visibleSections.flatMap((s) => s.controls).concat(result.hiddenControls);
  assert.equal(placed.length, flat.length, 'every control is placed exactly once');
  for (const c of placed) {
    assert.equal(c.category, 'packages-deploy', 'backend category untouched');
    assert.ok(['HIGH', 'LOW'].includes(c.riskLevel));
  }
  const recovery = result.visibleSections.find((s) => s.meta.id === 'recovery-center');
  assert.ok(recovery, 'Recovery Center is visible once it holds UI_READY pipeline actions');
  const recoveryIds = recovery.controls.map((c) => c.id);
  for (const id of ['pipeline-rollback', 'pipeline-reset-tree', 'pipeline-delete-tag']) {
    if (flat.find((c) => c.id === id).effectiveStatus === 'UI_READY') assert.ok(recoveryIds.includes(id), id);
    else assert.equal(result.hiddenControlSections[id], 'recovery-center');
  }
  for (const [id, section] of Object.entries(result.hiddenControlSections)) {
    assert.equal(ui.hasExplicitUiSection(id), true, `hidden ${id} explicitly mapped to ${section}`);
  }
});
