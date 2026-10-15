#!/usr/bin/env node
'use strict';
// Trusted bootstrap helper: install separately through an owner-reviewed app
// integration. A shared source pin never replaces this executable implicitly.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const loader = require('./admin-console.cjs');
const PREFIX = '===TEST-DEV-PROGRESS===';
const ID = /^[A-Za-z0-9_-]{1,100}$/;
function fail(message) { throw new Error(message); }
function canonical(dir) {
  const resolved = path.resolve(dir);
  if (fs.realpathSync(resolved) !== resolved || !fs.lstatSync(resolved).isDirectory()) fail('Snapshot roots must be regular canonical directories.');
  return resolved;
}
function git(root, args, input, binary = false) {
  const env = { PATH: process.platform === 'win32' ? process.env.PATH : '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', HOME: process.env.HOME, SystemRoot: process.env.SystemRoot,
    GIT_CONFIG_NOSYSTEM: '1', GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: '', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' };
  return execFileSync(process.platform === 'win32' ? 'git' : '/usr/bin/git', ['-C', root, '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=' + (process.platform === 'win32' ? 'NUL' : '/dev/null'), ...args], { env, encoding: binary ? undefined : 'utf8', input, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024, timeout: 60000 });
}
function inventory(root) {
  return [...new Set(git(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean))].sort();
}
function sensitive(name) {
  return name.split('/').some(part => part === '.git' || part === '.ssh' || part === '.npmrc' || (part.startsWith('.env') && part !== '.env.example')) || /\.(?:key|pem)$/i.test(name);
}
function sourceFile(root, name) {
  if (!loader.safePath(name) || sensitive(name)) fail('Unsafe or credential-related snapshot input requires review.');
  const file = loader.secureTarget(root, name);
  let fd;
  try { fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.size > 128 * 1024 * 1024) fail('Special or oversized build input refused.');
    const bytes = fs.readFileSync(fd), after = fs.fstatSync(fd);
    if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) fail('Source changed during snapshot creation.');
    return { bytes, hash: loader.sha256(bytes), mode: before.mode & 0o111 ? 0o755 : 0o644 };
  } finally { fs.closeSync(fd); }
}
function committedFiles(root, head) {
  const entries = git(root, ['ls-tree', '-r', '-z', head]).split('\0').filter(Boolean).map(line => {
    const tab = line.indexOf('\t'), header = line.slice(0, tab).split(' '), name = line.slice(tab + 1);
    if (tab < 0 || !['100644', '100755'].includes(header[0]) || header[1] !== 'blob' || !/^[a-f0-9]{40}$/.test(header[2]) || !loader.safePath(name) || sensitive(name)) fail('Linked, special or credential-related committed input refused.');
    return { name, oid: header[2], mode: header[0] === '100755' ? 0o755 : 0o644 };
  });
  if (!entries.length || entries.length > 20000) fail('Invalid development source inventory.');
  const batch = git(root, ['cat-file', '--batch'], entries.map(e => e.oid).join('\n') + '\n', true);
  let offset = 0;
  for (const entry of entries) {
    const end = batch.indexOf(10, offset), header = batch.subarray(offset, end).toString('utf8').split(' '), size = Number(header[2]);
    if (end < offset || header[0] !== entry.oid || header[1] !== 'blob' || !Number.isSafeInteger(size) || size < 0 || size > 128 * 1024 * 1024) fail('Invalid Git source object.');
    offset = end + 1; entry.bytes = batch.subarray(offset, offset + size);
    if (entry.bytes.length !== size || batch[offset + size] !== 10 || crypto.createHash('sha1').update('blob ' + size + '\0').update(entry.bytes).digest('hex') !== entry.oid) fail('Git source object integrity failed.');
    entry.hash = loader.sha256(entry.bytes); offset += size + 1;
  }
  if (offset !== batch.length) fail('Unexpected Git source payload.');
  return entries;
}
function createDevelopmentSnapshot(config, progress = () => {}) {
  const started = performance.now(), stages = [];
  function stage(id, work) {
    const record = { id, startedAt: new Date().toISOString(), durationMs: 0, status: 'running' };
    progress({ schema: 1, requestId: config.requestId, stage: { ...record } });
    const start = performance.now();
    try { const result = work(); record.status = 'passed'; return result; }
    catch (error) { record.status = 'failed'; throw error; }
    finally { record.durationMs = Math.round(performance.now() - start); stages.push(record); progress({ schema: 1, requestId: config.requestId, stage: { ...record } }); }
  }
  let root, parent, head, branch, lock, snapshot, identity, files;
  try {
    stage('validation', () => {
      if (typeof config.requestId !== 'string' || typeof config.installation !== 'string' || !ID.test(config.requestId) || !ID.test(config.installation) || !['w3buildcost', 'w3books', 'w3forge'].includes(config.consumer)) fail('Invalid development snapshot identity.');
      if (!/^[1-9][0-9]{0,9}$/.test(String(config.ownerPid))) fail('A supervising backend process is required.');
      root = canonical(config.root); parent = canonical(config.snapshotRoot);
      if (parent === root || parent.startsWith(root + path.sep) || root.startsWith(parent + path.sep)) fail('Test snapshots require a separate dedicated root.');
      const st = fs.lstatSync(parent);
      if (process.platform !== 'win32' && (st.uid !== process.getuid() || (st.mode & 0o022))) fail('The snapshot parent must be private to the trusted helper account.');
      branch = git(root, ['branch', '--show-current']).trim();
      head = git(root, ['rev-parse', 'HEAD']).trim();
      if (!/^dev\/v\d+\.\d+\.\d+$/.test(branch) || !/^[a-f0-9]{40}$/.test(head)) fail('Only a versioned development checkout may be tested.');
      lock = loader.validateLock(JSON.parse(fs.readFileSync(loader.secureTarget(root, 'admin-console.lock.json'), 'utf8')));
      if (lock.consumer !== config.consumer) fail('The snapshot belongs to another consumer.');
      loader.verify(root);
    });
    const hashes = new Map(), digest = crypto.createHash('sha256');
    stage('snapshot', () => {
      snapshot = fs.mkdtempSync(path.join(parent, 'test-' + config.requestId + '-'));
      fs.chmodSync(snapshot, 0o700); identity = fs.lstatSync(snapshot);
      const committed = committedFiles(root, head);
      files = committed.map(entry => entry.name).sort();
      const currentInventory = inventory(root);
      for (const name of currentInventory) { if (!loader.safePath(name)) fail('Unsafe snapshot source path.'); loader.secureTarget(root, name); }
      if (JSON.stringify(currentInventory) !== JSON.stringify(files)) fail('Commit or preserve pending source changes before testing this exact development revision.');
      for (const entry of committed) {
        const working = sourceFile(root, entry.name);
        if (!working || working.hash !== entry.hash || (process.platform !== 'win32' && working.mode !== entry.mode)) fail('Commit pending source changes before testing; the checkout must match the committed bytes.');
        const destination = loader.secureTarget(snapshot, entry.name); fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
        fs.writeFileSync(destination, entry.bytes, { flag: 'wx', mode: entry.mode }); hashes.set(entry.name, { hash: entry.hash, mode: entry.mode });
        digest.update(entry.name + '\0' + entry.hash + '\0');
      }
      if (JSON.stringify(inventory(root)) !== JSON.stringify(files) || git(root, ['rev-parse', 'HEAD']).trim() !== head || git(root, ['branch', '--show-current']).trim() !== branch) fail('Source identity changed during snapshot creation.');
      for (const name of files) { const current = sourceFile(root, name), expected = hashes.get(name); if (!current || current.hash !== expected.hash || (process.platform !== 'win32' && current.mode !== expected.mode)) fail('Source changed during snapshot creation.'); }
    });
    stage('console-verification', () => { loader.snapshot(root, { destination: snapshot }); });
    digest.update(lock.manifestSha256);
    const marker = { schema: 1, createdAt: new Date().toISOString(), ownerPid: String(config.ownerPid), consumer: config.consumer, installation: config.installation, requestId: config.requestId, head, branch, sourceSha256: digest.digest('hex'), dirty: false, sourceKind: 'git-head', consoleRevision: lock.revision };
    fs.writeFileSync(path.join(snapshot, '.w3-test-snapshot.json'), JSON.stringify(marker) + '\n', { flag: 'wx', mode: 0o600 });
    const worker = path.join(snapshot, lock.targets.backend, 'testDev', 'worker.cjs');
    if (!fs.existsSync(worker) || !fs.lstatSync(worker).isFile()) fail('The selected shared console does not include the development test worker.');
    return { ...marker, snapshot, worker, stages, durationMs: Math.round(performance.now() - started) };
  } catch (error) {
    if (snapshot && identity) {
      const st = fs.lstatSync(snapshot);
      if (st.ino === identity.ino && st.dev === identity.dev && !st.isSymbolicLink() && path.dirname(snapshot) === parent && canonical(parent) === parent) fs.rmSync(snapshot, { recursive: true, force: true });
    }
    throw error;
  }
}
function main(argv) {
  const names = { '--root': 'root', '--snapshot-root': 'snapshotRoot', '--consumer': 'consumer', '--installation': 'installation', '--request-id': 'requestId', '--owner-pid': 'ownerPid' }, config = {};
  for (let i = 0; i < argv.length; i += 2) { const name = names[argv[i]]; if (!name || !argv[i + 1] || Object.hasOwn(config, name)) fail('Invalid snapshot arguments.'); config[name] = argv[i + 1]; }
  const result = createDevelopmentSnapshot(config, event => console.error(PREFIX + JSON.stringify(event)));
  console.log(JSON.stringify(result)); return result;
}
if (require.main === module) { try { main(process.argv.slice(2)); } catch (error) { const detail = String(error.message || 'Snapshot infrastructure failed.').replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+\/-]+=*/gi, '$1 [redacted]').replace(/((?:token|password|secret|authorization|cookie)\s*[:=]\s*)[^\r\n]*/gi, '$1[redacted]').replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/]+@/gi, '$1[redacted]@').replace(/[\r\n]+/g, ' ').slice(0, 1024); console.error('Development snapshot failed: ' + detail); process.exitCode = 1; } }
module.exports = { createDevelopmentSnapshot, sensitive, sourceFile };
