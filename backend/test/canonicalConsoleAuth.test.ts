import express from 'express';
import request from 'supertest';
import fs from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createCoreFixture } from './coreFixture';
import { makeForgeTree } from './setup';
import type { Database } from '../src/db/database';
import type { TerminalRuntime } from '../src/console/terminal/runtime';

let root: string;
let buildConsoleRouter: typeof import('../src/console').buildConsoleRouter;
let createTerminalRuntime: typeof import('../src/console/terminal/runtime').createTerminalRuntime;
const runtimes: TerminalRuntime[] = [];
beforeAll(async () => {
  root = makeForgeTree();
  const config = YAML.parse(await fs.readFile(path.resolve(__dirname, '../../config/apps/w3forge.yml'), 'utf8'));
  for (const key of Object.keys(config.paths)) if (typeof config.paths[key] === 'string') config.paths[key] = path.join(root, key);
  config.paths.workspaces = root;
  config.paths.scripts = path.join(root, 'scripts');
  config.paths.logs = path.join(root, 'logs');
  await fs.writeFile(path.join(root, 'config/apps/w3forge.yml'), YAML.stringify(config));
  vi.stubEnv('W3_FORGE_ROOT', root);
  vi.stubEnv('W3_APP_CONFIG_DIR', path.join(root, 'config/apps'));
  vi.stubEnv('W3_ACTIVE_APP_ID', 'w3forge');
  vi.stubEnv('ADMIN_LOG_DIR', path.join(root, 'logs/admin'));
  vi.stubEnv('W3_DATA_DIR', path.join(root, 'data'));
  vi.stubEnv('ADMIN_ALLOWED_IPS', '*');
  vi.stubEnv('ADMIN_TERMINAL_ENABLED', 'false');
  ({ buildConsoleRouter } = await import('../src/console'));
  ({ createTerminalRuntime } = await import('../src/console/terminal/runtime'));
});
afterEach(() => { for (const runtime of runtimes.splice(0)) runtime.manager.shutdown(); });
afterAll(async () => { vi.unstubAllEnvs(); await fs.rm(root, { recursive: true, force: true }); });

function setup() {
  const fixture = createCoreFixture();
  const db = {
    query: vi.fn().mockRejectedValue(new Error('postgres://secret-database-password@private-host/forge')),
    transaction: vi.fn().mockRejectedValue(new Error('unavailable')),
    ping: vi.fn().mockResolvedValue(false)
  } as unknown as Database;
  const terminal = createTerminalRuntime(fixture.auth);
  runtimes.push(terminal);
  const app = express();
  app.use('/api/auth', fixture.auth.router);
  app.use('/api/admin', buildConsoleRouter('2026-10-06T12:00:00Z', { ...fixture, db, terminal }));
  return { ...fixture, db, app, agent: request.agent(app) };
}

