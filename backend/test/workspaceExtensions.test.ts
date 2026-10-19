import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { createCoreFixture } from './coreFixture';
import { buildWorkspaceRouter } from '../src/workspace/routes';
import { createOllama } from '../src/workspace/ollama';
import { createEnvironmentReader } from '../src/workspace/environments';
import type { Database, Queryable } from '../src/db/database';
import { applyMigrations } from '../src/db/migrate';

const pg = new PGlite();
type Executable = Queryable & { exec(sql: string): Promise<unknown> };
const db: Database = {
  query: async <T>(sql: string, params: unknown[] = []) => { const r = await pg.query<T>(sql, params); return { rows: r.rows, rowCount: r.affectedRows }; },
  ping: async () => true,
  transaction: fn => pg.transaction(async tx => fn({
    query: async <T>(sql: string, params: unknown[] = []) => { const r = await tx.query<T>(sql, params); return { rows: r.rows, rowCount: r.affectedRows }; },
    exec: (sql: string) => tx.exec(sql)
  } as Executable))
};
beforeAll(async () => { await applyMigrations(db, path.resolve(__dirname, '../../database/migrations'), async (tx, sql) => { await (tx as Executable).exec(sql); }); });
afterAll(async () => { await pg.close(); });
const model = 'qwen2.5-coder:14b';
function fixture(database = db) {
  const core = createCoreFixture();
  const ollama = { inventory: vi.fn(async () => ({ models: [{ name: model, size: null, parameterSize: null }], defaultModel: model })),
    chat: vi.fn(async (_model, _messages, _signal, emit) => { await emit({ delta: 'Implement the approved request and validate its acceptance criteria.' }); }) } as ReturnType<typeof createOllama>;
  const services = vi.fn(async () => ({ observedAt: new Date().toISOString(), services: [] }));
  const hardware = vi.fn(async () => ({ observedAt: new Date().toISOString(), host: 'isolated-test-host', scope: 'forge-host' as const,
    os: { platform: 'linux', release: 'fixture', architecture: 'x64', uptimeSeconds: 60 }, cpu: { model: 'Fixture CPU', logicalCores: 4, clockMHz: null, loadAverage: [0,0,0] },
    memory: { totalBytes: 1024, availableBytes: 512 }, storage: { available: true, message: null, devices: [], root: null }, gpu: { available: false, message: 'Not observed', devices: [] } }));
  const app = express().use('/api/auth', core.auth.router).use('/api/forge', buildWorkspaceRouter(core.auth, { db: database, ollama, environments: createEnvironmentReader(async () => []), services, hardware }));
  return { ...core, app, agent: request.agent(app), ollama, services, hardware };
}
async function planning(f: ReturnType<typeof fixture>) {
  const suffix = randomUUID().replaceAll('-', '');
  const p = await f.agent.post('/api/forge/factory/projects').send({ name: 'API fixture', appId: 'app-' + suffix, repositoryUrl: 'https://github.com/W3/' + suffix,
    branch: 'dev/v0.4.4', description: '', rulesTitle: 'Pinned rules', rulesMarkdown: 'Use the approved branch. Preserve existing data.' });
  expect(p.status).toBe(200);
  const r = await f.agent.post('/api/forge/factory/requests').send({ projectId: p.body.data.id, title: 'Improve dashboard', description: 'Build the requested page.', acceptanceCriteria: 'Meaningful validation passes.' });
  expect(r.status).toBe(200);
  const started = await f.agent.post('/api/forge/factory/requests/' + r.body.data.id + '/action').send({ action: 'start_planning', expectedRevision: r.body.data.revision });
  expect(started.status).toBe(200); return started.body.data;
}

describe('factory and host observation API boundaries', () => {
  it('checks current Core admin identity before all new data sources or writes', async () => {
    const f = fixture();
    for (const route of ['/factory', '/hardware', '/services']) expect((await request(f.app).get('/api/forge' + route)).status).toBe(401);
    expect(f.services).not.toHaveBeenCalled(); expect(f.hardware).not.toHaveBeenCalled();
    await f.login(f.agent); f.state.role = 'viewer';
    for (const route of ['/factory', '/hardware', '/services']) expect((await f.agent.get('/api/forge' + route)).status).toBe(403);
    f.state.role = 'admin';
    const cross = await f.agent.post('/api/forge/factory/projects').set('Origin', 'https://untrusted.test').send({});
    expect(cross.status).toBe(403);
    expect(f.services).not.toHaveBeenCalled(); expect(f.hardware).not.toHaveBeenCalled();
    f.state.revoked = true;
    expect((await f.agent.get('/api/forge/hardware')).status).toBe(401);
  });

  it('returns no-store envelopes and a private factory setup error while hardware remains independent', async () => {
    const unavailable: Database = { query: async () => { throw Error('private connection password=fixture-secret'); }, ping: async () => false, transaction: async () => { throw Error('private connection password=fixture-secret'); } };
    const f = fixture(unavailable); await f.login(f.agent);
    const result = await f.agent.get('/api/forge/factory');
    expect(result.status).toBe(503); expect(result.body.error.code).toBe('FACTORY_UNAVAILABLE');
    expect(JSON.stringify(result.body)).not.toContain('fixture-secret');
    const host = await f.agent.get('/api/forge/hardware');
    expect(host.status).toBe(200); expect(host.headers['cache-control']).toBe('no-store'); expect(host.body.data.host).toBe('isolated-test-host');
    expect((await f.agent.get('/api/forge/services')).body).toMatchObject({ success: true, data: { services: [] } });
  });

  it('rejects injected workflow ownership or state and never exposes SQL details', async () => {
    const f = fixture(); await f.login(f.agent); const row = await planning(f);
    const forged = await f.agent.post('/api/forge/factory/requests/' + row.id + '/action').send({ action: 'approve_plan', expectedRevision: row.revision, status: 'update_ready', createdBy: 'other-user' });
    expect(forged.status).toBe(400);
    const snapshot = await f.agent.get('/api/forge/factory');
    expect(snapshot.body.data.requests.find((item: any) => item.id === row.id)).toMatchObject({ status: 'planning', revision: row.revision });
  });

  it('shares model admission with chat and drafts the pinned rules without approving or submitting', async () => {
    const f = fixture(); await f.login(f.agent); const row = await planning(f);
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const wait = new Promise<void>(resolve => { release = resolve; });
    vi.mocked(f.ollama.chat).mockImplementationOnce(async (_model, messages, _signal, emit) => {
      expect(messages[0].content).toContain('Pinned rules'); expect(messages[0].content).toContain('dev/v0.4.4');
      enter(); await wait; await emit({ delta: 'A bounded plan draft.' });
    });
    const pending = f.agent.post('/api/forge/factory/requests/' + row.id + '/draft-plan').send({ model, expectedRevision: row.revision }).then(result => result);
    await entered;
    expect((await f.agent.post('/api/forge/chat').send({ model, messages: [{ role: 'user', content: 'Hello' }] })).status).toBe(429);
    release(); const drafted = await pending;
    expect(drafted.status).toBe(200); expect(drafted.body.data.plan).toBe('A bounded plan draft.');
    const snapshot = await f.agent.get('/api/forge/factory');
    expect(snapshot.body.data.requests.find((item: any) => item.id === row.id)).toMatchObject({ status: 'planning', plan: '', planVersion: 0, revision: row.revision });
    expect((await f.agent.post('/api/forge/chat').send({ model, messages: [{ role: 'user', content: 'Hello' }] })).status).toBe(200);
  });
});
