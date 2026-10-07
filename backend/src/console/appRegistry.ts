// =============================================================================
// Universal Modular Admin Framework — App Registry Loader (v0.6.0 foundation).
// =============================================================================
//
// Reads app config files from `config/apps/*.yml` and exposes a typed,
// in-memory registry. v0.6.0 is the FOUNDATION pass: this loader is wired
// into a single new READ-ONLY admin route (`GET /api/admin/apps`). No
// existing route, control, script, package, deploy, rollback, UI tab,
// styling, or layout is changed.
//
// Hardcoded global primitives that this module DOES NOT override:
//   - ApiEnvelope<T>            (see backend/src/types/api.ts)
//   - safeRunner / shell:false  (see backend/src/admin/controls/safeRunner.ts)
//   - control validation        (see backend/src/admin/controls/validator.ts)
//   - execution + audit logging (see backend/src/admin/adminAudit.ts)
//   - existing W3 Forge UI styling, layout, and UX
//   - deployment authority model and main/tag/release-gate ownership
//
// Modular per-app fields (sourced from this registry):
//   - paths / repos / scripts / logs / runtime / service info
//   - authority flags + deploy permissions
//   - allowed controls + future review behavior
//
// No new third-party dependency is introduced. The YAML reader is a small,
// intentionally narrow parser that only understands the constructs used by
// `config/apps/*.yml` (scalars, nested maps, and `- string` list items).
// Anything outside that grammar is rejected with a controlled error.
// =============================================================================

import { repoRoot } from '../config/env';
import fs from 'node:fs';
import path from 'node:path';
import { AppError } from '../types/api';

// ---- Public types ----------------------------------------------------------

export interface AppRepoConfig {
  url: string;
  default_dev_branch: string;
  allowed_branch_pattern: string;
  blocked_branches: string[];
}

export interface AppPathsConfig {
  deploy: string;
  runtime: string;
  scripts: string;
  logs: string;
  backups: string;
  // v0.6.5: update_packages / installed_packages are required for INTERNAL
  // apps (e.g. w3forge) and optional for external-readonly apps (e.g.
  // w3forge) which never receive packages from this registry.
  update_packages?: string;
  installed_packages?: string;
}

export interface AppServiceConfig {
  name: string;
  port: number;
  health_url: string;
  version_url: string;
}

export interface AppAuthorityConfig {
  may_deploy: boolean;
  may_package: boolean;
  may_tag_release: boolean;
  may_modify_production_data: boolean;
  requires_user_release_gate: boolean;
}

export interface AppAdminConsoleConfig {
  role: string;
  preserve_ui: boolean;
  // v0.6.5: the three preserve_*_tab flags are required for the W3 Forge
  // admin console app (w3forge) and optional for external-readonly
  // satellite apps (e.g. w3forge) which do not render W3 Forge's tabs.
  preserve_github_validation_tab?: boolean;
  preserve_controls_tab?: boolean;
  preserve_file_browser_tab?: boolean;
}

export interface AppControlsConfig {
  mode: string;
  registry_migration_status: string;
  // v0.6.2: optional additive fields for the Controls Registry Migration
  // Foundation. Absent in v0.6.0/v0.6.1 YAMLs; safe defaults are applied by
  // appConfigAccessors so older configs continue to load.
  app_id?: string;
  allow_legacy_w3forge_controls?: boolean;
}

// v0.6.3: File Browser app-config migration foundation. Entirely optional so
// v0.6.0/v0.6.1/v0.6.2 YAMLs still validate; accessors apply safe defaults
// matching the pre-v0.6.3 hardcoded behavior.
export interface AppFileBrowserConfig {
  mode: string;
  registry_migration_status: string;
  app_id?: string;
  allow_host_local_roots?: boolean;
  allowed_roots?: string[];
}

// v0.6.4: GitHub Validation / Release Workflow app-config migration
// foundation. Entirely optional so v0.6.0–0.6.3 YAMLs still validate;
// accessors apply safe defaults matching the pre-v0.6.4 hardcoded behavior.
export interface AppGitHubWorkflowConfig {
  mode: string;
  registry_migration_status: string;
  app_id?: string;
  allow_release_pipeline?: boolean;
  enforce_main_protection?: boolean;
  enforce_release_gate?: boolean;
}

