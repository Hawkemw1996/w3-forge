import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import fsSync, { type Dir, type Dirent, type Stats } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { makeForgeTree } from './setup';
import { createCoreFixture } from './coreFixture';
import type { ForgeAppConfig } from '../src/admin/forgeConfig';

let inventory: typeof import('../src/admin/routes/inventoryRoutes');
let buildAdminRouter: typeof import('../src/admin')['buildAdminRouter'];
let routeRoot: string;
let routeStaged: string;
const roots: string[] = [];
const tempBase = path.resolve(os.tmpdir());

function config(): ForgeAppConfig {
  const root = fsSync.mkdtempSync(path.join(os.tmpdir(), 'forge-inventory-test-'));
  roots.push(root);
  const cfg: ForgeAppConfig = {
    app_id: 'w3forge', name: 'W3 Forge', version: '0.4.1', repo: { allowed_branch_pattern: '^dev/v' },
    paths: { deploy: root, runtime: root, workspaces: root, scripts: path.join(root, 'scripts'), logs: path.join(root, 'logs'), backups: path.join(root, 'backups'), packages_staged: path.join(root, 'staged'), packages_installed: path.join(root, 'installed') },
    authority: { may_deploy: false, may_tag_release: false, may_modify_production_data: false }
  };
  for (const dir of [cfg.paths.backups, cfg.paths.packages_staged!, cfg.paths.packages_installed!]) fsSync.mkdirSync(dir);
  return cfg;
}
function entry(name: string, kind: 'file' | 'dir' | 'link'): Dirent {
  return { name, isFile: () => kind === 'file', isDirectory: () => kind === 'dir', isSymbolicLink: () => kind === 'link' } as Dirent;
}
function stat(kind: 'file' | 'dir' | 'link'): Stats {
  return { size: 10, mtime: new Date('2026-10-06T00:00:00Z'), isFile: () => kind === 'file', isDirectory: () => kind === 'dir', isSymbolicLink: () => kind === 'link' } as Stats;
}
function directory(entries: Dirent[]): Dir {
  return (async function* () { for (const value of entries) yield value; })() as unknown as Dir;
}
function error(code: string) { return Object.assign(new Error('private filesystem diagnostic'), { code }); }

beforeAll(async () => {
  routeRoot = makeForgeTree(); roots.push(routeRoot);
  routeStaged = path.join(routeRoot, 'staged');
  fsSync.mkdirSync(routeStaged);
  fsSync.mkdirSync(path.join(routeRoot, 'backups'));
  fsSync.writeFileSync(path.join(routeStaged, 'w3forge-v0.4.1.tar.gz'), 'private archive contents');
  const configPath = path.join(routeRoot, 'config', 'apps', 'w3forge.yml');
  const yaml = fsSync.readFileSync(configPath, 'utf8').replace('  backups: ', `  packages_staged: ${routeStaged}\n  backups: `);
  fsSync.writeFileSync(configPath, yaml);
  process.env.W3_FORGE_ROOT = routeRoot;
  process.env.W3_FORGE_ACTIVE_APP = 'w3forge';
  process.env.ADMIN_ALLOWED_IPS = '*';
  process.env.ADMIN_TERMINAL_ENABLED = 'false';
  inventory = await import('../src/admin/routes/inventoryRoutes');
  ({ buildAdminRouter } = await import('../src/admin'));
});
afterEach(() => { vi.restoreAllMocks(); });
afterAll(async () => {
  for (const root of roots) {
    const resolved = path.resolve(root);
    if (resolved.startsWith(tempBase + path.sep) && /^forge-(?:inventory-test|test)-/.test(path.basename(resolved))) {
      await fs.rm(resolved, { recursive: true, force: true });
    }
  }
});

