// =============================================================================
// W3 Core v0.6.1 — App Config Accessors (Universal Modular Admin Framework).
// =============================================================================
//
// Thin, typed read-only accessors over the v0.6.0 app registry foundation.
// These are introduced in v0.6.1 to migrate hardcoded W3 Forge admin
// constants to read from `config/apps/w3forge.yml` while preserving 100%
// of the existing runtime behavior:
//
//   Precedence (left wins):
//     1. ENV override     (e.g. W3_DEPLOY_DIR, W3_BACKUPS_DIR, W3_LOG_ROOT)
//     2. App config YAML  (config/apps/w3forge.yml -> paths.*, service.*)
//     3. Legacy hardcoded fallback (matches the v0.5.x defaults exactly)
//
// Why this layering exists:
//   - Production hosts already have ENV overrides set; v0.6.1 must NOT
//     change what those hosts resolve to. ENV stays first.
//   - YAML values are the new source of truth for hosts WITHOUT ENV
//     overrides (i.e. the public default path). Replaces the previous
//     hardcoded constants.
//   - Hardcoded fallback survives only as a safety net for the case
//     where the registry cannot be read. Behavior is identical to the
//     pre-v0.6.1 hardcoded defaults.
//
// What this module does NOT do (preserved from v0.6.0 foundation):
//   - It does NOT change ApiEnvelope<T>.
//   - It does NOT change safeRunner / shell:false behavior.
//   - It does NOT change adminAudit, adminGuard, controls validator,
//     deployment authority, package verification, or release-gate logic.
//   - It does NOT change any visible UI, route shape, or response field.
// =============================================================================

import {
  DEFAULT_ACTIVE_APP_ID,
  getActiveAppConfig,
  type AppConfig
} from './appRegistry';

// ---- Hardcoded legacy fallbacks (must match the pre-v0.6.1 defaults). ------
//
// These mirror the hardcoded `fromEnv(..., 'fallback')` defaults that lived
// in `backend/src/admin/paths.ts` before v0.6.1. They are used ONLY when the
// app registry cannot be loaded (corrupt YAML, missing config dir on a dev
// machine, etc.). The intent is: never throw from a path accessor; always
// resolve to the same value the system would have used pre-migration.

const LEGACY_FALLBACKS = {
  runtime: '/opt/w3forge',
  deploy: '/opt/w3forge-deploy',
  scripts: '/opt/w3forge-scripts',
  logs: '/opt/logs/w3forge',
  backups: '/opt/backups/w3forge',
  update_packages: '/opt/w3forge-update-packages',
  installed_packages: '/opt/w3forge-update-packages/installed',
  service_name: 'w3forge-admin.service',
  service_port: 8765,
  health_url: 'http://127.0.0.1:8765/health',
  version_url: 'http://127.0.0.1:8765/version'
} as const;

// ---- Safe registry read -----------------------------------------------------
//
// Returns the active app config when the registry loads cleanly, or `null`
// otherwise. Never throws: a registry read failure must never crash an
// admin route that previously relied on a constant value.

function safeActiveAppConfig(): AppConfig | null {
  try {
    return getActiveAppConfig();
  } catch {
    return null;
  }
}

// Pick the first non-empty trimmed string ENV var.
function firstEnvString(keys: string[]): string | null {
  for (const k of keys) {
    const v = (process.env[k] ?? '').trim();
    if (v) return v;
  }
  return null;
}

