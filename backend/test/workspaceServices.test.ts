import { describe, expect, it, vi } from 'vitest';
import { createServiceInventory } from '../src/workspace/services';

const observedAt = '2026-10-19T22:46:41.000Z';

function readers() {
  const inventory = vi.fn().mockResolvedValue({
    models: [{ name: 'qwen2.5-coder:14b', size: 8_900_000_000, parameterSize: '14B' }],
    defaultModel: 'qwen2.5-coder:14b',
  });
  const environments = vi.fn().mockResolvedValue({
    host: 'forge-test-host',
    observedAt,
    available: true,
    message: 'Observed labelled test containers.',
    environments: [{ id: 'test-running', state: 'running' }],
  });
  const read = createServiceInventory({
    ollama: { inventory } as any,
    environments: environments as any,
    now: () => new Date(observedAt),
  });
  return { inventory, environments, read };
}

describe('workspace service inventory', () => {
  it('reports actual local model names and running Codex test observations independently of an agent connection', async () => {
    const { inventory, environments, read } = readers();
    const result = await read();
    expect(result.observedAt).toBe(observedAt);
    expect(inventory).toHaveBeenCalledOnce();
    expect(environments).toHaveBeenCalledOnce();
    expect(result.services.find((service) => service.id === 'ollama')).toMatchObject({
      status: 'available',
      models: ['qwen2.5-coder:14b'],
      capabilities: ['local_chat', 'plan_drafting'],
      lastSeenAt: observedAt,
      activeTasks: null,
    });
    expect(result.services.find((service) => service.id === 'codex')).toMatchObject({
      status: 'observed',
      models: [],
      capabilities: ['test_environment_observation'],
      lastSeenAt: observedAt,
      activeTasks: 1,
      message: expect.stringContaining('not a connected coding-agent adapter'),
    });
  });

  it('does not make an empty model list or historical successful container into ready AI services', async () => {
    const { inventory, environments, read } = readers();
    inventory.mockResolvedValue({ models: [], defaultModel: 'uninstalled-default:14b' });
    environments.mockResolvedValue({
      available: true,
      observedAt,
      environments: [{ id: 'old-test', state: 'exited', exitCode: 0 }],
    });
    const result = await read();
    expect(result.services.find((service) => service.id === 'ollama')).toMatchObject({
      status: 'unavailable',
      models: [],
      capabilities: [],
      lastSeenAt: observedAt,
      activeTasks: null,
      message: expect.stringContaining('no models are installed'),
    });
    expect(result.services.find((service) => service.id === 'codex')).toMatchObject({
      status: 'not_configured',
      capabilities: [],
      lastSeenAt: null,
      activeTasks: 0,
      message: expect.stringContaining('container history does not establish test results'),
    });
    expect(JSON.stringify(result)).not.toContain('uninstalled-default');
    expect(JSON.stringify(result)).not.toContain('tests passed');
  });

  it('keeps model evidence when the environment reader is unavailable', async () => {
    const { environments, read } = readers();
    environments.mockResolvedValue({ available: false, observedAt, environments: [], message: 'private internal failure' });
    const result = await read();
    expect(result.services.find((service) => service.id === 'ollama')?.status).toBe('available');
    expect(result.services.find((service) => service.id === 'codex')).toMatchObject({
      status: 'unavailable',
      activeTasks: null,
      lastSeenAt: null,
      capabilities: [],
    });
    expect(JSON.stringify(result)).not.toContain('private internal failure');
  });

  it('keeps running test observations when local model discovery fails without exposing raw error details', async () => {
    const { inventory, read } = readers();
    inventory.mockRejectedValue(new Error('http://private-service:11434 secret-token=do-not-disclose'));
    const result = await read();
    expect(result.services.find((service) => service.id === 'codex')?.status).toBe('observed');
    expect(result.services.find((service) => service.id === 'ollama')).toMatchObject({
      status: 'unavailable',
      activeTasks: null,
      lastSeenAt: null,
      capabilities: [],
      models: [],
    });
    expect(JSON.stringify(result)).not.toContain('private-service');
    expect(JSON.stringify(result)).not.toContain('do-not-disclose');
  });

  it('runs the environment reader even if the local reader throws synchronously', async () => {
    const { inventory, environments, read } = readers();
    inventory.mockImplementation(() => { throw new Error('private sync failure'); });
    const result = await read();
    expect(environments).toHaveBeenCalledOnce();
    expect(result.services.find((service) => service.id === 'codex')?.activeTasks).toBe(1);
    expect(JSON.stringify(result)).not.toContain('private sync failure');
  });

  it('reports missing Codex activity without claiming an adapter and leaves external vendors unconfigured', async () => {
    const { environments, read } = readers();
    environments.mockResolvedValue({ available: true, observedAt, environments: [] });
    const result = await read();
    expect(result.services.find((service) => service.id === 'codex')).toMatchObject({
      status: 'not_configured',
      activeTasks: 0,
      lastSeenAt: null,
      message: expect.stringContaining('No coding-agent adapter is configured'),
    });
    for (const id of ['perplexity', 'grok', 'claude']) {
      expect(result.services.find((service) => service.id === id)).toMatchObject({
        status: 'not_configured',
        capabilities: [],
        models: [],
        lastSeenAt: null,
        activeTasks: null,
        message: expect.stringContaining('protected server-side adapter'),
      });
    }
    expect(result.services).toHaveLength(5);
  });

  it('reports both independent reader failures as unavailable with unknown task counts', async () => {
    const { inventory, environments, read } = readers();
    inventory.mockRejectedValue(new Error('secret local failure'));
    environments.mockRejectedValue(new Error('secret container failure'));
    const result = await read();
    for (const id of ['ollama', 'codex']) {
      expect(result.services.find((service) => service.id === id)).toMatchObject({
        status: 'unavailable',
        capabilities: [],
        models: [],
        lastSeenAt: null,
        activeTasks: null,
      });
    }
    expect(JSON.stringify(result)).not.toContain('secret');
  });
});
