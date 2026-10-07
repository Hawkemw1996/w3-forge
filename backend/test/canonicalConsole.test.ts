import express from 'express';
import request from 'supertest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const child = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('node:child_process', () => ({
  execFile: Object.assign(vi.fn(), { [Symbol.for('nodejs.util.promisify.custom')]: (...args: unknown[]) => child.run(...args) })
}));
vi.mock('../src/db/pool', () => ({ pool: { query: vi.fn().mockRejectedValue(new Error('Database not configured')) } }));

let root: string;
let app: express.Express;
let origin = 'git@github.com:Hawkemw1996/w3-forge.git';
let failStatus = false;
let failNetwork = false;
let resetRegistry: () => void;
let config: Record<string, any>;
const locations: Record<string, string> = {};

async function write(relative: string, text: string) {
  const filename = path.join(root, relative);
  await fs.mkdir(path.dirname(filename), { recursive: true });
  await fs.writeFile(filename, text);
}
async function saveConfig() {
  await write('config/apps/w3forge.yml', YAML.stringify(config));
  resetRegistry?.();
}

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-canonical-'));
  for (const [envKey, relative] of Object.entries({
    W3_APP_DIR: 'runtime', W3_DEPLOY_DIR: 'deploy', W3_SCRIPTS_DIR: 'scripts',
    W3_LOG_ROOT: 'logs', W3_BACKUPS_DIR: 'backups', W3_UPDATE_DIR: 'packages',
    W3_INSTALLED_DIR: 'packages/installed', W3_DATA_DIR: 'data', ADMIN_LOG_DIR: 'logs/admin'
  })) {
    locations[envKey] = path.join(root, relative);
    vi.stubEnv(envKey, locations[envKey]);
    await fs.mkdir(locations[envKey], { recursive: true });
  }
  vi.stubEnv('W3_FORGE_ROOT', root);
  vi.stubEnv('W3_APP_CONFIG_DIR', path.join(root, 'config/apps'));
  vi.stubEnv('W3_ACTIVE_APP_ID', 'w3forge');
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('APP_VERSION', '0.4.1');
  vi.stubEnv('CORE_APP_CLIENT_SECRET', 'secret-that-must-not-enter-a-git-process');
  await write('VERSION', '0.4.1\n');
  await write('deploy/VERSION', '0.4.1\n');
  await write('deploy/.git/HEAD', 'fixture');
  await write('runtime/README.md', 'Forge fixture');
  await write('runtime/.env', 'PRIVATE_SECRET=never-display');
  await write('runtime/.env.example', 'PLACEHOLDER=example');
  await write('logs/admin/admin.log', '2026-10-06T12:00:00Z started\n2026-10-06T12:01:00Z ready\n');
  await write('packages/w3forge-v0.4.0.tar.gz', 'own');
  await write('packages/w3forge-invalid.tar.gz', 'own malformed');
  await write('packages/w3buildcost-v0.3.9.tar.gz', 'foreign');
  await write('packages/dev/v0.4.1/w3forge.tar.gz', 'canonical');
  await write('packages/installed/v0.4.0/w3forge.tar.gz', 'installed');
  await write('packages/installed/v0.4.0/deployed-at.txt', '2026-10-06T11:00:00Z\n');
  await write('backups/w3forge_app_2026-10-06_12-00-00.tar.gz', 'app');
  await write('backups/w3forge_db_2026-10-06_12-00-00.sql', 'sql');
  await write('backups/w3buildcost_app_2026-10-06_12-00-00.tar.gz', 'foreign');
  config = {
    app_id: 'w3forge', name: 'W3 Forge', version: '0.4.1',
    repo: { url: 'https://github.com/Hawkemw1996/w3-forge.git',
      default_dev_branch: 'dev/v0.4.1', allowed_branch_pattern: '^dev/v[0-9]+\\.[0-9]+\\.[0-9]+$',
      blocked_branches: ['main', 'master'] },
    paths: { runtime: locations.W3_APP_DIR, deploy: locations.W3_DEPLOY_DIR, scripts: locations.W3_SCRIPTS_DIR,
      logs: locations.W3_LOG_ROOT, backups: locations.W3_BACKUPS_DIR, update_packages: locations.W3_UPDATE_DIR,
      installed_packages: locations.W3_INSTALLED_DIR },
    service: { name: 'w3forge-admin.service', port: 8765, health_url: 'http://127.0.0.1:8765/health', version_url: 'http://127.0.0.1:8765/version' },
    authority: { may_deploy: true, may_package: true, may_tag_release: false, may_modify_production_data: false, requires_user_release_gate: true },
    admin_console: { role: 'master', preserve_ui: true, preserve_github_validation_tab: true, preserve_controls_tab: true, preserve_file_browser_tab: true },
    controls: { mode: 'legacy-compatible', registry_migration_status: 'controls_registry_foundation', app_id: 'w3forge', allow_legacy_w3forge_controls: true },
    file_browser: { mode: 'legacy-compatible', registry_migration_status: 'file_browser_foundation', app_id: 'w3forge', allow_host_local_roots: true,
      allowed_roots: ['app', 'deploy', 'deploy-scripts', 'deploy-docs', 'scripts', 'update-packages', 'update-packages-installed', 'backups', 'logs', 'cleanup-review'] },
    github_workflow: { mode: 'legacy-compatible', registry_migration_status: 'github_validation_foundation', app_id: 'w3forge',
      allow_release_pipeline: true, enforce_main_protection: true, enforce_release_gate: true }
  };
  await saveConfig();
  const registry = await import('../src/console/appRegistry');
  resetRegistry = registry.resetAppRegistryCache;
  expect(registry.getActiveAppConfig().app_id).toBe('w3forge');
  app = express();
  app.use(express.json());
  const factories = [
    (await import('../src/console/routes/gitRoutes')).buildAdminGitRoutes,
    (await import('../src/console/routes/controlsRoutes')).buildAdminControlsRoutes,
    (await import('../src/console/routes/filesRoutes')).buildAdminFilesRoutes,
    (await import('../src/console/routes/packagesRoutes')).buildAdminPackagesRoutes,
    (await import('../src/console/routes/backupsRoutes')).buildAdminBackupsRoutes,
    (await import('../src/console/routes/logsRoutes')).buildAdminLogsRoutes,
    (await import('../src/console/routes/dashboardLayoutRoutes')).buildAdminDashboardLayoutRoutes,
    (await import('../src/console/routes/systemRoutes')).buildAdminSystemRoutes
  ];
  for (const factory of factories) app.use('/api/admin', factory());
  app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) =>
    res.status(500).json({ success: false, error: { message: error.message } }));
});

