import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { buildAdminRouter } from './admin';
import { createTerminalRuntime } from './admin/terminal/runtime';
import { loadPricingConfig } from './materialPricing/config';
import { buildMaterialPricingRouter } from './materialPricing/routes';
import { createCoreClient } from './auth/coreClient';
import { createCoreAuth } from './auth/coreAuth';
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

  const core = createCoreClient({
    baseUrl: process.env.CORE_API_URL ?? '',
    publicCoreUrl: process.env.CORE_PUBLIC_URL ?? process.env.CORE_API_URL ?? '',
    publicAppUrl: process.env.FORGE_PUBLIC_URL ?? '',
    clientSecret: process.env.CORE_APP_CLIENT_SECRET ?? '',
    instanceId: process.env.CORE_APP_INSTANCE_ID ?? '',
    appId: 'w3forge', appName: 'W3 Forge', version: readForgeVersion()
  });
  const auth = createCoreAuth(core, {
    publicAppUrl: (process.env.FORGE_PUBLIC_URL ?? '').replace(/\/+$/, ''),
    publicCoreUrl: (process.env.CORE_PUBLIC_URL ?? process.env.CORE_API_URL ?? '').replace(/\/+$/, ''),
    cookieSecure: process.env.COOKIE_SECURE !== 'false'
  });
  app.use('/api/material-pricing', buildMaterialPricingRouter(loadPricingConfig()));
  app.use('/api/auth', auth.router);
  const terminal = createTerminalRuntime(auth);
  app.use('/api/admin', buildAdminRouter(startedAt, auth, terminal));
  app.get('/health', (_req, res) => res.json({ success: true, data: { app: 'w3forge', version: readForgeVersion() } }));
  const announce = () => {
    if (core.configured) void core.announce().catch(() => console.warn('[w3-forge-admin] Core connection announcement unavailable.'));
  };
  announce();
  const discoveryTimer = setInterval(announce, 60_000);
  discoveryTimer.unref();

  const adminDist = path.join(FORGE_ROOT, 'frontend', 'admin', 'dist');
  if (fs.existsSync(adminDist)) {
    app.use('/admin', express.static(adminDist));
    // SPA fallback — any /admin/* not matching a file returns index.html.
    app.get(/^\/admin(\/.*)?$/, (_req, res) => {
      res.sendFile(path.join(adminDist, 'index.html'));
    });
  }

  app.get('/', (_req, res) => res.redirect(302, '/admin/'));

  const server = app.listen(port, host, () => {
    console.log(`[w3-forge-admin] listening on http://${host}:${port}`);
    console.log(`[w3-forge-admin] forgeRoot=${FORGE_ROOT} activeApp=${ACTIVE_APP}`);
  });
  const shutdown = () => {
    terminal.manager.shutdown();
    clearInterval(discoveryTimer);
    server.close(() => process.exit(0));
    const deadline = setTimeout(() => process.exit(0), 5_000);
    deadline.unref();
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  process.once('exit', () => terminal.manager.shutdown());
}

main();
