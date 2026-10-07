import { Pool } from 'pg';
import { env } from '../config/env';
import { assertDatabaseConnectionAllowed, type ResolvedDatabaseTarget } from './testDatabaseGuard';

export const databaseConfigured = !!(env.databaseUrl || process.env.FORGE_DATABASE_NAME || process.env.DATABASE_NAME || process.env.DB_NAME);
const target: ResolvedDatabaseTarget = { databaseUrl: env.databaseUrl, databaseName: env.databaseName };
const poolConfig = env.databaseUrl ? { connectionString: env.databaseUrl } : {
  host: env.databaseHost, port: env.databasePort, database: env.databaseName,
  user: env.databaseUser, password: env.databasePassword
};
export const pool = new Pool({ ...poolConfig, connectionTimeoutMillis: 3000, query_timeout: 5000, max: 5 });

/** Both pg calling conventions remain intact, including query's internal connect(callback). */
export function applyDatabaseGuard(targetPool: Pool, identity: ResolvedDatabaseTarget, configured = true): void {
  const wrap = (original: (...args: any[]) => any) => function (...args: any[]) {
    try {
      if (!configured) throw new Error('Forge database is not configured.');
      assertDatabaseConnectionAllowed(identity);
    } catch (error) {
      const callback = args.at(-1);
      if (typeof callback === 'function') { process.nextTick(() => callback(error)); return; }
      return Promise.reject(error);
    }
    return original(...args);
  };
  targetPool.query = wrap(targetPool.query.bind(targetPool)) as typeof targetPool.query;
  targetPool.connect = wrap(targetPool.connect.bind(targetPool)) as typeof targetPool.connect;
}
// Always enforce app isolation; no request can fall back to another app's database.
applyDatabaseGuard(pool, target, databaseConfigured);
pool.on('error', () => console.error('[w3forge] Database connection unavailable.'));
export async function testDatabaseConnection() {
  try { await pool.query('SELECT 1'); return true; } catch { return false; }
}
