import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fsp } from 'node:fs';
import { Router } from 'express';
import { env } from '../../config/env';
import { pool } from '../../db/pool';
import {
  APP_DIR,
  BACKUPS_DIR,
  DEPLOY_DIR,
  LOGS_ROOT,
  SCRIPTS_DIR,
  UPDATE_PACKAGES_DIR,
  UPDATE_PACKAGES_INSTALLED_DIR
} from '../paths';
import { getServiceName } from '../appConfigAccessors';
import { readContainerMemory, readContainerSwap } from '../../services/memoryReader';

// =============================================================================
// /api/admin/system/status and /api/admin/version
// =============================================================================
//
// system/status aggregates the read-only health signals the Admin Console
// dashboard widgets need. None of the queries here mutate state.
//
// v0.5.5 split:
//   - ROOT VOLUME usage uses `df -Pk /` and represents the LXC root
//     filesystem capacity (Total / Used / Available / %).
//   - FOLDER usage uses `du -sb <path>` on a fixed allowlist of operational
//     W3 Forge directories and represents the actual on-disk size of each
//     folder. This is what users actually want when they look at the
//     Disk Usage tile (e.g. "how big is /opt/backups/w3forge?"), and is NOT the
//     same as filesystem capacity.
//
// Both functions use `execFile` (no shell), fixed argv arrays, and a
// per-call timeout. The folder list is also hard-coded in this file —
// the route never accepts an arbitrary path from the frontend.
//
// Folder-size results are cached for 30 s to keep dashboard polls cheap
// even though each `du` call walks the directory tree.
//
// A legacy `disk: DiskEntry[]` field is still returned (root + folder
// entries, each as `{ path, sizeBytes, usedBytes, availableBytes,
// usePercent, available }`) so any older widget that hasn't been
// updated continues to render. New widgets should read
// `disk.rootVolume` and `disk.folders` instead.

const execFileAsync = promisify(execFile);

// -----------------------------------------------------------------------------
// Root Volume (df)
// -----------------------------------------------------------------------------

export interface RootVolumeEntry {
  path: string;
  sizeBytes: number | null;
  usedBytes: number | null;
  availableBytes: number | null;
  usePercent: number | null;
  available: boolean;
}

export async function readRootVolume(): Promise<RootVolumeEntry> {
  const ROOT = '/';
  try {
    const { stdout } = await execFileAsync('df', ['-Pk', ROOT], {
      timeout: 3000,
      env: { ...process.env, LC_ALL: 'C' }
    });
    const lines = stdout.trim().split('\n');
    if (lines.length < 2) throw new Error('df: no data');
    const cols = lines[lines.length - 1].trim().split(/\s+/);
    // df -Pk columns: Filesystem 1024-blocks Used Available Capacity Mounted-on
    const sizeBytes = Number(cols[1]) * 1024;
    const usedBytes = Number(cols[2]) * 1024;
    const availableBytes = Number(cols[3]) * 1024;
    const usePercent = Number(cols[4].replace('%', ''));
    return {
      path: ROOT,
      sizeBytes: Number.isFinite(sizeBytes) ? sizeBytes : null,
      usedBytes: Number.isFinite(usedBytes) ? usedBytes : null,
      availableBytes: Number.isFinite(availableBytes) ? availableBytes : null,
      usePercent: Number.isFinite(usePercent) ? usePercent : null,
      available: true
    };
  } catch {
    return {
      path: ROOT,
      sizeBytes: null,
      usedBytes: null,
      availableBytes: null,
      usePercent: null,
      available: false
    };
  }
}

// -----------------------------------------------------------------------------
// Folder Usage (du)
// -----------------------------------------------------------------------------

// Fixed, hard-coded list of monitored W3 Forge operational folders.
// The frontend NEVER influences which paths are measured.
const MONITORED_FOLDERS: readonly string[] = [
  APP_DIR,
  DEPLOY_DIR,
  UPDATE_PACKAGES_DIR,
  UPDATE_PACKAGES_INSTALLED_DIR,
  BACKUPS_DIR,
  LOGS_ROOT,
  SCRIPTS_DIR
];

export type FolderUsageStatus = 'ok' | 'missing' | 'unavailable';

export interface FolderUsageEntry {
  path: string;
  sizeBytes: number | null;
  status: FolderUsageStatus;
  measuredAt: string; // ISO timestamp of when this value was sampled
}

