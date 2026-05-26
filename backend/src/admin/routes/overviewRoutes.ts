import { Router } from 'express';
import { respond } from '../envelope';

// GET /api/admin/overview — Attention Required banner.
// Foundation-only static payload (parity with W3 Core v0.5.0 placeholder).
export function buildAdminOverviewRoutes(): Router {
  const router = Router();
  router.get('/overview', (_req, res) => {
    respond.ok(res, {
      attention: {
        acknowledged: false,
        message:
          'W3 Forge v0.4.0 Admin Console is a read-only foundation. Real alerts land in a later release.',
        items: [
          {
            severity: 'info',
            label: 'Internal-only — bound to 127.0.0.1.'
          },
          {
            severity: 'info',
            label: 'W3 Core remains deployment and release authority.'
          }
        ]
      }
    });
  });
  return router;
}
