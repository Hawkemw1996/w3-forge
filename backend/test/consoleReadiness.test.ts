import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import type { Database, Queryable } from '../src/db/database';
import { applyMigrations } from '../src/db/migrate';
import { envelopeErrorHandler } from '../src/admin/envelope';
import { createCoreFixture } from './coreFixture';
import { makeForgeTree } from './setup';

const root = makeForgeTree();
process.env.W3_FORGE_ROOT = root;
process.env.W3_FORGE_ACTIVE_APP = 'w3forge';
process.env.ADMIN_ALLOWED_IPS = '*';
process.env.W3_BACKUPS_DIR = path.join(root, 'backups');
fs.mkdirSync(process.env.W3_BACKUPS_DIR, { recursive: true });
fs.writeFileSync(path.join(process.env.W3_BACKUPS_DIR, 'w3forge-backup.tar.gz'), 'test-backup');
let buildRoutes: typeof import('../src/console/routes/productionReadinessRoutes').buildProductionReadinessRoutes;
let pg: PGlite;
let db: Database;
type Executable = Queryable & { exec(sql: string): Promise<unknown> };
beforeAll(async () => { buildRoutes = (await import('../src/console/routes/productionReadinessRoutes')).buildProductionReadinessRoutes; });
beforeEach(async () => {
  pg = new PGlite();
  const query = async <T>(sql: string, params: unknown[] = []) => {
    const result = await pg.query<T>(sql, params);
    return { rows: result.rows, rowCount: result.affectedRows };
  };
  db = {
    query,
    ping: async () => { await pg.query('SELECT 1'); return true; },
    transaction: fn => pg.transaction(async tx => {
      const adapted: Executable = {
        query: async <T>(sql: string, params: unknown[] = []) => {
          const result = await tx.query<T>(sql, params);
          return { rows: result.rows, rowCount: result.affectedRows };
        },
        exec: sql => tx.exec(sql)
      };
      return fn(adapted);
    })
  };
  await applyMigrations(db, path.resolve(__dirname, '../../database/migrations'), async (tx, sql) => { await (tx as Executable).exec(sql); });
});
afterEach(async () => { await pg.close(); });
function setup(database = db) {
  const fixture = createCoreFixture();
  fixture.core.health = async () => ({ reachable: true, registration: 'registered', version: '0.12.22' });
  const app = express();
  app.use('/api/auth', fixture.auth.router);
  app.use('/api/admin', fixture.auth.requireAdmin, fixture.auth.sameOrigin, express.json(), buildRoutes({ db: database, core: fixture.core }), envelopeErrorHandler);
  const agent = request.agent(app);
  const get = (route: string) => agent.get('/api/admin/' + route);
  const post = (route: string, data: unknown = {}) => agent.post('/api/admin/' + route).send(data);
  return { ...fixture, app, agent, get, post };
}