// Per-path cache so the Dashboard polling doesn't spawn `du` every 8 s.
// We keep a short TTL — operational folders don't change often, but staged
// packages and backups can grow, so we don't want stale numbers either.
const FOLDER_CACHE_TTL_MS = 30_000;
const folderCache = new Map<string, { entry: FolderUsageEntry; expiresAt: number }>();

async function readFolderUsage(folder: string): Promise<FolderUsageEntry> {
  // Allowlist guard. Belt-and-suspenders — MONITORED_FOLDERS is hard-coded
  // above, but this catches any future caller that tries to pass a path in.
  if (!MONITORED_FOLDERS.includes(folder)) {
    return {
      path: folder,
      sizeBytes: null,
      status: 'unavailable',
      measuredAt: new Date().toISOString()
    };
  }

  // Serve from cache if fresh.
  const cached = folderCache.get(folder);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.entry;
  }

  // Stat first — distinguishes "folder missing" from "du failed".
  try {
    const st = await fsp.stat(folder);
    if (!st.isDirectory()) {
      const entry: FolderUsageEntry = {
        path: folder,
        sizeBytes: null,
        status: 'unavailable',
        measuredAt: new Date().toISOString()
      };
      folderCache.set(folder, { entry, expiresAt: Date.now() + FOLDER_CACHE_TTL_MS });
      return entry;
    }
  } catch {
    const entry: FolderUsageEntry = {
      path: folder,
      sizeBytes: null,
      status: 'missing',
      measuredAt: new Date().toISOString()
    };
    folderCache.set(folder, { entry, expiresAt: Date.now() + FOLDER_CACHE_TTL_MS });
    return entry;
  }

  // `du -sb` returns bytes (apparent size). `-s` summarises; `-x` keeps it
  // on one filesystem (avoids accidentally walking into a future bind mount).
  // 6 s timeout per folder is generous for typical W3 Forge operational
  // folders (logs, backups, packages — all small) and bounded enough to
  // never block the dashboard.
  try {
    const { stdout } = await execFileAsync('du', ['-sb', '-x', folder], {
      timeout: 6000,
      env: { ...process.env, LC_ALL: 'C' },
      maxBuffer: 256 * 1024
    });
    const first = stdout.trim().split(/\s+/)[0];
    const sizeBytes = Number(first);
    const entry: FolderUsageEntry = {
      path: folder,
      sizeBytes: Number.isFinite(sizeBytes) ? sizeBytes : null,
      status: Number.isFinite(sizeBytes) ? 'ok' : 'unavailable',
      measuredAt: new Date().toISOString()
    };
    folderCache.set(folder, { entry, expiresAt: Date.now() + FOLDER_CACHE_TTL_MS });
    return entry;
  } catch {
    const entry: FolderUsageEntry = {
      path: folder,
      sizeBytes: null,
      status: 'unavailable',
      measuredAt: new Date().toISOString()
    };
    folderCache.set(folder, { entry, expiresAt: Date.now() + FOLDER_CACHE_TTL_MS });
    return entry;
  }
}

async function readAllFolderUsage(): Promise<FolderUsageEntry[]> {
  // Measure folders in parallel — each call has its own 6 s timeout.
  return Promise.all(MONITORED_FOLDERS.map(readFolderUsage));
}

// -----------------------------------------------------------------------------
// Legacy disk-entry shape (back-compat for older widgets).
// -----------------------------------------------------------------------------

interface LegacyDiskEntry {
  path: string;
  sizeBytes: number | null;
  usedBytes: number | null;
  availableBytes: number | null;
  usePercent: number | null;
  available: boolean;
}

function legacyEntryFromRoot(root: RootVolumeEntry): LegacyDiskEntry {
  return { ...root };
}

// For folder entries: we don't have a per-folder "total/available" — those
// concepts only apply to a filesystem. We surface the folder *size* in
// `usedBytes` and leave size/available/percent null so older widgets that
// still call this `disk[]` don't display the misleading root-volume numbers
// for every folder. Older widgets that fall back to "unavailable" when
// `available: false` will show "unavailable" — which is the correct, honest
// behavior. New widgets should read `disk.folders` instead.
function legacyEntryFromFolder(f: FolderUsageEntry): LegacyDiskEntry {
  return {
    path: f.path,
    sizeBytes: null,
    usedBytes: f.status === 'ok' ? f.sizeBytes : null,
    availableBytes: null,
    usePercent: null,
    available: f.status === 'ok'
  };
}

