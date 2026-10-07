import { applyControlPolicy } from './controlPolicy';
// =============================================================================
// W3 Core v0.6.2 - App-Aware Controls Registry Foundation.
// =============================================================================
//
// This module is the v0.6.2 Controls Registry Migration Foundation. It is an
// ADDITIVE wrapper over the legacy `ADMIN_CONTROLS` array exported by
// `./registry.ts`. Its job is to prepare the Controls backend for multi-app
// support while preserving the *exact* visible behavior of the W3 Forge
// Controls tab.
//
// Hard guarantees (asserted by tests):
//   - Every control id, category, risk level, run strategy, enabled flag,
//     requiresConfirmation, requiresInputs, inputSchema, confirmationSchema,
//     timeoutSeconds, allowedRoles, and logCategory comes from the legacy
//     `ADMIN_CONTROLS` registry. Nothing here mutates any of those fields.
//   - The set of controls returned by `getAppControls()` is *identical* to
//     the legacy `ADMIN_CONTROLS` array (same ids, same order, same count)
//     when `allow_legacy_w3forge_controls === true` (the v0.6.2 default).
//   - Script path resolution goes through `appConfigAccessors.getScriptsPath()`
//     so the underlying scripts directory is now config-driven. The default
//     resolved value remains `/opt/w3forge-scripts` (the v0.6.0 YAML default), which
//     keeps `expectedInstalledPath` byte-identical for an unmodified host.
//   - `resolveScriptPath()` rejects any script name that contains `/`, `\\`,
//     `..`, a null byte, or starts with `-`. There is no way to escape the
//     configured scripts directory.
//   - The decorated public payload is a superset of the legacy
//     `AdminControlPublic` shape. The only additions are the optional
//     `app_id` field on each control and the optional `app_id`, `app_name`,
//     `registry_source`, `config_driven` fields on the response envelope.
//     v0.5.x clients ignore the new fields.
//
// Non-goals for v0.6.2:
//   - No UI changes.
//   - No new controls, no removed controls, no renamed controls.
//   - No app selector. W3 Forge is not surfaced. The visible Controls tab
//     continues to render the W3 Forge registry exactly as it does today.
//   - No new execution paths. Execution stays on safe-direct / safe-wrapper /
//     safe-recovery / safe-deploy / safe-pipeline exactly as in v0.6.1.
//
// =============================================================================

import path from 'node:path';
import {
  ADMIN_CONTROLS,
  CATEGORY_META,
  deriveEffectiveStatus,
  getControl,
  toPublic
} from './registry';
import type {
  AdminControl,
  AdminControlPublic,
  ControlCategory
} from './types';
import {
  getAppName,
  getActiveAppId,
  getAllowLegacyW3ForgeControls,
  getControlsAppId,
  getControlsMode,
  getControlsRegistryMigrationStatus,
  getScriptsPath
} from '../appConfigAccessors';

// ---------------------------------------------------------------------------
// Script-path safety.
//
// The legacy registry stores `scriptName` as a bare filename (e.g.
// 'status-w3forge.sh'). The `expectedInstalledPath` is built by joining that
// filename with the scripts directory. This helper re-builds the path from
// the *current* `getScriptsPath()` value, but it refuses any input that
// could escape the configured directory.
//
// Reject:
//   - empty string
//   - any path separator: '/' or '\\'
//   - '..' segments
//   - null bytes
//   - a leading '-' (which could be interpreted as a CLI flag elsewhere)
// ---------------------------------------------------------------------------

const UNSAFE_SCRIPT_NAME = /[\/\\\x00]|(^|\/|\\)\.\.($|\/|\\)|^-/;

export function isSafeScriptName(scriptName: string): boolean {
  if (typeof scriptName !== 'string') return false;
  if (scriptName.length === 0) return false;
  if (scriptName.length > 255) return false;
  return !UNSAFE_SCRIPT_NAME.test(scriptName);
}

export interface ResolvedScriptPath {
  scriptsDir: string;
  scriptName: string;
  installedPath: string;
}

/**
 * Resolve the on-disk path for a control script using the app-config scripts
 * directory. Returns `null` (never throws) if the script name is unsafe.
 *
 * The scripts directory itself comes from `getScriptsPath()` which honors
 * ENV > YAML > legacy fallback.
 */
export function resolveScriptPath(scriptName: string): ResolvedScriptPath | null {
  if (!isSafeScriptName(scriptName)) return null;
  const scriptsDir = getScriptsPath();
  return {
    scriptsDir,
    scriptName,
    installedPath: path.join(scriptsDir, scriptName)
  };
}

// ---------------------------------------------------------------------------
// App-aware view over ADMIN_CONTROLS.
//
// In v0.6.2 the only app whose controls are exposed is `w3forge` (the legacy
// rows). `getAppControls(appId)` returns the legacy rows only when
//   - the requested appId matches the configured controls.app_id (or the
//     active app id as a fallback), AND
//   - controls.allow_legacy_w3forge_controls is true (default).
//
// Any other appId returns an empty array. There is no path by which a
// non-w3forge appId can read the legacy registry rows.
// ---------------------------------------------------------------------------

