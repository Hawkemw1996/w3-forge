// =============================================================================
// W3 Forge config loader.
// =============================================================================
//
// Loads ${W3_FORGE_ROOT}/config/apps/<app_id>.yml. Every path the admin
// surface touches is derived from this file. Replaces W3 Core's hardcoded
// `/opt/w3core/...` constants.

import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { AdminError } from './envelope';

export const APP_ID_REGEX = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const FORGE_ROOT = (process.env.W3_FORGE_ROOT ?? '/opt/w3forge-deploy').trim();
export const ACTIVE_APP = (process.env.W3_FORGE_ACTIVE_APP ?? 'w3forge').trim();

export interface AdminConsoleConfig {
  enabled: boolean;
  listen_host: string;
  listen_port: number;
  audit_log: string;
  allowed_scripts: string[];
}

export interface ForgeAppConfig {
  app_id: string;
  name: string;
  version: string;
  repo: {
    url?: string;
    default_dev_branch?: string;
    allowed_branch_pattern: string;
    blocked_branches?: string[];
  };
  paths: {
    deploy: string;
    runtime: string;
    workspaces: string;
    scripts: string;
    logs: string;
    backups: string;
  };
  authority: {
    may_deploy: boolean;
    may_tag_release: boolean;
    may_modify_production_data: boolean;
    [k: string]: unknown;
  };
  tests?: {
    validate_config?: boolean;
    require_local_model?: boolean;
    commands?: string[];
  };
  admin_console?: AdminConsoleConfig;
}

const cache = new Map<string, ForgeAppConfig>();

export function appConfigPath(appId: string): string {
  return path.join(FORGE_ROOT, 'config', 'apps', `${appId}.yml`);
}

export function loadApp(appId: string): ForgeAppConfig {
  if (!APP_ID_REGEX.test(appId)) {
    throw new AdminError(400, 'INVALID_APP_ID', `Invalid app id: ${appId}`);
  }
  const cached = cache.get(appId);
  if (cached) return cached;

  const p = appConfigPath(appId);
  if (!fs.existsSync(p)) {
    throw new AdminError(404, 'APP_NOT_FOUND', `App config not found: ${p}`);
  }
  let raw: string;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch (e) {
    throw new AdminError(500, 'CONFIG_READ_FAILED', (e as Error).message);
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (e) {
    throw new AdminError(500, 'CONFIG_PARSE_FAILED', (e as Error).message);
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new AdminError(500, 'CONFIG_INVALID', `Config is not a YAML object: ${p}`);
  }
  const cfg = parsed as ForgeAppConfig;
  // Minimal shape check — the bash validator is the source of truth, this is
  // just a guardrail for the TS layer.
  if (!cfg.app_id || !cfg.paths) {
    throw new AdminError(500, 'CONFIG_INCOMPLETE', `Config missing required keys: ${p}`);
  }
  cache.set(appId, cfg);
  return cfg;
}

export function clearConfigCache(): void {
  cache.clear();
}

export function resolveAuditPath(cfg: ForgeAppConfig): string {
  const p = cfg.admin_console?.audit_log ?? 'logs/admin/audit.jsonl';
  return path.isAbsolute(p) ? p : path.join(FORGE_ROOT, p);
}

// Resolve a forge-relative path against FORGE_ROOT for the read-only file
// browser. Refuses anything that escapes FORGE_ROOT after realpath.
export function resolveUnderForgeRoot(relative: string): string {
  const candidate = path.resolve(FORGE_ROOT, relative);
  const realRoot = fs.realpathSync(FORGE_ROOT);
  let realCandidate = candidate;
  try {
    realCandidate = fs.realpathSync(candidate);
  } catch {
    // Path may not exist yet; fall back to the lexical resolution.
  }
  if (realCandidate !== realRoot && !realCandidate.startsWith(realRoot + path.sep)) {
    throw new AdminError(403, 'PATH_ESCAPE', `Path escapes forge root: ${relative}`);
  }
  return realCandidate;
}
