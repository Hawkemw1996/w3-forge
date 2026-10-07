import { Router, json, type ErrorRequestHandler } from 'express';
import { env } from '../config/env';
import { resolveDatabaseName } from '../db/testDatabaseGuard';
import type { CoreAuth } from '../auth/coreAuth';
import type { CoreClient } from '../auth/coreClient';
import type { Database } from '../db/database';
import { adminGuard } from '../admin/adminGuard';
import { AdminError, envelopeNotFound, respond } from '../admin/envelope';
import { AppError } from '../types/api';
import { adminAudit } from './adminAudit';
import { githubRepositoryUrl } from './githubValidation/repositoryIdentity';
import { auditEvents } from '../db/audit';
import { buildAdminOverviewRoutes } from './routes/overviewRoutes';
import { buildAdminSystemRoutes } from './routes/systemRoutes';
import { buildAdminLogsRoutes } from './routes/logsRoutes';
import { buildAdminPackagesRoutes } from './routes/packagesRoutes';
import { buildAdminBackupsRoutes } from './routes/backupsRoutes';
import { buildAdminFilesRoutes } from './routes/filesRoutes';
import { buildAdminGitRoutes } from './routes/gitRoutes';
import { buildAdminDashboardLayoutRoutes } from './routes/dashboardLayoutRoutes';
import { buildAdminControlsRoutes } from './routes/controlsRoutes';
import { buildProductionReadinessRoutes } from './routes/productionReadinessRoutes';
import { buildAdminTerminalRoutes } from './routes/terminalRoutes';
import type { TerminalRuntime } from './terminal/runtime';
import { getAppName, getRepoUrl, getRuntimePath, getDeployPath, getScriptsPath,
  getLogsPath, getBackupsPath, getUpdatePackagesPath, getServiceName } from './appConfigAccessors';

export interface ConsoleDeps { auth: CoreAuth; core: CoreClient; terminal: TerminalRuntime; db: Database; }

// Operational routes use the canonical console. The existing Core app assignment,
// network policy and strict same-origin guards remain the authorization boundary.
export function buildConsoleRouter(startedAt: string, deps: ConsoleDeps): Router {
  const router = Router();
  router.use(json({ limit: '64kb' }), adminGuard, adminAudit, deps.auth.requireAdmin, deps.auth.sameOrigin);
  router.get('/console-config', (_req, res) => res.json({ success: true, data: {
    id: 'w3forge', name: getAppName(), permissionPrefix: 'forge', productBase: '/forge',
    packageStem: 'w3forge', serviceName: getServiceName(), databaseName: resolveDatabaseName({ databaseUrl: env.databaseUrl, databaseName: env.databaseName }) || 'unconfigured',
    terminalTarget: 'host', repositoryUrl: githubRepositoryUrl(getRepoUrl() ?? undefined), legacyBackupCutoff: null,
    paths: { runtime: getRuntimePath(), deploy: getDeployPath(), scripts: getScriptsPath(),
      logs: getLogsPath(), backups: getBackupsPath(), packages: getUpdatePackagesPath(),
      restoreTest: process.env.W3_RESTORE_TEST_DIR?.trim() || '/opt/w3forge-restore-test' }
  } }));
  router.use(buildAdminTerminalRoutes(deps.terminal));
  router.use(buildAdminOverviewRoutes());
  router.use(buildAdminSystemRoutes(startedAt));
  router.use(buildAdminLogsRoutes());
  router.use(buildAdminPackagesRoutes());
  router.use(buildAdminBackupsRoutes());
  router.use(buildAdminFilesRoutes());
  router.use(buildAdminGitRoutes());
  router.use(buildAdminDashboardLayoutRoutes());
  router.use(buildAdminControlsRoutes());
  router.use(buildProductionReadinessRoutes({ db: deps.db, core: deps.core }));
  router.get('/core/status', async (_req, res, next) => {
    try { res.json({ success: true, data: { configured: deps.core.configured,
      baseUrl: deps.core.baseUrl || null, ...await deps.core.health() } }); }
    catch (error) { next(error); }
  });
  router.get('/audit-events', async (req, res, next) => {
    try { res.json({ success: true, data: await auditEvents(deps.db, Number(req.query.limit) || 100) }); }
    catch (error) { next(error); }
  });
  router.use(envelopeNotFound);
  const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
    if (error instanceof AppError || error instanceof AdminError) {
      respond.err(res, error.status, error.code, error.message, error.details);
    } else if (error?.type === 'entity.parse.failed') {
      respond.err(res, 400, 'INVALID_JSON', 'The request body must be valid JSON.');
    } else {
      respond.err(res, 500, 'INTERNAL_ERROR', 'The admin request could not be completed.');
    }
  };
  router.use(errorHandler);
  return router;
}
