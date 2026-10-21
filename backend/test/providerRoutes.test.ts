import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createCoreFixture } from './coreFixture';
import { buildWorkspaceRouter } from '../src/workspace/routes';
import type { createProviderConnections } from '../src/workspace/providerConnections';

function fixture() {
  const core = createCoreFixture();
  const test = vi.fn(async () => ({ id: 'codex', state: 'signed_in', test: { status: 'passed' } }));
  const connections = { test, inventory: vi.fn(async () => []) } as unknown as ReturnType<typeof createProviderConnections>;
  const app = express().use('/api/auth', core.auth.router).use('/api/forge', buildWorkspaceRouter(core.auth, { connections }));
  return { ...core, app, agent: request.agent(app), test };
}
describe('provider test API authorization and input boundary', () => {
  it('requires current Core admin authorization and same-origin mutations before launching any test', async () => {
    const f = fixture();
    expect((await request(f.app).post('/api/forge/services/codex/test').send({})).status).toBe(401);
    await f.login(f.agent);
    f.state.role = 'viewer'; expect((await f.agent.post('/api/forge/services/codex/test').send({})).status).toBe(403);
    f.state.role = 'admin'; expect((await f.agent.post('/api/forge/services/codex/test').set('Origin', 'https://untrusted.test').send({})).status).toBe(403);
    f.state.revoked = true; expect((await f.agent.post('/api/forge/services/codex/test').send({})).status).toBe(401);
    expect(f.test).not.toHaveBeenCalled();
  });
  it('rejects arbitrary providers, prompts, executable paths, users and settings', async () => {
    const f = fixture(); await f.login(f.agent);
    for (const provider of ['perplexity', 'grok', 'root']) expect((await f.agent.post('/api/forge/services/' + provider + '/test').send({})).status).toBe(400);
    for (const body of [{ prompt: 'execute something' }, { account: 'root' }, { executable: '/bin/bash' }, { env: {} }, []]) {
      expect((await f.agent.post('/api/forge/services/codex/test').send(body)).status).toBe(400);
    }
    expect(f.test).not.toHaveBeenCalled();
  });
  it('returns no-store envelopes for both supported provider checks', async () => {
    const f = fixture(); await f.login(f.agent);
    for (const provider of ['codex', 'claude']) {
      const response = await f.agent.post('/api/forge/services/' + provider + '/test').send({});
      expect(response.status).toBe(200); expect(response.headers['cache-control']).toBe('no-store');
      expect(response.body).toMatchObject({ success: true, data: { test: { status: 'passed' } } });
      expect(f.test).toHaveBeenLastCalledWith(provider);
    }
  });
});