beforeEach(() => {
  origin = 'git@github.com:Hawkemw1996/w3-forge.git';
  failStatus = false;
  failNetwork = false;
  child.run.mockReset();
  child.run.mockImplementation(async (command: string, args: string[]) => {
    if (command !== 'git') throw new Error('unavailable on fixture host');
    if (args[0] === 'remote') return { stdout: origin, stderr: '' };
    if (args[0] === 'status') {
      if (failStatus) throw new Error('status failed');
      return { stdout: '', stderr: '' };
    }
    if (args[0] === 'rev-parse') return { stdout: args.includes('--abbrev-ref') ? 'dev/v0.4.1' : 'a'.repeat(40), stderr: '' };
    if (args[0] === 'describe') return { stdout: 'v0.4.1', stderr: '' };
    if (args[0] === 'ls-remote') {
      if (failNetwork) throw { stderr: 'credential=secret-from-host' };
      return { stdout: 'a'.repeat(40) + '\trefs/heads/dev/v0.4.1\n' + 'b'.repeat(40) + '\trefs/heads/main\n', stderr: '' };
    }
    return { stdout: '', stderr: '' };
  });
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});

describe('canonical Forge console contract and target isolation', () => {
  it('retains complete canonical controls and protected confirmation contracts', async () => {
    const response = await request(app).get('/api/admin/controls?appId=w3buildcost').expect(200);
    const data = response.body.data;
    expect(data.app_id).toBe('w3forge');
    expect(data.release).toBe('v0.4.1');
    const controls = data.categories.flatMap((group: any) => group.controls);
    expect(controls.length).toBeGreaterThan(25);
    expect(controls.find((c: any) => c.id === 'restore-w3forge')).toMatchObject({ riskLevel: 'CRITICAL', runStrategy: 'safe-recovery', requiresConfirmation: true });
    expect(controls.find((c: any) => c.id === 'pipeline-package-dev')).toMatchObject({ runStrategy: 'safe-pipeline' });
    for (const control of controls) {
      expect(control.expectedInstalledPath.startsWith(locations.W3_SCRIPTS_DIR + path.sep)).toBe(true);
      expect(JSON.stringify(control)).not.toContain('w3buildcost');
    }
    const validation = await request(app).post('/api/admin/controls/restore-w3forge/validate').send({}).expect(200);
    expect(validation.body.data.runnable).toBe(false);
    expect(child.run).not.toHaveBeenCalled();
  });

  it('refuses arbitrary controls without spawning a command', async () => {
    await request(app).post('/api/admin/controls/arbitrary-shell/run').send({ command: 'anything' }).expect(404);
    expect(child.run).not.toHaveBeenCalled();
  });

  it('lists own legacy and canonical packages with full installed metadata', async () => {
    const legacy = (await request(app).get('/api/admin/packages/staged?root=/another-app').expect(200)).body.data;
    expect(legacy.root).toBe(locations.W3_UPDATE_DIR);
    expect(legacy.packages.map((p: any) => p.name).sort()).toEqual(['w3forge-invalid.tar.gz', 'w3forge-v0.4.0.tar.gz']);
    expect(legacy.packages.find((p: any) => p.name.includes('invalid')).validName).toBe(false);
    const dev = (await request(app).get('/api/admin/packages/staged-dev').expect(200)).body.data;
    expect(dev.packages[0]).toMatchObject({ name: 'w3forge.tar.gz', layout: 'canonical', channel: 'dev', parsedVersion: '0.4.1' });
    const installed = (await request(app).get('/api/admin/packages/installed/0.4.0').expect(200)).body.data;
    expect(JSON.stringify(installed)).toContain('2026-10-06T11:00:00Z');
    await request(app).get('/api/admin/packages/installed/not-a-version').expect(400);
  });

  it('pairs only this app’s backups and excludes foreign files from totals', async () => {
    const data = (await request(app).get('/api/admin/backups').expect(200)).body.data;
    expect(data.backups).toHaveLength(1);
    expect(data.backups[0].kind).toBe('paired');
    expect(data.backups[0].appArchive.name).toMatch(/^w3forge_app_/);
    expect(data.backups[0].dbArchive.name).toMatch(/^w3forge_db_/);
    expect(data.totalSizeBytes).toBe(6);
  });

  it('preserves file browsing, previews and archive restrictions without secret/traversal access', async () => {
    const listed = (await request(app).get('/api/admin/files/list').query({ root: 'app' }).expect(200)).body.data;
    expect(listed.entries.map((e: any) => e.name)).not.toContain('.env');
    const preview = (await request(app).get('/api/admin/files/view').query({ root: 'app', path: 'README.md' }).expect(200)).body.data;
    expect(JSON.stringify(preview)).toContain('Forge fixture');
    const hidden = await request(app).get('/api/admin/files/view').query({ root: 'app', path: '.env' });
    expect(hidden.status).toBeGreaterThanOrEqual(400);
    await request(app).get('/api/admin/files/view').query({ root: 'app', path: '../README.md' }).expect(404);
    await request(app).get('/api/admin/files/view').query({ root: 'app', path: 'backup.tar.gz' }).expect(415);
    await request(app).get('/api/admin/files/list').query({ root: '/etc' }).expect(400);
  });

  it('rejects a public filename that resolves to a hidden secret file', async () => {
    const original = fs.realpath.bind(fs);
    const alias = path.join(locations.W3_APP_DIR, 'public.md');
    const spy = vi.spyOn(fs, 'realpath').mockImplementation((async (filename: any, options: any) =>
      String(filename) === alias ? path.join(locations.W3_APP_DIR, '.env') : original(filename, options)) as any);
    try {
      const response = await request(app).get('/api/admin/files/view').query({ root: 'app', path: 'public.md' }).expect(404);
      expect(JSON.stringify(response.body)).not.toContain('PRIVATE_SECRET');
    } finally { spy.mockRestore(); }
  });

  it('returns the canonical recent logs feed and validates category paths', async () => {
    const data = (await request(app).get('/api/admin/logs/recent?limit=1').expect(200)).body.data;
    expect(data.sources).toContain('admin');
    expect(data.entries).toHaveLength(1);
    expect(data.entries[0]).toMatchObject({ source: 'admin' });
    await request(app).get('/api/admin/logs/INVALID').expect(400);
  });

  it('persists and resets the full canonical dashboard layout within the app data directory', async () => {
    const original = (await request(app).get('/api/admin/dashboard/layout').expect(200)).body.data;
    expect(original.source).toBe('default');
    expect(Object.keys(original.layouts)).toEqual(['lg', 'md', 'sm', 'xs']);
    const update = { ...original, hidden_tiles: ['cpu'] };
    const saved = (await request(app).put('/api/admin/dashboard/layout').send(update).expect(200)).body.data;
    expect(saved.source).toBe('file');
    expect(saved.path).toBe(path.join(locations.W3_DATA_DIR, 'dashboard-layout.json'));
    expect(JSON.parse(await fs.readFile(saved.path, 'utf8')).hidden_tiles).toEqual(['cpu']);
    await request(app).put('/api/admin/dashboard/layout').send({ layouts: { lg: 'invalid' } }).expect(400);
    const reset = (await request(app).post('/api/admin/dashboard/layout/reset').send({}).expect(200)).body.data;
    expect(reset.source).toBe('default');
    expect(reset.hidden_tiles).toEqual([]);
  });

  it('never invents database health or machine capacity when measurements fail', async () => {
    const data = (await request(app).get('/api/admin/system/status').expect(200)).body.data;
    expect(data.status).toBe('degraded');
    expect(data.service).toBe('w3forge-admin.service');
    expect(data.diskUsage.rootVolume.available).toBe(false);
    expect(data.memory.process.rssBytes).toBeGreaterThan(0);
  });

  it('distinguishes a clean checkout from a failed status command', async () => {
    const clean = (await request(app).get('/api/admin/git/status').expect(200)).body.data;
    expect(clean).toMatchObject({ clean: true, status: 'ok', remoteMatchesConfig: true, app_id: 'w3forge' });
    failStatus = true;
    const failed = (await request(app).get('/api/admin/git/status').expect(200)).body.data;
    expect(failed).toMatchObject({ clean: null, uncommittedCount: null, status: 'unavailable' });
  });

  it.each(['/git/check-remote', '/git/branches-dev', '/git/fetch-tags'])('refuses a different app repository before network access: %s', async endpoint => {
    origin = 'git@github.com:Hawkemw1996/w3-buildcost.git';
    const call = endpoint === '/git/branches-dev' ? request(app).get('/api/admin' + endpoint) : request(app).post('/api/admin' + endpoint).send({});
    const data = (await call.expect(200)).body.data;
    expect(data.ok).toBe(false);
    expect(data.repositoryBinding).toBe('mismatch');
    expect(child.run.mock.calls.some(([, args]) => args[0] === 'ls-remote' || args[0] === 'fetch')).toBe(false);
  });

  it('does not disclose credential-bearing origin addresses and refuses to contact them', async () => {
    origin = 'https://token:SECRET_VALUE@github.com/Hawkemw1996/w3-forge.git';
    const status = await request(app).get('/api/admin/git/status').expect(200);
    expect(JSON.stringify(status.body)).not.toContain('SECRET_VALUE');
    expect(status.body.data.remote).toBeNull();
    const checked = await request(app).post('/api/admin/git/check-remote').send({}).expect(200);
    expect(checked.body.data.ok).toBe(false);
    expect(child.run.mock.calls.some(([, args]) => args[0] === 'ls-remote')).toBe(false);
  });

  it('pins the validated repository and keeps Core secrets out of Git subprocesses and failure responses', async () => {
    const checked = (await request(app).post('/api/admin/git/check-remote').send({}).expect(200)).body.data;
    expect(checked).toMatchObject({ ok: true, status: 'remote_ok' });
    const [, args, options] = child.run.mock.calls.find(([, args]) => args[0] === 'ls-remote')!;
    expect(args).toContain(origin);
    expect(args).not.toContain('origin');
    expect(options).toMatchObject({ cwd: locations.W3_DEPLOY_DIR, shell: false, timeout: 15000 });
    expect(options.env).not.toHaveProperty('CORE_APP_CLIENT_SECRET');
    failNetwork = true;
    const failed = await request(app).post('/api/admin/git/check-remote').send({}).expect(200);
    expect(failed.body.data.ok).toBe(false);
    expect(JSON.stringify(failed.body)).not.toContain('secret-from-host');
  });

  it('retains dev-branch policy filtering on the canonical picker', async () => {
    const data = (await request(app).get('/api/admin/git/branches-dev').expect(200)).body.data;
    expect(data.branches.map((b: any) => b.name)).toEqual(['dev/v0.4.1']);
    expect(data.github_workflow.enforce_main_protection).toBe(true);
    expect(data.github_workflow.enforce_release_gate).toBe(true);
  });
  it('reduces control authority consistently in registry, validation and execution', async () => {
    config.controls.allow_legacy_w3forge_controls = false;
    config.github_workflow.allow_release_pipeline = false;
    await saveConfig();
    try {
      const controls = (await request(app).get('/api/admin/controls').expect(200)).body.data.categories.flatMap((g: any) => g.controls);
      expect(controls.every((c: any) => c.enabled === false)).toBe(true);
      const validation = (await request(app).post('/api/admin/controls/status-w3forge/validate').send({}).expect(200)).body.data;
      expect(validation.runnable).toBe(false);
      const run = (await request(app).post('/api/admin/controls/status-w3forge/run').send({}).expect(409)).body.data;
      expect(run.accepted).toBe(false);
      await request(app).post('/api/admin/git/fetch-tags').send({}).expect(409);
      expect(child.run).not.toHaveBeenCalled();
    } finally {
      config.controls.allow_legacy_w3forge_controls = true;
      config.github_workflow.allow_release_pipeline = true;
      await saveConfig();
    }
  });

  it('preserves tag/recovery availability but refuses unconfirmed owner operations', async () => {
    const controls = (await request(app).get('/api/admin/controls').expect(200)).body.data.categories.flatMap((g: any) => g.controls);
    for (const id of ['restore-w3forge', 'pipeline-create-tag', 'pipeline-delete-tag']) {
      expect(controls.find((c: any) => c.id === id).enabled).toBe(true);
      const result = (await request(app).post('/api/admin/controls/' + id + '/run').send({}).expect(409)).body.data;
      expect(result.accepted).toBe(false);
    }
    expect(child.run).not.toHaveBeenCalled();
  });

  it('fails closed for control and file-root access when the config cannot be loaded', async () => {
    await write('config/apps/w3forge.yml', 'invalid: incomplete');
    resetRegistry();
    try {
      const roots = await request(app).get('/api/admin/files/roots').expect(500);
      expect(roots.body.success).toBe(false);
      expect(roots.body.data).toBeUndefined();
      const result = (await request(app).post('/api/admin/controls/status-w3forge/run').send({}).expect(409)).body.data;
      expect(result.accepted).toBe(false);
      const checked = (await request(app).post('/api/admin/git/check-remote').send({}).expect(200)).body.data;
      expect(checked.repositoryBinding).toBe('missing_config');
      expect(child.run.mock.calls.some(([, args]) => args[0] === 'ls-remote')).toBe(false);
    } finally { await saveConfig(); }
  });

  it('passes only nonsecret installation bindings to operational wrappers', async () => {
    const { controlEnvironment } = await import('../src/console/controls/controlEnvironment');
    const env = controlEnvironment();
    expect(env.W3_FORGE_ROOT).toBe(root);
    expect(env.W3_REPO_URL).toBe('https://github.com/Hawkemw1996/w3-forge');
    expect(env.W3_SCRIPTS_DIR).toBe(locations.W3_SCRIPTS_DIR);
    expect(env.W3LOG_ROOT).toBe(locations.W3_LOG_ROOT);
    expect(env.W3_SERVICE_NAME).toBe('w3forge-admin.service');
    expect(env).not.toHaveProperty('CORE_APP_CLIENT_SECRET');
    expect(Object.keys(env).some(key => /PASSWORD|TOKEN|SECRET/.test(key))).toBe(false);
  });

  it('validates the checked-in Forge config independently of retained legacy engineering targets', async () => {
    const registry = await import('../src/console/appRegistry');
    const configDir = path.resolve(__dirname, '../../config/apps');
    const own = registry.getAppConfig('w3forge', { configDir, fresh: true });
    expect(own.app_id).toBe('w3forge');
    expect(own.repo.url).toContain('Hawkemw1996/w3-forge');
    expect(() => registry.getAppConfig('w3core', { configDir, fresh: true })).toThrow();
    const catalog = registry.getRegistrySnapshot({ configDir, fresh: true });
    expect(catalog.apps.some(entry => entry.app_id === 'w3forge')).toBe(true);
    expect(catalog.validation.ok).toBe(false);
    expect(catalog.validation.errors.some(error => error.includes('w3core.yml'))).toBe(true);
  });

  it('rereads the own-app opt-in immediately instead of retaining a cached grant', async () => {
    const registry = await import('../src/console/appRegistry');
    expect(registry.getActiveAppConfig().controls.allow_legacy_w3forge_controls).toBe(true);
    config.controls.allow_legacy_w3forge_controls = false;
    await write('config/apps/w3forge.yml', YAML.stringify(config));
    try {
      expect(registry.getActiveAppConfig().controls.allow_legacy_w3forge_controls).toBe(false);
      const run = (await request(app).post('/api/admin/controls/status-w3forge/run').send({}).expect(409)).body.data;
      expect(run.accepted).toBe(false);
      expect(child.run).not.toHaveBeenCalled();
    } finally { config.controls.allow_legacy_w3forge_controls = true; await saveConfig(); }
  });

});