describe('active canonical console integration boundary', () => {
  it('requires Core sign-in for every complete console route and unknown paths', async () => {
    const f = setup();
    for (const endpoint of ['/overview', '/version', '/system/status', '/console-config', '/configuration', '/console/source', '/logs/categories',
      '/logs/recent', '/packages/staged', '/packages/installed-versions', '/backups', '/files/roots',
      '/git/status', '/git/tags', '/git/commits', '/git/branches-dev', '/dashboard/layout', '/controls',
      '/controls/scripts/audit', '/controls/lock', '/terminal/status', '/production-readiness', '/audit-events', '/unknown']) {
      const response = await request(f.app).get('/api/admin' + endpoint);
      expect(response.status, endpoint).toBe(401);
      expect(response.body.error.code).toBe('AUTH_REQUIRED');
    }
    for (const endpoint of ['/git/check-remote', '/git/fetch-tags', '/console/source/check', '/console/source/update', '/controls/restore-w3forge/run',
      '/controls/pipeline-create-tag/run', '/dashboard/layout/reset', '/terminal/sessions', '/production-mode/enable']) {
      expect((await request(f.app).post('/api/admin' + endpoint).send({})).status, endpoint).toBe(401);
    }
    expect((await request(f.app).get('/api/admin/version').set('Authorization', 'Bearer service-token')).status).toBe(401);
    expect(f.db.query).not.toHaveBeenCalled();
  });

  it('uses current app assignments for every request and refuses viewer/editor control access', async () => {
    const f = setup(); await f.login(f.agent);
    expect((await f.agent.get('/api/admin/console-config')).body.data.id).toBe('w3forge');
    for (const role of ['viewer', 'editor']) {
      f.state.role = role;
      expect((await f.agent.get('/api/admin/files/roots')).status).toBe(403);
      expect((await f.agent.post('/api/admin/controls/status-w3forge/run').send({})).status).toBe(403);
      expect((await f.agent.get('/api/admin/terminal/status').set('X-W3-Terminal', '1')).status).toBe(403);
    }
    f.state.role = 'admin';
    expect((await f.agent.get('/api/admin/version')).status).toBe(200);
    expect(f.state.calls.filter(call => call === '/api/app-sign-in/session').length).toBeGreaterThanOrEqual(8);
  });

  it('fails closed for Core outages, revocation and foreign-app tokens', async () => {
    const f = setup(); await f.login(f.agent);
    f.state.down = true;
    expect((await f.agent.get('/api/admin/controls')).status).toBe(503);
    f.state.down = false; f.state.foreignApp = true;
    expect((await f.agent.get('/api/admin/version')).status).toBe(503);
    f.state.foreignApp = false; f.state.revoked = true;
    expect((await f.agent.get('/api/admin/version')).status).toBe(401);
    f.state.revoked = false;
    expect((await f.agent.get('/api/admin/version')).status).toBe(401);
    expect(f.db.query).not.toHaveBeenCalled();
  });

  it('rejects cross-origin and non-JSON mutations before reaching state or control handlers', async () => {
    const f = setup(); await f.login(f.agent);
    await f.agent.put('/api/admin/dashboard/layout').set('Origin', 'https://other-app.test').send({}).expect(403);
    await f.agent.post('/api/admin/controls/status-w3forge/run').set('Sec-Fetch-Site', 'cross-site').send({}).expect(403);
    await f.agent.post('/api/admin/git/check-remote').set('Origin', 'null').send({}).expect(403);
    await f.agent.post('/api/admin/dashboard/layout/reset').type('form').send('x=1').expect(415);
    expect(f.db.query).not.toHaveBeenCalled();
  });

  it('returns common sanitized error envelopes for malformed input, unknown routes and unavailable DB', async () => {
    const f = setup(); await f.login(f.agent);
    const invalid = await f.agent.put('/api/admin/dashboard/layout').set('Content-Type', 'application/json').send('{').expect(400);
    expect(invalid.body.error.code).toBe('INVALID_JSON');
    const missing = await f.agent.get('/api/admin/does-not-exist').expect(404);
    expect(missing.body.success).toBe(false);
    const unavailable = await f.agent.get('/api/admin/audit-events').expect(500);
    expect(unavailable.body.error.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(unavailable.body)).not.toContain('secret-database-password');
    expect(JSON.stringify(unavailable.body)).not.toContain('private-host');
  });

  it('never bypasses terminal opt-in after a valid Core login', async () => {
    const f = setup(); await f.login(f.agent);
    await f.agent.get('/api/admin/terminal/status').expect(403);
    const status = await f.agent.get('/api/admin/terminal/status').set('X-W3-Terminal', '1').expect(200);
    expect(status.body.data.enabled).toBe(false);
    const created = await f.agent.post('/api/admin/terminal/sessions').set('X-W3-Terminal', '1').send({ cols: 100, rows: 30 }).expect(503);
    expect(created.body.error.code).toBe('TERMINAL_UNAVAILABLE');
  });
});