// v0.6.8: App capability model — descriptive metadata only.
//
// The capability block is OPTIONAL and entirely additive. Pre-v0.6.8 YAMLs
// continue to validate; for them the capability accessors
// (`appCapabilities.ts`) derive safe defaults from existing sections.
//
// Forward compatibility:
//   - The validator KNOWS the eight core namespaces below (database,
//     controls, github_validation, file_browser, logs, health_monitoring,
//     deployment, cooperative_development) and validates their structure.
//   - Any UNKNOWN top-level namespace under `capabilities:` is preserved
//     verbatim into `extra_namespaces` so future capability namespaces
//     can be introduced without breaking older releases that read this
//     YAML. The same is true for unknown KEYS inside the known
//     namespaces — they are kept in each namespace's `extras` map.
//   - The route layer only surfaces the eight known namespaces; the
//     `extra_*` fields are reserved for future migrations.
//
// Authority guard:
//   - For external-readonly apps (`integration.readonly === true`),
//     `deployment.enabled` MUST be false. Capability metadata can never
//     elevate authority above the existing `authority` block.
export type AppCapabilityDatabaseType = 'postgres' | 'sqlite' | null;

export interface AppCapabilityDatabase {
  enabled: boolean;
  type: AppCapabilityDatabaseType;
  readonly: boolean;
  health_check: boolean;
  extras?: Record<string, unknown>;
}

export interface AppCapabilityToggle {
  enabled: boolean;
  extras?: Record<string, unknown>;
}

export interface AppCapabilitiesConfig {
  database?: AppCapabilityDatabase;
  controls?: AppCapabilityToggle;
  github_validation?: AppCapabilityToggle;
  file_browser?: AppCapabilityToggle;
  logs?: AppCapabilityToggle;
  health_monitoring?: AppCapabilityToggle;
  deployment?: AppCapabilityToggle;
  cooperative_development?: AppCapabilityToggle;
  // Forward-compatibility bucket — any unknown top-level capability
  // namespace is preserved verbatim here so older releases don't break
  // on newer YAMLs.
  extra_namespaces?: Record<string, unknown>;
}

// v0.6.5: External-readonly integration block. When present (e.g. for
// satellite apps like W3 Forge), the loader applies a relaxed schema:
// `paths.update_packages` / `paths.installed_packages` and the three
// admin_console `preserve_*_tab` flags become optional. The loader still
// rejects YAMLs that try to grant write/exec authority through this path:
// `authority.may_deploy`, `may_package`, and `may_tag_release` MUST be
// false for any app whose `integration.readonly` is true.
export interface AppIntegrationConfig {
  type: string;            // e.g. 'external-api'
  transport: string;       // e.g. 'tailscale'
  tailscale_ip?: string;
  api_enabled: boolean;
  readonly: boolean;
}

export interface AppConfig {
  app_id: string;
  name: string;
  version: string;
  repo: AppRepoConfig;
  paths: AppPathsConfig;
  service: AppServiceConfig;
  authority: AppAuthorityConfig;
  admin_console: AppAdminConsoleConfig;
  controls: AppControlsConfig;
  // v0.6.3 additive optional section; absent in older YAMLs.
  file_browser?: AppFileBrowserConfig;
  // v0.6.4 additive optional section; absent in older YAMLs.
  github_workflow?: AppGitHubWorkflowConfig;
  // v0.6.5 additive optional section; present only for external/read-only
  // satellite apps. Drives the relaxed validation schema and the
  // /api/admin/apps/:appId/status probe behavior.
  integration?: AppIntegrationConfig;
  // v0.6.8 additive optional section; absent in older YAMLs. Safe
  // defaults are derived from existing sections by `appCapabilities.ts`
  // when this block is missing.
  capabilities?: AppCapabilitiesConfig;
}

export interface AppRegistryEntry {
  app_id: string;
  name: string;
  version: string;
  source_file: string;
  config: AppConfig;
}

export interface AppRegistrySnapshot {
  active_app_id: string;
  apps: AppRegistryEntry[];
  validation: {
    ok: boolean;
    errors: string[];
    warnings: string[];
  };
}

// ---- Defaults --------------------------------------------------------------

export const DEFAULT_ACTIVE_APP_ID = 'w3forge';

function defaultConfigDir(): string {
  // W3 Forge compiles to backend/dist/backend/src/admin/, so the config
  // directory is resolved from the detected repository root rather than a
  // fixed number of parent directories.
  const fromHere = path.join(repoRoot, 'config', 'apps');
  return process.env.W3_APP_CONFIG_DIR?.trim() || fromHere;
}

// ---- Minimal YAML reader ---------------------------------------------------
//
// Supports only the constructs used by `config/apps/*.yml`:
//   - Top-level scalar keys: `key: value`
//   - Nested maps via 2-space indentation
//   - String list items: `  - value`
//   - Comments (`#`) and blank lines
//   - Quoted (single or double) string values
//
// Anything outside that grammar throws a controlled YamlParseError so a
// route handler can surface an ApiEnvelope error instead of a 500 stack.

class YamlParseError extends Error {
  line: number;
  constructor(message: string, line: number) {
    super(`YAML parse error on line ${line}: ${message}`);
    this.line = line;
  }
}

type YamlScalar = string | number | boolean | null;
type YamlValue = YamlScalar | YamlValue[] | { [k: string]: YamlValue };

