// =============================================================================
// Centralized path configuration for the read-only Admin Console.
// =============================================================================
//
// All admin endpoints derive directory and file roots from this module. Each
// constant has a clear single-line meaning and a matching ENV override so the
// W3 Forge LXC's actual paths can be confirmed without code changes.
//
// v0.6.1 migration: the hardcoded fallback string for each W3 Forge path
// is now sourced from `config/apps/w3forge.yml` via the v0.6.0 app registry,
// using a single shared accessor in `appConfigAccessors`. The ENV-override
// precedence is unchanged; the hardcoded constants here keep their exact
// shape and exported names so every existing importer continues to work.
//
// Precedence (left wins):
//   1. ENV override                  (e.g. W3_DEPLOY_DIR, W3_BACKUPS_DIR)
//   2. App config YAML               (config/apps/w3forge.yml -> paths.*)
//   3. Legacy hardcoded fallback     (matches the pre-v0.6.1 defaults exactly)
//
// Defaults match the v0.4.x operating model documented in README.md:
//
//   - /opt/w3forge/                  runtime
//   - /opt/w3forge-deploy/           Git checkout
//   - /opt/w3forge-update-packages/         staging root
//   - /opt/w3forge-update-packages/dev/<vX.Y.Z>/w3forge.tar.gz       dev channel (v0.5.32+)
//   - /opt/w3forge-update-packages/main/<vX.Y.Z>/w3forge.tar.gz      main channel (v0.5.38+)
//   - /opt/w3forge-update-packages/installed/<vX.Y.Z>/w3forge.tar.gz installed (v0.5.38+)
//     + sidecars: deployed-at.txt, source.txt, request-id.txt, log-path.txt, sha256.txt
//   - /opt/backups/w3forge/                 nightly app+db backup pairs
//   - /opt/logs/w3forge/             standardized log roots, by category

import path from 'node:path';
import {
  getRuntimePath,
  getDeployPath,
  getScriptsPath,
  getLogsPath,
  getBackupsPath,
  getUpdatePackagesPath,
  getInstalledPackagesPath
} from './appConfigAccessors';

// v0.6.1: every path constant is computed once at module load via the
// shared accessor, which already applies ENV-override precedence over the
// app config YAML and a legacy hardcoded fallback. This file no longer
// needs its own `fromEnv(...)` helper; keeping the constants exported
// preserves all existing import sites verbatim.
//
// Note: snapshotting at module load matches the pre-v0.6.1 behavior exactly.
// The accessor is also re-exported below for callers that need a fresh read.

export const APP_DIR = getRuntimePath();
export const DEPLOY_DIR = getDeployPath();
export const UPDATE_PACKAGES_DIR = getUpdatePackagesPath();
export const UPDATE_PACKAGES_INSTALLED_DIR = getInstalledPackagesPath();
// v0.5.32: dedicated dev staging area used by the GitHub / Releases pipeline.
// The pipeline wrappers (pipeline-package-dev-release-w3forge-ui.sh,
// pipeline-verify-dev-package-w3forge-ui.sh, pipeline-deploy-dev-package-w3forge-ui.sh)
// all read/write through this directory. ENV override must match the wrappers'
// W3_DEV_UPDATE_DIR setting so the UI shows exactly what the host produces.
export const UPDATE_PACKAGES_DEV_DIR = (() => {
  const v = (process.env.W3_DEV_UPDATE_DIR ?? '').trim();
  return v ? v : path.join(UPDATE_PACKAGES_DIR, 'dev');
})();
// v0.5.38: dedicated main channel directory mirroring the dev layout. Each
// promoted-but-not-yet-deployed release lives at main/<vX.Y.Z>/w3forge.tar.gz.
export const UPDATE_PACKAGES_MAIN_DIR = (() => {
  const v = (process.env.W3_MAIN_UPDATE_DIR ?? '').trim();
  return v ? v : path.join(UPDATE_PACKAGES_DIR, 'main');
})();
export const BACKUPS_DIR = getBackupsPath();
export const LOGS_ROOT = getLogsPath();
// CLEANUP_REVIEW_DIR is intentionally NOT in the app config registry — it is
// a host-local diagnostic staging directory, not part of the per-app contract.
export const CLEANUP_REVIEW_DIR = (() => {
  const v = (process.env.W3_CLEANUP_REVIEW_DIR ?? '').trim();
  return v ? v : '/opt/w3forge-cleanup-review';
})();
export const SCRIPTS_DIR = getScriptsPath();

