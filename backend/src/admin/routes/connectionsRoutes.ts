import { Router } from 'express';
import { createCoreClient } from '../../auth/coreClient';
import { sessionSecretIssue } from '../../auth/sessionCrypto';
import { respond } from '../envelope';
import { ACTIVE_APP, loadApp } from '../forgeConfig';
import { loadPricingConfig, isSupportedModelTag } from '../../materialPricing/config';
import { githubRepositoryUrl } from './forgeGitRoutes';

// Configuration readiness only. No credentials, paid calls or workflow execution.
export function publicServiceUrl(raw: string | undefined): string | null {
  try {
    const url = new URL(raw ?? '');
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null;
    return url.href.replace(/\/$/, '');
  } catch { return null; }
}

export function connectionStatus(env: NodeJS.ProcessEnv = process.env) {
  const cfg = loadApp(ACTIVE_APP);
  let pricing;
  try { pricing = loadPricingConfig(env); } catch { pricing = null; }
  const coreUrl = publicServiceUrl(env.CORE_PUBLIC_URL ?? env.CORE_API_URL);
  const n8nUrl = publicServiceUrl(env.W3_FORGE_N8N_URL);
  return {
    app: { id: cfg.app_id, name: cfg.name, version: cfg.version },
    core: { configured: createCoreClient({ baseUrl: env.CORE_API_URL ?? '', publicCoreUrl: env.CORE_PUBLIC_URL ?? env.CORE_API_URL,
      publicAppUrl: env.FORGE_PUBLIC_URL, clientSecret: env.CORE_APP_CLIENT_SECRET, instanceId: env.CORE_APP_INSTANCE_ID }).configured && !sessionSecretIssue({sessionSecret:env.FORGE_SESSION_SECRET, pairingSecret:env.CORE_APP_CLIENT_SECRET, serviceToken:env.CORE_SERVICE_TOKEN}), publicUrl: coreUrl },
    github: { repositoryUrl: githubRepositoryUrl(cfg.repo.url), workspace: cfg.paths.workspaces,
      defaultDevBranch: cfg.repo.default_dev_branch ?? '' },
    terminal: { enabled: env.ADMIN_TERMINAL_ENABLED === 'true' },
    materialPricing: { enabled: env.W3_FORGE_MATERIAL_PRICING_ENABLED === 'true',
      configured: !!pricing?.enabled, maxProducts: pricing?.maxProducts ?? 0,
      maxRequestChargeCents: pricing?.maxRequestChargeCents ?? 0, maxDailyChargeCents: pricing?.maxDailyChargeCents ?? 0 },
    ollama: { configured: !!pricing && isSupportedModelTag(pricing.ollamaModel),
      model: pricing && isSupportedModelTag(pricing.ollamaModel) ? pricing.ollamaModel : null },
    n8n: { configured: !!n8nUrl, url: n8nUrl },
    chat: { status: 'planned' as const }, businessAutomations: { status: 'planned' as const }
  };
}

export function buildConnectionsRoutes(): Router {
  const router = Router();
  router.get('/connections', (_req, res, next) => {
    try { respond.ok(res, connectionStatus()); } catch (error) { next(error); }
  });
  return router;
}