function parseScalar(raw: string): YamlScalar {
  const v = raw.trim();
  if (v === '') return '';
  if (
    (v.startsWith('"') && v.endsWith('"') && v.length >= 2) ||
    (v.startsWith("'") && v.endsWith("'") && v.length >= 2)
  ) {
    return v.slice(1, -1);
  }
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'null' || v === '~') return null;
  if (/^-?\d+$/.test(v)) return parseInt(v, 10);
  if (/^-?\d+\.\d+$/.test(v)) return parseFloat(v);
  return v;
}

function indentOf(line: string): number {
  let i = 0;
  while (i < line.length && line[i] === ' ') i++;
  return i;
}

export function parseSimpleYaml(text: string): YamlValue {
  // Strip BOM and normalize newlines.
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const rawLines = normalized.split('\n');

  // Pre-filter: keep line numbers for error reporting.
  type Line = { n: number; raw: string; indent: number; content: string };
  const lines: Line[] = [];
  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i];
    if (raw.includes('\t')) {
      throw new YamlParseError('tabs are not allowed for indentation', i + 1);
    }
    const stripped = raw.replace(/\s+#.*$/, '').replace(/^#.*$/, '');
    if (stripped.trim() === '') continue;
    lines.push({ n: i + 1, raw, indent: indentOf(raw), content: stripped });
  }

  // Recursive descent on a list of lines at a given indent.
  function parseBlock(start: number, indent: number): { value: YamlValue; next: number } {
    if (start >= lines.length) return { value: {}, next: start };
    const first = lines[start];
    if (first.indent < indent) return { value: {}, next: start };

    // List of `- item` strings at this indent.
    if (first.content.trim().startsWith('- ') || first.content.trim() === '-') {
      const items: YamlValue[] = [];
      let i = start;
      while (i < lines.length) {
        const ln = lines[i];
        if (ln.indent !== indent) break;
        const t = ln.content.trim();
        if (!t.startsWith('-')) break;
        const after = t.slice(1).trim();
        if (after === '') {
          throw new YamlParseError('empty list item is not supported', ln.n);
        }
        items.push(parseScalar(after));
        i++;
      }
      return { value: items, next: i };
    }

    // Map of `key: value` pairs at this indent.
    const obj: { [k: string]: YamlValue } = {};
    let i = start;
    while (i < lines.length) {
      const ln = lines[i];
      if (ln.indent < indent) break;
      if (ln.indent > indent) {
        throw new YamlParseError(`unexpected indent (${ln.indent} vs ${indent})`, ln.n);
      }
      const t = ln.content.slice(indent);
      if (t.startsWith('-')) break;
      const colon = t.indexOf(':');
      if (colon < 0) {
        throw new YamlParseError('expected "key: value" mapping', ln.n);
      }
      const key = t.slice(0, colon).trim();
      const rest = t.slice(colon + 1);
      if (key === '') {
        throw new YamlParseError('empty key', ln.n);
      }

      if (rest.trim() === '') {
        // Nested block: child must be indented by exactly +2 spaces.
        const childIndent = indent + 2;
        const next = lines[i + 1];
        if (!next || next.indent < childIndent) {
          // Empty mapping value.
          obj[key] = {};
          i++;
          continue;
        }
        if (next.indent !== childIndent) {
          throw new YamlParseError(
            `expected child indent ${childIndent}, got ${next.indent}`,
            next.n
          );
        }
        const sub = parseBlock(i + 1, childIndent);
        obj[key] = sub.value;
        i = sub.next;
      } else {
        obj[key] = parseScalar(rest);
        i++;
      }
    }
    return { value: obj, next: i };
  }

  const { value } = parseBlock(0, 0);
  return value;
}

// ---- Validation ------------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function expectString(obj: Record<string, unknown>, key: string, ctx: string): string {
  const v = obj[key];
  if (typeof v !== 'string' || v.trim() === '') {
    throw new AppError(500, 'app_config_invalid', `${ctx}.${key} must be a non-empty string`);
  }
  return v;
}

function expectBool(obj: Record<string, unknown>, key: string, ctx: string): boolean {
  const v = obj[key];
  if (typeof v !== 'boolean') {
    throw new AppError(500, 'app_config_invalid', `${ctx}.${key} must be true or false`);
  }
  return v;
}

function expectNumber(obj: Record<string, unknown>, key: string, ctx: string): number {
  const v = obj[key];
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new AppError(500, 'app_config_invalid', `${ctx}.${key} must be a number`);
  }
  return v;
}

function expectStringArray(obj: Record<string, unknown>, key: string, ctx: string): string[] {
  const v = obj[key];
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
    throw new AppError(500, 'app_config_invalid', `${ctx}.${key} must be a list of strings`);
  }
  return v as string[];
}

