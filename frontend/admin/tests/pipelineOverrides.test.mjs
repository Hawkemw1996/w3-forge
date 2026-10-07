// Render the real controls; all network execution is stubbed and no release action runs.
// Registry tests cover the public schema; these narrow fixtures exercise its UI contract.
import test, { before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildHarness } from './helpers/buildHarness.mjs';
import { installMiniDom, fire, textOf, query, queryAll } from './helpers/miniDom.mjs';

const adminRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dom = installMiniDom();
// Supply the native input capabilities needed by React's real change-event plugin.
// Keep these additions local to this test process, without changing the shared shim.
dom.document.oninput = null;
const elementPrototype = Object.getPrototypeOf(dom.document.createElement('input'));
Object.defineProperty(elementPrototype, 'type', {
  configurable: true,
  get() { return this.getAttribute('type') ?? 'text'; }
});
const React = (await import('react')).default;
const { createRoot } = await import('react-dom/client');
const { act } = React;
let harness;
before(async () => { harness = await buildHarness('pipelineOverridesHarness', { appRoot: adminRoot }); });

function control(id, fields = [], phrase) {
  return {
    id, label: id, description: 'Pipeline regression fixture', category: 'packages-deploy',
    scriptName: `${id}.sh`, scriptSourcePath: `scripts/${id}.sh`, expectedInstalledPath: `/opt/w3forge-scripts/${id}.sh`,
    riskLevel: phrase ? 'HIGH' : 'MEDIUM', status: 'UI_READY', effectiveStatus: 'UI_READY', enabled: true,
    runStrategy: 'safe-pipeline', readOnly: false, writesToDisk: true, touchesDatabase: false,
    restartsService: false, destructive: false, requiresPreBackup: false,
    requiresInputs: fields.length > 0, inputSchema: fields.length ? { fields } : null,
    requiresConfirmation: Boolean(phrase),
    confirmationSchema: phrase ? {
      checkboxes: [{ key: 'confirmAction', label: 'I understand this action writes a release artifact.', mustBeTrue: true }],
      typedPhrases: [{ key: 'typedAction', label: `Type ${phrase}`, expected: phrase }]
    } : null,
    interactivePromptsToday: [], nonInteractiveToday: true, timeoutSeconds: 120,
    allowedRoles: ['admin'], logCategory: 'pipeline', notes: ''
  };
}
const target = (key) => ({ key, label: key, type: 'text', required: true });
const option = (key) => ({
  key, label: key === 'force' ? 'Replace the existing package' : 'Allow local changes in the deploy checkout',
  description: 'Existing safety checks still apply.', type: 'checkbox', required: false, mustBeTrue: false
});
const PACKAGE = control('pipeline-package-dev', [target('tag'), option('force')], 'PACKAGE');
const PROMOTE = control('pipeline-promote-dev-to-main', [target('version'), option('force')], 'PROMOTE');
const PULL = control('pipeline-pull-latest', [option('allowDirty')]);
const CHECK = control('pipeline-check-remote');
const CHECKOUT = control('pipeline-checkout-dev', [target('branch')]);
const TEST = control('pipeline-test-dev');
const CONTROLS = [CHECK, CHECKOUT, TEST, PACKAGE, PROMOTE, PULL];
const BRANCHES = ['dev/v0.3.3', 'dev/v0.3.2'];

let root;
let queryClient;
let requests = [];
let nextRunStatus = 'success';
let consoleErrors = [];
const originalFetch = globalThis.fetch;
const originalConsoleError = console.error;
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
const json = (data) => ({ ok: true, status: 200, json: async () => ({ success: true, data }) });

function installFetch() {
  requests = [];
  nextRunStatus = 'success';
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const method = init.method ?? 'GET';
    if (method === 'POST') {
      requests.push({ url, body: JSON.parse(init.body) });
      assert.match(url, /^\/api\/admin\/controls\/pipeline-[a-z-]+\/run$/);
      return json({ controlId: url.split('/')[4], accepted: true, reason: 'Mocked execution only', runStatus: nextRunStatus });
    }
    if (url === '/api/admin/git/branches-dev') {
      return json({ ok: true, branches: BRANCHES.map((name) => ({ name, sha: 'a'.repeat(40) })), count: 2, status: 'list_ok' });
    }
    if (url === '/api/admin/controls') {
      return json({ categories: [{ id: 'packages-deploy', controls: CONTROLS }] });
    }
    if (url === '/api/admin/packages/staged-dev') return json({ packages: [] });
    throw new Error(`Unexpected request: ${method} ${url}`);
  };
}