export function listKnownAppIds(): string[] {
  // v0.6.2: only the w3forge app exposes controls. Future versions will add
  // additional apps here; the route layer is already prepared to reject
  // unknown ids.
  const appId = getControlsAppId();
  return [appId];
}

export function isKnownAppId(appId: string): boolean {
  return listKnownAppIds().includes(appId);
}

export function getAppControls(appId?: string): ReadonlyArray<AdminControl> {
  const requested = (appId ?? getControlsAppId()).trim();
  if (requested === '') return [];
  if (!isKnownAppId(requested)) return [];
  if (!getAllowLegacyW3ForgeControls()) return [];
  return ADMIN_CONTROLS;
}

export function getAppControlsCount(appId?: string): number {
  return getAppControls(appId).length;
}

/**
 * Decorate a legacy AdminControl into the public wire shape, attaching the
 * v0.6.2 optional `app_id` field and a freshly-resolved `expectedInstalledPath`
 * from the app-config scripts directory.
 *
 * Behavior contract:
 *   - All legacy fields are preserved verbatim (id, label, category, risk,
 *     runStrategy, enabled, inputSchema, confirmationSchema, timeoutSeconds,
 *     etc.).
 *   - `expectedInstalledPath` is recomputed from `getScriptsPath()`. On an
 *     unmodified host with the v0.6.0 YAML default (`/opt/w3forge-scripts`), this
 *     value is byte-identical to the legacy hardcoded path.
 *   - If the script name fails the safety check (which is not expected for
 *     any registry entry), the legacy `expectedInstalledPath` is preserved
 *     defensively. The control is *not* dropped \u2014 silently dropping a
 *     control would change visible behavior.
 *   - `app_id` is attached as an additive field; v0.5.x clients ignore it.
 */
export function decorateAppControl(control: AdminControl, appId?: string): AdminControlPublic {
  const resolvedAppId = (appId ?? getControlsAppId()).trim() || getActiveAppId();
  const base = toPublic(applyControlPolicy(control));
  const resolved = resolveScriptPath(control.scriptName);
  return {
    ...base,
    expectedInstalledPath: resolved ? resolved.installedPath : control.expectedInstalledPath,
    app_id: resolvedAppId
  };
}

/**
 * Convenience: decorate every control for the given app in legacy registry
 * order. Returns an empty array if the app is unknown or legacy controls are
 * disabled by config.
 */
export function getDecoratedAppControls(appId?: string): AdminControlPublic[] {
  const controls = getAppControls(appId);
  const id = (appId ?? getControlsAppId()).trim() || getActiveAppId();
  return controls.map((c) => decorateAppControl(c, id));
}

// ---------------------------------------------------------------------------
// Registry source metadata.
//
// `registry_source` describes how the response was assembled:
//   - 'legacy-compatible' (v0.6.2 default): legacy ADMIN_CONTROLS rows
//     decorated with app_id and config-driven script paths.
//   - 'app-registry' (future): rows loaded from a per-app registry file.
//
// `config_driven` is true when script paths and the registered app id are
// sourced from the YAML; it is informational and never affects gating.
// ---------------------------------------------------------------------------

export interface AppControlRegistryMeta {
  app_id: string;
  app_name: string;
  registry_source: string;
  config_driven: boolean;
  controls_mode: string;
  registry_migration_status: string;
  legacy_w3forge_controls_allowed: boolean;
  scripts_dir: string;
  controls_count: number;
}

export function getAppControlRegistryMeta(appId?: string): AppControlRegistryMeta {
  const resolvedAppId = (appId ?? getControlsAppId()).trim() || getActiveAppId();
  const mode = getControlsMode();
  // v0.6.2 only supports the legacy-compatible source. Any other mode value
  // is reported transparently but does not change behavior.
  const registry_source = mode === 'legacy-compatible' ? 'legacy-compatible' : mode;
  return {
    app_id: resolvedAppId,
    app_name: getAppName(),
    registry_source,
    config_driven: true,
    controls_mode: mode,
    registry_migration_status: getControlsRegistryMigrationStatus(),
    legacy_w3forge_controls_allowed: getAllowLegacyW3ForgeControls(),
    scripts_dir: getScriptsPath(),
    controls_count: getAppControls(resolvedAppId).length
  };
}

// ---------------------------------------------------------------------------
// Re-exports for convenience. The legacy `registry.ts` symbols remain the
// canonical source of truth for control data \u2014 this module never wraps
// them in a way that hides any field.
// ---------------------------------------------------------------------------

export {
  ADMIN_CONTROLS,
  CATEGORY_META,
  deriveEffectiveStatus,
  getControl,
  toPublic
};
export type { AdminControl, AdminControlPublic, ControlCategory };
