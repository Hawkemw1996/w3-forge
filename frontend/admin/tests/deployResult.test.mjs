import test, { before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildHarness } from './helpers/buildHarness.mjs';
import { installMiniDom, fire, textOf, queryAll } from './helpers/miniDom.mjs';
import { consoleConfiguration } from './helpers/consoleConfiguration.mjs';

const dom = installMiniDom();
const React = (await import('react')).default;
const { createRoot } = await import('react-dom/client');
const { act } = React;
let harness, root;
before(async () => {
  harness = await buildHarness('pipelineOverridesHarness', {
    appRoot: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
    // Older compatibility path plus the separate current durable-result suite.
    configuration: { ...consoleConfiguration('w3forge'), durableOperations: false }
  });
});
const originalFetch = globalThis.fetch;
const originalTimeout = window.setTimeout;
const originalNow = Date.now;
const settle = () => new Promise(resolve => setTimeout(resolve, 20));
const json = data => ({ ok: true, status: 200, json: async () => ({ success: true, data }) });
const control = {
  id: 'pipeline-deploy-dev', label: 'Deploy Dev Package', description: 'Deploy fixture',
  enabled: true, status: 'UI_READY', effectiveStatus: 'UI_READY', riskLevel: 'HIGH',
  runStrategy: 'safe-pipeline', restartsService: true, readOnly: false,
  requiresInputs: false, requiresConfirmation: false, timeoutSeconds: 1800,
  interactivePromptsToday: [], allowedRoles: ['admin'], notes: ''
};
const interrupted = {
  controlId: control.id, accepted: true, runStatus: 'failed', exitCode: -1,
  requestId: 'req_current', reason: 'Command failed: deploy wrapper', stdoutTail: 'delegate launched'
};
const installed = {
  version: '0.3.3', requestId: 'req_current', deployedAt: '2026-10-04T23:10:00Z',
  packagePath: '/opt/w3forge-update-packages/installed/v0.3.3/w3forge.tar.gz', logPath: '/opt/logs/w3forge/deploy.log'
};
const runButton = () => queryAll(dom.root, 'button').find(n => textOf(n).trim() === 'Run');

async function mount(options = {}) {
  const state = {
    posts: 0, successes: [], probes: [], baseline: { ...installed, requestId: 'req_old', deployedAt: '2026-10-03T23:10:00Z' },
    record: installed, version: '0.3.3', health: 'ok', reply: interrupted, ...options
  };
  window.setTimeout = (fn, ms) => originalTimeout(fn, ms === 2000 ? 10 : ms);
  globalThis.fetch = async (url, init = {}) => {
    if (init.method === 'POST') {
      state.posts++;
      if (state.disconnect) throw new TypeError('Failed to fetch');
      if (state.httpError) return { ok: false, status: state.httpError, statusText: 'Unavailable', json: async () => ({ success: false }) };
      return json(state.reply);
    }
    state.probes.push({ url, init });
    if (url === '/version') return json({ version: state.version });
    if (url === '/health') return json({ status: state.health });
    if (url.startsWith('/api/admin/packages/installed/')) {
      const data = state.posts ? state.record : state.baseline;
      if (data === 'unavailable') throw new TypeError('Failed to fetch');
      if (data === null) return { ok: false, status: 404, json: async () => ({ success: false }) };
      return json(data);
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  root = createRoot(dom.root);
  await act(async () => {
    root.render(React.createElement(harness.ControlCard, {
      control: { ...control, ...state.control },
      extraInputs: state.inputs ?? { version: 'v0.3.3', packageName: 'w3forge.tar.gz' },
      onRunSuccess: value => state.successes.push(value)
    }));
  });
  await act(async () => { fire(runButton(), 'click'); await settle(); });
  return state;
}
async function poll() { await act(async () => { await settle(); }); }
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  root = undefined;
  globalThis.fetch = originalFetch;
  window.setTimeout = originalTimeout;
  Date.now = originalNow;
});
after(() => dom.uninstall());

test('a returned exit -1 is reconciled with this deployment record, health and selected version', async () => {
  const state = await mount();
  await poll();
  assert.equal(state.successes.length, 1, 'notify the workflow after confirming deployment');
  assert.match(textOf(dom.root), /Success/);
  assert.doesNotMatch(textOf(dom.root), /Command failed|exit -1/);
  assert.equal(state.successes[0].requestId, 'req_current');
  assert.equal(state.posts, 1, 'never repeat the deploy POST');
  for (const probe of state.probes.filter(p => p.url.includes('/installed/'))) {
    assert.equal(probe.init.cache, 'no-store');
    assert.equal(probe.init.credentials, 'same-origin');
    assert.ok(probe.init.signal);
  }
});

test('a detached launch waits for its own installed record, including a same-version redeploy', async () => {
  const state = await mount({
    reply: { ...interrupted, runStatus: 'success', exitCode: 0, structured: { status: 'success', runStatus: 'launched-detached' } },
    record: { ...installed, requestId: 'req_old' }
  });
  assert.match(textOf(dom.root), /Checking deployment/);
  assert.equal(runButton().disabled, true);
  assert.equal(state.successes.length, 0, 'launch acceptance and the old healthy instance are not completion');
  state.record = installed;
  await poll();
  assert.equal(state.successes.length, 1);
  await poll();
  assert.equal(state.successes.length, 1, 'completion callback fires once');
  assert.equal(state.posts, 1);
});

