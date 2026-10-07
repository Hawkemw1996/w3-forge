import { afterAll, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertDatabaseConnectionAllowed } from '../src/db/testDatabaseGuard';
import { applyDatabaseGuard } from '../src/db/pool';
import { applyMigrations } from '../src/db/migrate';
import type { Database, Queryable } from '../src/db/database';
import type { Pool } from 'pg';

describe('Forge database isolation', () => {
  it('refuses other applications in all modes, including URL overrides', () => {
    for (const name of ['w3core', 'w3buildcost', 'postgres', '', 'w3forgeOther']) {
      for (const mode of ['production', 'test']) {
        expect(() => assertDatabaseConnectionAllowed({ databaseName: name, databaseUrl: '' }, mode)).toThrow();
        expect(() => assertDatabaseConnectionAllowed({ databaseName: 'w3forge', databaseUrl: 'postgres://localhost/' + name }, mode)).toThrow();
      }
    }
    expect(() => assertDatabaseConnectionAllowed({ databaseName: 'w3forge', databaseUrl: 'not-a-url' }, 'production')).toThrow();
  });
  it('requires disposable Forge targets under test and accepts own configured production target', () => {
    const own = { databaseName: 'w3forge', databaseUrl: '' };
    expect(() => assertDatabaseConnectionAllowed(own, 'production')).not.toThrow();
    expect(() => assertDatabaseConnectionAllowed(own, 'test')).toThrow();
    expect(() => assertDatabaseConnectionAllowed({ ...own, databaseName: 'w3forge_test_parity' }, 'test')).not.toThrow();
  });
  it('rejects promise and callback queries/connect before any network activity', async () => {
    const query = vi.fn(), connect = vi.fn();
    const stub = { query, connect } as unknown as Pool;
    applyDatabaseGuard(stub, { databaseName: 'w3core', databaseUrl: '' });
    await expect(stub.query('SELECT 1')).rejects.toThrow();
    await expect(stub.connect()).rejects.toThrow();
    await new Promise<void>(resolve => stub.query('SELECT 1', error => { expect(error).toBeInstanceOf(Error); resolve(); }));
    await new Promise<void>(resolve => stub.connect(error => { expect(error).toBeInstanceOf(Error); resolve(); }));
    expect(query).not.toHaveBeenCalled(); expect(connect).not.toHaveBeenCalled();
  });
  it('refuses an unconfigured pool even for a permitted database', async () => {
    const query = vi.fn(), connect = vi.fn();
    const stub = { query, connect } as unknown as Pool;
    applyDatabaseGuard(stub, { databaseName: 'w3forge_test', databaseUrl: '' }, false);
    await expect(stub.query('SELECT 1')).rejects.toThrow('not configured');
    expect(query).not.toHaveBeenCalled();
  });
});

describe('administrative migration integrity', () => {
  const pg = new PGlite();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-migration-'));
  type Executable = Queryable & { exec(sql: string): Promise<unknown> };
  const db: Database = {
    query: async <T>(sql: string, params: unknown[] = []) => {
      const r = await pg.query<T>(sql, params); return { rows: r.rows, rowCount: r.affectedRows };
    },
    ping: async () => true,
    transaction: fn => pg.transaction(async tx => fn({
      query: async <T>(sql: string, params: unknown[] = []) => {
        const r = await tx.query<T>(sql, params); return { rows: r.rows, rowCount: r.affectedRows };
      }, exec: (sql: string) => tx.exec(sql)
    } as Executable))
  };
  const exec = async (tx: Queryable, sql: string) => { await (tx as Executable).exec(sql); };
  afterAll(async () => { await pg.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  it('applies atomically, replays without changes, and refuses modified migrations', async () => {
    const name = '001_test_foundation.sql', file = path.join(dir, name);
    fs.writeFileSync(file, 'CREATE TABLE parity_rows (id int PRIMARY KEY); INSERT INTO parity_rows VALUES (1);');
    expect(await applyMigrations(db, dir, exec)).toEqual({ applied: [name], skipped: [] });
    expect(await applyMigrations(db, dir, exec)).toEqual({ applied: [], skipped: [name] });
    const original = fs.readFileSync(file, 'utf8');
    fs.appendFileSync(file, '\n-- changed');
    await expect(applyMigrations(db, dir, exec)).rejects.toThrow('checksum mismatch');
    fs.writeFileSync(file, original);
    fs.writeFileSync(path.join(dir, '002_invalid.sql'), 'INSERT INTO parity_rows VALUES (2); SELECT missing_column FROM parity_rows;');
    await expect(applyMigrations(db, dir, exec)).rejects.toThrow();
    expect((await db.query('SELECT id FROM parity_rows ORDER BY id')).rows).toEqual([{ id: 1 }]);
    expect((await db.query('SELECT migration_name FROM schema_migrations')).rows).toEqual([{ migration_name: name }]);
  });
});