describe('read-only inventory listings', () => {
  it('distinguishes unconfigured, invalid, missing, non-directory, and ready-empty roots', async () => {
    const cfg = config();
    expect((await inventory.listPackages({ ...cfg, paths: { ...cfg.paths, packages_staged: undefined } }, 'staged')).connection.state).toBe('not_configured');
    const invalid = await inventory.listPackages({ ...cfg, paths: { ...cfg.paths, packages_staged: 'relative/path' } }, 'staged');
    expect(invalid).toMatchObject({ root: null, connection: { configured: true, available: false, state: 'unavailable' }, packages: [] });
    const missing = await inventory.listPackages({ ...cfg, paths: { ...cfg.paths, packages_staged: path.join(cfg.paths.deploy, 'missing') } }, 'staged');
    expect(missing.connection).toMatchObject({ configured: true, available: false, state: 'missing' });
    const fileRoot = path.join(cfg.paths.deploy, 'file-root'); await fs.writeFile(fileRoot, 'not a directory');
    expect((await inventory.listPackages({ ...cfg, paths: { ...cfg.paths, packages_staged: fileRoot } }, 'staged')).connection.state).toBe('missing');
    expect(await inventory.listPackages(cfg, 'staged')).toMatchObject({ connection: { state: 'ready', available: true }, packages: [], truncated: false });
    expect(await inventory.listBackups({ ...cfg, paths: { ...cfg.paths, backups: '' } })).toMatchObject({ connection: { state: 'not_configured' }, backups: [], totalSizeBytes: 0 });
    expect(await inventory.listBackups(cfg)).toMatchObject({ connection: { state: 'ready', available: true }, backups: [], totalSizeBytes: 0 });
  });

  it('lists only this app’s flat and canonical packages with metadata, retaining malformed own-app names', async () => {
    const cfg = config(), root = cfg.paths.packages_staged!;
    await fs.writeFile(path.join(root, 'w3forge-v0.4.1.tar.gz'), 'private archive contents');
    await fs.writeFile(path.join(root, 'w3forge-review.tar.gz'), 'draft');
    await fs.writeFile(path.join(root, 'w3buildcost-v0.4.1.tar.gz'), 'other app');
    await fs.writeFile(path.join(root, 'unrelated.tar.gz'), 'unrelated');
    await fs.mkdir(path.join(root, 'v0.4.2')); await fs.writeFile(path.join(root, 'v0.4.2', 'w3forge.tar.gz'), 'canonical');
    await fs.mkdir(path.join(root, 'v0.4.3')); await fs.writeFile(path.join(root, 'v0.4.3', 'w3buildcost.tar.gz'), 'other app canonical');
    const readFile = vi.spyOn(fs, 'readFile');
    const data = await inventory.listPackages(cfg, 'staged');
    expect(data.connection.state).toBe('ready');
    expect(data.packages).toHaveLength(3);
    expect(data.packages).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'w3forge-v0.4.1.tar.gz', parsedVersion: '0.4.1', layout: 'legacy-flat', validName: true }),
      expect.objectContaining({ name: 'w3forge-review.tar.gz', parsedVersion: null, layout: 'legacy-flat', validName: false }),
      expect.objectContaining({ name: 'w3forge.tar.gz', path: path.join(root, 'v0.4.2', 'w3forge.tar.gz'), parsedVersion: '0.4.2', layout: 'canonical', validName: true })
    ]));
    expect(JSON.stringify(data)).not.toMatch(/w3buildcost|unrelated|private archive contents/);
    expect(data.packages.every(value => Number.isFinite(value.sizeBytes) && Number.isFinite(Date.parse(value.mtime)))).toBe(true);
    expect(readFile).not.toHaveBeenCalled();
    expect((await inventory.listPackages(cfg, 'installed')).packages).toEqual([]);
  });

  it('lists only this app’s supported backups and reports actual archive/database totals', async () => {
    const cfg = config();
    const names = ['w3forge-v0.4.1-archive.tar.gz', 'w3forge_2026-10-06.sql.gz', 'w3forge-backup.zip', 'w3forge-db.sql', 'w3buildcost-db.sql', 'w3forge-other.txt', 'w3forgex-db.sql'];
    for (const name of names) await fs.writeFile(path.join(cfg.paths.backups, name), '12345');
    const data = await inventory.listBackups(cfg);
    expect(data.connection.state).toBe('ready');
    expect(data.backups).toHaveLength(4);
    expect(data.totalSizeBytes).toBe(20);
    expect(data.backups.filter(value => value.kind === 'database')).toHaveLength(2);
    expect(data.backups.find(value => value.name === names[0])?.parsedVersion).toBe('0.4.1');
    expect(JSON.stringify(data)).not.toMatch(/w3buildcost|w3forgex|other.txt/);
  });

  it('rejects configured symbolic-link roots before opening either inventory', async () => {
    const cfg = config();
    vi.spyOn(fs, 'lstat').mockResolvedValue(stat('link'));
    const opendir = vi.spyOn(fs, 'opendir');
    expect(await inventory.listPackages(cfg, 'staged')).toMatchObject({ connection: { state: 'unavailable', available: false }, packages: [] });
    expect(await inventory.listBackups(cfg)).toMatchObject({ connection: { state: 'unavailable', available: false }, backups: [] });
    expect(opendir).not.toHaveBeenCalled();
  });

  it('skips symlink entries and file/directory entries replaced by links before metadata inspection', async () => {
    const cfg = config(), root = cfg.paths.packages_staged!;
    vi.spyOn(fs, 'opendir').mockResolvedValue(directory([
      entry('w3forge-v0.4.1.tar.gz', 'link'), entry('w3forge-v0.4.2.tar.gz', 'file'), entry('v0.4.3', 'dir'), entry('w3forge-v0.4.4.tar.gz', 'file')
    ]));
    const lstat = vi.spyOn(fs, 'lstat').mockImplementation(async (file) => {
      if (String(file) === root) return stat('dir');
      if (String(file).endsWith('w3forge-v0.4.4.tar.gz')) return stat('file');
      return stat('link');
    });
    const data = await inventory.listPackages(cfg, 'staged');
    expect(data.packages.map(value => value.name)).toEqual(['w3forge-v0.4.4.tar.gz']);
    expect(lstat.mock.calls.some(([file]) => String(file).endsWith('w3forge-v0.4.1.tar.gz'))).toBe(false);
    expect(lstat.mock.calls.some(([file]) => String(file).endsWith(path.join('v0.4.3', 'w3forge.tar.gz')))).toBe(false);
  });

  it('does not follow a backup file replaced by a symbolic link', async () => {
    const cfg = config();
    vi.spyOn(fs, 'opendir').mockResolvedValue(directory([entry('w3forge-db.sql', 'file')]));
    vi.spyOn(fs, 'lstat').mockImplementation(async file => String(file) === cfg.paths.backups ? stat('dir') : stat('link'));
    expect(await inventory.listBackups(cfg)).toMatchObject({ connection: { state: 'ready' }, backups: [], totalSizeBytes: 0 });
  });

  it.each(['packages', 'backups'] as const)('caps the %s scan and reports truncation', async kind => {
    const cfg = config();
    vi.spyOn(fs, 'opendir').mockResolvedValue(directory([entry('w3forge-v0.4.1.tar.gz', 'file'), entry('w3forge-v0.4.2.tar.gz', 'file'), entry('w3forge-v0.4.3.tar.gz', 'file')]));
    const lstat = vi.spyOn(fs, 'lstat').mockImplementation(async file => [cfg.paths.backups, cfg.paths.packages_staged].includes(String(file)) ? stat('dir') : stat('file'));
    const data = kind === 'packages' ? await inventory.listPackages(cfg, 'staged', 2) : await inventory.listBackups(cfg, 2);
    expect(data).toMatchObject({ connection: { state: 'ready' }, truncated: true });
    expect('packages' in data ? data.packages : data.backups).toHaveLength(2);
    expect(lstat.mock.calls.some(([file]) => String(file).endsWith('w3forge-v0.4.3.tar.gz'))).toBe(false);
  });

  it.each(['packages', 'backups'] as const)('clears partial %s results when later metadata is inaccessible', async kind => {
    const cfg = config();
    vi.spyOn(fs, 'opendir').mockResolvedValue(directory([entry('w3forge-v0.4.1.tar.gz', 'file'), entry('w3forge-v0.4.2.tar.gz', 'file')]));
    vi.spyOn(fs, 'lstat').mockImplementation(async file => {
      if ([cfg.paths.backups, cfg.paths.packages_staged].includes(String(file))) return stat('dir');
      if (String(file).endsWith('w3forge-v0.4.2.tar.gz')) throw error('EACCES');
      return stat('file');
    });
    const data = kind === 'packages' ? await inventory.listPackages(cfg, 'staged') : await inventory.listBackups(cfg);
    expect(data.connection).toMatchObject({ configured: true, available: false, state: 'unavailable' });
    expect('packages' in data ? data.packages : data.backups).toEqual([]);
    if ('totalSizeBytes' in data) expect(data.totalSizeBytes).toBe(0);
    expect(JSON.stringify(data)).not.toContain('private filesystem diagnostic');
  });

  it('treats an archive removed during a listing as absent rather than exposing stale metadata', async () => {
    const cfg = config();
    vi.spyOn(fs, 'opendir').mockResolvedValue(directory([entry('w3forge-v0.4.1.tar.gz', 'file')]));
    vi.spyOn(fs, 'lstat').mockImplementation(async file => {
      if (String(file) === cfg.paths.packages_staged) return stat('dir');
      throw error('ENOENT');
    });
    expect(await inventory.listPackages(cfg, 'staged')).toMatchObject({ connection: { state: 'ready' }, packages: [] });
  });
});

