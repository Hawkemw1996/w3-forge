// =============================================================================
// W3 Core v0.6.3 — App-aware File Browser registry foundation.
// =============================================================================
//
// Additive, legacy-compatible layer above the legacy in-process file-browser
// root list in `backend/src/admin/routes/filesRoutes.ts`. v0.6.3 does NOT
// change any visible /api/admin/files/* behavior:
//
//   - The same 10 root ids are exposed, in the same fixed order.
//   - Every root resolves to the same absolute path it resolved to in
//     v0.6.2, because every path comes from `appConfigAccessors` (which
//     in turn applies the same ENV > YAML > legacy-hardcoded precedence
//     introduced in v0.6.1).
//   - The traversal / realpath / hidden-file / archive-not-previewable
//     contract enforced by `resolveInsideRoot` and the route handlers is
//     unchanged.
//
// What v0.6.3 adds:
//
//   1. A typed `AppFileBrowserRoot` shape with optional `app_id` and
//      `root_source` fields, so the visible response can additively expose
//      the migration metadata without changing existing fields.
//   2. `getAppFileBrowserRoots()` — single source of truth for the visible
//      root list. Honors `file_browser.allowed_roots` from YAML when
//      present (so a future release can hide a root by editing the YAML),
//      and falls back to the full legacy list when the field is absent.
//      The `allow_host_local_roots` toggle controls visibility of the
//      host-local `cleanup-review` root only; it does NOT bypass any
//      traversal check.
//   3. `decorateAppFileBrowserRoot()` — attaches `app_id` + `root_source`
//      to a single root payload. Preserves every legacy field verbatim.
//   4. `getAppFileBrowserRegistryMeta()` — exposes the four additive
//      top-level response fields (`app_id`, `app_name`, `registry_source`,
//      `config_driven`) for /files/roots.
//
// Nothing in this module reads or writes outside the configured roots.
// Path-traversal protection remains in the route layer (`resolveInsideRoot`)
// and is intentionally NOT duplicated here — this module only computes
// which root ids are visible and where they live.
// =============================================================================

import path from 'node:path';
import {
  getRuntimePath,
  getDeployPath,
  getScriptsPath,
  getLogsPath,
  getBackupsPath,
  getUpdatePackagesPath,
  getInstalledPackagesPath,
  getFileBrowserMode,
  getFileBrowserAppId,
  getFileBrowserAllowedRoots,
  getAllowHostLocalFileBrowserRoots,
  getAppName
} from '../appConfigAccessors';

// ---- Public types ----------------------------------------------------------

export interface AppFileBrowserRoot {
  id: string;
  path: string;
  label: string;
  description: string;
  // v0.6.3 additive metadata. Always populated by this module so the route
  // layer can surface them without per-call composition logic.
  app_id: string;
  root_source: AppFileBrowserRootSource;
}

export type AppFileBrowserRootSource =
  // Path came from getRuntimePath/getDeployPath/... — i.e. ENV > YAML > legacy.
  | 'app-config'
  // Host-local diagnostic root (cleanup-review). Resolved from ENV with a
  // hardcoded fallback because this directory is NOT part of the per-app
  // contract in `config/apps/*.yml`.
  | 'host-local';

export interface AppFileBrowserRegistryMeta {
  app_id: string;
  app_name: string;
  // v0.6.3 always reports `'legacy-compatible'` to match
  // `config/apps/w3forge.yml -> file_browser.mode`. The string is sourced from
  // the YAML via `getFileBrowserMode()` so a future release that flips the
  // mode propagates automatically.
  registry_source: string;
  // v0.6.3 is the *foundation*: roots are resolved through accessors but the
  // route layer still iterates a fixed legacy list (plus the optional
  // `allowed_roots` filter). Future versions that materialise the full list
  // from YAML will flip this flag to `true`.
  config_driven: boolean;
  registry_migration_status: string;
}

// ---- Legacy fixed-order root definitions (paths via accessors) -------------
//
// The id, label, and description strings are byte-identical to the values
// exported by `filesRoutes.ts` in v0.6.2. The path strings are computed at
// call time so any ENV/YAML override applied before the request lands is
// honored without re-importing the module — matching the v0.6.2 controls
// `decorateAppControl()` contract.

interface LegacyRootDef {
  id: string;
  label: string;
  description: string;
  resolvePath: () => string;
  source: AppFileBrowserRootSource;
}

const HOST_LOCAL_CLEANUP_REVIEW_DEFAULT = '/opt/w3forge-cleanup-review';

function resolveCleanupReview(): string {
  const v = (process.env.W3_CLEANUP_REVIEW_DIR ?? '').trim();
  return v ? v : HOST_LOCAL_CLEANUP_REVIEW_DEFAULT;
}

