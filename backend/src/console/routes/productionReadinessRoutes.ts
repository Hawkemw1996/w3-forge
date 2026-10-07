// =============================================================================
// Shared W3 console — Production Readiness admin routes.
// =============================================================================
//
// Derived from W3 Core v0.12.11 admin/routes/productionReadinessRoutes.ts.
// Same response shape (the Admin Console page is unchanged), but the checks
// are app's: database, migration ledger, configured application tables,
// append-only history triggers, audit trail, backups, W3 Core reachability.
// Core-only checks (entities, relationships, financial accounts, access
// grants, app registry tables) are removed — those live in W3 Core.
//
//   GET  /api/admin/production-readiness
//   GET  /api/admin/production-config
//   POST /api/admin/production-config     (productionDataMode only)
//   GET  /api/admin/production-cutover
//   POST /api/admin/production-cutover    (first record wins)

import { Router, Request, Response, NextFunction } from 'express';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { env } from '../../config/env';
import { BACKUPS_DIR } from '../paths';
import type { Database } from '../../db/database';
import type { CoreClient } from '../../auth/coreClient';
import { REQUIRED_TABLES, APPEND_ONLY_TABLES } from '../../db/requiredSchema';
import { audit } from '../../db/audit';

interface CheckResult {
  key: string;
  label: string;
  pass: boolean;
  detail?: string;
}

async function getBackupHealth(): Promise<{
  exists: boolean;
  ageHours: number | null;
  filename: string | null;
  sizeBytes: number | null;
  mtime: string | null;
  health: 'green' | 'yellow' | 'red' | 'unknown';
}> {
  try {
    const entries = await fsp.readdir(BACKUPS_DIR, { withFileTypes: true });
    const backupFiles = entries
      .filter((e) => e.isFile() && (e.name.endsWith('.tar.gz') || e.name.endsWith('.sql')))
      .map((e) => e.name);

    if (backupFiles.length === 0) {
      return {
        exists: false,
        ageHours: null,
        filename: null,
        sizeBytes: null,
        mtime: null,
        health: 'red'
      };
    }

    // Find the newest backup file by mtime
    let newestMtime = 0;
    let newestName = '';
    let newestSize = 0;
    for (const name of backupFiles) {
      try {
        const st = await fsp.stat(path.join(BACKUPS_DIR, name));
        if (st.mtimeMs > newestMtime) {
          newestMtime = st.mtimeMs;
          newestName = name;
          newestSize = st.size;
        }
      } catch {
        // skip
      }
    }

    if (!newestName) {
      return {
        exists: false,
        ageHours: null,
        filename: null,
        sizeBytes: null,
        mtime: null,
        health: 'red'
      };
    }

    const ageMs = Date.now() - newestMtime;
    const ageHours = ageMs / (1000 * 60 * 60);

    let health: 'green' | 'yellow' | 'red';
    if (ageHours < 24) {
      health = 'green';
    } else if (ageHours < 24 * 7) {
      health = 'yellow';
    } else {
      health = 'red';
    }

    return {
      exists: true,
      ageHours: Number(ageHours.toFixed(1)),
      filename: newestName,
      sizeBytes: newestSize,
      mtime: new Date(newestMtime).toISOString(),
      health
    };
  } catch {
    return {
      exists: false,
      ageHours: null,
      filename: null,
      sizeBytes: null,
      mtime: null,
      health: 'unknown'
    };
  }
}

interface CutoverRow {
  id: string | number;
  enabled_at: Date | string;
  enabled_by_core_user_id: string | null;
  enabled_version: string;
  notes: string | null;
}

function cutoverOut(row: CutoverRow) {
  return {
    id: Number(row.id),
    enabled_at: row.enabled_at instanceof Date ? row.enabled_at.toISOString() : String(row.enabled_at),
    enabled_by: row.enabled_by_core_user_id,
    enabled_version: row.enabled_version,
    notes: row.notes ?? null
  };
}

