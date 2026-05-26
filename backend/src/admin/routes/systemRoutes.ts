import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { respond } from '../envelope';
import { ACTIVE_APP, FORGE_ROOT, loadApp } from '../forgeConfig';

function readForgeVersion(): string {
  try {
    const p = path.join(FORGE_ROOT, 'VERSION');
    return fs.readFileSync(p, 'utf8').trim();
  } catch {
    return 'unknown';
  }
}

export function buildAdminSystemRoutes(startedAt: string): Router {
  const router = Router();

  router.get('/version', (_req, res) => {
    respond.ok(res, {
      app: 'w3-forge',
      activeApp: ACTIVE_APP,
      version: readForgeVersion(),
      nodeEnv: process.env.NODE_ENV ?? 'development'
    });
  });

  router.get('/system', (_req, res) => {
    const cfg = loadApp(ACTIVE_APP);
    respond.ok(res, {
      app: cfg.app_id,
      name: cfg.name,
      version: cfg.version,
      forgeRoot: FORGE_ROOT,
      startedAt,
      uptimeSeconds: Math.floor(process.uptime()),
      host: os.hostname(),
      platform: process.platform,
      nodeVersion: process.version,
      authority: {
        mayDeploy: cfg.authority.may_deploy === true,
        mayTagRelease: cfg.authority.may_tag_release === true,
        mayModifyProductionData: cfg.authority.may_modify_production_data === true
      },
      readOnlyFoundation: true
    });
  });

  return router;
}
