import { describe, it, expect, beforeAll, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createCoreFixture } from './coreFixture';
import { makeForgeTree } from './setup';
import { safeReturnPath, createCoreAuth } from '../src/auth/coreAuth';
import { createCoreClient } from '../src/auth/coreClient';
import * as sessionCrypto from '../src/auth/sessionCrypto';

process.env.W3_FORGE_ROOT = makeForgeTree();
process.env.W3_FORGE_ACTIVE_APP = 'w3forge';
process.env.ADMIN_ALLOWED_IPS = '*';
let buildAdminRouter: typeof import('../src/admin').buildAdminRouter;
beforeAll(async () => { buildAdminRouter = (await import('../src/admin')).buildAdminRouter; });
function setup(sessionOptions: Parameters<typeof createCoreFixture>[0] = {}) {
  const fixture = createCoreFixture(sessionOptions), app = express();
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
    expect(me.body.data.user).toEqual({ coreUserId: '1', username: 'operator', displayName: 'operator', coreRole: 'admin', appRole: 'admin', permissions: ['forge:read', 'forge:write', 'forge:admin'], coreStatus: 'verified', lastVerifiedAt: expect.any(String), expiresAt: expect.any(String) });
    expect(me.headers['cache-control']).toBe('no-store');
    expect(JSON.stringify(me.body)).not.toContain('T'.repeat(43));
    expect(f.state.calls).toContain('/api/app-discovery/announce');
    expect((await f.agent.get('/api/admin/controls')).status).toBe(200);
    expect((await f.agent.get(callback)).headers.location).toBe('/forge/login?error=sign_in_failed');
  });
  it('rejects callbacks from another browser and mismatched state', async () => {
    const f = setup();
    const callback = await f.begin(f.agent);
    expect((await request(f.app).get(callback)).headers.location).toBe('/forge/login?error=sign_in_failed');
    expect((await f.agent.get(callback.replace(/state=.*/, 'state=bad'))).headers.location).toBe('/forge/login?error=sign_in_failed');
    expect((await f.agent.get('/api/admin/version')).status).toBe(401);
    expect(f.state.calls).not.toContain('/api/app-sign-in/exchange');
  });
  it('prevents external or authentication return targets', () => {
    for (const p of ['https://evil.test/admin/', '//evil.test/admin', '/api/auth/callback', '/admin\\evil', '/admin/\n/evil']) expect(safeReturnPath(p)).toBe('/forge');
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


describe('shared W3 session encryption standard', () => {
  it('blocks sign-in before contacting Core when the session key is missing or reused', async () => {
    for(const options of [{sessionSecret:''},{sessionSecret:'A'.repeat(43)},{serviceToken:'A'.repeat(43)}]){
      const f=setup(options);
      const status=await f.agent.get('/api/auth/status');
      expect(status.body.data.configured).toBe(false);
      expect(status.body.data.setupError).toBeTypeOf('string');
      expect((await f.agent.post('/api/auth/login').send({})).status).toBe(503);
      expect(f.state.calls).toEqual([]);
      expect(f.state.tokens.size).toBe(0);
    }
  });
  it('seals Core tokens on login and decrypts them only for session validation and logout', async () => {
    const seal=vi.spyOn(sessionCrypto,'encryptCoreSession');
    const open=vi.spyOn(sessionCrypto,'decryptCoreSession');
    try {
      const f=setup(); await f.login(f.agent);
      expect(seal).toHaveBeenCalledWith('T'.repeat(43),f.authOptions.sessionSecret);
      const sealed=seal.mock.results.at(-1)!.value;
      expect(sealed).not.toContain('T'.repeat(43));
      expect((await f.agent.get('/api/admin/version')).status).toBe(200);
      expect(open).toHaveBeenCalledWith(sealed,f.authOptions.sessionSecret);
      const status=await f.agent.get('/api/auth/status');
      expect(JSON.stringify(status.body)).not.toContain(sealed);
      expect(JSON.stringify(status.body)).not.toContain(f.authOptions.sessionSecret);
      expect((await f.agent.post('/api/auth/logout').send({})).status).toBe(200);
      expect(f.state.tokens.size).toBe(0);
    } finally {seal.mockRestore();open.mockRestore();}
  });
  it('drops local sessions after session-key rotation and never revives them with the old key', async () => {
    const f=setup();await f.login(f.agent);
    const before=f.authOptions.sessionSecret;
    f.authOptions.sessionSecret='rotated-session-secret-01234567890123456789';
    const calls=f.state.calls.length;
    expect((await f.agent.get('/api/admin/version')).status).toBe(401);
    expect(f.state.calls).toHaveLength(calls);
    f.authOptions.sessionSecret=before;
    expect((await f.agent.get('/api/admin/version')).status).toBe(401);
    expect((await f.agent.post('/api/auth/logout').send({})).status).toBe(200);
  });
  it('refuses a callback if encryption configuration becomes invalid before exchange', async () => {
    const f=setup();const callback=await f.begin(f.agent);
    f.authOptions.sessionSecret='';
    expect((await f.agent.get(callback)).headers.location).toBe('/forge/core-unavailable');
    expect(f.state.calls).not.toContain('/api/app-sign-in/exchange');
    expect(f.state.tokens.size).toBe(0);
  });
});


describe('canonical console authentication contract', () => {
  it('returns canonical status and /me permissions only from current app assignments', async () => {
    const f = setup();
    const anonymous = await f.agent.get('/api/auth/status');
    expect(anonymous.body.data).toMatchObject({ identityProvider: 'w3core', coreConfigured: true, loginAvailable: true, loginUnavailableReason: null, authenticated: false, user: null, sessionError: null });
    expect((await f.agent.get('/api/auth/me')).status).toBe(401);
    await f.login(f.agent);
    for (const [role, permissions] of [
      ['admin', ['forge:read', 'forge:write', 'forge:admin']],
      ['editor', ['forge:read', 'forge:write']],
      ['viewer', ['forge:read']]
    ] as const) {
      f.state.role = role;
      const me = await f.agent.get('/api/auth/me');
      expect(me.status).toBe(200);
      expect(me.body.data).toMatchObject({ coreUserId: '1', displayName: 'operator', coreRole: role, appRole: role, permissions, coreStatus: 'verified' });
      expect(Date.parse(me.body.data.lastVerifiedAt)).toBeLessThanOrEqual(Date.now());
      expect(Date.parse(me.body.data.expiresAt)).toBeGreaterThan(Date.now());
    }
  });
  it('reports Core outages in canonical status without authenticating stale data', async () => {
    const f = setup(); await f.login(f.agent); f.state.down = true;
    const status = await f.agent.get('/api/auth/status');
    expect(status.status).toBe(200);
    expect(status.body.data).toMatchObject({ authenticated: false, user: null, sessionError: { code: 'CORE_UNAVAILABLE' } });
    expect((await f.agent.get('/api/auth/me')).status).toBe(503);
    expect((await f.agent.get('/api/admin/version')).status).toBe(503);
    f.state.down = false; f.state.revoked = true;
    expect((await f.agent.get('/api/auth/me')).status).toBe(401);
    f.state.revoked = false;
    expect((await f.agent.get('/api/auth/status')).body.data.authenticated).toBe(false);
  });
  it('keeps local two-factor handling unavailable and accepts only safe app return routes', async () => {
    const f = setup();
    const legacy = await f.agent.post('/api/auth/login/verify-2fa').send({ code: '123456' });
    expect(legacy.status).toBe(410); expect(legacy.body.error.code).toBe('CORE_SIGN_IN_REQUIRED');
    expect(f.state.calls).toEqual([]);
    for (const target of ['/forge/login', '/forge/access-denied', '/forge/core-unavailable', '/forge/%2flogin', '/forge/%5c%5cevil.test', '/forge/%0aevil', '/forge/%']) expect(safeReturnPath(target)).toBe('/forge');
    expect(safeReturnPath('/forge/chat?room=one')).toBe('/forge/chat?room=one');
    const signedIn = await f.agent.get(await f.begin(f.agent, '/forge/chat?room=one'));
    expect(signedIn.headers.location).toBe('/forge/chat?room=one');
  });
});