for (const [label, options] of [
  ['old runtime', { version: '0.12.13' }],
  ['missing version response', { version: undefined }],
  ['unhealthy service', { health: 'degraded' }],
  ['missing installed record', { record: null }],
  ['unreadable installed record', { record: 'unavailable' }],
  ['different request', { record: { ...installed, requestId: 'req_other' } }],
  ['different recorded version', { record: { ...installed, version: '0.12.13' } }],
  ['partial metadata', { record: { ...installed, deployedAt: null } }],
  ['missing archive', { record: { ...installed, packagePath: null } }],
  ['unknown selected version', { inputs: { packageName: 'w3forge.tar.gz' } }]
]) {
  test(`${label} cannot turn an interrupted reply into Success`, async () => {
    const state = await mount(options);
    await poll();
    assert.equal(state.successes.length, 0);
    assert.match(textOf(dom.root), /Checking deployment/);
    assert.equal(state.posts, 1);
  });
}

for (const reply of [
  { ...interrupted, exitCode: 1 },
  { ...interrupted, structured: { status: 'failed' } },
  { ...interrupted, structured: { status: 'blocked' } },
  { ...interrupted, structured: { status: 'success', delegate_exit_code: 2 } },
  { ...interrupted, accepted: false, runStatus: 'blocked' }
]) {
  test(`a real failure or refusal remains final (${JSON.stringify(reply.structured ?? reply.runStatus)}, ${reply.exitCode}, ${reply.accepted})`, async () => {
    const state = await mount({ reply });
    assert.equal(state.successes.length, 0);
    assert.doesNotMatch(textOf(dom.root), /Checking deployment/);
    assert.match(textOf(dom.root), /Command failed/);
  });
}

test('an exit -1 from another control keeps its ordinary error', async () => {
  const state = await mount({ control: { id: 'pipeline-package-dev', restartsService: false }, reply: { ...interrupted, controlId: 'pipeline-package-dev' } });
  assert.match(textOf(dom.root), /Failed/);
  assert.equal(state.successes.length, 0);
  assert.equal(state.probes.length, 0);
});

test('a lost reply needs a fresh installed record, never the previous healthy install', async () => {
  const old = { ...installed, requestId: 'req_old', deployedAt: '2026-10-03T23:10:00Z' };
  const state = await mount({ disconnect: true, baseline: old, record: old });
  await poll();
  assert.equal(state.successes.length, 0);
  state.record = installed;
  await poll();
  assert.equal(state.successes.length, 1);
  assert.equal(state.posts, 1);
});

test('a first install after a lost reply can confirm from a known missing baseline', async () => {
  const state = await mount({ disconnect: true, baseline: null });
  await poll();
  assert.equal(state.successes.length, 1);
});

test('a lost reply with an unreadable baseline cannot use existing metadata to claim success', async () => {
  const state = await mount({ disconnect: true, baseline: 'unavailable' });
  await poll();
  assert.equal(state.successes.length, 0);
});

test('the returned request ID confirms even if the baseline read was unavailable', async () => {
  const state = await mount({ baseline: 'unavailable' });
  await poll();
  assert.equal(state.successes.length, 1);
});

test('a restart gateway error enters confirmation, but authentication errors do not', async () => {
  const state = await mount({ httpError: 502 });
  await poll();
  assert.equal(state.successes.length, 1);
  assert.equal(state.posts, 1);
});
test('an authentication error remains an error', async () => {
  const state = await mount({ httpError: 401 });
  assert.equal(state.successes.length, 0);
  assert.match(textOf(dom.root), /HTTP 401/);
  assert.doesNotMatch(textOf(dom.root), /Checking deployment/);
});

test('a legacy package basename supplies the selected version', async () => {
  const state = await mount({ inputs: { packageName: 'w3forge-v0.3.3.tar.gz' } });
  await poll();
  assert.equal(state.successes.length, 1);
  assert.ok(state.probes.some(p => p.url === '/api/admin/packages/installed/0.3.3'));
});

test('confirmation timeout is unconfirmed and Check again only reads status', async () => {
  const state = await mount({ record: null });
  Date.now = () => originalNow() + 13 * 60 * 1000;
  await poll();
  assert.match(textOf(dom.root), /Deployment result unconfirmed/);
  assert.doesNotMatch(textOf(dom.root), /Failed|exit -1|launched successfully/);
  assert.equal(state.successes.length, 0);
  assert.equal(runButton().disabled, true);
  state.record = installed;
  await act(async () => {
    fire(queryAll(dom.root, 'button').find(n => textOf(n) === 'Check again'), 'click');
    await settle();
  });
  await poll();
  assert.equal(state.posts, 1);
  assert.equal(state.successes.length, 1);
});

test('repeated clicks while checking never submit another deployment', async () => {
  const state = await mount({ record: null });
  await act(async () => { fire(runButton(), 'click'); fire(runButton(), 'click'); await settle(); });
  assert.equal(state.posts, 1);
});

test('unmount stops polling without completing the workflow', async () => {
  const state = await mount({ record: null });
  await act(async () => root.unmount());
  root = undefined;
  const count = state.probes.length;
  state.record = installed;
  await poll();
  assert.equal(state.probes.length, count);
  assert.equal(state.successes.length, 0);
});