// -----------------------------------------------------------------------------
// DB ping
// -----------------------------------------------------------------------------

export async function dbStatus(): Promise<{ status: string; latencyMs: number | null }> {
  const t0 = process.hrtime.bigint();
  try {
    await pool.query('SELECT 1');
    const latencyMs = Number(process.hrtime.bigint() - t0) / 1_000_000;
    return { status: 'connected', latencyMs: Number(latencyMs.toFixed(2)) };
  } catch {
    return { status: 'unavailable', latencyMs: null };
  }
}

// -----------------------------------------------------------------------------
// Router
// -----------------------------------------------------------------------------

export function buildAdminSystemRoutes(startedAt: string): Router {
  const router = Router();

  router.get('/system/status', async (_req, res, next) => {
    try {
      const db = await dbStatus();
      const mem = process.memoryUsage();
      const [containerMem, containerSwap, rootVolume, folders] = await Promise.all([
        readContainerMemory(),
        readContainerSwap(),
        readRootVolume(),
        readAllFolderUsage()
      ]);

      // Legacy combined array — root first then folders. Older widgets that
      // filter on `path === '/'` keep working; folder entries now correctly
      // surface as "unavailable" instead of the misleading root totals.
      const legacyDisk: LegacyDiskEntry[] = [
        legacyEntryFromRoot(rootVolume),
        ...folders.map(legacyEntryFromFolder)
      ];

      const uptimeSeconds = (Date.now() - Date.parse(startedAt)) / 1000;

      // v0.6.1: service name now sourced from config/apps/w3forge.yml via
      // getServiceName() (ENV > YAML > legacy fallback). Fallback resolves
      // to the same `'w3forge.service'` value used pre-migration so the
      // /system/status response shape and value are unchanged.
      res.json({
        success: true,
        data: {
          service: getServiceName(),
          status: db.status === 'connected' ? 'ok' : 'degraded',
          uptimeSeconds: Number(uptimeSeconds.toFixed(0)),
          startedAt,
          app: env.appName,
          version: env.appVersion,
          nodeEnv: env.nodeEnv,
          hostname: os.hostname(),
          platform: `${os.type()} ${os.release()} (${os.arch()})`,
          nodeVersion: process.version,
          database: db,
          memory: {
            // Back-compat fields (Node process).
            rssBytes: mem.rss,
            heapUsedBytes: mem.heapUsed,
            heapTotalBytes: mem.heapTotal,
            // v0.5.3.1 structured shape.
            process: {
              rssBytes: mem.rss,
              heapUsedBytes: mem.heapUsed,
              heapTotalBytes: mem.heapTotal,
              heapUsagePercent:
                mem.heapTotal > 0
                  ? Math.min(100, Math.max(0, Math.round((mem.heapUsed / mem.heapTotal) * 100)))
                  : null,
              externalBytes: mem.external,
              arrayBuffersBytes:
                (mem as NodeJS.MemoryUsage & { arrayBuffers?: number }).arrayBuffers ?? null
            },
            container: {
              usedBytes: containerMem.usedBytes,
              limitBytes: containerMem.limitBytes,
              availableBytes: containerMem.availableBytes,
              usagePercent: containerMem.usagePercent,
              source: containerMem.source,
              swap: {
                usedBytes: containerSwap.usedBytes,
                limitBytes: containerSwap.limitBytes,
                source: containerSwap.source
              }
            }
          },
          cpu: {
            loadAverage: os.loadavg(),
            cores: os.cpus()?.length ?? 0
          },
          // v0.5.5: legacy flat array kept for back-compat. New disk shape:
          //   disk.rootVolume — { path, sizeBytes, usedBytes, ... } via df
          //   disk.folders    — [{ path, sizeBytes, status, measuredAt }] via du
          // Both new + old structures are populated; the frontend should
          // prefer `disk.rootVolume` and `disk.folders`.
          disk: legacyDisk,
          diskUsage: {
            rootVolume,
            folders,
            monitoredFolders: [...MONITORED_FOLDERS]
          }
        }
      });
    } catch (err) {
      next(err);
    }
  });

  router.get('/version', (_req, res) => {
    res.json({
      success: true,
      data: {
        app: env.appName,
        version: env.appVersion,
        nodeEnv: env.nodeEnv,
        startedAt
      }
    });
  });

  return router;
}
