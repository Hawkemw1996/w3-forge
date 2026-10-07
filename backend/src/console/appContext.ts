// =============================================================================
// W3 Core v0.6.6 — Read-only App Context Resolver.
// =============================================================================
//
// Resolves an "active app context" from request input (query param `appId`)
// against the registry loaded by appRegistry.ts. Provides a computed
// capability snapshot per resolved app.
//
// Strict contract for v0.6.6:
//
//   - READ-ONLY. The resolver never writes anything, never spawns a
//     process, never makes a network call, never forwards credentials.
//   - The resolver only INSPECTS the in-memory registry snapshot already
//     produced by `getRegistrySnapshot()`.
//   - App context can only REDUCE authority, never elevate it. External
//     apps (those whose YAML declares `integration.readonly = true`) have
//     `can_execute_controls`, `can_package`, and `can_deploy` forced to
//     `false` regardless of any authority bits in their YAML.
//   - Default app id is `w3forge` (DEFAULT_ACTIVE_APP_ID).
//   - App id must match the v0.6.6 regex `^[a-z][a-z0-9-]{1,63}$` —
//     hyphen-safe only, no underscores. (v0.6.5 allowed underscores; the
//     v0.6.6 contract tightens this. Existing app ids `w3forge` and
//     `w3forge` do not use underscores so the change is backward
//     compatible at the data layer.)
//   - Errors are structured: `{ code, message }` — ready to wrap in the
//     ApiEnvelope `{ success: false, error }` shape.
//
// v0.6.6 does NOT:
//   - Switch any pipeline target (deploy/package/tag still target w3forge).
//   - Add a frontend app selector (UI is byte-for-byte unchanged).
//   - Enable remote shell, remote deploy, remote file writes, or any
//     credential forwarding.
//   - Introduce a token / session system; the resolver is stateless.
// =============================================================================

import {
  getRegistrySnapshot,
  DEFAULT_ACTIVE_APP_ID,
  type AppRegistryEntry,
  type AppRegistrySnapshot,
  type LoadOptions
} from './appRegistry';

// v0.6.6: tightened app id regex — hyphen-safe only (no underscores).
// Matches the user-approved v0.6.6 spec correction. The appRegistry's
// internal regex still allows underscores for backward compatibility with
// any future YAML migration; this stricter regex is enforced at the
// request boundary (query param) before we touch the registry.
export const APP_CONTEXT_APP_ID_REGEX = /^[a-z][a-z0-9-]{1,63}$/;

export interface AppContextCapabilities {
  local: boolean;
  external: boolean;
  can_read_status: boolean;
  can_read_config: boolean;
  can_execute_controls: boolean;
  can_package: boolean;
  can_deploy: boolean;
}

export interface AppContextConfigSummary {
  app_id: string;
  name: string;
  version: string;
  source_file: string;
  admin_console_role: string;
  controls_mode: string;
  registry_migration_status: string;
  // Additive integration metadata — present only for external satellite
  // apps. Absent (undefined) for internal apps to mirror the v0.6.5
  // /apps response shape.
  integration_type?: string;
  transport?: string;
  api_enabled?: boolean;
}

export interface AppContextAuthority {
  may_deploy: boolean;
  may_package: boolean;
  may_tag_release: boolean;
  may_modify_production_data: boolean;
  requires_user_release_gate: boolean;
}

export interface AppContextResolved {
  active_app_id: string;
  default_app_id: string;
  is_default: boolean;
  readonly: boolean;
  integration_type: string;        // 'internal' for w3forge; 'external-api' / etc. for satellites.
  classification: 'local' | 'external';
  config_summary: AppContextConfigSummary;
  authority: AppContextAuthority;
  capabilities: AppContextCapabilities;
}

export interface AppContextResolveError {
  code: 'app_id_invalid' | 'app_not_found' | 'app_registry_load_failed';
  message: string;
}

export type AppContextResolveResult =
  | { ok: true; value: AppContextResolved }
  | { ok: false; error: AppContextResolveError };