describe('canonical readiness routes with real PostgreSQL semantics', () => {
  it('reports actual administrative schema, migration, audit protection, backups and Core measurements', async () => {
    const f = setup(); await f.login(f.agent);
    const response = await f.get('production-readiness');
    expect(response.status).toBe(200);
    const data = response.body.data;
    expect(data).toMatchObject({ migration_version: '001_admin_foundation.sql', production_data_mode: false, all_checks_pass: true, pass_count: 9, total_checks: 9, cutover_record: null,
      backup: { exists: true, filename: 'w3forge-backup.tar.gz', size_bytes: 11, health: 'green' } });
    expect(data.checks.map((check: { key: string }) => check.key)).toEqual(['database_connected', 'migrations_applied', 'required_tables', 'history_protection', 'audit_logging', 'backup_exists', 'backup_age', 'core_reachable', 'core_registration']);
    expect(data.checks.find((check: { key: string }) => check.key === 'required_tables')).toMatchObject({ pass: true, detail: '4 required tables present' });
    expect(JSON.stringify(data)).not.toContain('BuildCost');
  });
  it('persists production configuration with the requesting Core identity and an atomic audit event', async () => {
    const f = setup(); await f.login(f.agent);
    const invalid = await f.post('production-config', { key: 'other', value: true });
    expect(invalid.status).toBe(400);
    expect((await f.get('production-config')).body.data).toEqual({});
    const saved = await f.post('production-config', { key: 'productionDataMode', value: { enabled: true } });
    expect(saved.body).toEqual({ success: true, data: { key: 'productionDataMode', value: { enabled: true } } });
    expect((await f.get('production-config')).body.data).toEqual({ productionDataMode: { enabled: true } });
    const audit = await db.query<{ actor_core_user_id: string; actor_name: string; action: string; details: unknown }>('SELECT actor_core_user_id, actor_name, action, details FROM audit_events');
    expect(audit.rows).toEqual([{ actor_core_user_id: '1', actor_name: 'operator', action: 'admin.config_changed', details: { value: { enabled: true } } }]);
    await f.post('production-config', { key: 'productionDataMode', value: { enabled: false } });
    expect((await f.get('production-readiness')).body.data.production_data_mode).toBe(false);
  });
  it('records the first cutover once under concurrent requests and preserves it on later requests', async () => {
    const f = setup(); await f.login(f.agent);
    expect((await f.get('production-cutover')).body.data).toBeNull();
    const replies = await Promise.all([f.post('production-cutover', { notes: 'first note' }), f.post('production-cutover', { notes: 'second note' })]);
    expect(replies.map(r => r.status).sort()).toEqual([200, 201]);
    const created = replies.find(r => r.status === 201)!;
    const repeated = replies.find(r => r.status === 200)!;
    expect(repeated.body).toEqual({ success: true, data: created.body.data, already_recorded: true });
    expect(created.body.data).toMatchObject({ id: 1, enabled_by: '1', enabled_version: '0.4.0' });
    expect((await f.get('production-cutover')).body.data).toEqual(created.body.data);
    expect((await f.get('production-config')).body.data).toEqual({ productionDataMode: { enabled: true } });
    expect((await db.query('SELECT * FROM production_cutover_record')).rows).toHaveLength(1);
    expect((await db.query("SELECT * FROM audit_events WHERE action = 'admin.production_mode_enabled'")).rows).toHaveLength(1);
  });
  it('rolls back configuration and cutover when their required audit write fails', async () => {
    const f = setup(); await f.login(f.agent);
    await pg.exec("CREATE FUNCTION reject_test_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test audit unavailable'; END; $$; CREATE TRIGGER reject_test_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_test_audit();");
    expect((await f.post('production-config', { key: 'productionDataMode', value: { enabled: true } })).status).toBe(500);
    expect((await db.query('SELECT * FROM platform_config')).rows).toEqual([]);
    expect((await f.post('production-cutover', { notes: 'must roll back' })).status).toBe(500);
    expect((await db.query('SELECT * FROM production_cutover_record')).rows).toEqual([]);
    expect((await db.query('SELECT * FROM platform_config')).rows).toEqual([]);
    expect((await db.query('SELECT * FROM audit_events')).rows).toEqual([]);
  });
  it('reports unavailable database measurements truthfully and refuses persistence while offline', async () => {
    const unavailable = async () => { throw new Error('Database is not configured'); };
    const f = setup({ query: unavailable, transaction: unavailable, ping: async () => false }); await f.login(f.agent);
    const readiness = await f.get('production-readiness');
    expect(readiness.status).toBe(200);
    expect(readiness.body.data).toMatchObject({ all_checks_pass: false, migration_version: null, production_data_mode: false, cutover_record: null });
    for (const key of ['database_connected', 'migrations_applied', 'required_tables', 'history_protection', 'audit_logging']) {
      expect(readiness.body.data.checks.find((check: { key: string }) => check.key === key).pass).toBe(false);
    }
    expect((await f.get('production-config')).status).toBe(500);
    expect((await f.post('production-config', { key: 'productionDataMode', value: { enabled: true } })).status).toBe(500);
    expect((await f.post('production-cutover')).status).toBe(500);
  });
  it('requires current app-admin assignment and same-origin JSON before all persistence', async () => {
    const f = setup();
    expect((await f.get('production-readiness')).status).toBe(401);
    expect((await f.post('production-cutover')).status).toBe(401);
    await f.login(f.agent);
    expect((await f.post('production-cutover').set('Origin', 'https://evil.test')).status).toBe(403);
    f.state.role = 'viewer';
    expect((await f.post('production-cutover')).status).toBe(403);
    f.state.role = 'admin'; f.state.revoked = true;
    expect((await f.post('production-config', { key: 'productionDataMode', value: { enabled: true } })).status).toBe(401);
    expect((await db.query('SELECT * FROM platform_config')).rows).toEqual([]);
    expect((await db.query('SELECT * FROM production_cutover_record')).rows).toEqual([]);
  });
});