// Defined as a function-returning-array (not a static const) so each call
// re-reads accessors. This is important for tests that override ENV vars
// between calls and assert that the new path is used immediately.
function legacyRootDefs(): readonly LegacyRootDef[] {
  return [
    {
      id: 'app',
      label: '/opt/w3forge',
      description: 'Live application directory (read-only browse).',
      resolvePath: () => getRuntimePath(),
      source: 'app-config'
    },
    {
      id: 'deploy',
      label: '/opt/w3forge-deploy',
      description: 'Deploy staging tree.',
      resolvePath: () => getDeployPath(),
      source: 'app-config'
    },
    {
      id: 'deploy-scripts',
      label: '/opt/w3forge-deploy/scripts',
      description: 'Scripts shipped with the staged deploy.',
      resolvePath: () => path.join(getDeployPath(), 'scripts'),
      source: 'app-config'
    },
    {
      id: 'deploy-docs',
      label: '/opt/w3forge-deploy/docs',
      description: 'Documentation in the staged deploy (if present).',
      resolvePath: () => path.join(getDeployPath(), 'docs'),
      source: 'app-config'
    },
    {
      id: 'scripts',
      label: '/opt/w3forge-scripts',
      description: 'Operational scripts (deploy, backup, cleanup).',
      resolvePath: () => getScriptsPath(),
      source: 'app-config'
    },
    {
      id: 'update-packages',
      label: '/opt/w3forge-update-packages',
      description: 'Staged release tarballs awaiting deploy.',
      resolvePath: () => getUpdatePackagesPath(),
      source: 'app-config'
    },
    {
      id: 'update-packages-installed',
      label: '/opt/w3forge-update-packages/installed',
      description: 'Archived release tarballs after deploy.',
      resolvePath: () => getInstalledPackagesPath(),
      source: 'app-config'
    },
    {
      id: 'backups',
      label: '/opt/backups/w3forge',
      description: 'Local app + database backups.',
      resolvePath: () => getBackupsPath(),
      source: 'app-config'
    },
    {
      id: 'logs',
      label: '/opt/logs/w3forge',
      description: 'Application log files.',
      resolvePath: () => getLogsPath(),
      source: 'app-config'
    },
    {
      id: 'cleanup-review',
      label: '/opt/w3forge-cleanup-review',
      description: 'Files staged for offline cleanup review.',
      resolvePath: resolveCleanupReview,
      source: 'host-local'
    }
  ];
}

// ---- Public API ------------------------------------------------------------

/**
 * Returns the full ordered list of legacy root ids the file browser knows
 * about. Order is fixed and byte-identical to the pre-v0.6.3 ROOTS array.
 */
export function listLegacyFileBrowserRootIds(): string[] {
  return legacyRootDefs().map((r) => r.id);
}

/**
 * Returns the visible, ordered list of file-browser roots for the active
 * app. Honors the optional `file_browser.allowed_roots` YAML filter and the
 * `allow_host_local_roots` toggle. Unknown ids in `allowed_roots` are
 * silently skipped so a typo in YAML cannot synthesize a new visible root.
 *
 * v0.6.3 default behavior: when `allowed_roots` is absent in YAML, every
 * legacy root is returned in its original order (visible behavior is
 * unchanged). When `allow_host_local_roots=false`, only the `cleanup-review`
 * root is dropped from the list; the per-request traversal/realpath checks
 * in `filesRoutes.ts` are unchanged.
 */
export function getAppFileBrowserRoots(): AppFileBrowserRoot[] {
  const defs = legacyRootDefs();
  const allowedFromYaml = getFileBrowserAllowedRoots();
  const allowHostLocal = getAllowHostLocalFileBrowserRoots();
  const appId = getFileBrowserAppId();

  let filtered: readonly LegacyRootDef[];
  if (allowedFromYaml === null) {
    // No explicit policy in YAML — preserve legacy visible behavior.
    filtered = defs;
  } else {
    const set = new Set(allowedFromYaml);
    // Preserve legacy *order* by iterating defs, not the YAML list. A typo
    // in YAML therefore cannot reorder the visible list or synthesize an
    // unknown root.
    filtered = defs.filter((r) => set.has(r.id));
  }

  // Host-local toggle: drop the host-local roots when the flag is false.
  // Currently only `cleanup-review` is sourced from outside the app config.
  if (!allowHostLocal) {
    filtered = filtered.filter((r) => r.source !== 'host-local');
  }

  return filtered.map((r) => ({
    id: r.id,
    path: r.resolvePath(),
    label: r.label,
    description: r.description,
    app_id: appId,
    root_source: r.source
  }));
}

/**
 * Look up a single root by id. Returns `null` when the id is not in the
 * visible list (either unknown or filtered out by YAML / host-local toggle).
 * This is the function the route layer should call to resolve `?root=...`.
 */
export function getAppFileBrowserRoot(id: unknown): AppFileBrowserRoot | null {
  if (typeof id !== 'string' || id === '') return null;
  return getAppFileBrowserRoots().find((r) => r.id === id) ?? null;
}

/**
 * Returns true iff `id` is a known legacy root id (regardless of whether
 * the YAML allowed_roots filter is currently hiding it). Used only for
 * diagnostic / debug surfaces; callers that need to enforce access MUST
 * use `getAppFileBrowserRoot()` instead.
 */
export function isKnownLegacyFileBrowserRootId(id: unknown): boolean {
  if (typeof id !== 'string') return false;
  return legacyRootDefs().some((r) => r.id === id);
}

/**
 * Returns the additive top-level response fields surfaced on
 * /api/admin/files/roots. None of these fields existed before v0.6.3; the
 * frontend ignores unknown fields, so adding them is backward compatible.
 */
export function getAppFileBrowserRegistryMeta(): AppFileBrowserRegistryMeta {
  return {
    app_id: getFileBrowserAppId(),
    app_name: getAppName(),
    registry_source: getFileBrowserMode(),
    config_driven: false,
    registry_migration_status: (() => {
      // Avoid a second registry read when the accessor is already imported.
      // We import the dedicated accessor lazily here to keep the import set
      // narrow and explicit.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const acc = require('../appConfigAccessors') as {
        getFileBrowserRegistryMigrationStatus: () => string;
      };
      return acc.getFileBrowserRegistryMigrationStatus();
    })()
  };
}
