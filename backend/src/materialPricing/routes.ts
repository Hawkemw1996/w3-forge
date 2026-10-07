import { createHash, timingSafeEqual } from 'node:crypto';
import { Router, json, type ErrorRequestHandler } from 'express';
import { AdminError, respond } from '../admin/envelope';
import { adminGuard } from '../admin/adminGuard';
import type { PricingConfig } from './config';
import { createPricingService } from './service';
import type { Fetcher } from './transport';

// Separate narrowly scoped service identity. This router grants no admin/session access.
// Paid collection is intentionally NOT an existing read-only safeRunner control.
export function buildMaterialPricingRouter(config: PricingConfig, fetcher?: Fetcher): Router {
  const router = Router();
  const service = createPricingService(config, fetcher);
  const digest = (token: string) => createHash('sha256').update(token).digest();
  router.use(adminGuard);
  router.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!config.enabled) { respond.err(res, 503, 'MATERIAL_PRICING_DISABLED', 'Material pricing is disabled.'); return; }
    const header = req.get('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token || token.length > 256 || !timingSafeEqual(digest(token), digest(config.sharedToken))) {
      respond.err(res, 401, 'PRICING_AUTH_REQUIRED', 'A valid material pricing service credential is required.'); return;
    }
    if (req.get('origin')) { respond.err(res, 403, 'SERVICE_REQUEST_REQUIRED', 'Material pricing accepts server requests only.'); return; }
    if (req.method === 'POST' && !req.is('application/json')) {
      respond.err(res, 415, 'JSON_REQUIRED', 'A JSON request is required.'); return;
    }
    next();
  });
  router.use(json({ limit: '64kb', strict: true }));
  router.post('/collect', async (req, res, next) => {
    try { respond.ok(res, await service.collect(req.body)); } catch (error) { next(error); }
  });
  router.post('/match', async (req, res, next) => {
    try { respond.ok(res, await service.match(req.body)); } catch (error) { next(error); }
  });
  router.use((_req, res) => { respond.err(res, 404, 'NOT_FOUND', 'Material pricing endpoint not found.'); });
  const errors: ErrorRequestHandler = (error, _req, res, _next) => {
    if (error instanceof AdminError) { respond.err(res, error.status, error.code, error.message); return; }
    if (error?.type === 'entity.too.large') { respond.err(res, 413, 'REQUEST_TOO_LARGE', 'The pricing request is too large.'); return; }
    if (error instanceof SyntaxError) { respond.err(res, 400, 'INVALID_JSON', 'Invalid JSON request.'); return; }
    respond.err(res, 500, 'PRICING_INTERNAL_ERROR', 'The material pricing request could not be completed.');
  };
  router.use(errors);
  return router;
}
