import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadPricingConfig, type PricingConfig } from '../src/materialPricing/config';
import { buildMaterialPricingRouter } from '../src/materialPricing/routes';
import { createPricingService, parseActorObservation } from '../src/materialPricing/service';
import { boundedJson } from '../src/materialPricing/transport';
import type { Observation } from '../src/materialPricing/types';

const dirs: string[] = [];
function config(overrides: Partial<PricingConfig> = {}): PricingConfig {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-pricing-'));
  dirs.push(dir);
  return { enabled: true, sharedToken: randomBytes(32).toString('hex'),
    apifyToken: 'apify_' + randomBytes(24).toString('hex'), dataDir: dir,
    maxProducts: 10, maxRequestChargeCents: 10, maxDailyChargeCents: 100,
    maxLedgerEntries: 1000, requestTimeoutMs: 25000, actorTimeoutSeconds: 180,
    ollamaUrl: 'http://127.0.0.1:11434', ollamaModel: 'qwen2.5:7b', ...overrides };
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
const input = { schemaVersion: 1, requestId: 'test-request-00000001', maxTotalChargeCents: 10, postalCode: '49221', storeId: '0088',
  products: [{ sourceId: 'source-1', productId: '123456789' }] };
const base: Observation = { sourceId: 'source-1', productId: '123456789', storeId: '0088', status: 'pending', observedAt: '2026-10-06T12:00:00.000Z' };
const output = (changes: Record<string, unknown> = {}) => ({ status: 200, stores: {
  '88': { id: '88', products: { '123456789': { name: '2x4 SPF stud', url: 'https://www.lowes.com/pd/stud/123456789',
    priceCentsPerUnit: 499, salePriceCentsPerUnit: 450, bulkPriceCentsPerUnit: 400, bulkQuantityRequired: 50, quantityAvailable: 42, ...changes } } }
} });
const run = (status = 'SUCCEEDED') => ({ data: { id: 'run123', status, defaultDatasetId: 'dataset123', finishedAt: '2026-10-06T12:00:00.000Z' } });
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
function provider(data: unknown = output()) {
  return vi.fn(async (url: string, init: RequestInit) => {
    if (init.method === 'POST') return json(run('RUNNING'), 201);
    if (url.includes('/actor-runs/')) return json(run());
    return json([data]);
  });
}
function client(cfg: PricingConfig, fetcher = provider()) {
  const app = express();
  app.use('/api/material-pricing', buildMaterialPricingRouter(cfg, fetcher));
  return { app, fetcher };
}

describe('material pricing configuration and service boundary', () => {
  it('is disabled by default and does not need or invoke providers', async () => {
    const cfg = loadPricingConfig({});
    const { app, fetcher } = client(cfg);
    expect((await request(app).post('/api/material-pricing/collect').send(input)).status).toBe(503);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('rejects weak or shared credentials, nonlocal Ollama and invalid limits without exposing values', () => {
    const cfg = config();
    const env = { W3_FORGE_MATERIAL_PRICING_ENABLED: 'true',
      W3_FORGE_MATERIAL_PRICING_SHARED_TOKEN: cfg.sharedToken,
      W3_FORGE_MATERIAL_PRICING_APIFY_TOKEN: cfg.apifyToken,
      W3_FORGE_MATERIAL_PRICING_DATA_DIR: cfg.dataDir };
    expect(loadPricingConfig(env).ollamaModel).toBe('');
    for (const extra of [
      { W3_FORGE_MATERIAL_PRICING_SHARED_TOKEN: 'weak' },
      { CORE_APP_CLIENT_SECRET: cfg.sharedToken },
      { W3_FORGE_MATERIAL_PRICING_OLLAMA_URL: 'http://evil.example:11434' },
      { W3_FORGE_MATERIAL_PRICING_MAX_PRODUCTS: '21' },
      { W3_FORGE_MATERIAL_PRICING_DATA_DIR: 'relative-path' },
      { W3_FORGE_MATERIAL_PRICING_OLLAMA_MODEL: 'other-model:latest' }
    ]) expect(() => loadPricingConfig({ ...env, ...extra })).toThrow('configuration is invalid');
  });
  it('requires the scoped bearer, JSON and server request, and cannot grant admin access', async () => {
    const cfg = config(), { app, fetcher } = client(cfg);
    expect((await request(app).post('/api/material-pricing/collect').set('Cookie', 'forge_session=admin').send(input)).status).toBe(401);
    expect((await request(app).post('/api/material-pricing/collect').set('Authorization', 'Bearer wrong').send(input)).status).toBe(401);
    expect((await request(app).post('/api/material-pricing/collect').set('Authorization', 'Bearer ' + cfg.sharedToken).set('Origin', 'https://forge.example').send(input)).status).toBe(403);
    expect((await request(app).post('/api/material-pricing/collect').set('Authorization', 'Bearer ' + cfg.sharedToken).send('text')).status).toBe(415);
    expect((await request(app).post('/api/material-pricing/admin').set('Authorization', 'Bearer ' + cfg.sharedToken).send({})).status).toBe(404);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('returns sanitized envelopes for malformed and oversized JSON', async () => {
    const cfg = config(), { app, fetcher } = client(cfg);
    const malformed = await request(app).post('/api/material-pricing/collect').set('Authorization', 'Bearer ' + cfg.sharedToken).set('Content-Type', 'application/json').send('{' + cfg.apifyToken);
    expect(malformed.status).toBe(400);
    expect(malformed.body.success).toBe(false);
    expect(JSON.stringify(malformed.body)).not.toContain(cfg.apifyToken);
    const large = await request(app).post('/api/material-pricing/collect').set('Authorization', 'Bearer ' + cfg.sharedToken).send({ value: 'x'.repeat(66000) });
    expect(large.status).toBe(413);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('validates ZIP, store, products, duplicate IDs and unknown fields before any paid POST', async () => {
    const cfg = config({ maxProducts: 1 }), fetcher = provider(), service = createPricingService(cfg, fetcher);
    for (const bad of [
      { ...input, postalCode: '00000' }, { ...input, storeId: '9999' },
      { ...input, callback: 'https://evil.example' }, { ...input, requestId: '../../escape' },
      { ...input, products: [...input.products, ...input.products] },
      { ...input, products: [{ sourceId: 'source-1', productId: 'https://evil.example' }] },
      { ...input, products: [...input.products, { sourceId: 'source-2', productId: '999' }] }
    ]) await expect(service.collect(bad)).rejects.toMatchObject({ code: 'INVALID_PRICING_REQUEST' });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('actor observations and bounded collection', () => {
  it('maps integer cents and separate discounts only from the selected store/product', () => {
    expect(parseActorObservation(output(), base).observation).toMatchObject({
      status: 'priced', regularPriceCents: 499, salePriceCents: 450, bulkPriceCents: 400, bulkQuantityRequired: 50, quantityAvailable: 42
    });
    const wrong = { status: 200, stores: { '9999': { id: '9999', products: {} } } };
    expect(parseActorObservation(wrong, base).observation).toMatchObject({ status: 'not_available' });
    const mismatch = output(); mismatch.stores['88'].id = '9999';
    expect(parseActorObservation(mismatch, base).observation.error).toBe('STORE_ID_MISMATCH');
    expect(parseActorObservation(output({ productId: '999' }), base).observation.error).toBe('PRODUCT_ID_MISMATCH');
    expect(parseActorObservation(output({ url: 'https://www.lowes.com/pd/other/999' }), base).observation.error).toBe('PRODUCT_URL_MISMATCH');
  });
  it('never invents regular prices, converts strings, accepts zero or treats sale/bulk as regular', () => {
    for (const price of [undefined, null, 0, -1, '499', 4.99, Number.MAX_SAFE_INTEGER]) {
      expect(parseActorObservation(output({ priceCentsPerUnit: price }), base).observation).toMatchObject({ status: 'failed', error: 'REGULAR_PRICE_MISSING_OR_INVALID' });
    }
    const priced = parseActorObservation(output({ salePriceCentsPerUnit: 0, bulkQuantityRequired: undefined }), base).observation;
    expect(priced.salePriceCents).toBeUndefined(); expect(priced.bulkPriceCents).toBeUndefined();
  });
  it('distinguishes actor 202/206 from a succeeded Apify run and does not repeat the actor POST', async () => {
    for (const status of [202, 206]) {
      const cfg = config(), fetcher = provider({ status, asyncId: 'pending-123' });
      const service = createPricingService(cfg, fetcher);
      const first = await service.collect(input);
      expect(first.observations[0]).toMatchObject({ status: 'pending', error: 'ACTOR_LOOKUP_PENDING' });
      expect(first.observations[0].regularPriceCents).toBeUndefined();
      await createPricingService(cfg, fetcher).collect(input);
      expect(fetcher.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1);
    }
  });
  it('passes provider-enforced spending/time caps and caches completed requests across service instances', async () => {
    const cfg = config(), fetcher = provider(), service = createPricingService(cfg, fetcher);
    const first = await service.collect(input);
    expect(first.observations[0]).toMatchObject({ ...base, status: 'priced', regularPriceCents: 499, apifyRunId: 'run123', datasetId: 'dataset123' });
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toContain('/acts/maplerope44~lowes-product-lookup/runs?');
    const query = new URL(url).searchParams;
    expect(query.get('maxTotalChargeUsd')).toBe('0.10');
    expect(query.get('timeout')).toBe('180'); expect(query.get('restartOnError')).toBe('false'); expect(query.get('maxItems')).toBe('1');
    expect(init.redirect).toBe('manual');
    expect(JSON.parse(init.body as string)).toEqual({ zip: '49221', productId: '123456789' });
    expect(url).not.toContain(cfg.apifyToken);
    expect(await createPricingService(cfg, fetcher).collect(input)).toEqual(first);
    expect(fetcher).toHaveBeenCalledTimes(3);
    await expect(service.collect({ ...input, products: [{ sourceId: 'source-1', productId: '999' }] })).rejects.toMatchObject({ code: 'PRICING_REQUEST_CONFLICT' });
  });
  it('records uncertain starts durably before POST and never retries a paid POST on timeout or redirect', async () => {
    for (const response of ['timeout', 'redirect']) {
      const cfg = config();
      const fetcher = vi.fn(async (_url: string, _init: RequestInit): Promise<Response> => {
        const saved = JSON.parse(fs.readFileSync(path.join(cfg.dataDir, 'requests.json'), 'utf8'));
        expect(saved.entries[input.requestId].items[0].state).toBe('starting');
        if (response === 'timeout') throw new Error(cfg.apifyToken);
        return new Response('', { status: 302, headers: { location: 'https://evil.example' } });
      });
      const first = await createPricingService(cfg, fetcher).collect(input);
      expect(first.observations[0].error).toBe('START_OUTCOME_UNKNOWN');
      expect(JSON.stringify(first)).not.toContain(cfg.apifyToken);
      await createPricingService(cfg, fetcher).collect(input);
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });
  it('GET polls known pending runs on retry without repeating the start', async () => {
    const cfg = config();
    let complete = false;
    const fetcher = vi.fn(async (url: string, init: RequestInit) => {
      if (init.method === 'POST') return json(run('RUNNING'));
      if (url.includes('/actor-runs/')) return json(run(complete ? 'SUCCEEDED' : 'RUNNING'));
      return json([output()]);
    });
    expect((await createPricingService(cfg, fetcher).collect(input)).observations[0].status).toBe('pending');
    complete = true;
    expect((await createPricingService(cfg, fetcher).collect(input)).observations[0].status).toBe('priced');
    expect(fetcher.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1);
  });
  it('fails closed when budget, capacity, or a stale durable lock blocks new requests', async () => {
    const cfg = config({ maxDailyChargeCents: 10 }), fetcher = provider(), service = createPricingService(cfg, fetcher);
    await service.collect(input);
    await expect(service.collect({ ...input, requestId: 'test-request-00000002' })).rejects.toMatchObject({ code: 'PRICING_DAILY_BUDGET' });
    const full = createPricingService({ ...cfg, maxLedgerEntries: 1 }, fetcher);
    await expect(full.collect({ ...input, requestId: 'test-request-00000003' })).rejects.toMatchObject({ code: 'PRICING_LEDGER_FULL' });
    fs.writeFileSync(path.join(cfg.dataDir, 'requests.lock'), '');
    await expect(service.collect(input)).rejects.toMatchObject({ code: 'PRICING_BUSY' });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it('bounds upstream body bytes and aborts a never-ending response deadline', async () => {
    await expect(boundedJson(async () => json({ text: 'x'.repeat(100) }), 'https://api.apify.com', {}, 100, 20)).rejects.toMatchObject({ code: 'PRICING_UPSTREAM_UNAVAILABLE' });
    const hanging = async (_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(new Error('aborted')));
    });
    await expect(boundedJson(hanging, 'https://api.apify.com', {}, 10)).rejects.toMatchObject({ code: 'PRICING_UPSTREAM_UNAVAILABLE' });
  });
});

describe('Qwen advisory matching', () => {
  const matchInput = { schemaVersion: 1, requestId: 'match-request-0000001', material: { materialId: 'mat-1', requirements: ['2x4', 'SPF', '8 feet'] },
    candidates: [{ productId: '123456789', name: '2x4 SPF stud', attributes: ['8 feet'] }] };
  const recommendation = { recommendedProductId: '123456789', discrepancies: ['Grade is not supplied'], reason: 'Confirm the missing grade before choosing this product.' };
  it('uses the exact configured model with schema-constrained output and no secrets, URLs or tools', async () => {
    const cfg = config();
    const fetcher = vi.fn(async (_url: string, _init: RequestInit) => json({ model: cfg.ollamaModel, done: true, message: { content: JSON.stringify(recommendation) } }));
    const result = await createPricingService(cfg, fetcher).match(matchInput);
    expect(result).toMatchObject({ ...recommendation, advisory: true, model: cfg.ollamaModel });
    const [url, init] = fetcher.mock.calls[0], sent = JSON.parse(init.body as string);
    expect(url).toBe('http://127.0.0.1:11434/api/chat');
    expect(sent.model).toBe(cfg.ollamaModel); expect(sent.stream).toBe(false); expect(sent.tools).toBeUndefined();
    expect(sent.format.properties.recommendedProductId.anyOf[0].enum).toEqual(['123456789']);
    expect(init.body).not.toContain(cfg.apifyToken); expect(init.body).not.toContain(cfg.sharedToken);
  });
  it('requires an explicitly configured installed model tag', async () => {
    const fetcher = provider();
    await expect(createPricingService(config({ ollamaModel: '' }), fetcher).match(matchInput)).rejects.toMatchObject({ code: 'MATCH_NOT_CONFIGURED' });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('rejects malformed JSON, unknown IDs, extra price fields, tool calls and prose URLs', async () => {
    const cfg = config();
    for (const content of ['not-json', JSON.stringify({ ...recommendation, recommendedProductId: '999' }),
      JSON.stringify({ ...recommendation, price: 499 }), JSON.stringify({ ...recommendation, reason: 'See https://evil.example' })]) {
      const fetcher = vi.fn(async () => json({ model: cfg.ollamaModel, done: true, message: { content } }));
      await expect(createPricingService(cfg, fetcher).match(matchInput)).rejects.toMatchObject({ code: 'MATCH_UNAVAILABLE' });
    }
    const tool = vi.fn(async () => json({ model: cfg.ollamaModel, done: true, message: { content: JSON.stringify(recommendation), tool_calls: [] } }));
    await expect(createPricingService(cfg, tool).match(matchInput)).rejects.toMatchObject({ code: 'MATCH_UNAVAILABLE' });
  });
});


describe('ledger corruption and upstream failure recovery', () => {
  it('rejects a corrupt reservation before starting a new actor', async () => {
    const cfg = config(), fetcher = provider();
    await createPricingService(cfg, fetcher).collect(input);
    const filename = path.join(cfg.dataDir, 'requests.json'), saved = JSON.parse(fs.readFileSync(filename, 'utf8'));
    delete saved.entries[input.requestId].reservedCents;
    fs.writeFileSync(filename, JSON.stringify(saved));
    await expect(createPricingService(cfg, fetcher).collect({ ...input, requestId: 'test-request-00000002' })).rejects.toMatchObject({ code: 'PRICING_LEDGER_UNAVAILABLE' });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it('returns a successful envelope for priced data and a failed observation for failed provider runs', async () => {
    const cfg = config(), { app } = client(cfg);
    const result = await request(app).post('/api/material-pricing/collect').set('Authorization', 'Bearer ' + cfg.sharedToken).send(input);
    expect(result.status).toBe(200); expect(result.body.success).toBe(true);
    expect(result.body.data.observations[0].regularPriceCents).toBe(499);
    const cfg2 = config(), failed = vi.fn(async () => json(run('FAILED')));
    expect((await createPricingService(cfg2, failed).collect(input)).observations[0]).toMatchObject({ status: 'failed', error: 'APIFY_RUN_FAILED' });
    await createPricingService(cfg2, failed).collect(input);
    expect(failed).toHaveBeenCalledTimes(2);
  });
});

describe('caller-authorized spending ceiling', () => {
  it('uses the smaller caller/server ceiling and persists that exact reservation', async () => {
    for (const [callerCap, serverCap, expected] of [[1, 10, 1], [50, 10, 10]]) {
      const cfg = config({ maxRequestChargeCents: serverCap }), fetcher = provider();
      await createPricingService(cfg, fetcher).collect({ ...input, maxTotalChargeCents: callerCap });
      expect(new URL(fetcher.mock.calls[0][0]).searchParams.get('maxTotalChargeUsd')).toBe((expected / 100).toFixed(2));
      const saved = JSON.parse(fs.readFileSync(path.join(cfg.dataDir, 'requests.json'), 'utf8'));
      expect(saved.entries[input.requestId].reservedCents).toBe(expected);
      expect(saved.entries[input.requestId].request.maxTotalChargeCents).toBe(callerCap);
    }
  });
  it('rejects missing/invalid or insufficient caller/server budgets before any actor request or ledger write', async () => {
    const cfg = config(), fetcher = provider(), service = createPricingService(cfg, fetcher);
    for (const maxTotalChargeCents of [undefined, null, 0, -1, 1.5, '10', 101]) {
      await expect(service.collect({ ...input, maxTotalChargeCents })).rejects.toMatchObject({ code: 'INVALID_PRICING_REQUEST' });
    }
    const two = { ...input, maxTotalChargeCents: 1, products: [...input.products, { sourceId: 'source-2', productId: '999' }] };
    await expect(service.collect(two)).rejects.toMatchObject({ code: 'PRICING_REQUEST_BUDGET' });
    await expect(createPricingService({ ...cfg, maxRequestChargeCents: 1 }, fetcher).collect({ ...two, maxTotalChargeCents: 10 })).rejects.toMatchObject({ code: 'PRICING_REQUEST_BUDGET' });
    expect(fetcher).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(cfg.dataDir, 'requests.json'))).toBe(false);
  });
  it('does not permit a retry to change its original authorization ceiling', async () => {
    const cfg = config(), fetcher = provider(), service = createPricingService(cfg, fetcher);
    await service.collect(input);
    await expect(service.collect({ ...input, maxTotalChargeCents: 20 })).rejects.toMatchObject({ code: 'PRICING_REQUEST_CONFLICT' });
    expect(fetcher.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1);
  });
  it('rejects persisted reservations or per-run allocations that exceed the original caller authorization', async () => {
    for (const mutation of ['reservation', 'allocation']) {
      const cfg = config(), fetcher = provider(), service = createPricingService(cfg, fetcher);
      await service.collect(input);
      const filename = path.join(cfg.dataDir, 'requests.json'), saved = JSON.parse(fs.readFileSync(filename, 'utf8'));
      const entry = saved.entries[input.requestId];
      if (mutation === 'reservation') { entry.reservedCents = 11; entry.perRunCents = 11; }
      else entry.perRunCents = 9;
      fs.writeFileSync(filename, JSON.stringify(saved));
      await expect(service.collect(input)).rejects.toMatchObject({ code: 'PRICING_LEDGER_UNAVAILABLE' });
      expect(fetcher).toHaveBeenCalledTimes(3);
    }
  });
});
