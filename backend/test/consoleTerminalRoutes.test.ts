import { afterEach, beforeAll, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { makeForgeTree } from './setup';
import { createCoreFixture } from './coreFixture';
import { TerminalSessionManager, type TerminalIdentity } from '../src/console/terminal/sessionManager';
import { fakeTerminal } from './terminalFixture';
import { envelopeErrorHandler } from '../src/admin/envelope';
process.env.W3_FORGE_ROOT = makeForgeTree();
process.env.W3_FORGE_ACTIVE_APP = 'w3forge';
process.env.ADMIN_ALLOWED_IPS = '*';
let buildAdminTerminalRoutes: typeof import('../src/console/routes/terminalRoutes').buildAdminTerminalRoutes;
beforeAll(async () => { buildAdminTerminalRoutes = (await import('../src/console/routes/terminalRoutes')).buildAdminTerminalRoutes; });
const managers: TerminalSessionManager[] = [];
afterEach(() => { for (const manager of managers.splice(0)) manager.shutdown(); });
function setup(enabled = true, pollMs = 1) {
  const fixture = createCoreFixture(), app = express();
  const processes: ReturnType<typeof fakeTerminal>[] = [];
  let owner: TerminalIdentity | undefined;
  const manager = new TerminalSessionManager({ spawn: () => { const p = fakeTerminal(); processes.push(p); return p; },
    authorize: fixture.auth.authorizeAdminSession, audit: () => {}, pollMs });
  managers.push(manager);
  const runtime = { origin: fixture.auth.publicAppUrl, authorize: fixture.auth.authorizeAdminSession,
    identity: (req: express.Request) => { const identity = fixture.auth.adminSession(req); if (identity) owner = identity; return identity; },
    status: () => ({ enabled, supported: true, available: enabled, hostname: 'forge-test', access: 'root-login' as const, message: 'Terminal test.' }), manager };
  app.use('/api/auth', fixture.auth.router);
  app.use('/api/admin', fixture.auth.requireAdmin, fixture.auth.sameOrigin, express.json(), buildAdminTerminalRoutes(runtime), envelopeErrorHandler);
  const agent = request.agent(app);
  const post = (path: string, body: unknown = {}) => agent.post('/api/admin/terminal' + path).set('X-W3-Terminal', '1').send(body);
  const get = (path: string) => agent.get('/api/admin/terminal' + path).set('X-W3-Terminal', '1');
  return { ...fixture, app, agent, manager, processes, post, get, owner: () => owner! };
}

it('requires Core admin identity and explicit same-origin terminal requests on every endpoint', async () => {
  const f = setup();
  expect((await f.get('/status')).status).toBe(401);
  expect((await f.post('/sessions', { cols: 80, rows: 24 })).status).toBe(401);
  await f.login(f.agent);
  expect((await f.agent.get('/api/admin/terminal/status')).status).toBe(403);
  expect((await f.get('/status').set('Origin', 'https://evil.test')).status).toBe(403);
  expect((await f.get('/status').set('Sec-Fetch-Site', 'same-site')).status).toBe(403);
  expect((await f.post('/sessions', { cols: 80, rows: 24 }).set('Origin', 'https://evil.test')).status).toBe(403);
  expect((await f.agent.post('/api/admin/terminal/sessions').set('X-W3-Terminal', '1').type('form').send('cols=80&rows=24')).status).toBe(415);
  f.state.role = 'viewer'; expect((await f.get('/status')).status).toBe(403);
  expect(f.processes).toHaveLength(0);
});

it('preserves envelopes through create, stream, input, resize and close without leaking credentials', async () => {
  const f = setup(); await f.login(f.agent);
  const status = await f.get('/status'); expect(status.body.success).toBe(true); expect(status.headers['cache-control']).toBe('no-store');
  const opened = await f.post('/sessions', { cols: 80, rows: 24 });
  expect(opened.status).toBe(201); const { id } = opened.body.data;
  expect(opened.body.data).toEqual({ id, hostname: 'forge-test', access: 'root-login' });
  expect(JSON.stringify(opened.body)).not.toMatch(/sessionHash|TTTTTTTT|AAAAAAA/);
  f.processes[0].output('shell ready\r\n');
  const output = await f.get(`/sessions/${id}/output?cursor=0`); expect(output.body.data.output).toBe('shell ready\r\n');
  expect((await f.post(`/sessions/${id}/input`, { data: '\u0003' })).body.data.accepted).toBe(true);
  expect((await f.post(`/sessions/${id}/resize`, { cols: 100, rows: 40 })).body.data.resized).toBe(true);
  expect(f.processes[0].write).toHaveBeenCalledWith('\u0003'); expect(f.processes[0].resize).toHaveBeenCalledWith(100, 40);
  expect((await f.post(`/sessions/${id}/close`)).body.data.closed).toBe(true);
  expect(f.processes[0].kill).toHaveBeenCalledTimes(1);
});

it('refuses disabled sessions and malformed dimensions, cursor and input before execution', async () => {
  const disabled = setup(false); await disabled.login(disabled.agent);
  expect((await disabled.post('/sessions', { cols: 80, rows: 24 })).body.error.code).toBe('TERMINAL_UNAVAILABLE');
  expect(disabled.processes).toHaveLength(0);
  const f = setup(); await f.login(f.agent);
  for (const body of [{}, { cols: 9, rows: 24 }, { cols: 80, rows: 201 }, { cols: 80.5, rows: 24 }]) {
    expect((await f.post('/sessions', body)).body.error.code).toBe('TERMINAL_SIZE_INVALID');
  }
  const id = (await f.post('/sessions', { cols: 80, rows: 24 })).body.data.id;
  expect((await f.post(`/sessions/${id}/input`, { data: '' })).status).toBe(400);
  expect((await f.post(`/sessions/${id}/input`, { data: 'x'.repeat(8193) })).status).toBe(400);
  expect((await f.get(`/sessions/${id}/output?cursor=bad`)).status).toBe(400);
  expect((await f.post(`/sessions/${id}/resize`, { cols: 999, rows: 40 })).status).toBe(400);
  expect(f.processes[0].write).not.toHaveBeenCalled(); expect(f.processes[0].resize).not.toHaveBeenCalled();
});

it('does not allow another login for the same user to read, write, resize or close a terminal', async () => {
  const f = setup(); await f.login(f.agent);
  const id = (await f.post('/sessions', { cols: 80, rows: 24 })).body.data.id;
  const other = request.agent(f.app); await f.login(other);
  for (const suffix of ['input', 'resize', 'close']) {
    const body = suffix === 'input' ? { data: 'whoami\r' } : suffix === 'resize' ? { cols: 80, rows: 24 } : {};
    expect((await other.post(`/api/admin/terminal/sessions/${id}/${suffix}`).set('X-W3-Terminal', '1').send(body)).status).toBe(404);
  }
  expect((await other.get(`/api/admin/terminal/sessions/${id}/output?cursor=0`).set('X-W3-Terminal', '1')).status).toBe(404);
});

it('revokes idle terminals after logout, role removal, Core revocation, outage or invalid identity', async () => {
  for (const change of ['logout', 'viewer', 'revoked', 'down', 'foreignApp', 'expired']) {
    const f = setup(); await f.login(f.agent); await f.post('/sessions', { cols: 80, rows: 24 });
    if (change === 'logout') await f.agent.post('/api/auth/logout').send({});
    else if (change === 'viewer') f.state.role = 'viewer';
    else f.state[change as 'revoked' | 'down' | 'foreignApp' | 'expired'] = true;
    await f.manager.reap(); expect(f.processes[0].kill).toHaveBeenCalledTimes(1);
  }
});

it('revalidates held reads after logout and refuses their private output', async () => {
  const f = setup(true, 5_000); await f.login(f.agent);
  const id = (await f.post('/sessions', { cols: 80, rows: 24 })).body.data.id;
  const pendingRead = f.manager.read(id, f.owner(), 0);
  await f.agent.post('/api/auth/logout').send({});
  f.processes[0].output('PRIVATE_OUTPUT');
  await expect(pendingRead).rejects.toMatchObject({ code: 'TERMINAL_AUTH_EXPIRED' });
  expect(f.processes[0].kill).toHaveBeenCalledTimes(1);
});

it('does not authorize a stale successful Core check that completes after local logout', async () => {
  const f = setup(); await f.login(f.agent);
  await f.post('/sessions', { cols: 80, rows: 24 });
  const owner = f.owner();
  const verified = await f.core.me('T'.repeat(43));
  let release!: (result: typeof verified) => void;
  f.core.me = () => new Promise(resolve => { release = resolve; });
  const pendingAuthorization = f.auth.authorizeAdminSession(owner);
  await f.agent.post('/api/auth/logout').send({});
  release(verified);
  expect(await pendingAuthorization).toBe(false);
});


it('closes an idle terminal when the Forge session-encryption key is rotated', async () => {
  const f = setup(); await f.login(f.agent); await f.post('/sessions', { cols: 80, rows: 24 });
  f.authOptions.sessionSecret='rotated-terminal-session-secret-0123456789';
  await f.manager.reap();
  expect(f.processes[0].kill).toHaveBeenCalledTimes(1);
});
