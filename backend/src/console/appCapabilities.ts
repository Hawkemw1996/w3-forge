// =============================================================================
// W3 Core v0.6.8 — App Capability Model (read-only, descriptive layer).
// =============================================================================
//
// Resolves an `AppCapabilities` view for any registered app. The capability
// model is descriptive metadata only:
//
//   - No remote DB execution. No credential forwarding. No arbitrary
//     connection strings. No remote control execution. No token system.
//   - The eight known capability namespaces (database, controls,
//     github_validation, file_browser, logs, health_monitoring,
//     deployment, cooperative_development) are surfaced via typed
//     accessors with safe defaults.
//   - When an app's YAML has no `capabilities:` block, defaults are
//     DERIVED from existing sections so v0.6.7-era YAMLs continue to
//     report a sensible capability surface:
//       * controls.enabled              = true
//       * github_validation.enabled     = true
//       * file_browser.enabled          = true
//       * logs.enabled                  = true
//       * health_monitoring.enabled     = true
//       * database.enabled              = false (no implicit DB)
//       * deployment.enabled            = authority.may_deploy
//       * cooperative_development.enabled = false
//   - Authority guard: even when a YAML attempts to set
//     `deployment.enabled = true` on an external-readonly app the
//     registry validator already rejects the file. As a belt-and-
//     suspenders measure the accessor here clamps deployment.enabled
//     to false whenever the resolved entry is external-readonly.
//
// This module is a PURE READER: no fs writes, no spawn, no env writes,
// no global mutation. The only inputs are an `AppRegistryEntry` (already
// validated by `appRegistry.ts`) or, for the convenience accessors, the
// registry snapshot.
// =============================================================================

import {
  type AppRegistryEntry,
  type AppCapabilitiesConfig,
  type AppCapabilityDatabase,
  type AppCapabilityToggle,
  type AppCapabilityDatabaseType
} from './appRegistry';

// -----------------------------------------------------------------------------
// Resolved capability shape — what callers consume.
// -----------------------------------------------------------------------------

export interface ResolvedCapabilityDatabase {
  enabled: boolean;
  type: AppCapabilityDatabaseType;
  readonly: boolean;
  health_check: boolean;
  source: 'app-config' | 'default';
}

export interface ResolvedCapabilityToggle {
  enabled: boolean;
  source: 'app-config' | 'default';
}

export interface AppCapabilities {
  app_id: string;
  database: ResolvedCapabilityDatabase;
  controls: ResolvedCapabilityToggle;
  github_validation: ResolvedCapabilityToggle;
  file_browser: ResolvedCapabilityToggle;
  logs: ResolvedCapabilityToggle;
  health_monitoring: ResolvedCapabilityToggle;
  deployment: ResolvedCapabilityToggle;
  cooperative_development: ResolvedCapabilityToggle;
  // Forward-compatibility passthrough — unknown namespaces preserved from
  // YAML so future releases can introduce new capability sections without
  // breaking older readers.
  extra_namespaces?: Record<string, unknown>;
  // Provenance: was the capabilities block sourced from the YAML or
  // derived from defaults?
  source: 'app-config' | 'default';
}

// -----------------------------------------------------------------------------
// Default builders.
// -----------------------------------------------------------------------------

function defaultDatabase(): ResolvedCapabilityDatabase {
  // Safe default: no implicit database is assumed for any app. Apps that
  // back themselves with a database must opt in via the YAML block.
  return {
    enabled: false,
    type: null,
    readonly: true,
    health_check: false,
    source: 'default'
  };
}

function defaultToggle(enabled: boolean): ResolvedCapabilityToggle {
  return { enabled, source: 'default' };
}

// -----------------------------------------------------------------------------
// Resolver.
// -----------------------------------------------------------------------------

/**
 * Resolve the capability view for a registry entry. Never throws. When
 * the YAML `capabilities:` block is absent, derives a safe default view
 * from existing sections (authority.may_deploy, integration.readonly).
 */
export function resolveAppCapabilities(entry: AppRegistryEntry): AppCapabilities {
  const cfg = entry.config;
  const cap = cfg.capabilities;
  const isExternalReadonly = cfg.integration?.readonly === true;
  const mayDeploy = cfg.authority?.may_deploy === true;

  // ---- Database namespace -------------------------------------------------
  let database: ResolvedCapabilityDatabase;
  if (cap?.database) {
    database = resolveDatabase(cap.database, isExternalReadonly);
  } else {
    database = defaultDatabase();
  }

  // ---- Toggle namespaces -------------------------------------------------
  // For pre-v0.6.8 YAMLs (no capabilities block), the safe defaults assume
  // the existing W3 Forge admin surfaces are live for internal apps and
  // disabled for external-readonly apps. This preserves the v0.6.7
  // behavior byte-for-byte.

  const controls = resolveToggle(cap?.controls, !isExternalReadonly);
  const github_validation = resolveToggle(cap?.github_validation, !isExternalReadonly);
  const file_browser = resolveToggle(cap?.file_browser, !isExternalReadonly);
  const logs = resolveToggle(cap?.logs, !isExternalReadonly);
  const health_monitoring = resolveToggle(cap?.health_monitoring, true);

  // Deployment defaults to mirror authority.may_deploy. Authority guard
  // clamps to false on external-readonly apps even if the YAML somehow
  // got past the validator.
  let deployment = resolveToggle(cap?.deployment, mayDeploy);
  if (isExternalReadonly && deployment.enabled) {
    deployment = { enabled: false, source: deployment.source };
  }

  // Cooperative development defaults to true for external-readonly
  // satellites (they participate in cooperative-dev workflows) and false
  // for internal master apps. The YAML wins if present.
  const cooperative_development = resolveToggle(
    cap?.cooperative_development,
    isExternalReadonly
  );

  return {
    app_id: entry.app_id,
    database,
    controls,
    github_validation,
    file_browser,
    logs,
    health_monitoring,
    deployment,
    cooperative_development,
    extra_namespaces: cap?.extra_namespaces,
    source: cap ? 'app-config' : 'default'
  };
}

