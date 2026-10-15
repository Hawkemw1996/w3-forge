#!/usr/bin/env node
'use strict';
// Trusted operator code, installed separately from the generated console pin.
// No development code executes until runuser has dropped to the build account.
const fs = require('node:fs'), path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const ID = /^[A-Za-z0-9_-]{1,100}$/, USER = /^[a-z_][a-z0-9_-]{0,30}[$]?$/;
const PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
function fail(message) { throw new Error(message); }
function canonical(value, directory = true) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || fs.realpathSync(value) !== value) fail('A canonical absolute host path is required.');
  const st = fs.lstatSync(value);
  if (st.isSymbolicLink() || (directory ? !st.isDirectory() : !st.isFile())) fail('A regular host path is required.');
  return value;
}
function trustedPath(file, directory) {
  canonical(file, directory);
  for (let item = file;; item = path.dirname(item)) {
    const st = fs.lstatSync(item);
    if (st.uid !== 0 || (st.mode & 0o022)) fail('Trusted host code and its parents must be root-owned and not writable by other accounts.');
    if (path.dirname(item) === item) return file;
  }
}
function trustedFile(file) { return trustedPath(file, false); }
function configuration(consumer, requestId, env) {
  if (!['w3buildcost', 'w3books', 'w3forge'].includes(consumer) || !ID.test(requestId || '')) fail('Invalid test identity.');
  const config = { consumer, requestId, root: env.W3_DEPLOY_DIR, snapshotRoot: env.W3_TEST_SNAPSHOT_ROOT,
    cacheRoot: env.W3_TEST_CACHE_ROOT, installation: env.W3_TEST_INSTALLATION_ID,
    buildUser: env.W3_TEST_BUILD_USER, productionUser: env.W3_TEST_PRODUCTION_USER,
    npmCli: env.W3_TEST_NPM_CLI, cacheEpoch: env.W3_TEST_CACHE_EPOCH || '1', ownerPid: env.W3_TEST_OWNER_PID,
    envFile: env.W3_ENV_FILE, dataRoot: env.W3_DATA_DIR };
  if (!USER.test(config.buildUser || '') || !USER.test(config.productionUser || '') || config.buildUser === config.productionUser
    || !ID.test(config.installation || '') || !ID.test(config.cacheEpoch) || !/^[1-9][0-9]{0,9}$/.test(config.ownerPid || '')) fail('Explicit separate build/production identities and supervising backend are required.');
  for (const name of ['root', 'snapshotRoot', 'cacheRoot', 'dataRoot']) canonical(config[name]);
  canonical(config.envFile, false); canonical(config.npmCli, false);
  const roots = [config.root, config.snapshotRoot, config.cacheRoot, config.dataRoot];
  for (let i = 0; i < roots.length; i++) for (let j = i + 1; j < roots.length; j++) {
    if (roots[i] === roots[j] || roots[i].startsWith(roots[j] + path.sep) || roots[j].startsWith(roots[i] + path.sep)) fail('Source, snapshot, cache and production data roots must be separate.');
  }
  return config;
}
function account(name, execute = execFileSync) {
  const row = execute('/usr/bin/getent', ['passwd', name], { encoding: 'utf8', env: { PATH }, stdio: ['ignore', 'pipe', 'pipe'] }).trim().split(':');
  if (row.length !== 7 || row[0] !== name || !/^[1-9][0-9]*$/.test(row[2]) || !/^[1-9][0-9]*$/.test(row[3]) || !/\/(?:nologin|false)$/.test(row[6])) fail('The build account must be a dedicated non-login system account.');
  const groups = execute('/usr/bin/id', ['-G', name], { encoding: 'utf8', env: { PATH }, stdio: ['ignore', 'pipe', 'pipe'] }).trim().split(/\s+/);
  if (groups.length !== 1 || groups[0] !== row[3]) fail('The build account must have only its dedicated primary group.');
  return { uid: Number(row[2]), gid: Number(row[3]) };
}
function boundaries(config, build) {
  const parent = fs.lstatSync(config.snapshotRoot), cache = fs.lstatSync(config.cacheRoot);
  trustedPath(config.snapshotRoot, true); trustedPath(path.dirname(config.cacheRoot), true);
  if (parent.uid !== 0 || (parent.mode & 0o022) || !(parent.mode & 0o001)) fail('Snapshot parent requires root ownership, traversal and no non-root write access.');
  if (cache.uid !== build.uid || (cache.mode & 0o077)) fail('Cache root must be private to the dedicated build account.');
  // Refuse leftovers; only an operator may recover a snapshot after a hard kill.
  if (fs.readdirSync(config.snapshotRoot).length) fail('An existing test snapshot requires operator recovery before another run.');
}
function transfer(snapshot, build) {
  function visit(item) {
    const st = fs.lstatSync(item);
    if (st.isSymbolicLink() || (!st.isFile() && !st.isDirectory()) || (st.isFile() && st.nlink !== 1)) fail('Unsafe ownership-transfer input.');
    if (st.isDirectory()) for (const name of fs.readdirSync(item)) visit(path.join(item, name));
    fs.chownSync(item, build.uid, build.gid);
  }
  visit(snapshot);
}
function cleanup(snapshot, parent, identity) {
  canonical(parent);
  if (path.dirname(snapshot) !== parent || !path.basename(snapshot).startsWith('test-')) fail('Cleanup path is outside the dedicated snapshot parent.');
  let st;
  try { st = fs.lstatSync(snapshot); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (st.isSymbolicLink() || !st.isDirectory() || st.ino !== identity.ino || st.dev !== identity.dev) fail('Snapshot identity changed; operator recovery is required.');
  fs.rmSync(snapshot, { recursive: true, force: true });
  if (fs.existsSync(snapshot)) fail('Snapshot cleanup did not finish.');
}
function failure(requestId, reason) {
  // Fixed messages only; child output is redacted by the unprivileged worker.
  process.stdout.write('===STRUCTURED-RESULT===\ntest_worker_protocol=1\nstatus=failed\nrequest_id=' + (ID.test(requestId || '') ? requestId : 'invalid') + '\nreason=' + reason + '\n===END===\n');
}
async function main(argv, env = process.env) {
  const [consumer, requestId] = argv;
  if (argv.length !== 2 || process.platform !== 'linux' || process.getuid() !== 0) fail('The trusted Linux host supervisor requires root and fixed consumer/request arguments.');
  for (const file of [__filename, path.join(__dirname, 'admin-console.cjs'), path.join(__dirname, 'test-dev-snapshot.cjs'), process.execPath, '/usr/sbin/runuser', '/usr/bin/env', '/usr/bin/getent', '/usr/bin/id', '/usr/bin/test']) trustedFile(fs.realpathSync(file));
  const config = configuration(consumer, requestId, env), build = account(config.buildUser);
  trustedFile(config.npmCli); boundaries(config, build);
  const productionUid = Number(execFileSync('/usr/bin/id', ['-u', config.productionUser], { env: { PATH }, encoding: 'utf8' }).trim());
  if (!Number.isSafeInteger(productionUid) || productionUid === build.uid) fail('Production and build identities must differ.');
  for (const [flag, value] of [['-r', config.envFile], ['-x', config.dataRoot]]) {
    const probe = spawn('/usr/sbin/runuser', ['--user', config.buildUser, '--', '/usr/bin/test', flag, value], { env: { PATH }, stdio: 'ignore' });
    const code = await new Promise((resolve, reject) => { probe.once('error', reject); probe.once('close', resolve); });
    if (code !== 1) fail('Build account isolation from production secrets/data is not verified.');
  }
  // Bootstrap imports happen only after checking the installed trusted code.
  const { createDevelopmentSnapshot } = require('./test-dev-snapshot.cjs');
  let result, identity, operation, operationIdentity, child, cancelled = false, force;
  const stop = () => {
    cancelled = true;
    if (!child?.pid) return;
    try { process.kill(-child.pid, 'SIGTERM'); } catch { /* Failure remains explicit. */ }
    force ||= setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 4000);
  };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  const outputLost = () => stop();
  process.stdout.on('error', outputLost); process.stderr.on('error', outputLost);
  let code = 1;
  try {
    operation = fs.mkdtempSync(path.join(config.snapshotRoot, 'test-' + requestId + '-host-'));
    fs.chmodSync(operation, 0o700); operationIdentity = fs.lstatSync(operation);
    result = createDevelopmentSnapshot({ ...config, snapshotRoot: operation }, event => process.stderr.write('===TEST-DEV-PROGRESS===' + JSON.stringify(event) + '\n'));
    identity = fs.lstatSync(result.snapshot);
    if (cancelled) fail('Development validation interrupted before execution.');
    // The root-owned stable parent protects this operation envelope from rename.
    // Its build-owned inner parent lets the worker remove its own snapshot.
    transfer(result.snapshot, build); fs.chownSync(operation, build.uid, build.gid);
    const fields = { snapshot: result.snapshot, 'snapshot-root': operation, 'cache-root': config.cacheRoot,
      consumer, installation: config.installation, 'request-id': requestId, head: result.head, branch: result.branch,
      'npm-cli': config.npmCli, 'cache-epoch': config.cacheEpoch, 'owner-pid': config.ownerPid };
    const args = ['--user', config.buildUser, '--', '/usr/bin/env', '-i', 'PATH=' + PATH, 'LANG=C.UTF-8', process.execPath, result.worker];
    for (const [key, value] of Object.entries(fields)) args.push('--' + key, value);
    child = spawn('/usr/sbin/runuser', args, { detached: true, env: { PATH, LANG: 'C.UTF-8' }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', chunk => { if (!process.stdout.destroyed) process.stdout.write(chunk); });
    child.stderr.on('data', chunk => { if (!process.stderr.destroyed) process.stderr.write(chunk); });
    code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', value => resolve(value === 0 ? 0 : 1)); });
    if (cancelled) code = 1;
  } finally {
    if (force) clearTimeout(force);
    process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop);
    try { if (result && identity) cleanup(result.snapshot, operation, identity); }
    finally { if (operation && operationIdentity) cleanup(operation, config.snapshotRoot, operationIdentity); }
  }
  if (code !== 0) failure(requestId, 'Isolated development validation failed or was interrupted; review the recorded stages.');
  return code;
}
if (require.main === module) main(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(() => { failure(process.argv[3], 'Test host configuration, snapshot preparation or cleanup failed; operator review is required.'); process.exitCode = 1; });
module.exports = { configuration, account, boundaries, transfer, cleanup, trustedFile };
