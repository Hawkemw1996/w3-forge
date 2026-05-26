// =============================================================================
// Envelope contract test — every /api/admin/* route returns the uniform
// ApiEnvelope shape on success AND failure.
// =============================================================================

import { describe, it, expect, beforeAll } from 'vitest';
import { makeForgeTree } from './setup';

let app: import('express').Express;
let request: typeof import('supertest');

const FORGE_ROOT = makeForgeTree();
process.env.W3_FORGE_ROOT = FORGE_ROOT;
process.env.W3_FORGE_ACTIVE_APP = 'w3forge';
process.env.ADMIN_ALLOWED_IPS = '*';

beforeAll(async () => {
  const expressMod = await import('express');
  request = (await import('supertest')).default as unknown as typeof import('supertest');
  const { buildAdminRouter } = await import('../src/admin');
  app = expressMod.default();
  app.use('/api/admin', buildAdminRouter(new Date().toISOString()));
});

function assertEnvelope(body: unknown): asserts body is { success: boolean } {
  expect(body).toBeTypeOf('object');
  expect(body).not.toBeNull();
  expect(body).toHaveProperty('success');
  const s = (body as { success: unknown }).success;
  expect(typeof s).toBe('boolean');
  if (s === true) {
    expect(body).toHaveProperty('data');
  } else {
    expect(body).toHaveProperty('error');
    const err = (body as { error: unknown }).error as Record<string, unknown>;
    expect(typeof err.code).toBe('string');
    expect(typeof err.message).toBe('string');
  }
}

describe('Envelope contract — happy paths', () => {
  it('GET /version is envelope success', async () => {
    const r = await request(app).get('/api/admin/version');
    expect(r.status).toBe(200);
    assertEnvelope(r.body);
    expect(r.body.success).toBe(true);
  });

  it('GET /overview is envelope success', async () => {
    const r = await request(app).get('/api/admin/overview');
    assertEnvelope(r.body);
    expect(r.body.success).toBe(true);
  });

  it('GET /system is envelope success', async () => {
    const r = await request(app).get('/api/admin/system');
    assertEnvelope(r.body);
    expect(r.body.success).toBe(true);
  });

  it('GET /logs is envelope success', async () => {
    const r = await request(app).get('/api/admin/logs');
    assertEnvelope(r.body);
    expect(r.body.success).toBe(true);
  });

  it('GET /files is envelope success', async () => {
    const r = await request(app).get('/api/admin/files');
    assertEnvelope(r.body);
    expect(r.body.success).toBe(true);
  });

  it('GET /controls is envelope success and lists only LOW/safe-direct controls', async () => {
    const r = await request(app).get('/api/admin/controls');
    assertEnvelope(r.body);
    expect(r.body.success).toBe(true);
    const ctrls = (r.body as { data: { controls: { riskLevel: string; runStrategy: string; readOnly: boolean }[] } })
      .data.controls;
    expect(ctrls.length).toBeGreaterThan(0);
    for (const c of ctrls) {
      expect(c.riskLevel).toBe('LOW');
      expect(c.runStrategy).toBe('safe-direct');
      expect(c.readOnly).toBe(true);
    }
  });
});

describe('Envelope contract — failure paths', () => {
  it('unknown route → envelope failure 404 NOT_FOUND', async () => {
    const r = await request(app).get('/api/admin/nope');
    assertEnvelope(r.body);
    expect(r.body.success).toBe(false);
    expect(r.status).toBe(404);
  });

  it('POST /controls/deploy-prod/run → envelope failure (control not registered)', async () => {
    const r = await request(app)
      .post('/api/admin/controls/deploy-prod/run')
      .set('Content-Type', 'application/json')
      .send({ controlId: 'deploy-prod', appId: 'w3forge' });
    assertEnvelope(r.body);
    expect(r.body.success).toBe(false);
    expect(r.status).toBe(404);
    expect((r.body as { error: { code: string } }).error.code).toBe('CONTROL_NOT_FOUND');
  });

  it('POST /controls with unknown appId → envelope failure', async () => {
    const r = await request(app)
      .post('/api/admin/controls/config-validate/run')
      .set('Content-Type', 'application/json')
      .send({ controlId: 'config-validate', appId: 'nonexistent' });
    assertEnvelope(r.body);
    expect(r.body.success).toBe(false);
    expect([404]).toContain(r.status);
  });

  it('invalid log file (path traversal) → envelope failure', async () => {
    const r = await request(app).get('/api/admin/logs/tail?file=../../../etc/passwd');
    assertEnvelope(r.body);
    expect(r.body.success).toBe(false);
    // Either pre-flight (400 INVALID_FILE on the `..` segment) or post-flight
    // (403 PATH_ESCAPE on the realpath check) is an acceptable rejection.
    expect([400, 403]).toContain(r.status);
  });

  it('invalid file browse (..) → envelope failure', async () => {
    const r = await request(app).get('/api/admin/files?path=..');
    assertEnvelope(r.body);
    expect(r.body.success).toBe(false);
  });
});
