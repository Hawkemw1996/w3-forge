// =============================================================================
// W3 Forge — App-aware GitHub Validation / Release Workflow registry (v0.6.4)
// =============================================================================
//
// v0.6.4 is the third migration pass on top of the v0.6.0 Universal Modular
// Admin Framework foundation. The visible GitHub Validation tab — cards,
// buttons, step layout, status bubbles, logs rendering, pipeline UX, the
// release workflow — is UNCHANGED. This module is the additive app-aware
// governance layer the route in `backend/src/admin/routes/gitRoutes.ts`
// delegates to for:
//
//   - the allowed dev-branch shape (read from `repo.allowed_branch_pattern`),
//   - the hard-blocked branch list (read from `repo.blocked_branches`, with
//     `main`/`master` always included by `getBlockedBranches()`),
//   - the canonical default dev branch (read from `repo.default_dev_branch`),
//   - the configured repo URL (read from `repo.url`),
//   - the configured authority snapshot (`authority.*`),
//   - additive metadata fields surfaced on /api/admin/git/* responses
//     (`app_id`, `app_name`, `repo_source`, `config_driven`,
//     `authority_source`, `registry_migration_status`, plus the three
//     governance policy bits).
//
// GOVERNANCE PRESERVATION:
//   - This module never creates tags.
//   - This module never deploys.
//   - This module never modifies production data.
//   - This module never weakens the release gate or merge gates.
//   - This module never re-orders the release workflow.
//   - This module never adds new tabs or new visible UI surfaces.
//   - This module is a PURE READER: no `fs.writeFile`, no `child_process`,
//     no env writes, no global mutation.
//
// FALL-BACK / FAIL-CLOSED POSTURE:
//   - When the YAML block is absent, every governance bit returns its safe
//     default (release_gate enforced, main protected, repo_source =
//     `'legacy-fallback'`).
//   - When the regex in `allowed_branch_pattern` is malformed (which the
//     YAML validator already catches at load time, but we double-check
//     here), `isAllowedDevBranchName()` returns `false`. We never silently
//     "allow" a branch shape we cannot validate.
//
// API SHAPE:
//   - `getAppGitHubWorkflowMeta()` returns the meta block the route layer
//     spreads onto each /api/admin/git/* response as additive fields.
//   - `getDevBranchPattern()` returns the resolved RegExp, or `null` when
//     none is configured (which the legacy route already handles by
//     filtering out everything).
//   - `isAllowedDevBranchName(name)` is the pure predicate used by the
//     route layer to filter `ls-remote` output.
//   - `isBlockedBranchName(name)` is the pure predicate that rejects
//     `main`/`master` (and anything else listed in
//     `repo.blocked_branches`).
//   - `getAppGitHubWorkflowRegistryMeta()` is a static description of the
//     v0.6.4 registry surface used by the validator script and tests.
// =============================================================================

import {
  getActiveAppId,
  getAppName,
  getAllowedDevBranchPattern,
  getBlockedBranches,
  getDefaultDevBranch,
  getRepoUrl,
  getRepoSource,
  getAuthority,
  getAllowReleasePipeline,
  getEnforceMainProtection,
  getEnforceReleaseGate,
  getGitHubWorkflowAppId,
  getGitHubWorkflowMode,
  getGitHubWorkflowRegistryMigrationStatus,
  AuthoritySnapshot
} from '../appConfigAccessors';

// ---- Types -----------------------------------------------------------------

export type AppGitHubRepoSource = 'app-config' | 'legacy-fallback';

export interface AppGitHubWorkflowMeta {
  // App identity
  app_id: string;
  app_name: string;

  // Repo metadata
  repo_url: string | null;
  repo_source: AppGitHubRepoSource;
  default_dev_branch: string | null;
  allowed_branch_pattern: string | null;
  blocked_branches: string[];

  // Authority + governance policy (read-only mirrors of YAML / safe defaults)
  authority: AuthoritySnapshot;
  authority_source: 'app-config' | 'safe-fallback';
  allow_release_pipeline: boolean;
  enforce_main_protection: boolean;
  enforce_release_gate: boolean;

  // Migration breadcrumbs
  mode: string;
  registry_source: string;
  registry_migration_status: string;
  config_driven: boolean;
}

export interface AppGitHubWorkflowRegistryMeta {
  version: '0.8.2';
  module: 'appGitHubWorkflowRegistry';
  preserves_ui: true;
  preserves_governance: true;
  pure_reader: true;
}

// ---- Internals -------------------------------------------------------------

