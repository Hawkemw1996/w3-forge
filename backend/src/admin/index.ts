import { Router, json } from 'express';
import type { CoreAuth } from '../auth/coreAuth';
import { adminGuard } from './adminGuard';
import { adminAudit } from './adminAudit';
import { envelopeErrorHandler, envelopeNotFound } from './envelope';
import { buildAdminOverviewRoutes } from './routes/overviewRoutes';
import { buildAdminSystemRoutes } from './routes/systemRoutes';
import { buildAdminLogsRoutes } from './routes/logsRoutes';
import { buildAdminFilesRoutes } from './routes/filesRoutes';
import { buildForgeGitRoutes } from './routes/forgeGitRoutes';
import { buildAdminControlsRoutes } from './routes/controlsRoutes';
import { buildAdminTerminalRoutes } from './routes/terminalRoutes';
import { buildInventoryRoutes } from './routes/inventoryRoutes';
import { buildConnectionsRoutes } from './routes/connectionsRoutes';
import { createTerminalRuntime, type TerminalRuntime } from './terminal/runtime';

// =============================================================================
// /api/admin/* router — v0.4.0 Forge Admin Interface foundation.
// =============================================================================
//
// Order:
//   1. JSON body parser (small limit; admin payloads are tiny).
//   2. adminGuard       — IP allowlist; returns envelope failure on deny.
//   3. adminAudit       — JSONL log capturing status + error.code.
//   4. Core app admin assignment + same-origin JSON mutations.
//   5. Feature routers  — overview, system, logs, files, git, controls, terminal, connections.
//   5. envelopeNotFound — any unmatched /api/admin/* path → envelope 404.
//   6. envelopeErrorHandler — last; normalizes any thrown error to envelope.
//
// Inventory is read-only. Setup, release/deploy and backup execution are not mounted.

export function buildAdminRouter(startedAt: string, auth: CoreAuth, terminal: TerminalRuntime = createTerminalRuntime(auth)): Router {
  const router = Router();

  router.use(json({ limit: '64kb' }));
  router.use(adminGuard);
  router.use(adminAudit);
  router.use(auth.requireAdmin, auth.sameOrigin);

  router.use('/', buildAdminOverviewRoutes());
  router.use('/', buildAdminSystemRoutes(startedAt));
  router.use('/', buildAdminLogsRoutes());
  router.use('/', buildAdminFilesRoutes());
  router.use('/', buildForgeGitRoutes());
  router.use('/', buildAdminControlsRoutes());
  router.use('/', buildAdminTerminalRoutes(terminal));
  router.use('/', buildConnectionsRoutes());
  router.use('/', buildInventoryRoutes());

  router.use(envelopeNotFound);
  router.use(envelopeErrorHandler);

  return router;
}
