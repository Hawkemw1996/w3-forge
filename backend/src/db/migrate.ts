// W3 Forge — ledger-aware migration runner (Node).
//
// Same rules as scripts/_w3forge-migration-ledger.sh (the runner the
// deploy scripts use):
//   - files must be named NNN_snake_case.sql (README.md is ignored);
//   - applied in name order; each migration and its schema_migrations row are
//     committed in ONE transaction (a failure rolls both back);
//   - an applied migration whose checksum (sha256 of the file bytes) differs
//     from the ledger, or whose ledger checksum is NULL, stops the run:
//     released migrations are immutable;
//   - re-running is a no-op for applied migrations.
//
// Used by the test suite (PGlite / disposable databases) and by
// `npm run db:migrate --workspace backend` for local development.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Database } from './database';

export const MIGRATION_NAME = /^[0-9]{3}_[a-z0-9_]+\.sql$/;

export interface MigrationFile {
  name: string;
  checksum: string;
  sql: string;
}

export function readMigrations(dir: string): MigrationFile[] {
  if (!fs.existsSync(dir)) throw new Error(`No migrations directory at ${dir}`);
  const names = fs.readdirSync(dir).filter((n) => n !== 'README.md');
  for (const n of names) {
    if (!MIGRATION_NAME.test(n)) throw new Error(`Unexpected file in migrations directory: ${n} (expected NNN_snake_case.sql).`);
  }
  const files = names.sort().map((name) => {
    const buf = fs.readFileSync(path.join(dir, name));
    return { name, checksum: crypto.createHash('sha256').update(buf).digest('hex'), sql: buf.toString('utf8') };
  });
  if (!files.length) throw new Error(`No SQL migrations found in ${dir}`);
  return files;
}

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

export async function ensureLedger(db: Database): Promise<void> {
  await db.query(`CREATE TABLE IF NOT EXISTS public.schema_migrations (
    migration_name TEXT PRIMARY KEY,
    checksum       TEXT,
    applied_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
}

/**
 * Apply pending migrations. `exec` runs a multi-statement SQL script inside the
 * given transaction (pg: client.query(sql); PGlite: tx.exec(sql)).
 */
export async function applyMigrations(
  db: Database,
  dir: string,
  exec: (tx: import('./database').Queryable, sql: string) => Promise<void> = (tx, sql) => tx.query(sql).then(() => undefined)
): Promise<MigrationResult> {
  const files = readMigrations(dir);
  await ensureLedger(db);
  const out: MigrationResult = { applied: [], skipped: [] };
  for (const f of files) {
    const r = await db.query<{ checksum: string | null }>('SELECT checksum FROM public.schema_migrations WHERE migration_name = $1', [f.name]);
    if (r.rows.length) {
      const sum = r.rows[0].checksum;
      if (sum == null) throw new Error(`Migration ${f.name} has a NULL ledger checksum. Refusing to proceed.`);
      if (sum !== f.checksum) throw new Error(`Migration ${f.name} checksum mismatch: ledger=${sum} disk=${f.checksum}. Released migrations are immutable; refusing to proceed.`);
      out.skipped.push(f.name);
      continue;
    }
    await db.transaction(async (tx) => {
      await exec(tx, f.sql);
      await tx.query('INSERT INTO public.schema_migrations (migration_name, checksum) VALUES ($1, $2)', [f.name, f.checksum]);
    });
    out.applied.push(f.name);
  }
  return out;
}

/** The migrations directory shipped with this checkout / deploy. */
export function defaultMigrationsDir(repoRoot: string): string {
  return path.join(repoRoot, 'database', 'migrations');
}
