'use strict';
// Shared console script boundary. Configuration is data; never sourced as shell code.
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');
function repositoryIdentity(value) {
  if (typeof value !== 'string' || /[\s\x00-\x1f]/.test(value)) return null;
  let match = /^git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(value);
  if (!match) {
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password || url.search || url.hash) return null;
      match = /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(url.pathname);
    } catch { return null; }
  }
  return match ? (match[1] + '/' + match[2]).toLowerCase() : null;
}
function ownedPath(value, label) {
  if (typeof value !== 'string' || !value || /[\x00-\x1f]/.test(value) || !path.isAbsolute(value)
    || value === path.parse(value).root || /^\/(opt|etc|var|home|root|tmp)\/?$/.test(value)
    || /(?:^|[\\/])(?:w3core|w3buildcost|w3-buildcost|cleanbooksai)(?:[\\/.-]|$)/i.test(value)) throw new Error('Unsafe or foreign app ' + label + ' root.');
  const resolved = path.resolve(value);
  const actual = fs.existsSync(resolved) ? fs.realpathSync(resolved) : resolved;
  if (actual === path.parse(actual).root || /^\/(opt|etc|var|home|root|tmp)\/?$/.test(actual) || /(?:^|[\\/])(?:w3core|w3buildcost|w3-buildcost|cleanbooksai)(?:[\\/.-]|$)/i.test(actual)) throw new Error('Unsafe or foreign app ' + label + ' root.');
  return resolved;
}
function checkRepository(directory, expected, run = spawnSync) {
  const commands = [['config', '--get-all', 'remote.origin.url'], ['remote', 'get-url', '--all', 'origin'], ['remote', 'get-url', '--push', '--all', 'origin']];
  for (const args of commands) {
    const result = run('git', ['-C', directory, ...args], { encoding: 'utf8', windowsHide: true, shell: false, timeout: 10000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' } });
    const values = String(result.stdout || '').trim().split(/\r?\n/).filter(Boolean);
    if (result.error || result.status !== 0 || !values.length || values.some(value => repositoryIdentity(value) !== expected)) {
      throw new Error('Repository binding refused: origin and every effective fetch/push URL must match this app.');
    }
  }
}
function configuration(config, script, root, input = process.env) {
  if (config.app_id !== 'w3forge' || input.W3_ACTIVE_APP_ID && input.W3_ACTIVE_APP_ID !== config.app_id) throw new Error('Wrong application configuration.');
  if (config.controls?.allow_legacy_w3forge_controls !== true) throw new Error('Operational console scripts are not enabled for this installation.');
  if (script.startsWith('pipeline-') && config.github_workflow?.allow_release_pipeline !== true) throw new Error('Release pipeline is not enabled for this installation.');
  // authority.* describes agent authority. Owner operations use the reference
  // console's explicit per-action confirmations and validations, not those bits.
  const repository = config.repo?.url;
  const expected = repositoryIdentity(repository);
  if (!expected || expected !== repositoryIdentity(input.W3_REPO_URL || repository)) throw new Error('A matching app-owned repository must be configured.');
  const paths = config.paths || {};
  const variables = {
    W3_FORGE_ROOT: root,
    W3_DEPLOY_DIR: input.W3_DEPLOY_DIR || paths.deploy || '/opt/w3forge-deploy',
    W3_APP_DIR: input.W3_APP_DIR || paths.runtime || '/opt/w3forge',
    W3_SCRIPTS_DIR: input.W3_SCRIPTS_DIR || paths.scripts || '/opt/w3forge-scripts',
    W3_LOG_ROOT: input.W3_LOG_ROOT || input.W3LOG_ROOT || paths.logs || '/opt/logs/w3forge',
    W3_BACKUPS_DIR: input.W3_BACKUPS_DIR || paths.backups || '/opt/backups/w3forge',
    W3_UPDATE_DIR: input.W3_UPDATE_DIR || paths.update_packages || paths.packages_staged || '/opt/w3forge-update-packages'
  };
  for (const [key, value] of Object.entries(variables)) variables[key] = ownedPath(value, key);
  variables.W3LOG_ROOT = variables.W3_LOG_ROOT;
  variables.W3_BACKUP_DIR = variables.W3_BACKUPS_DIR;
  for (const [key, sub, configured] of [['W3_INSTALLED_DIR', 'installed', paths.installed_packages || paths.packages_installed], ['W3_DEV_UPDATE_DIR', 'dev'], ['W3_MAIN_UPDATE_DIR', 'main']]) variables[key] = ownedPath(input[key] || configured || path.join(variables.W3_UPDATE_DIR, sub), key);
  variables.W3_SERVICE_NAME = input.W3_SERVICE_NAME || config.service?.name || 'w3forge-admin.service';
  if (!/^w3forge(?:-admin)?(?:\.service)?$/.test(variables.W3_SERVICE_NAME)) throw new Error('Refusing another app service.');
  variables.W3_SERVICE_PORT = String(input.W3_SERVICE_PORT || config.service?.port || config.admin_console?.listen_port || 8765);
  if (!/^\d{1,5}$/.test(variables.W3_SERVICE_PORT) || Number(variables.W3_SERVICE_PORT) < 1 || Number(variables.W3_SERVICE_PORT) > 65535) throw new Error('Invalid service port.');
  variables.W3_HEALTH_URL = input.W3_HEALTH_URL || 'http://127.0.0.1:' + variables.W3_SERVICE_PORT + '/health';
  variables.W3_VERSION_URL = input.W3_VERSION_URL || 'http://127.0.0.1:' + variables.W3_SERVICE_PORT + '/version';
  for (const key of ['W3_HEALTH_URL', 'W3_VERSION_URL']) {
    const url = new URL(variables[key]);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error('Invalid probe address.');
  }
  variables.W3_REPO_URL = repository;
  variables.W3_ACTIVE_APP_ID = config.app_id;
  for (const [key, field] of [['W3_BACKUP_REMOTE_HOST', 'remote_host'], ['W3_BACKUP_REMOTE_USER', 'remote_user'], ['W3_BACKUP_REMOTE_PATH', 'remote_path']]) variables[key] = input[key] || config.backup?.[field] || '';
  if (variables.W3_BACKUP_REMOTE_HOST && (!/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(variables.W3_BACKUP_REMOTE_HOST)
    || !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(variables.W3_BACKUP_REMOTE_USER)
    || !/^\/[A-Za-z0-9_./-]*w3forge(?:\/[A-Za-z0-9_./-]*)?$/.test(variables.W3_BACKUP_REMOTE_PATH)
    || variables.W3_BACKUP_REMOTE_PATH.split('/').includes('..'))) throw new Error('Remote backups require an explicit Forge-owned host, user and path.');
  for (const value of Object.values(variables)) if (/[\x00-\x1f]/.test(value)) throw new Error('Invalid multiline configuration.');
  return { variables, expected };
}

function databaseConfiguration(text, input = process.env) {
  const file = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Z_]+)=(.*)$/.exec(line);
    if (match) file[match[1]] = match[2].replace(/^(["'])(.*)\1$/, '$2');
  }
  const env = { ...input, ...file };
  let hostname = env.FORGE_DATABASE_HOST || env.W3_DB_HOST || env.DATABASE_HOST || env.DB_HOST || '127.0.0.1';
  let username = env.FORGE_DATABASE_USER || env.W3_DB_USER || env.DATABASE_USER || env.DB_USER || 'w3forge_user';
  let database = env.FORGE_DATABASE_NAME || env.W3_DB_NAME || env.DATABASE_NAME || env.DB_NAME || 'w3forge';
  let password = env.FORGE_DATABASE_PASSWORD || env.DATABASE_PASSWORD || env.DB_PASSWORD || env.PGPASSWORD || '';
  let port = env.FORGE_DATABASE_PORT || env.PGPORT || env.DATABASE_PORT || env.DB_PORT || '5432';
  let sslmode = env.PGSSLMODE || '';
  const connection = env.FORGE_DATABASE_URL || env.W3FORGE_DB_URL || env.DATABASE_URL;
  if (connection) {
    let url;
    try { url = new URL(connection); } catch { throw new Error('Invalid Forge database URL; no fallback database will be used.'); }
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || url.hash) throw new Error('Invalid Forge database URL; no fallback database will be used.');
    database = decodeURIComponent(url.pathname.slice(1)); hostname = url.hostname;
    username = decodeURIComponent(url.username); password = decodeURIComponent(url.password); port = url.port || '5432';
    for (const key of url.searchParams.keys()) if (key !== 'sslmode') throw new Error('Unsupported database URL option; configure explicit PostgreSQL environment instead.');
    sslmode = url.searchParams.get('sslmode') || sslmode;
  }
  if (!/^w3forge(?:_[a-z0-9_]+)?$/.test(database)) throw new Error('Database belongs to another application.');
  const output = { W3_DB_HOST: hostname, W3_DB_USER: username, W3_DB_NAME: database, PGHOST: hostname, PGUSER: username, PGDATABASE: database, PGPORT: String(port), PGPASSWORD: password, PGSSLMODE: sslmode };
  if (!username || !/^\d{1,5}$/.test(output.PGPORT) || Number(port)<1 || Number(port)>65535) throw new Error('Invalid Forge database connection.');
  for (const value of Object.values(output)) if (/[\x00-\x1f]/.test(value)) throw new Error('Invalid multiline database configuration.');
  return output;
}

function main() {
  const [script, suppliedRoot, mode, target] = process.argv.slice(2);
  const root = path.resolve(suppliedRoot || path.join(__dirname, '../..'));
  const req = createRequire(path.join(root, 'package.json'));
  const YAML = req('yaml');
  const configDir = process.env.W3_APP_CONFIG_DIR || path.join(root, 'config/apps');
  const config = YAML.parse(fs.readFileSync(path.join(configDir, 'w3forge.yml'), 'utf8'));
  const { variables, expected } = configuration(config, script, root);
  if (mode === '--database-env') {
    const file = '/etc/w3forge/admin.env';
    const database = databaseConfiguration(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');
    for (const [key, value] of Object.entries(database)) process.stdout.write(key + '=' + value + '\n');
    return;
  }
  checkRepository(mode === '--check-repository' ? ownedPath(target, 'repository') : variables.W3_DEPLOY_DIR, expected);
  if (mode !== '--check-repository') for (const [key, value] of Object.entries(variables)) process.stdout.write(key + '=' + value + '\n');
}
module.exports = { repositoryIdentity, checkRepository, configuration, databaseConfiguration };
if (require.main === module) {
  try { main(); }
  catch (error) {
    // Never echo raw Git URLs, configuration contents, or child stderr.
    const message = error?.code ? 'Installation configuration is unavailable or invalid.' : error instanceof Error ? error.message.replace(/[\r\n]/g, ' ') : 'Invalid installation configuration.';
    process.stderr.write('[BLOCKED] ' + message + '\n');
    process.exitCode = 3;
  }
}
