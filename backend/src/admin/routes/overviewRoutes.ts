import { Router } from 'express';
import { respond } from '../envelope';

// GET /api/admin/overview — Attention Required banner.
// Stable operating guidance; connection health is shown by the relevant feature.
export function buildAdminOverviewRoutes(): Router {
  const router = Router();
  router.get('/overview', (_req, res) => {
    respond.ok(res, {
      attention: {
        acknowledged: false,
        message:
          'Review Settings for service configuration and GitHub Validation for repository access.',
        items: [
          {
            severity: 'info',
            label: 'Interactive terminal access requires a Forge admin assignment and explicit host enablement.'
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
