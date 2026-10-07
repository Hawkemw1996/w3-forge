import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { respond } from '../envelope';
import { ACTIVE_APP, FORGE_ROOT, loadApp } from '../forgeConfig';

interface FilesystemStats { bsize: number; blocks: number; bfree: number; bavail: number }
export interface SystemTelemetrySources {
  memoryUsage: () => Pick<NodeJS.MemoryUsage, 'rss' | 'heapUsed' | 'heapTotal'>;
  totalmem: () => number;
  freemem: () => number;
  cpus: () => unknown[];
  loadavg: () => number[];
  platform: () => NodeJS.Platform;
  statfs: (root: string) => Promise<FilesystemStats>;
}
const DISK_PROBE_TIMEOUT_MS = 1_000;
const SYSTEM_SOURCES: SystemTelemetrySources = {
  memoryUsage: () => process.memoryUsage(),
  totalmem: () => os.totalmem(),
  freemem: () => os.freemem(),
  cpus: () => os.cpus(),
  loadavg: () => os.loadavg(),
  platform: () => process.platform,
  statfs: (root) => fs.promises.statfs(root)
};

function safely<T>(read: () => T, unavailable: T): T {
  try { return read(); } catch { return unavailable; }
}
function bytes(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

async function diskTelemetry(root: string, statfs: SystemTelemetrySources['statfs']) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // A slow or unavailable mount must not hold the status response indefinitely.
    // This is one filesystem-stat call; there is no recursive directory scan.
    const stats = await Promise.race([
      Promise.resolve().then(() => statfs(root)),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), DISK_PROBE_TIMEOUT_MS);
        timer.unref();
      })
    ]);
    if (!stats) return null;
    const blockSize = bytes(stats.bsize), blocks = bytes(stats.blocks);
    const free = bytes(stats.bfree), available = bytes(stats.bavail);
    if (!blockSize || blocks == null || free == null || available == null
      || free > blocks || available > free) return null;
    const sizeBytes = bytes(blockSize * blocks);
    const availableBytes = bytes(blockSize * available);
    const usedBytes = bytes(blockSize * (blocks - free));
    if (!sizeBytes || availableBytes == null || usedBytes == null) return null;
    // bfree includes reserved free blocks, whereas bavail reports space usable
    // by the service account. Used + available can therefore be below total.
    return { root, sizeBytes, availableBytes, usedBytes };
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function readSystemTelemetry(root: string, overrides: Partial<SystemTelemetrySources> = {}) {
  const sources = { ...SYSTEM_SOURCES, ...overrides };
  const usage = safely<ReturnType<SystemTelemetrySources['memoryUsage']> | null>(sources.memoryUsage, null);
  const hostTotal = bytes(safely<number | null>(sources.totalmem, null));
  const hostFree = bytes(safely<number | null>(sources.freemem, null));
  const heapTotal = bytes(usage?.heapTotal), heapUsed = bytes(usage?.heapUsed);
  const cores = safely(() => sources.cpus().length, 0);
  const platform = safely<NodeJS.Platform | null>(sources.platform, null);
  const load = !platform || platform === 'win32' ? null : safely<number[] | null>(sources.loadavg, null);
  return {
    memory: {
      processRssBytes: bytes(usage?.rss),
      processHeapUsedBytes: heapUsed != null && heapTotal != null && heapUsed <= heapTotal ? heapUsed : null,
      processHeapTotalBytes: heapTotal,
      hostTotalBytes: hostTotal && hostTotal > 0 ? hostTotal : null,
      hostFreeBytes: hostFree != null && hostTotal != null && hostTotal > 0 && hostFree <= hostTotal ? hostFree : null
    },
    cpu: {
      // Zero denotes unavailable processor count; it is not a measured CPU load.
      cores: Number.isSafeInteger(cores) && cores > 0 ? cores : 0,
      loadAverage: Array.isArray(load) && load.length === 3 && load.every(value => Number.isFinite(value) && value >= 0) ? load : null
    },
    disk: await diskTelemetry(root, sources.statfs)
  };
}

function readForgeVersion(): string {
  try {
    const p = path.join(FORGE_ROOT, 'VERSION');
    return fs.readFileSync(p, 'utf8').trim();
  } catch {
    return 'unknown';
  }
}

export function buildAdminSystemRoutes(startedAt: string, options: { telemetry?: Partial<SystemTelemetrySources> } = {}): Router {
  const router = Router();

  router.get('/version', (_req, res) => {
    respond.ok(res, {
      app: 'w3-forge',
      activeApp: ACTIVE_APP,
      version: readForgeVersion(),
      nodeEnv: process.env.NODE_ENV ?? 'development'
    });
  });

  router.get('/system', async (_req, res, next) => {
    try {
      const cfg = loadApp(ACTIVE_APP);
      const telemetry = await readSystemTelemetry(FORGE_ROOT, options.telemetry);
      respond.ok(res, {
        app: cfg.app_id,
        name: cfg.name,
        version: cfg.version,
        forgeRoot: FORGE_ROOT,
        startedAt,
        uptimeSeconds: Math.floor(process.uptime()),
        host: os.hostname(),
        platform: process.platform,
        nodeVersion: process.version,
        ...telemetry,
        authority: {
          mayDeploy: cfg.authority.may_deploy === true,
          mayTagRelease: cfg.authority.may_tag_release === true,
          mayModifyProductionData: cfg.authority.may_modify_production_data === true
        },
        readOnlyFoundation: false
      });
    } catch (error) { next(error); }
  });

  return router;
}
