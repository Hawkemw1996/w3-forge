import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import { BACKUPS_DIR, parseBackupVersion } from '../paths';

// =============================================================================
// /api/admin/backups — read-only summary of /opt/backups/w3forge.
// =============================================================================
//
// Two backup formats are supported in v0.5.4:
//
//   Legacy (paired) — locked since v0.4.8, still used by backup-w3forge.sh:
//     w3forge_app_YYYY-MM-DD_HH-MM-SS.tar.gz
//     w3forge_db_YYYY-MM-DD_HH-MM-SS.sql
//   Files with matching timestamps are grouped as a single pair so the
//   dashboard / Backups page shows one row per backup event. Pairs have no
//   embedded app version — version surfaces as null (UI shows 'Unknown').
//
//   v0.5.4 version-aware single archive — preferred going forward, produced by
//   backup-before-update-w3forge.sh:
//     w3forge-backup-vX.Y.Z-YYYYMMDD-HHMMSS.tar.gz   (preferred)
//     w3forge-vX.Y.Z-backup-YYYYMMDD-HHMMSS.tar.gz   (alternative)
//   These carry an embedded version that the UI surfaces as the backup's
//   app version. They are NOT paired — the single archive is the whole
//   backup. dbArchive is null and that is correct.
//
// The endpoint is strictly read-only and never opens the archives.

const APP_RE = /^w3forge_app_(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})\.tar\.gz$/;
const DB_RE = /^w3forge_db_(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})\.sql$/;
// v0.5.4 version-aware single-archive timestamps.
const VERSIONED_BACKUP_TS_RE_A =
  /^w3forge-backup-v\d+\.\d+\.\d+-(\d{8})-(\d{6})\.tar\.gz$/;
const VERSIONED_BACKUP_TS_RE_B =
  /^w3forge-v\d+\.\d+\.\d+-backup-(\d{8})-(\d{6})\.tar\.gz$/;

interface BackupFile {
  name: string;
  sizeBytes: number;
  mtime: string;
}

interface BackupPair {
  pairTimestamp: string | null;
  appArchive: BackupFile | null;
  dbArchive: BackupFile | null;
  /** v0.5.4: parsed version, or null when filename has no version metadata. */
  parsedVersion: string | null;
  /** v0.5.4: 'paired' for legacy pairs, 'versioned-archive' for single v0.5.4 archives. */
  kind: 'paired' | 'versioned-archive';
}

function normalizeVersionedTs(stamp: string, hms: string): string {
  // Convert YYYYMMDD-HHMMSS into YYYY-MM-DD_HH-MM-SS for consistent sort/display
  // alongside legacy paired timestamps.
  return (
    `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}` +
    `_${hms.slice(0, 2)}-${hms.slice(2, 4)}-${hms.slice(4, 6)}`
  );
}

async function listBackups(): Promise<{ pairs: BackupPair[]; total: number }> {
  let entries: import('node:fs').Dirent[] = [];
  try {
    entries = await fs.readdir(BACKUPS_DIR, { withFileTypes: true });
  } catch {
    return { pairs: [], total: 0 };
  }

  const pairsByTs = new Map<string, BackupPair>();
  const versioned: BackupPair[] = [];
  let total = 0;
  for (const e of entries) {
    if (!e.isFile()) continue;
    if (!APP_RE.test(e.name) && !DB_RE.test(e.name)
      && !VERSIONED_BACKUP_TS_RE_A.test(e.name) && !VERSIONED_BACKUP_TS_RE_B.test(e.name)) continue;
    const full = path.join(BACKUPS_DIR, e.name);
    let stat: import('node:fs').Stats;
    try {
      stat = await fs.stat(full);
    } catch {
      continue;
    }
    total += stat.size;

    // v0.5.4 single-archive versioned backup
    const vA = VERSIONED_BACKUP_TS_RE_A.exec(e.name);
    const vB = VERSIONED_BACKUP_TS_RE_B.exec(e.name);
    if (vA || vB) {
      const stamp = (vA?.[1] ?? vB?.[1])!;
      const hms = (vA?.[2] ?? vB?.[2])!;
      versioned.push({
        pairTimestamp: normalizeVersionedTs(stamp, hms),
        appArchive: { name: e.name, sizeBytes: stat.size, mtime: stat.mtime.toISOString() },
        dbArchive: null,
        parsedVersion: parseBackupVersion(e.name),
        kind: 'versioned-archive'
      });
      continue;
    }

    // Legacy paired backup (app/db with shared timestamp)
    const appMatch = APP_RE.exec(e.name);
    const dbMatch = DB_RE.exec(e.name);
    if (!appMatch && !dbMatch) continue;
    const ts = (appMatch?.[1] ?? dbMatch?.[1])!;
    let pair = pairsByTs.get(ts);
    if (!pair) {
      pair = {
        pairTimestamp: ts,
        appArchive: null,
        dbArchive: null,
        parsedVersion: null,
        kind: 'paired'
      };
      pairsByTs.set(ts, pair);
    }
    const file: BackupFile = {
      name: e.name,
      sizeBytes: stat.size,
      mtime: stat.mtime.toISOString()
    };
    if (appMatch) pair.appArchive = file;
    else pair.dbArchive = file;
  }

  const pairs = [...pairsByTs.values(), ...versioned].sort((a, b) =>
    (b.pairTimestamp ?? '').localeCompare(a.pairTimestamp ?? '')
  );
  return { pairs, total };
}

export function buildAdminBackupsRoutes(): Router {
  const router = Router();

  router.get('/backups', async (_req, res, next) => {
    try {
      const { pairs, total } = await listBackups();
      res.json({
        success: true,
        data: {
          root: BACKUPS_DIR,
          backups: pairs,
          totalSizeBytes: total
        }
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
