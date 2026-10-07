import path from 'node:path';

export interface PricingConfig {
  enabled: boolean;
  sharedToken: string;
  apifyToken: string;
  dataDir: string;
  maxProducts: number;
  maxRequestChargeCents: number;
  maxDailyChargeCents: number;
  maxLedgerEntries: number;
  requestTimeoutMs: number;
  actorTimeoutSeconds: number;
  ollamaUrl: string;
  ollamaModel: string;
}

export function loadPricingConfig(env: NodeJS.ProcessEnv = process.env): PricingConfig {
  const enabled = env.W3_FORGE_MATERIAL_PRICING_ENABLED === 'true';
  const fail = (): never => { throw new Error('Material pricing configuration is invalid; check the documented server settings.'); };
  const integer = (name: string, fallback: number, min: number, max: number): number => {
    const value = env[name] === undefined ? fallback : Number(env[name]);
    if (!Number.isSafeInteger(value) || value < min || value > max) return fail();
    return value;
  };
  const sharedToken = env.W3_FORGE_MATERIAL_PRICING_SHARED_TOKEN ?? '';
  const apifyToken = env.W3_FORGE_MATERIAL_PRICING_APIFY_TOKEN ?? '';
  const dataDir = env.W3_FORGE_MATERIAL_PRICING_DATA_DIR ?? '';
  let ollamaUrl = env.W3_FORGE_MATERIAL_PRICING_OLLAMA_URL ?? 'http://127.0.0.1:11434';
  const ollamaModel = env.W3_FORGE_MATERIAL_PRICING_OLLAMA_MODEL ?? '';
  if (enabled) {
    if (!/^[A-Za-z0-9_-]{48,256}$/.test(sharedToken) || new Set(sharedToken).size < 12 ||
        !/^[A-Za-z0-9_-]{20,256}$/.test(apifyToken) || sharedToken === apifyToken ||
        sharedToken === env.CORE_APP_CLIENT_SECRET || !path.isAbsolute(dataDir)) fail();
    try {
      const url = new URL(ollamaUrl);
      // Local inference only. No credentials, arbitrary hosts, paths, queries or redirects.
      if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) ||
          url.username || url.password || url.pathname !== '/' || url.search || url.hash) fail();
      ollamaUrl = url.origin;
    } catch { fail(); }
    if (ollamaModel && !/^qwen2\.5:[A-Za-z0-9._-]{1,64}$/.test(ollamaModel)) fail();
  }
  const cfg: PricingConfig = {
    enabled, sharedToken, apifyToken, dataDir, ollamaUrl, ollamaModel,
    maxProducts: integer('W3_FORGE_MATERIAL_PRICING_MAX_PRODUCTS', 10, 1, 20),
    maxRequestChargeCents: integer('W3_FORGE_MATERIAL_PRICING_MAX_REQUEST_CHARGE_CENTS', 10, 1, 100),
    maxDailyChargeCents: integer('W3_FORGE_MATERIAL_PRICING_MAX_DAILY_CHARGE_CENTS', 100, 1, 10000),
    maxLedgerEntries: integer('W3_FORGE_MATERIAL_PRICING_MAX_LEDGER_ENTRIES', 1000, 1, 10000),
    requestTimeoutMs: integer('W3_FORGE_MATERIAL_PRICING_REQUEST_TIMEOUT_MS', 25000, 1000, 45000),
    actorTimeoutSeconds: integer('W3_FORGE_MATERIAL_PRICING_ACTOR_TIMEOUT_SECONDS', 180, 120, 300)
  };
  if (enabled && (cfg.maxRequestChargeCents < cfg.maxProducts || cfg.maxDailyChargeCents < cfg.maxRequestChargeCents)) fail();
  return cfg;
}
