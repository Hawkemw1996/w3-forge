import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { buildAdminRouter } from './admin';
import { FORGE_ROOT, ACTIVE_APP, loadApp } from './admin/forgeConfig';

// =============================================================================
// W3 Forge Admin Backend — v0.4.0 entry point.
// =============================================================================
//
// Binds to admin_console.listen_host:listen_port from the active app config.
// Serves the built admin frontend (frontend/admin/dist) under /admin/* when
// present. Refuses to start if the active app's admin_console is disabled
// or if the host is not loopback (unless ADMIN_ALLOW_NON_LOOPBACK=1).

function readForgeVersion(): string {
  try {
    return fs.readFileSync(path.join(FORGE_ROOT, 'VERSION'), 'utf8').trim();
  } catch {
    return 'unknown';
  }
}

function main(): void {
  const startedAt = new Date().toISOString();

  let cfg;
  try {
    cfg = loadApp(ACTIVE_APP);
  } catch (e) {
    console.error(`[w3-forge-admin] Failed to load app ${ACTIVE_APP}: ${(e as Error).message}`);
    process.exit(1);
  }

  const ac = cfg.admin_console;
  if (!ac || ac.enabled !== true) {
    console.error(`[w3-forge-admin] admin_console is not enabled for ${ACTIVE_APP}.`);
    process.exit(1);
  }

  const host = (process.env.W3_FORGE_ADMIN_HOST ?? ac.listen_host ?? '127.0.0.1').trim();
  const port = Number(process.env.W3_FORGE_ADMIN_PORT ?? ac.listen_port ?? 8765);

  if (
    host !== '127.0.0.1' &&
    host !== 'localhost' &&
    host !== '::1' &&
    process.env.ADMIN_ALLOW_NON_LOOPBACK !== '1'
  ) {
    console.error(
      `[w3-forge-admin] Refusing to bind non-loopback host (${host}). ` +
        `Set ADMIN_ALLOW_NON_LOOPBACK=1 to override (foundation discourages this).`
    );
    process.exit(1);
  }

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', false);

  app.use('/api/admin', buildAdminRouter(startedAt));

  const adminDist = path.join(FORGE_ROOT, 'frontend', 'admin', 'dist');
  if (fs.existsSync(adminDist)) {
    app.use('/admin', express.static(adminDist));
    // SPA fallback — any /admin/* not matching a file returns index.html.
    app.get(/^\/admin(\/.*)?$/, (_req, res) => {
      res.sendFile(path.join(adminDist, 'index.html'));
    });
  }

  app.get('/', (_req, res) => {
    res.json({
      success: true,
      data: {
        app: 'w3-forge',
        version: readForgeVersion(),
        admin: '/admin',
        api: '/api/admin',
        startedAt
      }
    });
  });

  app.listen(port, host, () => {
    console.log(`[w3-forge-admin] listening on http://${host}:${port}`);
    console.log(`[w3-forge-admin] forgeRoot=${FORGE_ROOT} activeApp=${ACTIVE_APP}`);
  });
}

main();