async function mount(props) {
  installFetch();
  consoleErrors = [];
  console.error = (...args) => { consoleErrors.push(args.map(String).join(' ')); };
  root = createRoot(dom.root);
  await renderCard(props);
}
async function renderCard(props) {
  await act(async () => { root.render(React.createElement(harness.ControlCard, props)); });
}
const runButton = (scope = dom.root) => queryAll(scope, 'button').find((node) => textOf(node).trim() === 'Run');
const inputOption = (scope = dom.root) => queryAll(scope, 'input[type="checkbox"]').find((node) => textOf(node.parentElement).includes('(optional)'));
const confirmation = (scope = dom.root) => queryAll(scope, 'input[type="checkbox"]').find((node) => !textOf(node.parentElement).includes('(optional)'));
const textInput = (scope = dom.root) => queryAll(scope, 'input[type="text"]').find((node) => !node.getAttribute('placeholder'));
const cardFor = (id) => queryAll(dom.root, '.card').find((node) => queryAll(node, 'span').some((span) => span.getAttribute('title')?.startsWith(`${id} · `)));

async function setChecked(node, checked) {
  assert.ok(node, 'checkbox rendered');
  await act(async () => {
    node.checked = checked;
    fire(node, 'click');
  });
  assert.equal(node.checked, checked, 'React committed the requested checkbox state');
}
async function type(node, value) {
  assert.ok(node, 'text input rendered');
  await act(async () => {
    // Native typing changes the DOM before the event; bypass React's value tracker.
    Object.getOwnPropertyDescriptor(elementPrototype, 'value').set.call(node, value);
    fire(node, 'input');
  });
  assert.equal(node.value, value);
}
async function confirm(scope = dom.root) {
  const checkbox = confirmation(scope);
  if (checkbox) await setChecked(checkbox, true);
  for (const node of queryAll(scope, 'input[type="text"]')) {
    const phrase = node.getAttribute('placeholder');
    if (phrase) await type(node, phrase);
  }
}
async function run(scope = dom.root) {
  const button = runButton(scope);
  assert.ok(button, 'Run rendered');
  assert.equal(button.disabled, false, 'Run enabled');
  const count = requests.length;
  await act(async () => { fire(button, 'click'); await settle(); });
  assert.equal(requests.length, count + 1, 'one mocked run posted');
  return requests.at(-1).body;
}

afterEach(async () => {
  if (root) await act(async () => { root.unmount(); });
  root = undefined;
  queryClient?.clear();
  queryClient = undefined;
  console.error = originalConsoleError;
  globalThis.fetch = originalFetch;
  assert.deepEqual(consoleErrors, [], 'no React errors');
});
after(() => { delete elementPrototype.type; dom.uninstall(); });

for (const [entry, seed, key] of [
  [PACKAGE, { tag: 'v0.3.3' }, 'force'],
  [PROMOTE, { version: 'v0.3.3' }, 'force'],
  [PULL, undefined, 'allowDirty']
]) {
  test(`${entry.id}: optional checkbox sends booleans, stays optional, and resets after each run`, async () => {
    await mount({ control: entry, initialInputs: seed });
    assert.equal(inputOption().checked, false, 'override starts off');
    await confirm();
    assert.equal((await run()).inputs[key], false, 'unchecked optional input does not block Run');
    await setChecked(inputOption(), true);
    const enabledPayload = await run();
    assert.equal(enabledPayload.inputs[key], true, 'checked override is boolean true');
    assert.equal(key in enabledPayload.confirmations, false, 'override is separate from mandatory confirmations');
    assert.equal(inputOption().checked, false, 'override resets after a run');
    await setChecked(inputOption(), true);
    await setChecked(inputOption(), false);
    assert.equal((await run()).inputs[key], false, 'manually unchecked override is boolean false');
  });
}

