'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { repositoryIdentity, checkRepository, configuration, databaseConfiguration } = require('../_w3forge-policy.cjs');
const scripts = path.resolve(__dirname, '..');
const root = path.resolve(scripts, '../..');
const expected = 'hawkemw1996/w3-forge';
const ownUrl = 'https://github.com/Hawkemw1996/w3-forge.git';
const config = () => ({ app_id: 'w3forge', repo: { url: ownUrl }, controls: { allow_legacy_w3forge_controls: true }, github_workflow: { allow_release_pipeline: true }, authority: { may_tag_release: false, may_modify_production_data: false }, service: { name: 'w3forge-admin.service', port: 8765 } });
function bashPath() {
  if (process.env.W3_TEST_BASH) return process.env.W3_TEST_BASH;
  if (process.platform === 'win32') return path.resolve(path.dirname(process.execPath), '../../native/git/usr/bin/sh.exe');
  return '/bin/bash';
}
test('all prepared shell scripts parse with Bash without execution', () => {
  for (const name of fs.readdirSync(scripts).filter(n => n.endsWith('.sh'))) {
    const result = spawnSync(bashPath(), ['-n', path.join(scripts, name)], { encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, name + ': ' + (result.error?.message || result.stderr));
  }
});
test('installation opt-ins fail closed, while agent metadata does not disable confirmed owner workflows', () => {
  assert.throws(() => configuration({ ...config(), controls: {} }, 'deploy-w3forge-ui.sh', root, {}), /not enabled/);
  assert.throws(() => configuration({ ...config(), github_workflow: {} }, 'pipeline-create-tag-w3forge-ui.sh', root, {}), /not enabled/);
  assert.equal(configuration(config(), 'pipeline-create-tag-w3forge-ui.sh', root, {}).expected, expected);
  assert.equal(configuration(config(), 'restore-w3forge-ui.sh', root, {}).variables.W3_SERVICE_PORT, '8765');
  assert.throws(() => configuration(config(), 'status-w3forge.sh', root, { W3_ACTIVE_APP_ID: 'w3core' }), /Wrong application/);
});
test('only credential-free canonical GitHub identities are accepted', () => {
  assert.equal(repositoryIdentity(ownUrl), expected);
  assert.equal(repositoryIdentity('git@github.com:Hawkemw1996/w3-forge.git'), expected);
  for (const url of ['https://secret@github.com/Hawkemw1996/w3-forge', ownUrl + '?token=secret', 'https://github.com.evil.test/Hawkemw1996/w3-forge', 'file:///tmp/repository']) assert.equal(repositoryIdentity(url), null);
});
test('raw origin and all effective fetch/push URLs must match before any network or mutation', () => {
  const calls = [];
  checkRepository(root, expected, (command, args, options) => { calls.push(args); assert.equal(command, 'git'); assert.equal(options.shell, false); return { status: 0, stdout: ownUrl + '\n' }; });
  assert.equal(calls.length, 3);
  assert.ok(calls.every(args => !args.some(arg => ['fetch', 'push', 'pull', 'ls-remote', 'reset'].includes(arg))));
  for (const failureIndex of [0, 1, 2]) {
    let index = 0;
    assert.throws(() => checkRepository(root, expected, () => ({ status: 0, stdout: index++ === failureIndex ? 'https://github.com/Other/app.git\n' : ownUrl + '\n' })), /binding refused/);
  }
  assert.throws(() => checkRepository(root, expected, () => ({ status: 0, stdout: ownUrl + '\nhttps://github.com/Other/app.git\n' })), /binding refused/);
});
test('paths and backup destinations cannot silently inherit another W3 app', () => {
  assert.throws(() => configuration(config(), 'backup-w3forge.sh', root, { W3_APP_DIR: '/opt/w3buildcost' }), /foreign/);
  assert.throws(() => configuration(config(), 'backup-w3forge.sh', root, { W3_SERVICE_NAME: 'w3core.service' }), /another app/);
  const env = configuration(config(), 'backup-w3forge.sh', root, {}).variables;
  assert.equal(env.W3_BACKUP_REMOTE_HOST, '');
  assert.equal(env.W3_BACKUP_REMOTE_PATH, '');
  assert.throws(() => configuration(config(), 'backup-w3forge.sh', root, { W3_BACKUP_REMOTE_HOST: 'backup.example', W3_BACKUP_REMOTE_USER: 'backup', W3_BACKUP_REMOTE_PATH: '/backups/w3core' }), /Forge-owned/);
});
test('database URL configuration targets the same Forge database as the backend without fallback', () => {
  const vars = databaseConfiguration('FORGE_DATABASE_URL=postgresql://forge_user:example%20secret@127.0.0.1:5544/w3forge_admin?sslmode=require\n', {});
  assert.equal(vars.W3_DB_NAME, 'w3forge_admin'); assert.equal(vars.PGPORT, '5544'); assert.equal(vars.PGPASSWORD, 'example secret'); assert.equal(vars.PGSSLMODE, 'require');
  for (const value of ['not-a-url', 'postgresql://user@host/w3core', 'postgresql://user@host/w3buildcost', 'postgresql://user@host/w3forge?options=unsafe']) assert.throws(() => databaseConfiguration('FORGE_DATABASE_URL=' + value, {}));
  assert.equal(databaseConfiguration('FORGE_DATABASE_NAME=w3forge_custom\nFORGE_DATABASE_USER=forge_user', {}).W3_DB_NAME, 'w3forge_custom');
});
test('entrypoints load policy first, installations include guards/migrations, and schema checks are administrative only', () => {
  const helper = fs.readFileSync(path.join(scripts, '_w3forge-migration-ledger.sh'), 'utf8');
  const names = helper.match(/W3FORGE_REQUIRED_TABLES=\(([\s\S]*?)\n\)/)[1].trim().split(/\s+/).sort();
  assert.deepEqual(names, ['schema_migrations', 'audit_events', 'platform_config', 'production_cutover_record'].sort());
  const installer = fs.readFileSync(path.join(scripts, 'install-server-scripts.sh'), 'utf8');
  for (const name of fs.readdirSync(scripts).filter(n => (n.endsWith('.sh') || n.endsWith('.cjs')) && n !== 'install-server-scripts.sh')) assert.ok(installer.includes('$SOURCE_DIR/' + name), 'Missing installed helper/script: ' + name);
  const {ADMIN_CONTROLS} = require(path.join(root, 'backend/dist/console/controls/registry.js'));
  const sources = ADMIN_CONTROLS.map(control => {
    assert.ok(control.scriptSourcePath.startsWith('scripts/admin/'), 'Forge script source stays in its app-owned operator folder');
    return control.scriptSourcePath.slice('scripts/admin/'.length);
  });
  assert.ok(sources.length > 20, 'Canonical controls source inventory must be present.');
  for (const name of sources) { assert.ok(fs.existsSync(path.join(scripts, name)), 'Missing source: ' + name); assert.ok(installer.includes('$SOURCE_DIR/' + name), 'Missing installed control: ' + name); }
  for (const name of fs.readdirSync(scripts).filter(n => n.endsWith('.sh') && !n.startsWith('_'))) {
    const source = fs.readFileSync(path.join(scripts, name), 'utf8');
    assert.ok(source.indexOf('w3forge_guard_script') < source.indexOf('\n', source.indexOf('w3forge_guard_script')));
    assert.ok(!source.includes('100.99.39.74'));
    assert.ok(!source.includes('frontend/package.json'));
    assert.ok(!source.match(/source\s+"\$REPO_ROOT\/\.env"/));
  }
  assert.match(fs.readFileSync(path.join(scripts, 'migrate-w3forge.sh'), 'utf8'), /w3forge_database_env/);
});
test('runtime layout preflight refuses the currently mismatched checkout service before mutation', () => {
  const body = 'source "$W3_TEST_POLICY"\nsystemctl() { case "$*" in *WorkingDirectory*) echo /tmp/forge-checkout;; *ExecStart*) echo /tmp/forge-checkout/backend/dist/index.js;; esac; }\nw3forge_require_runtime_layout\n';
  const result = spawnSync(bashPath(), ['-s'], { input: body, encoding: 'utf8', windowsHide: true, env: { ...process.env, W3_TEST_POLICY: path.join(scripts, '_w3forge-policy.sh').replaceAll('\\', '/'), W3_APP_DIR: '/tmp/forge-runtime', W3_SERVICE_NAME: 'w3forge-admin.service' } });
  assert.equal(result.status, 3, result.stderr);
  assert.match(result.stderr, /Service runtime layout differs/);
});

test('runtime sync includes built workspace dependencies while packages exclude them', () => {
  for (const name of ['deploy-w3forge.sh', 'deploy-w3forge-noninteractive.sh']) {
    const source = fs.readFileSync(path.join(scripts, name), 'utf8');
    const start = source.indexOf('info "Syncing runtime files');
    const end = source.indexOf('"$DEPLOY_DIR/" "$APP_DIR/"', start);
    assert.ok(start >= 0 && end > start);
    const sync = source.slice(start, end);
    assert.ok(!sync.includes("--exclude 'node_modules'"));
    assert.ok(sync.includes("--exclude '.git'") && sync.includes("--exclude '.env'"));
    assert.ok(source.indexOf('w3forge_verify_workspace_links "$DEPLOY_DIR"') < source.indexOf('systemctl stop'));
  }
  for (const name of ['release-current-w3forge.sh', 'package-w3forge-review.sh']) assert.ok(fs.readFileSync(path.join(scripts, name), 'utf8').includes("--exclude 'node_modules'"));
});