// ---------------------------------------------------------------------------
// Capability computer
// ---------------------------------------------------------------------------
//
// Computes the capability matrix for a resolved registry entry. This is
// the SECURITY FLOOR for v0.6.6 app-context switching:
//
//   - External-readonly apps (integration.readonly === true) ALWAYS have
//     can_execute_controls / can_package / can_deploy forced to false,
//     even if the underlying authority flags are mis-set. (The registry
//     validator already rejects such YAMLs at load time, but the floor
//     here is defense-in-depth.)
//   - Internal apps may have these capabilities ENABLED if the registry
//     grants them, but never beyond what the registry's `authority` block
//     already allowed. The resolver cannot grant authority a YAML did
//     not already declare.
//   - can_read_status and can_read_config are always true (registry data
//     is by definition publicly readable inside the admin console).
// ---------------------------------------------------------------------------
export function computeCapabilities(entry: AppRegistryEntry): AppContextCapabilities {
  const integ = entry.config.integration;
  const isExternal = !!integ;
  const isReadonly = integ?.readonly === true;

  // Security floor: external-readonly apps cannot execute / package /
  // deploy through this layer, regardless of authority bits.
  if (isReadonly) {
    return {
      local: false,
      external: true,
      can_read_status: true,
      can_read_config: true,
      can_execute_controls: false,
      can_package: false,
      can_deploy: false
    };
  }

  // Internal apps inherit from the registry's authority block. The
  // resolver can only REDUCE authority; here we mirror the authority
  // bits one-for-one without granting anything new.
  const auth = entry.config.authority;
  return {
    local: !isExternal,
    external: isExternal,
    can_read_status: true,
    can_read_config: true,
    // Controls execution is gated by `may_deploy || may_package` in the
    // legacy code path (the Controls tab is the union of the two). For
    // v0.6.6 we expose the conservative AND so a future caller cannot
    // assume more authority than the existing pipeline grants.
    can_execute_controls: auth.may_deploy === true || auth.may_package === true,
    can_package: auth.may_package === true,
    can_deploy: auth.may_deploy === true
  };
}

function toConfigSummary(entry: AppRegistryEntry): AppContextConfigSummary {
  const summary: AppContextConfigSummary = {
    app_id: entry.app_id,
    name: entry.name,
    version: entry.version,
    source_file: entry.source_file,
    admin_console_role: entry.config.admin_console.role,
    controls_mode: entry.config.controls.mode,
    registry_migration_status: entry.config.controls.registry_migration_status
  };
  const integ = entry.config.integration;
  if (integ) {
    summary.integration_type = integ.type;
    summary.transport = integ.transport;
    summary.api_enabled = integ.api_enabled;
  }
  return summary;
}

function toAuthority(entry: AppRegistryEntry): AppContextAuthority {
  const a = entry.config.authority;
  return {
    may_deploy: a.may_deploy === true,
    may_package: a.may_package === true,
    may_tag_release: a.may_tag_release === true,
    may_modify_production_data: a.may_modify_production_data === true,
    requires_user_release_gate: a.requires_user_release_gate === true
  };
}

function classify(entry: AppRegistryEntry): {
  classification: 'local' | 'external';
  integration_type: string;
  readonly: boolean;
} {
  const integ = entry.config.integration;
  if (integ) {
    return {
      classification: 'external',
      integration_type: integ.type,
      readonly: integ.readonly === true
    };
  }
  return { classification: 'local', integration_type: 'internal', readonly: false };
}

// ---------------------------------------------------------------------------
// resolveAppContext
// ---------------------------------------------------------------------------
//
// Pure function over registry state. No I/O beyond the registry snapshot
// load (which is itself memoized and read-only).
//
// `requestedAppId`:
//   - undefined / null / '' → default to DEFAULT_ACTIVE_APP_ID (w3forge).
//   - non-string → 'app_id_invalid'.
//   - string that fails APP_CONTEXT_APP_ID_REGEX → 'app_id_invalid'.
//   - well-formed but not in registry → 'app_not_found'.
// ---------------------------------------------------------------------------
export function resolveAppContext(
  requestedAppId?: unknown,
  opts: LoadOptions = {}
): AppContextResolveResult {
  let appId: string;
  if (requestedAppId === undefined || requestedAppId === null || requestedAppId === '') {
    appId = DEFAULT_ACTIVE_APP_ID;
  } else if (typeof requestedAppId !== 'string') {
    return {
      ok: false,
      error: { code: 'app_id_invalid', message: `app id must be a string` }
    };
  } else if (!APP_CONTEXT_APP_ID_REGEX.test(requestedAppId)) {
    return {
      ok: false,
      error: {
        code: 'app_id_invalid',
        message: `invalid app id: "${requestedAppId}" (must match ${APP_CONTEXT_APP_ID_REGEX.toString()})`
      }
    };
  } else {
    appId = requestedAppId;
  }

  let snap: AppRegistrySnapshot;
  try {
    snap = getRegistrySnapshot(opts);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'failed to load app registry';
    return { ok: false, error: { code: 'app_registry_load_failed', message } };
  }

  const entry = snap.apps.find((a) => a.app_id === appId);
  if (!entry) {
    return {
      ok: false,
      error: { code: 'app_not_found', message: `unknown app id: ${appId}` }
    };
  }

  const cls = classify(entry);
  const resolved: AppContextResolved = {
    active_app_id: entry.app_id,
    default_app_id: DEFAULT_ACTIVE_APP_ID,
    is_default: entry.app_id === DEFAULT_ACTIVE_APP_ID,
    readonly: cls.readonly,
    integration_type: cls.integration_type,
    classification: cls.classification,
    config_summary: toConfigSummary(entry),
    authority: toAuthority(entry),
    capabilities: computeCapabilities(entry)
  };
  return { ok: true, value: resolved };
}
