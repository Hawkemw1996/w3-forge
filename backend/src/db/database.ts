// W3 Forge — minimal database interface used by the domain services.
//
// Services depend on this interface instead of the global pg pool so the test
// suite can run the real SQL against an isolated in-process PostgreSQL
// (@electric-sql/pglite, already a W3 Core devDependency) or a disposable
// w3forge_test* database. Production uses `pgDatabase(pool)`.

import type { Pool, PoolClient } from 'pg';

export interface QueryResultLike<T> {
  rows: T[];
  rowCount?: number | null;
}

export interface Queryable {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<QueryResultLike<T>>;
}

export interface Database extends Queryable {
  /** Run `fn` in one transaction (BEGIN … COMMIT, ROLLBACK on any error). */
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  /** Cheap connectivity probe. */
  ping(): Promise<boolean>;
}

export function pgDatabase(pool: Pool): Database {
  return {
    async query<T>(text: string, params: unknown[] = []) {
      const r = await pool.query(text, params as unknown[]);
      return { rows: r.rows as T[], rowCount: r.rowCount };
    },
    async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
      const client: PoolClient = await pool.connect();
      try {
        await client.query('BEGIN');
        const tx: Queryable = {
          async query<R>(text: string, params: unknown[] = []) {
            const r = await client.query(text, params as unknown[]);
            return { rows: r.rows as R[], rowCount: r.rowCount };
          }
        };
        const out = await fn(tx);
        await client.query('COMMIT');
        return out;
      } catch (err) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // connection already broken; the original error is what matters
        }
        throw err;
      } finally {
        client.release();
      }
    },
    async ping() {
      try {
        await pool.query('SELECT 1');
        return true;
      } catch {
        return false;
      }
    }
  };
}
