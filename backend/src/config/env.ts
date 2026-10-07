import path from 'path';
import fs from 'node:fs';

// =============================================================================
// W3 Forge runtime configuration.
// =============================================================================
//
// Derived from W3 Core v0.12.11 backend/src/config/env.ts. Differences:
//   - Forge identity defaults (port 8765, database w3forge,
//     data dir /opt/w3forge-data).
//   - W3 Core API connection settings (CORE_API_URL, CORE_SERVICE_TOKEN).
//     Forge talks to W3 Core over HTTP only; it never opens the w3core
//     database.
//   - Application-session settings (FORGE_SESSION_SECRET and timing).
//   - Explicit Core app assignments (see docs/CORE_INTEGRATION.md).
//
// The repository / deploy root is located by walking up from this file to the
// directory holding VERSION, so the same code works from backend/src (ts-node),
// backend/dist (compiled) and /opt/w3forge (deployed).

function findRepoRoot(start: string): string {
  let dir = start;
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, 'VERSION')) && fs.existsSync(path.join(dir, 'backend'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(start, '../../..');
}

export const repoRoot = process.env.W3_FORGE_ROOT?.trim() ? path.resolve(process.env.W3_FORGE_ROOT.trim()) : findRepoRoot(__dirname);

// Forge's service launcher supplies the environment; never load an additional .env here.

function resolveAppVersion(): string {
  const envVersion = process.env.APP_VERSION?.trim();
  if (envVersion) return envVersion;
  try {
    const v = fs.readFileSync(path.join(repoRoot, 'VERSION'), 'utf8').trim();
    if (v) return v;
  } catch {
    // fall through
  }
  return '0.0.0';
}

function list(value: string | undefined, fallback: string): string[] {
  return (value?.trim() || fallback)
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function int(value: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: Number(process.env.ADMIN_LISTEN_PORT || process.env.PORT || 8765),
  appId: 'w3forge',
  appName: process.env.APP_NAME || 'W3 Forge',
  serviceName: 'w3forge-admin.service',

  appVersion: resolveAppVersion(),

  databaseHost: process.env.FORGE_DATABASE_HOST || process.env.DATABASE_HOST || process.env.DB_HOST || 'localhost',
  databasePort: Number(process.env.FORGE_DATABASE_PORT || process.env.DATABASE_PORT || process.env.DB_PORT || 5432),
  databaseName: process.env.FORGE_DATABASE_NAME || process.env.DATABASE_NAME || process.env.DB_NAME || 'w3forge',
  databaseUser: process.env.FORGE_DATABASE_USER || process.env.DATABASE_USER || process.env.DB_USER || 'w3forge_user',
  databasePassword: process.env.FORGE_DATABASE_PASSWORD || process.env.DATABASE_PASSWORD || process.env.DB_PASSWORD || '',
  databaseUrl: process.env.FORGE_DATABASE_URL || process.env.DATABASE_URL || '',

  frontendDist: process.env.FRONTEND_DIST?.trim() || path.join(repoRoot, 'frontend', 'admin', 'dist'),

  dataDir: process.env.W3_DATA_DIR?.trim() || '/opt/w3forge-data',

  adminAllowedIps: process.env.ADMIN_ALLOWED_IPS?.trim() || '',

  // Operator opt-in for the administrator container terminal.
  adminTerminalEnabled: process.env.ADMIN_TERMINAL_ENABLED === 'true',
  adminTerminalOrigin: process.env.ADMIN_TERMINAL_ORIGIN?.trim() || '',
  adminLogDir: process.env.ADMIN_LOG_DIR?.trim() || '/opt/logs/w3forge/admin',

  corsAllowedOrigins: process.env.CORS_ALLOWED_ORIGINS?.trim() ||
    'http://localhost:8765,http://127.0.0.1:8765,http://localhost:5173,http://127.0.0.1:5173',

  // --- W3 Core API (identity + platform context) ---------------------------
  /** Base URL of the W3 Core service, e.g. http://127.0.0.1:3000. Empty = not configured. */
  coreApiUrl: (process.env.CORE_API_URL?.trim() || '').replace(/\/+$/, ''),
  /** Optional W3 Core service token (Bearer) for app-to-Core calls. Never logged or returned. */
  coreServiceToken: process.env.CORE_SERVICE_TOKEN?.trim() || '',
  coreTimeoutMs: int(process.env.CORE_TIMEOUT_MS, 5000, 500, 30000),
  corePublicUrl: process.env.CORE_PUBLIC_URL?.trim() || process.env.CORE_API_URL?.trim() || '',
  publicAppUrl: process.env.FORGE_PUBLIC_URL?.trim() || '',
  coreClientSecret: process.env.CORE_APP_CLIENT_SECRET?.trim() || '',
  coreInstanceId: process.env.CORE_APP_INSTANCE_ID?.trim() || '',

  // --- Application sessions -------------------------------------------------
  /** Secret (>= 32 chars) used to encrypt the stored W3 Core session. Required for login. */
  sessionSecret: process.env.FORGE_SESSION_SECRET || '',
  cookieSecure: process.env.COOKIE_SECURE !== 'false',
  /** Legacy configuration field; verification is always immediate. */
  sessionVerifyIntervalSec: 0,
  /** Legacy configuration field; offline authorization is refused. */
  coreOutageGraceSec: 0,
  /** Absolute session lifetime (seconds). */
  sessionMaxAgeSec: int(process.env.FORGE_SESSION_MAX_AGE_SEC, 43200, 300, 86400),

  // Core assignments exclusively control app permissions.
};

export type Env = typeof env;