export function buildProductionReadinessRoutes(deps: { db: Database; core: CoreClient }): Router {
  const router = Router();
  const { db, core } = deps;

  async function cutoverRecord() {
    try {
      const r = await db.query<CutoverRow>('SELECT id, enabled_at, enabled_by_core_user_id, enabled_version, notes FROM public.production_cutover_record ORDER BY id ASC LIMIT 1');
      return r.rows[0] ? cutoverOut(r.rows[0]) : null;
    } catch {
      return null;
    }
  }

  async function productionDataMode(): Promise<boolean> {
    try {
      const r = await db.query<{ value: string }>("SELECT value FROM public.platform_config WHERE key = 'productionDataMode'");
      return r.rows[0] ? JSON.parse(r.rows[0].value)?.enabled === true : false;
    } catch {
      return false;
    }
  }

  router.get('/production-readiness', async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const dbOk = await db.ping();
      let migrationVersion: string | null = null;
      let migrationCount = 0;
      let missingTables: string[] = [...REQUIRED_TABLES];
      let triggersOk = false;
      if (dbOk) {
        try {
          const m = await db.query<{ version: string }>('SELECT migration_name AS version FROM public.schema_migrations ORDER BY migration_name');
          migrationCount = m.rows.length;
          migrationVersion = m.rows.length ? m.rows[m.rows.length - 1].version : null;
        } catch {
          migrationVersion = null;
        }
        const t = await db.query<{ table_name: string }>("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'");
        const have = new Set(t.rows.map((r) => r.table_name));
        missingTables = REQUIRED_TABLES.filter((x) => !have.has(x));
        const trig = await db.query<{ tbl: string }>(
          "SELECT DISTINCT c.relname AS tbl FROM pg_trigger g JOIN pg_class c ON c.oid = g.tgrelid WHERE NOT g.tgisinternal AND g.tgname LIKE '%append_only%'"
        );
        const withTrig = new Set(trig.rows.map((r) => r.tbl));
        triggersOk = APPEND_ONLY_TABLES.every((x) => withTrig.has(x));
      }
      const [backupHealth, prodMode, cutover, coreHealth] = await Promise.all([getBackupHealth(), productionDataMode(), cutoverRecord(), core.health()]);

      const checks: CheckResult[] = [
        { key: 'database_connected', label: 'Database Connected', pass: dbOk, detail: dbOk ? 'PostgreSQL connection verified' : 'Database unavailable' },
        { key: 'migrations_applied', label: 'Migrations Applied', pass: migrationVersion !== null, detail: migrationVersion ? `${migrationCount} applied (latest ${migrationVersion})` : 'schema_migrations ledger missing or empty' },
        { key: 'required_tables', label: `${env.appName} Schema Present`, pass: dbOk && missingTables.length === 0, detail: missingTables.length ? `Missing: ${missingTables.join(', ')}` : `${REQUIRED_TABLES.length} required tables present` },
        { key: 'history_protection', label: 'History Tables Append-Only', pass: triggersOk, detail: triggersOk ? `${APPEND_ONLY_TABLES.join(', ')} reject UPDATE/DELETE` : 'Append-only triggers missing' },
        { key: 'audit_logging', label: 'Audit Trail Enabled', pass: dbOk && !missingTables.includes('audit_events'), detail: 'audit_events table (append-only)' },
        { key: 'backup_exists', label: 'Database Backup Exists', pass: backupHealth.exists, detail: backupHealth.exists ? `Latest: ${backupHealth.filename}` : 'No backup files found' },
        { key: 'backup_age', label: 'Last Backup Age', pass: backupHealth.health === 'green', detail: backupHealth.ageHours !== null ? `${backupHealth.ageHours}h ago (${backupHealth.health})` : 'Unknown' },
        { key: 'core_reachable', label: 'W3 Core API Reachable', pass: coreHealth.reachable, detail: coreHealth.detail ?? (coreHealth.reachable ? `Core ${coreHealth.version ?? ''}`.trim() : 'Unreachable') },
        { key: 'core_registration', label: 'Registered in W3 Core', pass: coreHealth.registration === 'registered', detail: coreHealth.registration === 'registered' ? `${env.appId} found in the Core app registry` : coreHealth.registration === 'not_registered' ? `${env.appId} not in the Core app registry` : 'Not checked (service token not configured or Core unreachable)' }
      ];

      res.json({
        success: true,
        data: {
          system: { version: env.appVersion, gitCommit: process.env.W3_GIT_COMMIT?.trim() || null, environment: env.nodeEnv },
          migration_version: migrationVersion,
          production_data_mode: prodMode,
          all_checks_pass: checks.every((c) => c.pass),
          pass_count: checks.filter((c) => c.pass).length,
          total_checks: checks.length,
          checks,
          backup: {
            exists: backupHealth.exists,
            filename: backupHealth.filename,
            size_bytes: backupHealth.sizeBytes,
            mtime: backupHealth.mtime,
            age_hours: backupHealth.ageHours,
            health: backupHealth.health
          },
          cutover_record: cutover
        }
      });
    } catch (err) {
      next(err);
    }
  });

  router.get('/production-config', async (_req, res, next) => {
    try {
      const r = await db.query<{ key: string; value: string; updated_at: Date; updated_by: string | null }>('SELECT key, value, updated_at, updated_by FROM public.platform_config ORDER BY key');
      const data: Record<string, unknown> = {};
      for (const row of r.rows) {
        let v: unknown = row.value;
        try { v = JSON.parse(row.value); } catch { /* keep raw */ }
        data[row.key] = v;
      }
      res.json({ success: true, data });
    } catch (err) {
      next(err);
    }
  });

  router.post('/production-config', async (req, res, next) => {
    try {
      const { key, value } = (req.body ?? {}) as { key?: unknown; value?: unknown };
      if (key !== 'productionDataMode') {
        res.status(400).json({ success: false, error: 'Unknown config key. Allowed: productionDataMode' });
        return;
      }
      const user = req.forgeUser!;
      await db.transaction(async (tx) => {
        await tx.query(
          `INSERT INTO public.platform_config (key, value, updated_at, updated_by) VALUES ($1, $2, NOW(), $3)
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW(), updated_by = EXCLUDED.updated_by`,
          [key, JSON.stringify(value ?? null), user.coreUserId]
        );
        await audit(tx, { coreUserId: user.coreUserId, name: user.displayName }, 'admin.config_changed', 'platform_config', key, null, null, { value: value ?? null });
      });
      res.json({ success: true, data: { key, value: value ?? null } });
    } catch (err) {
      next(err);
    }
  });

  router.get('/production-cutover', async (_req, res, next) => {
    try {
      res.json({ success: true, data: await cutoverRecord() });
    } catch (err) {
      next(err);
    }
  });

  router.post('/production-cutover', async (req, res, next) => {
    try {
      const notes = typeof req.body?.notes === 'string' ? req.body.notes.slice(0, 2000) : null;
      const user = req.forgeUser!;
      const result = await db.transaction(async (tx) => {
        await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`${env.appId}:cutover`]);
        const existing = await tx.query<CutoverRow>('SELECT id, enabled_at, enabled_by_core_user_id, enabled_version, notes FROM public.production_cutover_record ORDER BY id LIMIT 1');
        if (existing.rows[0]) return { record: cutoverOut(existing.rows[0]), already: true };
        const r = await tx.query<CutoverRow>(
          `INSERT INTO public.production_cutover_record (enabled_by_core_user_id, enabled_version, notes) VALUES ($1, $2, $3)
           RETURNING id, enabled_at, enabled_by_core_user_id, enabled_version, notes`,
          [user.coreUserId, env.appVersion, notes]
        );
        await tx.query(
          `INSERT INTO public.platform_config (key, value, updated_at, updated_by) VALUES ('productionDataMode', '{"enabled":true}', NOW(), $1)
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW(), updated_by = EXCLUDED.updated_by`,
          [user.coreUserId]
        );
        await audit(tx, { coreUserId: user.coreUserId, name: user.displayName }, 'admin.production_mode_enabled', 'production_cutover_record', String(r.rows[0].id), null, null, { version: env.appVersion });
        return { record: cutoverOut(r.rows[0]), already: false };
      });
      if (result.already) res.json({ success: true, data: result.record, already_recorded: true });
      else res.status(201).json({ success: true, data: result.record });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