function expectMap(obj: Record<string, unknown>, key: string, ctx: string): Record<string, unknown> {
  const v = obj[key];
  if (!isPlainObject(v)) {
    throw new AppError(500, 'app_config_invalid', `${ctx}.${key} must be a mapping`);
  }
  return v;
}

const APP_ID_REGEX = /^[a-z][a-z0-9_-]{1,63}$/;

export function validateAppConfig(raw: unknown, source: string): AppConfig {
  if (!isPlainObject(raw)) {
    throw new AppError(500, 'app_config_invalid', `${source}: top-level must be a mapping`);
  }

  const appId = expectString(raw, 'app_id', 'app');
  if (!APP_ID_REGEX.test(appId)) {
    throw new AppError(
      500,
      'app_config_invalid',
      `app.app_id "${appId}" must match ${APP_ID_REGEX.toString()}`
    );
  }
  const name = expectString(raw, 'name', 'app');
  const version = expectString(raw, 'version', 'app');

  const repoMap = expectMap(raw, 'repo', 'app');
  const repo: AppRepoConfig = {
    url: expectString(repoMap, 'url', 'repo'),
    default_dev_branch: expectString(repoMap, 'default_dev_branch', 'repo'),
    allowed_branch_pattern: expectString(repoMap, 'allowed_branch_pattern', 'repo'),
    blocked_branches: expectStringArray(repoMap, 'blocked_branches', 'repo')
  };
  // Validate the regex is parseable and covers the default dev branch.
  let pattern: RegExp;
  try {
    pattern = new RegExp(repo.allowed_branch_pattern);
  } catch (err) {
    throw new AppError(
      500,
      'app_config_invalid',
      `repo.allowed_branch_pattern is not a valid RegExp: ${(err as Error).message}`
    );
  }
  if (!pattern.test(repo.default_dev_branch)) {
    throw new AppError(
      500,
      'app_config_invalid',
      `repo.default_dev_branch "${repo.default_dev_branch}" must match repo.allowed_branch_pattern`
    );
  }
  if (!repo.blocked_branches.includes('main') || !repo.blocked_branches.includes('master')) {
    throw new AppError(
      500,
      'app_config_invalid',
      'repo.blocked_branches must include both "main" and "master"'
    );
  }

  // v0.6.5: pre-read the optional integration block so the rest of
  // validation knows whether to apply the strict internal schema
  // (w3forge) or the relaxed external-readonly schema (w3forge).
  let integration: AppIntegrationConfig | undefined;
  const integRaw = (raw as Record<string, unknown>).integration;
  if (integRaw !== undefined) {
    if (!isPlainObject(integRaw)) {
      throw new AppError(500, 'app_config_invalid', 'app.integration must be a mapping');
    }
    integration = {
      type: expectString(integRaw, 'type', 'integration'),
      transport: expectString(integRaw, 'transport', 'integration'),
      api_enabled: expectBool(integRaw, 'api_enabled', 'integration'),
      readonly: expectBool(integRaw, 'readonly', 'integration')
    };
    if (typeof integRaw.tailscale_ip === 'string' && integRaw.tailscale_ip.trim() !== '') {
      integration.tailscale_ip = integRaw.tailscale_ip.trim();
    }
  }
  const isExternalReadonly = integration?.readonly === true;

  const pathsMap = expectMap(raw, 'paths', 'app');
  const paths: AppPathsConfig = {
    deploy: expectString(pathsMap, 'deploy', 'paths'),
    runtime: expectString(pathsMap, 'runtime', 'paths'),
    scripts: expectString(pathsMap, 'scripts', 'paths'),
    logs: expectString(pathsMap, 'logs', 'paths'),
    backups: expectString(pathsMap, 'backups', 'paths')
  };
  // update_packages / installed_packages are required for internal apps
  // (so the v0.5.x deploy/package pipeline keeps working) but optional
  // for external-readonly apps (which never receive packages from this
  // registry).
  if (isExternalReadonly) {
    if (typeof pathsMap.update_packages === 'string' && pathsMap.update_packages.trim() !== '') {
      paths.update_packages = pathsMap.update_packages.trim();
    }
    if (typeof pathsMap.installed_packages === 'string' && pathsMap.installed_packages.trim() !== '') {
      paths.installed_packages = pathsMap.installed_packages.trim();
    }
  } else {
    paths.update_packages = expectString(pathsMap, 'update_packages', 'paths');
    paths.installed_packages = expectString(pathsMap, 'installed_packages', 'paths');
  }

  const serviceMap = expectMap(raw, 'service', 'app');
  const service: AppServiceConfig = {
    name: expectString(serviceMap, 'name', 'service'),
    port: expectNumber(serviceMap, 'port', 'service'),
    health_url: expectString(serviceMap, 'health_url', 'service'),
    version_url: expectString(serviceMap, 'version_url', 'service')
  };

  const authorityMap = expectMap(raw, 'authority', 'app');
  const authority: AppAuthorityConfig = {
    may_deploy: expectBool(authorityMap, 'may_deploy', 'authority'),
    may_package: expectBool(authorityMap, 'may_package', 'authority'),
    may_tag_release: expectBool(authorityMap, 'may_tag_release', 'authority'),
    may_modify_production_data: expectBool(
      authorityMap,
      'may_modify_production_data',
      'authority'
    ),
    requires_user_release_gate: expectBool(
      authorityMap,
      'requires_user_release_gate',
      'authority'
    )
  };

  const consoleMap = expectMap(raw, 'admin_console', 'app');
  const admin_console: AppAdminConsoleConfig = {
    role: expectString(consoleMap, 'role', 'admin_console'),
    preserve_ui: expectBool(consoleMap, 'preserve_ui', 'admin_console')
  };
  // v0.6.5: the three preserve_*_tab flags are required for internal apps
  // (so the W3 Forge UI cannot be silently dropped via YAML) but optional
  // for external-readonly satellite apps which do not render W3 Forge's
  // tabs at all.
  if (isExternalReadonly) {
    if (typeof consoleMap.preserve_github_validation_tab === 'boolean') {
      admin_console.preserve_github_validation_tab = consoleMap.preserve_github_validation_tab;
    }
    if (typeof consoleMap.preserve_controls_tab === 'boolean') {
      admin_console.preserve_controls_tab = consoleMap.preserve_controls_tab;
    }
    if (typeof consoleMap.preserve_file_browser_tab === 'boolean') {
      admin_console.preserve_file_browser_tab = consoleMap.preserve_file_browser_tab;
    }
  } else {
    admin_console.preserve_github_validation_tab = expectBool(
      consoleMap,
      'preserve_github_validation_tab',
      'admin_console'
    );
    admin_console.preserve_controls_tab = expectBool(
      consoleMap,
      'preserve_controls_tab',
      'admin_console'
    );
    admin_console.preserve_file_browser_tab = expectBool(
      consoleMap,
      'preserve_file_browser_tab',
      'admin_console'
    );
  }

  // v0.6.5: External-readonly apps must NEVER carry write/exec authority
  // through the registry. The integration block does not grant any new
  // authority; this guard prevents a misconfigured satellite YAML from
  // sneaking deploy/package/tag-release authority into the snapshot.
  if (isExternalReadonly) {
    if (authority.may_deploy === true) {
      throw new AppError(
        500,
        'app_config_invalid',
        'external-readonly app may not set authority.may_deploy = true'
      );
    }
    if (authority.may_package === true) {
      throw new AppError(
        500,
        'app_config_invalid',
        'external-readonly app may not set authority.may_package = true'
      );
    }
    if (authority.may_tag_release === true) {
      throw new AppError(
        500,
        'app_config_invalid',
        'external-readonly app may not set authority.may_tag_release = true'
      );
    }
    if (authority.may_modify_production_data === true) {
      throw new AppError(
        500,
        'app_config_invalid',
        'external-readonly app may not set authority.may_modify_production_data = true'
      );
    }
  }

  const controlsMap = expectMap(raw, 'controls', 'app');
  const controls: AppControlsConfig = {
    mode: expectString(controlsMap, 'mode', 'controls'),
    registry_migration_status: expectString(controlsMap, 'registry_migration_status', 'controls')
  };
  // v0.6.2 additive optional fields. Reading defensively keeps older YAMLs valid.
  if (typeof controlsMap.app_id === 'string' && controlsMap.app_id.trim() !== '') {
    controls.app_id = controlsMap.app_id.trim();
  }
  if (typeof controlsMap.allow_legacy_w3forge_controls === 'boolean') {
    controls.allow_legacy_w3forge_controls = controlsMap.allow_legacy_w3forge_controls;
  }

  // v0.6.3 additive optional file_browser section. Absent in older YAMLs;
  // when present, mode and registry_migration_status must be non-empty
  // strings. allowed_roots and the boolean flag remain optional.
  let file_browser: AppFileBrowserConfig | undefined;
  const fbRaw = (raw as Record<string, unknown>).file_browser;
  if (fbRaw !== undefined) {
    if (!isPlainObject(fbRaw)) {
      throw new AppError(500, 'app_config_invalid', 'app.file_browser must be a mapping');
    }
    file_browser = {
      mode: expectString(fbRaw, 'mode', 'file_browser'),
      registry_migration_status: expectString(
        fbRaw,
        'registry_migration_status',
        'file_browser'
      )
    };
    if (typeof fbRaw.app_id === 'string' && fbRaw.app_id.trim() !== '') {
      file_browser.app_id = fbRaw.app_id.trim();
    }
    if (typeof fbRaw.allow_host_local_roots === 'boolean') {
      file_browser.allow_host_local_roots = fbRaw.allow_host_local_roots;
    }
    if (Array.isArray(fbRaw.allowed_roots)) {
      if (fbRaw.allowed_roots.some((x) => typeof x !== 'string')) {
        throw new AppError(
          500,
          'app_config_invalid',
          'file_browser.allowed_roots must be a list of strings'
        );
      }
      file_browser.allowed_roots = (fbRaw.allowed_roots as string[]).map((s) => s.trim());
    }
  }

  // v0.6.4 additive optional github_workflow section. Absent in older YAMLs;
  // when present, mode and registry_migration_status must be non-empty
  // strings. The three boolean flags remain optional.
  let github_workflow: AppGitHubWorkflowConfig | undefined;
  const gwRaw = (raw as Record<string, unknown>).github_workflow;
  if (gwRaw !== undefined) {
    if (!isPlainObject(gwRaw)) {
      throw new AppError(500, 'app_config_invalid', 'app.github_workflow must be a mapping');
    }
    github_workflow = {
      mode: expectString(gwRaw, 'mode', 'github_workflow'),
      registry_migration_status: expectString(
        gwRaw,
        'registry_migration_status',
        'github_workflow'
      )
    };
    if (typeof gwRaw.app_id === 'string' && gwRaw.app_id.trim() !== '') {
      github_workflow.app_id = gwRaw.app_id.trim();
    }
    if (typeof gwRaw.allow_release_pipeline === 'boolean') {
      github_workflow.allow_release_pipeline = gwRaw.allow_release_pipeline;
    }
    if (typeof gwRaw.enforce_main_protection === 'boolean') {
      github_workflow.enforce_main_protection = gwRaw.enforce_main_protection;
    }
    if (typeof gwRaw.enforce_release_gate === 'boolean') {
      github_workflow.enforce_release_gate = gwRaw.enforce_release_gate;
    }
  }

  // v0.6.8 additive optional capabilities section. Absent in older YAMLs.
  // The validator KNOWS eight core namespaces and validates their
  // structure; UNKNOWN namespaces under `capabilities:` are preserved
  // verbatim into `extra_namespaces` for forward compatibility, and
  // UNKNOWN keys inside the known namespaces are preserved verbatim
  // into each namespace's `extras` map.
  let capabilities: AppCapabilitiesConfig | undefined;
  const capRaw = (raw as Record<string, unknown>).capabilities;
  if (capRaw !== undefined) {
    if (!isPlainObject(capRaw)) {
      throw new AppError(500, 'app_config_invalid', 'app.capabilities must be a mapping');
    }
    capabilities = validateCapabilitiesBlock(capRaw, isExternalReadonly);
  }

  return {
    app_id: appId,
    name,
    version,
    repo,
    paths,
    service,
    authority,
    admin_console,
    controls,
    file_browser,
    github_workflow,
    integration,
    capabilities
  };
}

