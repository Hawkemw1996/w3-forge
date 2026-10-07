// W3 Forge — `npm run db:migrate --workspace backend`
//
// Applies pending migrations from database/migrations to the database named
// by DB_* (see .env.example) using the ledger rules in ./migrate.ts. Refuses
// the W3 Core database (pool guard). Production deploys use
// scripts/migrate-w3forge.sh (same rules, run by the release scripts).

import { pool } from './pool';
import { pgDatabase } from './database';
import { applyMigrations, defaultMigrationsDir } from './migrate';
import { repoRoot } from '../config/env';

async function main() {
  const db = pgDatabase(pool);
  try {
    const r = await applyMigrations(db, defaultMigrationsDir(repoRoot));
    for (const n of r.skipped) console.log(`skip  ${n} (already applied, checksum OK)`);
    for (const n of r.applied) console.log(`apply ${n}`);
    console.log(`Migrations complete: ${r.applied.length} applied, ${r.skipped.length} already present.`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(`Migration failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
