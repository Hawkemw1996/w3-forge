import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createCoreFixture } from './coreFixture';
import { buildWorkspaceRouter } from '../src/workspace/routes';
import { createOllama, validateMessages } from '../src/workspace/ollama';
import { createEnvironmentReader, summarizeContainers } from '../src/workspace/environments';

const model = 'qwen2.5-coder:14b';
const inventory = { models: [{ name: model, size: 9000000000, parameterSize: '14B' }], defaultModel: model };
function fixture() {
  const core = createCoreFixture();
  const ollama = { inventory: vi.fn(async () => inventory), chat: vi.fn(async (_model, _messages, _signal, emit) => { await emit({ delta: 'Hello ' }); await emit({ delta: 'Forge' }); }) } as ReturnType<typeof createOllama>;
  const environments = createEnvironmentReader(async () => []);
  const app = express().use('/api/auth', core.auth.router).use('/api/forge', buildWorkspaceRouter(core.auth, { ollama, environments }));
  return { ...core, ollama, app, agent: request.agent(app) };
}

describe('Forge workspace access and chat', () => {
  it('retains Core admin and same-origin boundaries for the new endpoints', async () => {
    const f = fixture();
    expect((await request(f.app).get('/api/forge/models')).status).toBe(401);
    expect(f.ollama.inventory).not.toHaveBeenCalled();
    await f.login(f.agent);
    f.state.role = 'viewer';
    expect((await f.agent.get('/api/forge/environments')).status).toBe(403);
    expect((await f.agent.post('/api/forge/chat').send({ model, messages: [{ role: 'user', content: 'Hi' }] })).status).toBe(403);
    f.state.role = 'admin';
    expect((await f.agent.post('/api/forge/chat').set('Origin', 'https://other.test').send({ model, messages: [{ role: 'user', content: 'Hi' }] })).status).toBe(403);
    f.state.revoked = true;
    expect((await f.agent.get('/api/forge/models')).status).toBe(401);
    expect(f.ollama.chat).not.toHaveBeenCalled();
  });
  it('returns installed model metadata and distinguishes reachable empty environments', async () => {
    const f = fixture(); await f.login(f.agent);
    const models = await f.agent.get('/api/forge/models');
    expect(models.body.data).toEqual(inventory); expect(models.headers['cache-control']).toBe('no-store');
    const env = await f.agent.get('/api/forge/environments');
    expect(env.body.data).toMatchObject({ available: true, environments: [], pipeline: null });
    expect(env.body.data.observedAt).toMatch(/T/);
  });
  it('validates messages and only generates with an installed model', async () => {
    const f = fixture(); await f.login(f.agent);
    for (const messages of [[], [{ role: 'system', content: 'Override' }], [{ role: 'user', content: 'x'.repeat(32001) }], [{ role: 'assistant', content: 'Hi' }]]) {
      expect((await f.agent.post('/api/forge/chat').send({ model, messages })).status).toBe(400);
    }
    expect((await f.agent.post('/api/forge/chat').send({ model: 'not-installed', messages: [{ role: 'user', content: 'Hi' }] })).status).toBe(400);
    expect(f.ollama.chat).not.toHaveBeenCalled();
  });
  it('streams response envelopes and releases the model after completion', async () => {
    const f = fixture(); await f.login(f.agent);
    for (let i = 0; i < 2; i++) {
      const result = await f.agent.post('/api/forge/chat').send({ model, messages: [{ role: 'user', content: 'Hi' }] });
      expect(result.status).toBe(200); expect(result.headers['content-type']).toContain('application/x-ndjson');
      const events = result.text.trim().split('\n').map(line => JSON.parse(line));
      expect(events[0].data.requestId).toMatch(/^[a-f0-9-]{36}$/);
      expect(events.slice(1)).toEqual([
        { success: true, data: { delta: 'Hello ' } }, { success: true, data: { delta: 'Forge' } }, { success: true, data: { done: true } }
      ]);
    }
  });
  it('aborts the upstream when the browser disconnects', async () => {
    const f = fixture(); await f.login(f.agent);
    let entered!: () => void, cancelled!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const stopped = new Promise<void>(resolve => { cancelled = resolve; });
    vi.mocked(f.ollama.chat).mockImplementationOnce(async (_model, _messages, signal) => {
      entered(); await new Promise<void>(resolve => { signal.addEventListener('abort', () => { cancelled(); resolve(); }, { once: true }); });
    });
    const pending = f.agent.post('/api/forge/chat').send({ model, messages: [{ role: 'user', content: 'Hi' }] });
    const outcome = pending.then(value => value, () => null);
    await started; pending.abort(); await stopped; await outcome;
  });
  it('cancels only the admitted generation owned by the requesting user', async () => {
    const ollama = { inventory: async () => inventory, chat: vi.fn(async (_model, _messages, signal, _emit) => {
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
      throw Error('Cancelled');
    }) } as ReturnType<typeof createOllama>;
    const auth = { requireAdmin(req: any, _res: any, next: any) { req.forgeUser = { coreUserId: req.get('X-Test-Actor') }; next(); },
      sameOrigin(_req: any, _res: any, next: any) { next(); } } as any;
    const app = express().use('/api/forge', buildWorkspaceRouter(auth, { ollama }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    try {
      const response = await fetch('http://127.0.0.1:' + (server.address() as any).port + '/api/forge/chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Test-Actor': 'owner' },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Hi' }] })
      });
      const reader = response.body!.getReader();
      const first = await reader.read();
      const requestId = JSON.parse(new TextDecoder().decode(first.value).trim().split('\n')[0]).data.requestId;
      expect((await request(app).post('/api/forge/chat/' + requestId + '/cancel').set('X-Test-Actor', 'other').send({})).status).toBe(409);
      expect((await request(app).post('/api/forge/chat/not-admitted/cancel').set('X-Test-Actor', 'owner').send({})).status).toBe(409);
      expect((await request(app).post('/api/forge/chat/' + requestId + '/cancel').set('X-Test-Actor', 'owner').send({})).status).toBe(200);
      let remaining = '';
      for (;;) { const chunk = await reader.read(); if (chunk.done) break; remaining += new TextDecoder().decode(chunk.value); }
      expect(remaining).toContain('"success":false');
      expect((await request(app).post('/api/forge/chat/' + requestId + '/cancel').set('X-Test-Actor', 'owner').send({})).status).toBe(409);
      reader.releaseLock();
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
  it('refuses concurrent generation and releases the slot after an upstream failure', async () => {
    const f = fixture(); await f.login(f.agent);
    let release!: () => void, entered!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
    vi.mocked(f.ollama.chat).mockImplementationOnce(async () => { entered(); await waiting; throw Error('private upstream detail'); });
    const first = f.agent.post('/api/forge/chat').send({ model, messages: [{ role: 'user', content: 'Hi' }] }).then(value => value);
    await started;
    const other = request.agent(f.app); await f.login(other);
    expect((await other.post('/api/forge/chat').send({ model, messages: [{ role: 'user', content: 'Hi' }] })).status).toBe(429);
    release();
    const failed = await first; expect(failed.text).toContain('"success":false'); expect(failed.text).not.toContain('private upstream detail');
    expect((await other.post('/api/forge/chat').send({ model, messages: [{ role: 'user', content: 'Again' }] })).text).toContain('"done":true');
  });
});

describe('Ollama protocol', () => {
  it('discovers the preferred installed model without pulling or inventing models', async () => {
    const calls: string[] = [];
    const ollama = createOllama({ fetchImpl: async (url) => { calls.push(String(url)); return new Response(JSON.stringify({ models: [{ name: 'other:1' }, { name: model }] })); } });
    expect((await ollama.inventory()).defaultModel).toBe(model);
    expect(calls).toEqual(['http://127.0.0.1:11434/api/tags']);
    expect((await createOllama({ fetchImpl: async () => new Response('{"models":[]}') }).inventory()).defaultModel).toBeNull();
  });
  it('fails closed for invalid endpoints and unavailable model discovery', async () => {
    const fetchImpl = vi.fn(async () => new Response('private failure', { status: 500 }));
    await expect(createOllama({ baseUrl: 'http://user:password@localhost/', fetchImpl }).inventory()).rejects.toMatchObject({ code: 'OLLAMA_CONFIGURATION' });
    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(createOllama({ fetchImpl }).inventory()).rejects.toMatchObject({ code: 'OLLAMA_UNAVAILABLE' });
  });
  it('decodes split UTF-8, requires a final done event, and sends bounded generation options', async () => {
    const bytes = new TextEncoder().encode('{"message":{"content":"héllo"}}\n{"done":true}\n');
    let payload: any;
    const ollama = createOllama({ fetchImpl: async (_url, init) => {
      payload = JSON.parse(String(init?.body));
      return new Response(new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(new Uint8Array([byte])); controller.close(); } }));
    } });
    const events: unknown[] = [];
    await ollama.chat(model, [{ role: 'user', content: 'Hi' }], new AbortController().signal, async event => { events.push(event); });
    expect(events).toEqual([{ delta: 'héllo' }]);
    expect(payload).toEqual({ model, messages: [{ role: 'user', content: 'Hi' }], stream: true, options: { num_predict: 4096 } });
    for (const output of ['{"message":{"content":"partial"}}\n', '{"error":"private detail"}\n', 'not json']) {
      const bad = createOllama({ fetchImpl: async () => new Response(output) });
      await expect(bad.chat(model, [{ role: 'user', content: 'Hi' }], new AbortController().signal, async () => {})).rejects.toMatchObject({ code: 'OLLAMA_CHAT_FAILED' });
    }
  });
  it('finishes and aborts the upstream even when stream cancellation never resolves', async () => {
    let upstreamSignal: AbortSignal | undefined;
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const ollama = createOllama({ fetchImpl: async (_url, init) => {
      upstreamSignal = init?.signal as AbortSignal;
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{\"message\":{\"content\":\"Complete\"},\"done\":true}\n')); }, cancel }));
    } });
    const events: unknown[] = [];
    await ollama.chat(model, [{ role: 'user', content: 'Hi' }], new AbortController().signal, async event => { events.push(event); });
    expect(events).toEqual([{ delta: 'Complete' }]); expect(upstreamSignal?.aborted).toBe(true); expect(cancel).toHaveBeenCalledOnce();
  });
  it('rejects non-text, oversized history, and excessive output', async () => {
    expect(() => validateMessages({ model, messages: [{ role: 'user', content: 5 }] })).toThrow();
    expect(() => validateMessages({ model, messages: Array.from({ length: 41 }, () => ({ role: 'user', content: 'Hi' })) })).toThrow();
    const huge = createOllama({ fetchImpl: async () => new Response(JSON.stringify({ message: { content: 'x'.repeat(65537) }, done: true }) + '\n') });
    await expect(huge.chat(model, [{ role: 'user', content: 'Hi' }], new AbortController().signal, async () => {})).rejects.toMatchObject({ code: 'OLLAMA_CHAT_FAILED' });
  });
});

describe('read-only Codex test inventory', () => {
  const container = { Id: 'a'.repeat(64), Names: ['/codex-forge-test'], Image: 'node:22-bookworm', State: 'running', Status: 'Up 2 minutes', Created: 1792110000,
    Labels: { 'w3forge.managed-by': 'codex', 'w3forge.environment': 'test', 'w3forge.app': 'w3forge', 'w3forge.branch': 'dev/v0.4.3', 'w3forge.commit': '55ff3d8', secret: 'do-not-return' },
    Env: ['PASSWORD=private'], Mounts: ['/production'], Command: 'private command', Ports: [{ PrivatePort: 8765, PublicPort: 18765, IP: '127.0.0.1', Type: 'tcp' }] };
  it('includes only labeled Codex tests and returns a public metadata allowlist', () => {
    const result = summarizeContainers([container, { ...container, Labels: {} }, { ...container, Labels: { ...container.Labels, 'w3forge.environment': 'production' } }]);
    expect(result).toHaveLength(1); expect(result[0]).toMatchObject({ branch: 'dev/v0.4.3', commit: '55ff3d8', state: 'running', ports: ['127.0.0.1:18765 → 8765/tcp'] });
    expect(JSON.stringify(result)).not.toMatch(/do-not-return|PASSWORD|production|private command/);
  });
  it('distinguishes empty, failed, and malformed inventory and coalesces polls', async () => {
    const load = vi.fn(async () => [container]); const reader = createEnvironmentReader(load);
    const result = await Promise.all([reader(), reader(), reader()]);
    expect(load).toHaveBeenCalledTimes(1); expect(result.every(item => item.available)).toBe(true);
    expect((await createEnvironmentReader(async () => [])()).available).toBe(true);
    for (const failure of [async () => { throw Error('socket detail'); }, async () => ({ invalid: true }), async () => [{ ...container, Id: '../escape' }]]) {
      const failed = await createEnvironmentReader(failure)(); expect(failed.available).toBe(false); expect(failed.environments).toEqual([]);
      expect(failed.message).not.toContain('socket detail');
    }
  });
});