// ---- v0.6.8 capabilities validator -----------------------------------------
//
// Forward-compatible: tolerates unknown nested namespaces/keys while still
// validating the known core capability structure. Unknown top-level
// namespaces under `capabilities:` are preserved verbatim into
// `extra_namespaces`; unknown keys inside a known namespace are preserved
// verbatim into that namespace's `extras` map.

const KNOWN_CAPABILITY_NAMESPACES = new Set<string>([
  'database',
  'controls',
  'github_validation',
  'file_browser',
  'logs',
  'health_monitoring',
  'deployment',
  'cooperative_development'
]);

const KNOWN_DATABASE_KEYS = new Set<string>([
  'enabled',
  'type',
  'readonly',
  'health_check'
]);

const KNOWN_TOGGLE_KEYS = new Set<string>(['enabled']);

function validateCapabilityToggle(
  raw: Record<string, unknown>,
  ctx: string
): AppCapabilityToggle {
  if (typeof raw.enabled !== 'boolean') {
    throw new AppError(500, 'app_config_invalid', `${ctx}.enabled must be true or false`);
  }
  const out: AppCapabilityToggle = { enabled: raw.enabled };
  const extras: Record<string, unknown> = {};
  for (const key of Object.keys(raw)) {
    if (!KNOWN_TOGGLE_KEYS.has(key)) extras[key] = raw[key];
  }
  if (Object.keys(extras).length > 0) out.extras = extras;
  return out;
}

