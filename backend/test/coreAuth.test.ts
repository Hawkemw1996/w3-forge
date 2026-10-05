import { describe, it, expect, beforeAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createCoreFixture } from './coreFixture';
import { makeForgeTree } from './setup';
import { safeReturnPath, createCoreAuth } from '../src/auth/coreAuth';
import { createCoreClient } from '../src/auth/coreClient';

process.env.W3_FORGE_ROOT = makeForgeTree();
process.env.W3_FORGE_ACTIVE_APP = 'w3forge';
process.env.ADMIN_ALLOWED_IPS = '*';
let buildAdminRouter: typeof import('../src/admin').buildAdminRouter;
beforeAll(async () => { buildAdminRouter = (await import('../src/admin')).buildAdminRouter; });
function setup() {
  const fixture = createCoreFixture(), app = express();
  app.use('/api/auth', fixture.auth.router);
  app.use('/api/admin', buildAdminRouter(new Date().toISOString(), fixture.auth));
  return { ...fixture, app, agent: request.agent(app) };
}

describe('Core connection and browser sign-in', () => {
  it('requires identity for every admin route, including unknown paths', async () => {
    const f = setup();
    for (const p of ['/overview', '/files', '/logs', '/version', '/controls', '/git/status', '/nope']) {
      const r = await request(f.app).get('/api/admin' + p);
      expect(r.status).toBe(401); expect(r.body.error.code).toBe('AUTH_REQUIRED');
    }
    expect((await request(f.app).post('/api/admin/controls/config-validate/run').send({})).status).toBe(401);
    expect((await request(f.app).get('/api/admin/version').set('Authorization', 'Bearer service-token')).status).toBe(401);
  });
  it('announces exact app metadata and completes PKCE without forwarding passwords', async () => {
    const f = setup();
    expect((await f.agent.post('/api/auth/login').send({ password: 'secret' })).status).toBe(400);
    expect(f.state.calls).toEqual([]);
    const callback = await f.begin(f.agent, '/admin/files');
    const result = await f.agent.get(callback);
    expect(result.status).toBe(303); expect(result.headers.location).toBe('/admin/files');
    const me = await f.agent.get('/api/auth/status');
    expect(me.body.data.user).toEqual({ id: '1', username: 'operator', appRole: 'admin' });
    expect(me.headers['cache-control']).toBe('no-store');
    expect(JSON.stringify(me.body)).not.toContain('T'.repeat(43));
    expect(f.state.calls).toContain('/api/app-discovery/announce');
    expect((await f.agent.get('/api/admin/controls')).status).toBe(200);
    expect((await f.agent.get(callback)).headers.location).toContain('sign_in=failed');
  });
  it('rejects callbacks from another browser and mismatched state', async () => {
    const f = setup();
    const callback = await f.begin(f.agent);
    expect((await request(f.app).get(callback)).headers.location).toContain('sign_in=failed');
    expect((await f.agent.get(callback.replace(/state=.*/, 'state=bad'))).headers.location).toContain('sign_in=failed');
    expect((await f.agent.get('/api/admin/version')).status).toBe(401);
    expect(f.state.calls).not.toContain('/api/app-sign-in/exchange');
  });
  it('prevents external or authentication return targets', () => {
    for (const p of ['https://evil.test/admin/', '//evil.test/admin', '/api/auth/callback', '/admin\\evil', '/admin/\n/evil']) expect(safeReturnPath(p)).toBe('/admin/');
    expect(safeReturnPath('/admin/files?path=docs')).toBe('/admin/files?path=docs');
  });
  it('requires an app admin assignment, regardless of any platform role', async () => {
    const f = setup(); await f.login(f.agent);
    for (const role of ['viewer', 'editor']) {
      f.state.role = role;
      expect((await f.agent.get('/api/admin/files')).status).toBe(403);
      expect((await f.agent.post('/api/admin/controls/config-validate/run').send({})).status).toBe(403);
    }
    f.state.role = 'admin'; expect((await f.agent.get('/api/admin/version')).status).toBe(200);
  });
  it('rechecks revocation and Core availability on every request', async () => {
    const f = setup(); await f.login(f.agent);
    f.state.down = true; expect((await f.agent.get('/api/admin/version')).status).toBe(503);
    f.state.down = false; expect((await f.agent.get('/api/admin/version')).status).toBe(200);
    f.state.revoked = true; expect((await f.agent.get('/api/admin/version')).status).toBe(401);
    f.state.revoked = false; expect((await f.agent.get('/api/admin/version')).status).toBe(401);
  });
  it('rejects foreign-app and expired identities and never falls back to cached permissions', async () => {
    const f = setup(); await f.login(f.agent);
    f.state.foreignApp = true; expect((await f.agent.get('/api/admin/version')).status).toBe(503);
    f.state.foreignApp = false; f.state.expired = true; expect((await f.agent.get('/api/admin/version')).status).toBe(503);
  });
  it('ends only its app session on logout and binds browser sessions to memory', async () => {
    const f = setup(); await f.login(f.agent);
    expect(f.state.tokens.size).toBe(1);
    expect((await f.agent.post('/api/auth/logout').send({})).status).toBe(200);
    expect(f.state.tokens.size).toBe(0);
    expect((await f.agent.get('/api/admin/version')).status).toBe(401);
  });
  it('rejects cross-origin and non-JSON mutations before execution', async () => {
    const f = setup(); await f.login(f.agent);
    expect((await f.agent.post('/api/auth/login').set('Origin', 'https://evil.test').send({})).status).toBe(403);
    expect((await f.agent.post('/api/auth/login').set('Origin', 'null').send({})).status).toBe(403);
    expect((await f.agent.post('/api/admin/controls/config-validate/run').set('Sec-Fetch-Site', 'cross-site').send({})).status).toBe(403);
    expect((await f.agent.post('/api/auth/logout').type('form').send('x=1')).status).toBe(415);
  });
  it('does not offer local or network-only access when Core is unconfigured', async () => {
    const core = createCoreClient({ baseUrl: '' });
    const auth = createCoreAuth(core, { publicAppUrl: '', publicCoreUrl: '', cookieSecure: false });
    const app = express(); app.use('/api/auth', auth.router);
    expect((await request(app).get('/api/auth/status')).body.data.configured).toBe(false);
    expect((await request(app).post('/api/auth/login').send({})).status).toBe(503);
  });
});
