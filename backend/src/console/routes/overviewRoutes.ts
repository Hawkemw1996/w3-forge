import { Router } from 'express';
import { collectAttention } from '../attention';

// =============================================================================
// /api/admin/overview — read-only dashboard operational observations.
// =============================================================================
//
// Existing Admin authorization is unchanged. Each bounded observation keeps
// missing evidence distinct from a healthy result.

export function buildAdminOverviewRoutes(): Router {
  const router = Router();

  router.get('/overview', async (_req, res, next) => {
    try { res.json({ success: true, data: await collectAttention() }); }
    catch (error) { next(error); }
  });

  return router;
}