function validateCapabilityDatabase(
  raw: Record<string, unknown>,
  ctx: string
): AppCapabilityDatabase {
  if (typeof raw.enabled !== 'boolean') {
    throw new AppError(500, 'app_config_invalid', `${ctx}.enabled must be true or false`);
  }
  // type may be the string 'postgres'/'sqlite' or YAML null. When the
  // database is disabled, null is the canonical value.
  let dbType: AppCapabilityDatabaseType;
  const t = raw.type;
  if (t === null || t === undefined) {
    dbType = null;
  } else if (typeof t === 'string') {
    const trimmed = t.trim();
    if (trimmed === 'postgres' || trimmed === 'sqlite') {
      dbType = trimmed;
    } else if (trimmed === '' || trimmed === 'null') {
      dbType = null;
    } else {
      throw new AppError(
        500,
        'app_config_invalid',
        `${ctx}.type must be one of: postgres, sqlite, null (got "${trimmed}")`
      );
    }
  } else {
    throw new AppError(
      500,
      'app_config_invalid',
      `${ctx}.type must be one of: postgres, sqlite, null`
    );
  }
  // readonly and health_check are required booleans for a well-formed
  // database namespace. When the block is absent entirely, the accessor
  // layer fills in safe defaults; once the block IS present, structure
  // is validated.
  if (typeof raw.readonly !== 'boolean') {
    throw new AppError(500, 'app_config_invalid', `${ctx}.readonly must be true or false`);
  }
  if (typeof raw.health_check !== 'boolean') {
    throw new AppError(500, 'app_config_invalid', `${ctx}.health_check must be true or false`);
  }
  // Defense in depth: enabled=false should not pin a real DB type.
  if (raw.enabled === false && dbType !== null) {
    throw new AppError(
      500,
      'app_config_invalid',
      `${ctx}.enabled=false requires ${ctx}.type=null (got "${dbType}")`
    );
  }
  const out: AppCapabilityDatabase = {
    enabled: raw.enabled,
    type: dbType,
    readonly: raw.readonly,
    health_check: raw.health_check
  };
  const extras: Record<string, unknown> = {};
  for (const key of Object.keys(raw)) {
    if (!KNOWN_DATABASE_KEYS.has(key)) extras[key] = raw[key];
  }
  if (Object.keys(extras).length > 0) out.extras = extras;
  return out;
}