// Paths that must NEVER be exposed through the read-only file browser.
// Used both by the file browser route and surfaced to the UI for visibility.
export const NEVER_EXPOSE: readonly string[] = [
  '/root',
  '/etc',
  '/var',
  '/opt',
  '/opt/w3forge/.env',
  '/opt/w3forge-deploy/.env',
  '/opt/w3forge/backend/.env',
  '/opt/w3forge/frontend/.env',
  '**/.env',
  'database credentials',
  'arbitrary filesystem paths'
];

// Canonical W3 Forge release tarball naming.
//
// v0.5.38 introduces a stable filename inside per-version directories:
//     <channel>/<vX.Y.Z>/w3forge.tar.gz       (canonical, v0.5.38+)
// The legacy versioned-filename pattern is still accepted to keep older
// packages and existing tests intact during the transition:
//     w3forge-vX.Y.Z.tar.gz                   (legacy, pre-v0.5.38)
//
// PACKAGE_NAME_REGEX matches BOTH forms. Use parsePackageVersion when the
// version must be derived from a filename in the legacy flat layout; in the
// canonical layered layout the version is encoded in the parent directory
// name (vX.Y.Z) and parsed by parseChannelVersionPath() instead.
export const LEGACY_PACKAGE_NAME_REGEX = /^w3forge-v(\d+)\.(\d+)\.(\d+)\.tar\.gz$/;
export const CANONICAL_PACKAGE_NAME_REGEX = /^w3forge\.tar\.gz$/;
export const PACKAGE_NAME_REGEX = /^(?:w3forge-v\d+\.\d+\.\d+\.tar\.gz|w3forge\.tar\.gz)$/;
export const VERSION_DIR_REGEX = /^v(\d+)\.(\d+)\.(\d+)$/;
export const CANONICAL_PACKAGE_FILENAME = 'w3forge.tar.gz';

export function parsePackageVersion(name: string): string | null {
  const m = LEGACY_PACKAGE_NAME_REGEX.exec(name);
  if (!m) return null;
  return `${m[1]}.${m[2]}.${m[3]}`;
}

export function parseVersionDir(dirName: string): string | null {
  const m = VERSION_DIR_REGEX.exec(dirName);
  if (!m) return null;
  return `${m[1]}.${m[2]}.${m[3]}`;
}

export type ReleaseChannel = 'dev' | 'main' | 'installed';

export function channelRoot(channel: ReleaseChannel): string {
  switch (channel) {
    case 'dev':
      return UPDATE_PACKAGES_DEV_DIR;
    case 'main':
      return UPDATE_PACKAGES_MAIN_DIR;
    case 'installed':
      return UPDATE_PACKAGES_INSTALLED_DIR;
  }
}

// Canonical version directory for a given channel + version. Does not check
// existence on disk; pure path construction.
export function channelVersionDir(channel: ReleaseChannel, version: string): string {
  const tag = version.startsWith('v') ? version : `v${version}`;
  return path.join(channelRoot(channel), tag);
}

// Canonical archive path: <channel>/<vX.Y.Z>/w3forge.tar.gz.
export function canonicalPackagePath(channel: ReleaseChannel, version: string): string {
  return path.join(channelVersionDir(channel, version), CANONICAL_PACKAGE_FILENAME);
}

// Convenience accessor used by status / installed-version readers.
export function installedVersionDir(version: string): string {
  return channelVersionDir('installed', version);
}

// v0.5.4: canonical version-aware backup naming.
//   w3forge-backup-vX.Y.Z-YYYYMMDD-HHMMSS.tar.gz   (preferred, going forward)
//   w3forge-vX.Y.Z-backup-YYYYMMDD-HHMMSS.tar.gz   (alternative acceptable)
//
// Legacy paired backups remain valid and are NOT renamed automatically:
//   w3forge_app_YYYY-MM-DD_HH-MM-SS.tar.gz
//   w3forge_db_YYYY-MM-DD_HH-MM-SS.sql
//
// parseBackupVersion returns the parsed X.Y.Z when one of the canonical
// version-aware patterns matches, otherwise null. Legacy paired backups
// have no embedded version and surface as 'Unknown' in the UI.
export const BACKUP_VERSIONED_REGEX_A =
  /^w3forge-backup-v(\d+)\.(\d+)\.(\d+)-(\d{8})-(\d{6})\.tar\.gz$/;
export const BACKUP_VERSIONED_REGEX_B =
  /^w3forge-v(\d+)\.(\d+)\.(\d+)-backup-(\d{8})-(\d{6})\.tar\.gz$/;

export function parseBackupVersion(name: string): string | null {
  const m = BACKUP_VERSIONED_REGEX_A.exec(name) ?? BACKUP_VERSIONED_REGEX_B.exec(name);
  if (!m) return null;
  return `${m[1]}.${m[2]}.${m[3]}`;
}
