import { Router } from 'express';
import {
  dashboardLayoutFilePath,
  getLayout,
  resetLayout,
  saveLayout,
  sanitizeIncoming
} from '../../services/dashboardLayoutStore';

// =============================================================================
// /api/admin/dashboard/layout — v0.5.3 tile layout persistence.
// =============================================================================
//
// Read-write API for the admin dashboard tile layout. Unlike most v0.5.x admin
// surfaces this DOES write to disk, but the only thing it writes is a single
// dashboard-layout.json file outside /opt/w3forge, which is the documented
// safe write target for layout state. The file survives systemd restarts and
// deploy-w3forge.sh rsync --delete because the storage dir is sibling of the
// runtime app directory (default: /opt/w3forge-data).
//
// Routes:
//   GET   /dashboard/layout         → current layout (or default if no file)
//   PUT   /dashboard/layout         → save sanitized layout
//   POST  /dashboard/layout/reset   → remove saved file, return default
//
// All responses use the same { success, data, error } envelope shape as the
// rest of /api/admin/* so the existing typed fetch client works unchanged.

export function buildAdminDashboardLayoutRoutes(): Router {
  const router = Router();

  router.get('/dashboard/layout', async (_req, res, next) => {
    try {
      const { layout, source } = await getLayout();
      res.json({
        success: true,
        data: {
          ...layout,
          source, // 'file' | 'default' — useful for the UI to show "Using Default Layout"
          path: dashboardLayoutFilePath()
        }
      });
    } catch (err) {
      next(err);
    }
  });

  router.put('/dashboard/layout', async (req, res, next) => {
    try {
      const sanitized = sanitizeIncoming(req.body);
      if ('error' in sanitized) {
        res.status(400).json({
          success: false,
          error: { code: 'INVALID_LAYOUT', message: sanitized.error }
        });
        return;
      }
      const saved = await saveLayout(sanitized);
      res.json({
        success: true,
        data: {
          ...saved,
          source: 'file' as const,
          path: dashboardLayoutFilePath()
        }
      });
    } catch (err) {
      next(err);
    }
  });

  router.post('/dashboard/layout/reset', async (_req, res, next) => {
    try {
      const layout = await resetLayout();
      res.json({
        success: true,
        data: {
          ...layout,
          source: 'default' as const,
          path: dashboardLayoutFilePath()
        }
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