function validateCapabilitiesBlock(
  raw: Record<string, unknown>,
  isExternalReadonly: boolean
): AppCapabilitiesConfig {
  const out: AppCapabilitiesConfig = {};
  const extraNamespaces: Record<string, unknown> = {};

  for (const key of Object.keys(raw)) {
    const value = raw[key];
    if (!KNOWN_CAPABILITY_NAMESPACES.has(key)) {
      // Forward-compatible: preserve unknown namespaces verbatim. Older
      // releases must remain able to LOAD newer YAMLs even if they don't
      // understand new namespaces.
      extraNamespaces[key] = value;
      continue;
    }
    if (!isPlainObject(value)) {
      throw new AppError(
        500,
        'app_config_invalid',
        `capabilities.${key} must be a mapping`
      );
    }
    const ctx = `capabilities.${key}`;
    if (key === 'database') {
      out.database = validateCapabilityDatabase(value, ctx);
    } else {
      // All other known namespaces are simple {enabled: boolean} toggles
      // with a forward-compatible extras bucket.
      const toggle = validateCapabilityToggle(value, ctx);
      switch (key) {
        case 'controls':
          out.controls = toggle;
          break;
        case 'github_validation':
          out.github_validation = toggle;
          break;
        case 'file_browser':
          out.file_browser = toggle;
          break;
        case 'logs':
          out.logs = toggle;
          break;
        case 'health_monitoring':
          out.health_monitoring = toggle;
          break;
        case 'deployment':
          out.deployment = toggle;
          break;
        case 'cooperative_development':
          out.cooperative_development = toggle;
          break;
        default:
          // Should be unreachable given KNOWN_CAPABILITY_NAMESPACES.
          extraNamespaces[key] = value;
      }
    }
  }

  if (Object.keys(extraNamespaces).length > 0) {
    out.extra_namespaces = extraNamespaces;
  }

  // Authority guard: external-readonly apps may not advertise deployment
  // capability through this block. The capability layer is descriptive
  // only and can never elevate authority above the existing authority
  // block.
  if (isExternalReadonly && out.deployment && out.deployment.enabled === true) {
    throw new AppError(
      500,
      'app_config_invalid',
      'external-readonly app may not set capabilities.deployment.enabled = true'
    );
  }

  return out;
}

// ---- Loader ----------------------------------------------------------------

export interface LoadOptions {
  configDir?: string;
  /** Security decisions must validate current files, never a cached positive. */
  fresh?: boolean;
}

interface CacheEntry {
  configDir: string;
  loadedAt: number;
  apps: AppRegistryEntry[];
}

let cache: CacheEntry | null = null;

function isYamlFile(name: string): boolean {
  return name.endsWith('.yml') || name.endsWith('.yaml');
}

function loadOne(filePath: string): AppRegistryEntry {
  let text: string;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new AppError(
      500,
      'app_config_read_failed',
      `cannot read ${filePath}: ${(err as Error).message}`
    );
  }
  let parsed: YamlValue;
  try {
    parsed = parseSimpleYaml(text);
  } catch (err) {
    if (err instanceof YamlParseError) {
      throw new AppError(500, 'app_config_invalid', `${filePath}: ${err.message}`);
    }
    throw err;
  }
  const cfg = validateAppConfig(parsed, filePath);
  return {
    app_id: cfg.app_id,
    name: cfg.name,
    version: cfg.version,
    source_file: filePath,
    config: cfg
  };
}