test('an override never bypasses the required confirmation checkbox or typed phrase', async () => {
  await mount({ control: PACKAGE, initialInputs: { tag: 'v0.3.3' } });
  await setChecked(inputOption(), true);
  assert.equal(runButton().disabled, true);
  await setChecked(confirmation(), true);
  assert.equal(runButton().disabled, true, 'typed phrase is still required');
  await type(query(dom.root, 'input[placeholder="PACKAGE"]'), 'WRONG');
  assert.equal(runButton().disabled, true, 'incorrect phrase is rejected');
  await type(query(dom.root, 'input[placeholder="PACKAGE"]'), 'PACKAGE');
  await setChecked(confirmation(), false);
  assert.equal(runButton().disabled, true, 'correct phrase cannot replace the required checkbox');
  await act(async () => { fire(runButton(), 'click'); });
  assert.equal(requests.length, 0, 'blocked button sent no mutation');
  await setChecked(confirmation(), true);
  const payload = await run();
  assert.deepEqual(payload, {
    inputs: { tag: 'v0.3.3', force: true },
    confirmations: { confirmAction: true, typedAction: 'PACKAGE' }
  });
});

test('editing the version, replacing parent target inputs, and a failed run each clear the override', async () => {
  const props = { control: PACKAGE, initialInputs: { tag: 'v0.3.3' } };
  await mount(props);
  await confirm();
  await setChecked(inputOption(), true);
  await type(textInput(), 'v0.3.4');
  assert.equal(inputOption().checked, false, 'manual target edit clears the override');
  assert.deepEqual((await run()).inputs, { tag: 'v0.3.4', force: false });
  await setChecked(inputOption(), true);
  await renderCard({ ...props, initialInputs: { tag: 'v0.3.5' } });
  assert.equal(inputOption().checked, false, 'new parent target clears consent even if local text was edited');
  await setChecked(inputOption(), true);
  nextRunStatus = 'failed';
  assert.equal((await run()).inputs.force, true);
  assert.equal(inputOption().checked, false, 'failure requires explicit re-selection for a retry');
  assert.equal((await run()).inputs.force, false);
});

test('controls without an override expose no checkbox and receive no override payload', async () => {
  await mount({ control: PACKAGE, initialInputs: { tag: 'v0.3.3' } });
  await setChecked(inputOption(), true);
  await renderCard({ control: TEST });
  assert.equal(queryAll(dom.root, 'input[type="checkbox"]').length, 0);
  assert.deepEqual(await run(), { inputs: {}, confirmations: {} });
});

test('changing the guided workflow branch resets both package and secondary pull overrides', async () => {
  installFetch();
  consoleErrors = [];
  console.error = (...args) => { consoleErrors.push(args.map(String).join(' ')); };
  queryClient = new harness.QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: 0 } } });
  root = createRoot(dom.root);
  await act(async () => {
    root.render(harness.withProviders(React.createElement(harness.UnifiedReleaseWorkflow), queryClient));
  });
  for (let i = 0; i < 10 && !cardFor(CHECK.id); i += 1) await act(async () => { await settle(); });
  await run(cardFor(CHECK.id));
  await run(cardFor(CHECKOUT.id));
  await run(cardFor(TEST.id));
  const secondary = queryAll(dom.root, 'button').find((node) => textOf(node).includes(`Secondary: ${PULL.label}`));
  assert.ok(secondary);
  await act(async () => { fire(secondary, 'click'); });
  await setChecked(inputOption(cardFor(PULL.id)), true);
  await setChecked(inputOption(cardFor(PACKAGE.id)), true);
  await confirm(cardFor(PACKAGE.id));

  const picker = query(dom.root, '#release-workflow-branch');
  await act(async () => { fire(query(picker, '[role="combobox"]'), 'click'); });
  const branchOption = queryAll(picker, '[role="option"]').find((node) => textOf(node) === BRANCHES[1]);
  assert.ok(branchOption);
  await act(async () => { fire(branchOption, 'mousedown'); });
  assert.equal(textInput(cardFor(PACKAGE.id)).value, 'v0.3.2', 'package target follows selected branch');
  assert.equal(inputOption(cardFor(PACKAGE.id)).checked, false);
  assert.equal(inputOption(cardFor(PULL.id)).checked, false, 'secondary card without target fields is reset too');
  assert.equal(runButton(cardFor(PACKAGE.id)).disabled, true, 'new target requires fresh confirmations');
  await confirm(cardFor(PACKAGE.id));
  assert.deepEqual((await run(cardFor(PACKAGE.id))).inputs, { tag: 'v0.3.2', force: false });
  assert.deepEqual((await run(cardFor(PULL.id))).inputs, { allowDirty: false });
});