function resolveDatabase(
  raw: AppCapabilityDatabase,
  isExternalReadonly: boolean
): ResolvedCapabilityDatabase {
  // Belt-and-suspenders: refuse to advertise an enabled DB for external-
  // readonly apps. The validator already enforces this on the deployment
  // toggle; for database we additionally clamp to enabled=false to
  // prevent any future YAML drift from re-enabling cross-app DB polling.
  if (isExternalReadonly && raw.enabled === true) {
    return {
      enabled: false,
      type: null,
      readonly: true,
      health_check: false,
      source: 'app-config'
    };
  }
  return {
    enabled: raw.enabled,
    type: raw.type,
    readonly: raw.readonly,
    health_check: raw.health_check,
    source: 'app-config'
  };
}

function resolveToggle(
  raw: AppCapabilityToggle | undefined,
  defaultEnabled: boolean
): ResolvedCapabilityToggle {
  if (raw) {
    return { enabled: raw.enabled === true, source: 'app-config' };
  }
  return defaultToggle(defaultEnabled);
}

// -----------------------------------------------------------------------------
// Convenience predicates.
// -----------------------------------------------------------------------------
//
// Each `has*Capability()` helper takes a registry entry and returns the
// resolved enabled flag for that capability. They are intentionally pure
// functions so callers (route layer, tests, future UI gating) can ask the
// question without holding onto a resolved view.

export function hasDatabaseCapability(entry: AppRegistryEntry): boolean {
  return resolveAppCapabilities(entry).database.enabled;
}

export function hasControlsCapability(entry: AppRegistryEntry): boolean {
  return resolveAppCapabilities(entry).controls.enabled;
}

export function hasGitHubValidationCapability(entry: AppRegistryEntry): boolean {
  return resolveAppCapabilities(entry).github_validation.enabled;
}

export function hasFileBrowserCapability(entry: AppRegistryEntry): boolean {
  return resolveAppCapabilities(entry).file_browser.enabled;
}

export function hasLogsCapability(entry: AppRegistryEntry): boolean {
  return resolveAppCapabilities(entry).logs.enabled;
}

export function hasHealthMonitoringCapability(entry: AppRegistryEntry): boolean {
  return resolveAppCapabilities(entry).health_monitoring.enabled;
}

export function hasDeploymentCapability(entry: AppRegistryEntry): boolean {
  return resolveAppCapabilities(entry).deployment.enabled;
}

export function hasCooperativeDevelopmentCapability(entry: AppRegistryEntry): boolean {
  return resolveAppCapabilities(entry).cooperative_development.enabled;
}

// -----------------------------------------------------------------------------
// Capability summary — small projection used by the v0.6.7 health
// orchestrator to additively enrich AppHealthStatus.
// -----------------------------------------------------------------------------

export interface AppCapabilitiesSummary {
  database_enabled: boolean;
  deployment_enabled: boolean;
  cooperative_development_enabled: boolean;
}

export function summarizeCapabilities(entry: AppRegistryEntry): AppCapabilitiesSummary {
  const resolved = resolveAppCapabilities(entry);
  return {
    database_enabled: resolved.database.enabled,
    deployment_enabled: resolved.deployment.enabled,
    cooperative_development_enabled: resolved.cooperative_development.enabled
  };
}

// -----------------------------------------------------------------------------
// Module metadata used by the validator script and tests.
// -----------------------------------------------------------------------------

export interface AppCapabilitiesRegistryMeta {
  version: '0.6.8';
  module: 'appCapabilities';
  preserves_ui: true;
  pure_reader: true;
  descriptive_only: true;
}

export function getAppCapabilitiesRegistryMeta(): AppCapabilitiesRegistryMeta {
  return {
    version: '0.6.8',
    module: 'appCapabilities',
    preserves_ui: true,
    pure_reader: true,
    descriptive_only: true
  };
}

// Re-export the capability config types for convenience.
export type {
  AppCapabilitiesConfig,
  AppCapabilityDatabase,
  AppCapabilityToggle,
  AppCapabilityDatabaseType
};