export function loadAppRegistry(opts: LoadOptions = {}): AppRegistryEntry[] {
  const dir = opts.configDir ?? defaultConfigDir();
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch (err) {
    throw new AppError(
      500,
      'app_config_dir_missing',
      `app config directory not found: ${dir} (${(err as Error).message})`
    );
  }
  const yamlFiles = entries.filter(isYamlFile).sort();
  const apps: AppRegistryEntry[] = [];
  const seen = new Set<string>();
  for (const f of yamlFiles) {
    const entry = loadOne(path.join(dir, f));
    if (seen.has(entry.app_id)) {
      throw new AppError(
        500,
        'app_config_invalid',
        `duplicate app_id "${entry.app_id}" in ${dir}`
      );
    }
    seen.add(entry.app_id);
    apps.push(entry);
  }
  cache = { configDir: dir, loadedAt: Date.now(), apps };
  return apps;
}

export function getAppConfig(appId: string, opts: LoadOptions = {}): AppConfig {
  if (typeof appId !== 'string' || !APP_ID_REGEX.test(appId)) {
    throw new AppError(400, 'app_id_invalid', `invalid app id: "${appId}"`);
  }
  // Validate the requested app independently. Legacy engineering targets in
  // the same catalog must not disable a valid local console, and a previous
  // cached grant must not survive an operator configuration change.
  const dir = opts.configDir ?? defaultConfigDir();
  const candidates = ['.yml', '.yaml'].map(extension => path.join(dir, appId + extension))
    .filter(filename => fs.existsSync(filename));
  if (candidates.length === 0) throw new AppError(404, 'app_not_found', 'unknown app id: ' + appId);
  if (candidates.length !== 1) throw new AppError(500, 'app_config_invalid', 'duplicate config files for app: ' + appId);
  const entry = loadOne(candidates[0]);
  if (entry.app_id !== appId) throw new AppError(500, 'app_config_invalid', 'configuration identity does not match requested app: ' + appId);
  return entry.config;
}

export function getActiveAppConfig(opts: LoadOptions = {}): AppConfig {
  const id = (process.env.W3_ACTIVE_APP_ID || process.env.W3_FORGE_ACTIVE_APP)?.trim() || DEFAULT_ACTIVE_APP_ID;
  return getAppConfig(id, opts);
}

export function getRegistrySnapshot(opts: LoadOptions = {}): AppRegistrySnapshot {
  const errors: string[] = [];
  const warnings: string[] = [];
  let apps: AppRegistryEntry[] = [];
  try {
    apps = ensureLoaded(opts);
  } catch (err) {
    // Catalog diagnostics retain valid entries without treating an unrelated
    // legacy target as valid or weakening its schema.
    const dir = opts.configDir ?? defaultConfigDir();
    try {
      const seen = new Set<string>();
      for (const filename of fs.readdirSync(dir).filter(isYamlFile).sort()) {
        try {
          const entry = loadOne(path.join(dir, filename));
          if (seen.has(entry.app_id)) throw new AppError(500, 'app_config_invalid', 'duplicate app id: ' + entry.app_id);
          seen.add(entry.app_id);
          apps.push(entry);
        } catch (error) {
          errors.push(filename + ': ' + (error instanceof Error ? error.message : 'invalid app configuration'));
        }
      }
    } catch {
      errors.push(err instanceof Error ? err.message : 'app registry cannot be read');
    }
  }
  const activeId = (process.env.W3_ACTIVE_APP_ID || process.env.W3_FORGE_ACTIVE_APP)?.trim() || DEFAULT_ACTIVE_APP_ID;
  if (apps.length > 0 && !apps.some((a) => a.app_id === activeId)) {
    errors.push(`active app "${activeId}" not present in registry`);
  }
  for (const a of apps) {
    if (!a.config.admin_console.preserve_ui) {
      warnings.push(
        `${a.app_id}: admin_console.preserve_ui=false — v0.6.0 requires the W3 Forge UI to remain visually unchanged`
      );
    }
  }
  return {
    active_app_id: activeId,
    apps,
    validation: { ok: errors.length === 0, errors, warnings }
  };
}

// Test/CLI hook — drops the in-memory cache so the next call re-reads disk.
export function resetAppRegistryCache(): void {
  cache = null;
}

function ensureLoaded(opts: LoadOptions): AppRegistryEntry[] {
  const dir = opts.configDir ?? defaultConfigDir();
  if (!opts.fresh && cache && cache.configDir === dir) return cache.apps;
  return loadAppRegistry({ configDir: dir });
}