describe('inventory routes under the Core admin guard', () => {
  function guarded() {
    const auth = createCoreFixture(), app = express();
    app.use('/api/auth', auth.auth.router);
    app.use('/api/admin', buildAdminRouter('2026-10-06T00:00:00Z', auth.auth));
    return { app, auth, agent: request.agent(app) };
  }
  it('requires an assigned admin and revalidates each inventory request', async () => {
    const { app, auth, agent } = guarded();
    for (const route of ['/packages/staged', '/packages/installed', '/backups']) expect((await request(app).get('/api/admin' + route)).status).toBe(401);
    await auth.login(agent);
    expect((await agent.get('/api/admin/packages/staged')).status).toBe(200);
    auth.state.role = 'viewer'; expect((await agent.get('/api/admin/backups')).status).toBe(403);
    auth.state.role = 'admin'; auth.state.down = true; expect((await agent.get('/api/admin/packages/staged')).status).toBe(503);
    auth.state.down = false; auth.state.revoked = true; expect((await agent.get('/api/admin/packages/installed')).status).toBe(401);
  });
  it('ignores browser-supplied roots and app identities and exposes no write/download actions', async () => {
    const { auth, agent } = guarded(); await auth.login(agent);
    const response = await agent.get('/api/admin/packages/staged').query({ root: path.join(routeRoot, 'outside'), path: '..', app: 'w3core', limit: '99999999' });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ success: true, data: { app: { id: 'w3forge' }, root: routeStaged, connection: { state: 'ready' } } });
    expect(response.body.data.packages.map((value: { name: string }) => value.name)).toEqual(['w3forge-v0.4.1.tar.gz']);
    expect(JSON.stringify(response.body)).not.toContain('private archive contents');
    for (const route of ['/packages/staged', '/packages/installed', '/backups', '/packages/download', '/backups/restore']) {
      expect((await agent.post('/api/admin' + route).send({})).status).toBe(404);
      expect((await agent.delete('/api/admin' + route).send({})).status).toBe(404);
    }
    expect((await agent.get('/api/admin/packages/download').query({ path: path.join(routeStaged, 'w3forge-v0.4.1.tar.gz') })).status).toBe(404);
  });
});
