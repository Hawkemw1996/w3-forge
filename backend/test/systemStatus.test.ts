import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { makeForgeTree } from './setup';
import type { SystemTelemetrySources } from '../src/admin/routes/systemRoutes';
import { envelopeErrorHandler } from '../src/admin/envelope';

let system: typeof import('../src/admin/routes/systemRoutes');
let root: string;
beforeAll(async () => {
  root = makeForgeTree();
  process.env.W3_FORGE_ROOT = root;
  process.env.W3_FORGE_ACTIVE_APP = 'w3forge';
  system = await import('../src/admin/routes/systemRoutes');
});
afterEach(() => { vi.useRealTimers(); });

function probes(overrides: Partial<SystemTelemetrySources> = {}): SystemTelemetrySources {
  return {
    memoryUsage: () => ({ rss: 500, heapUsed: 150, heapTotal: 200 }),
    totalmem: () => 8_000,
    freemem: () => 3_000,
    cpus: () => [{}, {}, {}, {}],
    loadavg: () => [0.5, 1.5, 2],
    platform: () => 'linux',
    statfs: async () => ({ bsize: 4096, blocks: 1000, bfree: 300, bavail: 250 }),
    ...overrides
  };
}

describe('read-only system telemetry', () => {
  it('separates process and host memory and measures only the configured filesystem once', async () => {
    const statfs = vi.fn(probes().statfs);
    const telemetry = await system.readSystemTelemetry('/approved/forge', probes({ statfs }));
    expect(telemetry).toEqual({
      memory: { processRssBytes: 500, processHeapUsedBytes: 150, processHeapTotalBytes: 200, hostTotalBytes: 8000, hostFreeBytes: 3000 },
      cpu: { cores: 4, loadAverage: [0.5, 1.5, 2] },
      disk: { root: '/approved/forge', sizeBytes: 4096000, availableBytes: 1024000, usedBytes: 2867200 }
    });
    expect(statfs).toHaveBeenCalledOnce();
    expect(statfs).toHaveBeenCalledWith('/approved/forge');
    expect(telemetry).not.toHaveProperty('container');
    expect(telemetry.disk!.usedBytes + telemetry.disk!.availableBytes).toBeLessThan(telemetry.disk!.sizeBytes);
  });

  it('reports Windows load averages as unavailable without querying unsupported data', async () => {
    const loadavg = vi.fn(() => [0, 0, 0]);
    const telemetry = await system.readSystemTelemetry(root, probes({ platform: () => 'win32', loadavg }));
    expect(telemetry.cpu).toEqual({ cores: 4, loadAverage: null });
    expect(loadavg).not.toHaveBeenCalled();
  });

  it('keeps other telemetry available if one measurement throws', async () => {
    const telemetry = await system.readSystemTelemetry(root, probes({
      memoryUsage: () => { throw new Error('private memory diagnostic'); },
      cpus: () => { throw new Error('private cpu diagnostic'); },
      loadavg: () => { throw new Error('private load diagnostic'); },
      statfs: async () => { throw new Error('private filesystem diagnostic'); }
    }));
    expect(telemetry).toEqual({
      memory: { processRssBytes: null, processHeapUsedBytes: null, processHeapTotalBytes: null, hostTotalBytes: 8000, hostFreeBytes: 3000 },
      cpu: { cores: 0, loadAverage: null }, disk: null
    });
    expect(JSON.stringify(telemetry)).not.toContain('private');
  });

  it('does not publish invalid or internally inconsistent memory totals', async () => {
    const telemetry = await system.readSystemTelemetry(root, probes({
      memoryUsage: () => ({ rss: Number.NaN, heapUsed: 501, heapTotal: 500 }),
      totalmem: () => 1000,
      freemem: () => 1001
    }));
    expect(telemetry.memory).toEqual({ processRssBytes: null, processHeapUsedBytes: null, processHeapTotalBytes: 500, hostTotalBytes: 1000, hostFreeBytes: null });
    const unavailable = await system.readSystemTelemetry(root, probes({
      totalmem: () => 0, freemem: () => -1,
      memoryUsage: () => ({ rss: Number.POSITIVE_INFINITY, heapUsed: 0, heapTotal: -1 })
    }));
    expect(Object.values(unavailable.memory)).toEqual([null, null, null, null, null]);
  });

  it.each([[Number.NaN, 0, 0], [0, -1, 0], [0, 0], [Number.POSITIVE_INFINITY, 0, 0]])('rejects unavailable load averages %j', async (...values) => {
    const telemetry = await system.readSystemTelemetry(root, probes({ loadavg: () => values, cpus: () => [] }));
    expect(telemetry.cpu).toEqual({ cores: 0, loadAverage: null });
  });

  it.each([
    { bsize: 0, blocks: 1000, bfree: 300, bavail: 250 },
    { bsize: 4096, blocks: 0, bfree: 0, bavail: 0 },
    { bsize: 4096, blocks: Number.NaN, bfree: 300, bavail: 250 },
    { bsize: 4096, blocks: 1000, bfree: -1, bavail: 0 },
    { bsize: 4096, blocks: 1000, bfree: 1001, bavail: 250 },
    { bsize: 4096, blocks: 1000, bfree: 300, bavail: 301 },
    { bsize: 4096, blocks: Number.MAX_SAFE_INTEGER, bfree: 300, bavail: 250 }
  ])('does not publish invalid filesystem values %j', async (stats) => {
    const telemetry = await system.readSystemTelemetry(root, probes({ statfs: async () => stats }));
    expect(telemetry.disk).toBeNull();
  });

  it('bounds a stalled filesystem probe to one second and returns the other measurements', async () => {
    vi.useFakeTimers();
    const statfs = vi.fn(() => new Promise<Awaited<ReturnType<SystemTelemetrySources['statfs']>>>(() => {}));
    const pending = system.readSystemTelemetry(root, probes({ statfs }));
    await vi.advanceTimersByTimeAsync(1_000);
    const telemetry = await pending;
    expect(statfs).toHaveBeenCalledOnce();
    expect(telemetry.disk).toBeNull();
    expect(telemetry.memory.processRssBytes).toBe(500);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('adds telemetry without changing the existing envelope, app identity, or authority', async () => {
    const app = express();
    const statfs = vi.fn(probes().statfs);
    app.use(system.buildAdminSystemRoutes('2026-10-06T00:00:00.000Z', { telemetry: probes({ statfs }) }), envelopeErrorHandler);
    const response = await request(app).get('/system');
    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.data).toMatchObject({
      app: 'w3forge', name: 'W3 Forge', version: '0.4.0', forgeRoot: root,
      startedAt: '2026-10-06T00:00:00.000Z', readOnlyFoundation: false,
      authority: { mayDeploy: false, mayTagRelease: false, mayModifyProductionData: false },
      memory: { processRssBytes: 500, hostTotalBytes: 8000 },
      cpu: { cores: 4 }, disk: { root }
    });
    expect(Number.isFinite(response.body.data.uptimeSeconds)).toBe(true);
    expect(statfs).toHaveBeenCalledOnce();
    expect(statfs).toHaveBeenCalledWith(root);
    const version = await request(app).get('/version');
    expect(version.body.data).toMatchObject({ app: 'w3-forge', activeApp: 'w3forge', version: '0.4.0' });
    expect(statfs).toHaveBeenCalledOnce();
  });
});