/**
 * Resolve the dev-branch RegExp. Returns `null` when no pattern is
 * configured or when the configured pattern cannot be compiled. This is
 * intentionally strict: when in doubt we return `null` so the route layer
 * filters everything out and the picker stays empty — fail-CLOSED.
 */
export function getDevBranchPattern(): RegExp | null {
  const raw = getAllowedDevBranchPattern();
  if (!raw || typeof raw !== 'string' || raw.trim() === '') return null;
  try {
    return new RegExp(raw);
  } catch {
    return null;
  }
}

/**
 * True iff `name` matches the configured dev-branch shape AND is not in
 * the blocked-branch list. The blocked check is belt-and-suspenders — the
 * legacy `dev/vX.Y.Z` pattern already excludes `main`/`master`, but a
 * future relaxed pattern must never accidentally let them through.
 */
export function isAllowedDevBranchName(name: string): boolean {
  if (typeof name !== 'string') return false;
  const t = name.trim();
  if (t === '') return false;
  if (isBlockedBranchName(t)) return false;
  const pattern = getDevBranchPattern();
  if (!pattern) return false;
  return pattern.test(t);
}

/**
 * True iff `name` is on the blocked-branch list. `getBlockedBranches()`
 * always includes `main` and `master` even when the registry is missing.
 */
export function isBlockedBranchName(name: string): boolean {
  if (typeof name !== 'string') return false;
  const t = name.trim();
  if (t === '') return false;
  return getBlockedBranches().includes(t);
}

/**
 * Determine whether the active `authority` block came from a loaded
 * AppConfig or from the SAFE_AUTHORITY_FALLBACK. We infer this from a
 * deny-everything signature on the snapshot: a real config has at least
 * one bit true. The legacy fallback is the only path that produces an
 * all-false-with-gate-true shape.
 *
 * This is metadata only — the actual authority guard already lives in
 * `appConfigAccessors.getAuthority()`. Surfacing the source is additive.
 */
function deriveAuthoritySource(auth: AuthoritySnapshot): 'app-config' | 'safe-fallback' {
  const isFallbackShape =
    auth.may_deploy === false &&
    auth.may_package === false &&
    auth.may_tag_release === false &&
    auth.may_modify_production_data === false &&
    auth.requires_user_release_gate === true;
  // The fallback shape is also a legitimate YAML shape, so we have to
  // confirm by checking the repo URL — if the registry loaded a real
  // config the URL is non-null even when authority is locked down.
  if (isFallbackShape && getRepoUrl() === null) return 'safe-fallback';
  return 'app-config';
}

// ---- Public meta builder ---------------------------------------------------

/**
 * Build the additive metadata block the route layer spreads onto each
 * /api/admin/git/* response. Re-reads accessors on every call so ENV
 * changes propagate immediately to tests/runtime.
 */
export function getAppGitHubWorkflowMeta(): AppGitHubWorkflowMeta {
  const authority = getAuthority();
  return {
    app_id: getGitHubWorkflowAppId(),
    app_name: getAppName(),

    repo_url: getRepoUrl(),
    repo_source: getRepoSource(),
    default_dev_branch: getDefaultDevBranch(),
    allowed_branch_pattern: getAllowedDevBranchPattern(),
    blocked_branches: getBlockedBranches(),

    authority,
    authority_source: deriveAuthoritySource(authority),
    allow_release_pipeline: getAllowReleasePipeline(),
    enforce_main_protection: getEnforceMainProtection(),
    enforce_release_gate: getEnforceReleaseGate(),

    mode: getGitHubWorkflowMode(),
    registry_source: 'app-config',
    registry_migration_status: getGitHubWorkflowRegistryMigrationStatus(),
    config_driven: true
  };
}

/**
 * Static metadata about the v0.6.4 registry surface itself. Used by tests
 * and the validator script.
 */
export function getAppGitHubWorkflowRegistryMeta(): AppGitHubWorkflowRegistryMeta {
  return {
    version: '0.8.2',
    module: 'appGitHubWorkflowRegistry',
    preserves_ui: true,
    preserves_governance: true,
    pure_reader: true
  };
}

/**
 * Pure-predicate convenience used by tests and the route layer to assert
 * that the active config's app_id (top-level) matches the github_workflow
 * block's app_id. v0.6.4 only operates on the active app; multi-app
 * filtering is reserved for a future release.
 */
export function isKnownGitHubWorkflowApp(appId: string): boolean {
  if (typeof appId !== 'string') return false;
  const t = appId.trim();
  if (t === '') return false;
  return t === getActiveAppId() || t === getGitHubWorkflowAppId();
}