function firstEnvNumber(keys: string[]): number | null {
  for (const k of keys) {
    const v = (process.env[k] ?? '').trim();
    if (!v) continue;
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

// ---- Public typed accessors ------------------------------------------------

/**
 * Returns the active W3 Forge app config or `null` when the registry
 * could not be loaded. Routes that need the full config object should
 * use this; routes that only need a single value should prefer the
 * narrow accessors below (they apply ENV-override precedence first).
 */
export function getW3ForgeAppConfig(): AppConfig | null {
  return safeActiveAppConfig();
}

/**
 * Returns the active app id resolved by the registry, or the default
 * (`w3forge`) when the registry is unavailable. Used for diagnostic
 * payloads only — no route currently switches behavior on this value.
 */
export function getActiveAppId(): string {
  return ((process.env.W3_ACTIVE_APP_ID || process.env.W3_FORGE_ACTIVE_APP)?.trim() || DEFAULT_ACTIVE_APP_ID);
}

// ---- Path accessors (ENV > YAML > legacy hardcoded fallback) ---------------

export function getRuntimePath(): string {
  const env = firstEnvString(['W3_APP_DIR']);
  if (env) return env;
  const cfg = safeActiveAppConfig();
  return cfg?.paths.runtime ?? LEGACY_FALLBACKS.runtime;
}

export function getDeployPath(): string {
  const env = firstEnvString(['W3_DEPLOY_DIR']);
  if (env) return env;
  const cfg = safeActiveAppConfig();
  return cfg?.paths.deploy ?? LEGACY_FALLBACKS.deploy;
}

export function getScriptsPath(): string {
  const env = firstEnvString(['W3_SCRIPTS_DIR']);
  if (env) return env;
  const cfg = safeActiveAppConfig();
  return cfg?.paths.scripts ?? LEGACY_FALLBACKS.scripts;
}

export function getLogsPath(): string {
  const env = firstEnvString(['W3_LOG_ROOT']);
  if (env) return env;
  const cfg = safeActiveAppConfig();
  return cfg?.paths.logs ?? LEGACY_FALLBACKS.logs;
}

export function getBackupsPath(): string {
  const env = firstEnvString(['W3_BACKUPS_DIR']);
  if (env) return env;
  const cfg = safeActiveAppConfig();
  return cfg?.paths.backups ?? LEGACY_FALLBACKS.backups;
}

export function getUpdatePackagesPath(): string {
  const env = firstEnvString(['W3_UPDATE_DIR']);
  if (env) return env;
  const cfg = safeActiveAppConfig();
  return cfg?.paths.update_packages ?? LEGACY_FALLBACKS.update_packages;
}

export function getInstalledPackagesPath(): string {
  const env = firstEnvString(['W3_INSTALLED_DIR']);
  if (env) return env;
  const cfg = safeActiveAppConfig();
  return cfg?.paths.installed_packages ?? LEGACY_FALLBACKS.installed_packages;
}

// ---- Service accessors -----------------------------------------------------

export function getServiceName(): string {
  const env = firstEnvString(['W3_SERVICE_NAME']);
  if (env) return env;
  const cfg = safeActiveAppConfig();
  return cfg?.service.name ?? LEGACY_FALLBACKS.service_name;
}

export function getServicePort(): number {
  const env = firstEnvNumber(['W3_SERVICE_PORT']);
  if (env !== null) return env;
  const cfg = safeActiveAppConfig();
  return cfg?.service.port ?? LEGACY_FALLBACKS.service_port;
}

export function getHealthUrl(): string {
  const env = firstEnvString(['W3_HEALTH_URL']);
  if (env) return env;
  const cfg = safeActiveAppConfig();
  return cfg?.service.health_url ?? LEGACY_FALLBACKS.health_url;
}

export function getVersionUrl(): string {
  const env = firstEnvString(['W3_VERSION_URL']);
  if (env) return env;
  const cfg = safeActiveAppConfig();
  return cfg?.service.version_url ?? LEGACY_FALLBACKS.version_url;
}

// ---- Repo / branch policy accessors ----------------------------------------

export function getRepoUrl(): string | null {
  const cfg = safeActiveAppConfig();
  return cfg?.repo.url ?? null;
}

export function getAllowedDevBranchPattern(): string | null {
  const cfg = safeActiveAppConfig();
  return cfg?.repo.allowed_branch_pattern ?? null;
}

export function getDefaultDevBranch(): string | null {
  const cfg = safeActiveAppConfig();
  return cfg?.repo.default_dev_branch ?? null;
}

export function getBlockedBranches(): string[] {
  const cfg = safeActiveAppConfig();
  // Always include the universal hard-blocked branches. The YAML validator
  // already requires both 'main' and 'master' to be present, but this
  // belt-and-suspenders check guarantees they are returned even if the
  // registry could not be loaded.
  const fromCfg = cfg?.repo.blocked_branches ?? [];
  const set = new Set<string>(fromCfg);
  set.add('main');
  set.add('master');
  return Array.from(set);
}

// ---- Authority / controls accessors ----------------------------------------

export interface AuthoritySnapshot {
  may_deploy: boolean;
  may_package: boolean;
  may_tag_release: boolean;
  may_modify_production_data: boolean;
  requires_user_release_gate: boolean;
}

// Conservative defaults: when the registry is unavailable, deny everything
// except read-only operations. This matches the v0.5.x behavior of the
// admin guard / release gate, which already refuses risky operations
// without an explicit configured authority.
const SAFE_AUTHORITY_FALLBACK: AuthoritySnapshot = {
  may_deploy: false,
  may_package: false,
  may_tag_release: false,
  may_modify_production_data: false,
  requires_user_release_gate: true
};

export function getAuthority(): AuthoritySnapshot {
  const cfg = safeActiveAppConfig();
  if (!cfg) return SAFE_AUTHORITY_FALLBACK;
  return {
    may_deploy: cfg.authority.may_deploy,
    may_package: cfg.authority.may_package,
    may_tag_release: cfg.authority.may_tag_release,
    may_modify_production_data: cfg.authority.may_modify_production_data,
    requires_user_release_gate: cfg.authority.requires_user_release_gate
  };
}

export function getControlsMode(): string {
  const cfg = safeActiveAppConfig();
  return cfg?.controls.mode ?? 'legacy-compatible';
}

export function getControlsRegistryMigrationStatus(): string {
  const cfg = safeActiveAppConfig();
  return cfg?.controls.registry_migration_status ?? 'not_migrated';
}

// ---------------------------------------------------------------------------
// v0.6.2 — Controls Registry Migration Foundation accessors.
//
// These are additive: they expose the app's display name and the optional
// controls.app_id / controls.allow_legacy_w3forge_controls fields without
// changing the existing read-only/fallback contract. All accessors honor the
// ENV > YAML > safe-default precedence already documented in this file.
// ---------------------------------------------------------------------------

export function getAppName(): string {
  const cfg = safeActiveAppConfig();
  if (cfg && typeof cfg.name === 'string' && cfg.name.trim() !== '') return cfg.name.trim();
  // Safe fallback mirrors the historical visible name.
  return 'W3 Forge';
}

export function getControlsAppId(): string {
  const cfg = safeActiveAppConfig();
  const yamlVal = cfg?.controls.app_id;
  if (typeof yamlVal === 'string' && yamlVal.trim() !== '') return yamlVal.trim();
  // Fall back to the top-level app_id, then to the legacy active id. This
  // guarantees decorate() always has a stable, non-empty value to attach.
  if (cfg && typeof cfg.app_id === 'string' && cfg.app_id.trim() !== '') return cfg.app_id.trim();
  return getActiveAppId();
}

export function getAllowLegacyW3ForgeControls(): boolean {
  const cfg = safeActiveAppConfig();
  const v = cfg?.controls.allow_legacy_w3forge_controls;
  if (typeof v === 'boolean') return v;
  // Missing configuration cannot enable this operational capability.
  return false;
}

// ---------------------------------------------------------------------------
// v0.6.3 — File Browser app-config migration foundation accessors.
//
// All accessors are additive. When the registry is unavailable or the
// optional `file_browser` block is absent in YAML, every accessor returns a
// safe default that matches the pre-v0.6.3 hardcoded behavior. None of them
// changes the visible /api/admin/files/* response shape on its own; the
// route layer in `backend/src/admin/routes/filesRoutes.ts` decides how to
// surface these values.
// ---------------------------------------------------------------------------

export function getFileBrowserMode(): string {
  const cfg = safeActiveAppConfig();
  return cfg?.file_browser?.mode ?? 'legacy-compatible';
}

export function getFileBrowserRegistryMigrationStatus(): string {
  const cfg = safeActiveAppConfig();
  return cfg?.file_browser?.registry_migration_status ?? 'not_migrated';
}

export function getFileBrowserAppId(): string {
  const cfg = safeActiveAppConfig();
  const yamlVal = cfg?.file_browser?.app_id;
  if (typeof yamlVal === 'string' && yamlVal.trim() !== '') return yamlVal.trim();
  if (cfg && typeof cfg.app_id === 'string' && cfg.app_id.trim() !== '') return cfg.app_id.trim();
  return getActiveAppId();
}

export function getAllowHostLocalFileBrowserRoots(): boolean {
  const cfg = safeActiveAppConfig();
  const v = cfg?.file_browser?.allow_host_local_roots;
  if (typeof v === 'boolean') return v;
  // Missing configuration cannot enable this operational capability.
  return false;
}

/**
 * Returns the list of allowed file-browser root keys declared in YAML, or
 * `null` when the optional `file_browser.allowed_roots` field is absent.
 * Callers should treat `null` as "no restriction declared" and fall back to
 * the legacy fixed-order root list, which preserves the pre-v0.6.3
 * visible behavior.
 */
export function getFileBrowserAllowedRoots(): string[] | null {
  const cfg = safeActiveAppConfig();
  const list = cfg?.file_browser?.allowed_roots;
  if (!Array.isArray(list)) return [];
  // Defensive copy + trim. An empty array is a meaningful (explicit) policy
  // and is returned as-is so callers can distinguish it from "no config".
  return list.map((s) => String(s).trim()).filter((s) => s !== '');
}

// ---------------------------------------------------------------------------
// v0.6.4 — GitHub Validation / Release Workflow app-config migration
// foundation accessors.
//
// All accessors are additive. When the registry is unavailable or the
// optional `github_workflow` block is absent in YAML, every accessor returns
// a safe default that matches the pre-v0.6.4 hardcoded behavior. None of
// them changes the visible /api/admin/git/* response shape on its own; the
// route layer in `backend/src/admin/routes/gitRoutes.ts` decides how to
// surface these values.
//
// Governance posture is intentionally fail-CLOSED. When in doubt, the
// release pipeline must be off, main protection must be enforced, and the
// release gate must require an explicit user decision.
// ---------------------------------------------------------------------------

export function getGitHubWorkflowMode(): string {
  const cfg = safeActiveAppConfig();
  return cfg?.github_workflow?.mode ?? 'legacy-compatible';
}

export function getGitHubWorkflowRegistryMigrationStatus(): string {
  const cfg = safeActiveAppConfig();
  return cfg?.github_workflow?.registry_migration_status ?? 'not_migrated';
}

export function getGitHubWorkflowAppId(): string {
  const cfg = safeActiveAppConfig();
  const yamlVal = cfg?.github_workflow?.app_id;
  if (typeof yamlVal === 'string' && yamlVal.trim() !== '') return yamlVal.trim();
  if (cfg && typeof cfg.app_id === 'string' && cfg.app_id.trim() !== '') return cfg.app_id.trim();
  return getActiveAppId();
}

export function getAllowReleasePipeline(): boolean {
  const cfg = safeActiveAppConfig();
  const v = cfg?.github_workflow?.allow_release_pipeline;
  if (typeof v === 'boolean') return v;
  // Missing configuration cannot enable this operational capability.
  return false;
}

export function getEnforceMainProtection(): boolean {
  const cfg = safeActiveAppConfig();
  const v = cfg?.github_workflow?.enforce_main_protection;
  if (typeof v === 'boolean') return v;
  // Default true — fail-CLOSED. Even when the YAML block is absent, the
  // route layer continues to filter for `dev/vX.Y.Z` refs only and the
  // `main`/`master` block in getBlockedBranches() still applies. This
  // accessor only surfaces the policy bit; it does not gate enforcement.
  return true;
}

export function getEnforceReleaseGate(): boolean {
  const cfg = safeActiveAppConfig();
  const v = cfg?.github_workflow?.enforce_release_gate;
  if (typeof v === 'boolean') return v;
  // Default true — fail-CLOSED. Mirrors
  // authority.requires_user_release_gate's safe default in
  // SAFE_AUTHORITY_FALLBACK above.
  return true;
}

/**
 * Coarse-grained label describing where the active repo URL was sourced
 * from. Used as additive metadata on /api/admin/git/* responses; the legacy
 * fields (`remote`, etc.) are unchanged.
 */
export function getRepoSource(): 'app-config' | 'legacy-fallback' {
  const cfg = safeActiveAppConfig();
  return cfg && typeof cfg.repo.url === 'string' && cfg.repo.url.trim() !== ''
    ? 'app-config'
    : 'legacy-fallback';
}
