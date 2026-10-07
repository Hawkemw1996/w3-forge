import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import {
  UPDATE_PACKAGES_DIR,
  UPDATE_PACKAGES_INSTALLED_DIR,
  UPDATE_PACKAGES_DEV_DIR,
  UPDATE_PACKAGES_MAIN_DIR,
  parsePackageVersion,
  parseVersionDir,
  channelRoot,
  canonicalPackagePath,
  installedVersionDir,
  PACKAGE_NAME_REGEX,
  LEGACY_PACKAGE_NAME_REGEX,
  CANONICAL_PACKAGE_NAME_REGEX,
  CANONICAL_PACKAGE_FILENAME,
  ReleaseChannel
} from '../paths';

// =============================================================================
// /api/admin/packages/* — read-only listing of W3 Forge release tarballs.
// =============================================================================
//
// v0.5.38 canonical layout:
//   /opt/w3forge-update-packages/dev/<vX.Y.Z>/w3forge.tar.gz       (dev channel)
//   /opt/w3forge-update-packages/main/<vX.Y.Z>/w3forge.tar.gz      (main channel)
//   /opt/w3forge-update-packages/installed/<vX.Y.Z>/w3forge.tar.gz (installed channel)
//     + sidecars: deployed-at.txt, source.txt, request-id.txt,
//                 log-path.txt, sha256.txt
//
// Legacy layouts still surfaced during transition:
//   /opt/w3forge-update-packages/w3forge-vX.Y.Z.tar.gz             (flat staged)
//   /opt/w3forge-update-packages/installed/w3forge-vX.Y.Z.tar.gz   (flat installed)
//
// Existing endpoints (staged, staged-dev, installed) remain backward compatible
// and now return BOTH canonical and legacy entries. New v0.5.38 endpoints:
//   GET /packages/staged-main           (canonical main channel)
//   GET /packages/installed-versions    (list installed canonical version dirs)
//   GET /packages/installed/:version    (sidecar metadata for one installed v)
//
// Read-only. These routes never move, rename, or modify any file.

interface PackageEntry {
  name: string;
  path: string;
  sizeBytes: number;
  mtime: string;
  validName: boolean;
  parsedVersion: string | null;
  // v0.5.38: where the package was discovered.
  layout: 'canonical' | 'legacy-flat';
  channel: ReleaseChannel | 'staged-legacy';
}

interface InstalledVersionSummary {
  version: string;            // X.Y.Z (no leading v)
  dir: string;                // absolute install dir path
  packagePath: string | null; // canonical w3forge.tar.gz path if present
  deployedAt: string | null;
  source: string | null;
  requestId: string | null;
  logPath: string | null;
  sha256: string | null;
}

async function safeRead(file: string): Promise<string | null> {
  try {
    if (!(await fs.lstat(file)).isFile()) return null;
    const handle = await fs.open(file, 'r');
    try {
      const buffer = Buffer.alloc(4096);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      return buffer.subarray(0, bytesRead).toString('utf8').replace(/\s+$/u, '').slice(0, 1024);
    } finally { await handle.close(); }
  } catch {
    return null;
  }
}

async function statPackage(
  full: string,
  name: string,
  layout: PackageEntry['layout'],
  channel: PackageEntry['channel'],
  versionFromDir: string | null
): Promise<PackageEntry | null> {
  try {
    const stat = await fs.lstat(full);
    if (!stat.isFile()) return null;
    const parsedVersion =
      layout === 'canonical' ? versionFromDir : parsePackageVersion(name);
    return {
      name,
      path: full,
      sizeBytes: stat.size,
      mtime: stat.mtime.toISOString(),
      validName: PACKAGE_NAME_REGEX.test(name),
      parsedVersion,
      layout,
      channel
    };
  } catch {
    return null;
  }
}

// List canonical packages under <channelRoot>/<vX.Y.Z>/w3forge.tar.gz.
async function listCanonicalChannel(
  channel: ReleaseChannel
): Promise<PackageEntry[]> {
  const root = channelRoot(channel);
  const out: PackageEntry[] = [];
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const dirent of entries) {
    if (!dirent.isDirectory()) continue;
    const version = parseVersionDir(dirent.name);
    if (!version) continue;
    const archive = path.join(root, dirent.name, CANONICAL_PACKAGE_FILENAME);
    const entry = await statPackage(
      archive,
      CANONICAL_PACKAGE_FILENAME,
      'canonical',
      channel,
      version
    );
    if (entry) out.push(entry);
  }
  return out;
}

// List legacy flat packages directly under a directory (no recursion).
async function listLegacyFlat(
  dir: string,
  channel: PackageEntry['channel']
): Promise<PackageEntry[]> {
  const out: PackageEntry[] = [];
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const dirent of entries) {
    if (!dirent.isFile()) continue;
    if (!dirent.name.startsWith('w3forge-') || !dirent.name.endsWith('.tar.gz')) continue;
    // Skip the canonical name in the flat root — only legacy versioned names
    // belong here. The canonical layout lives in <root>/<v>/.
    if (CANONICAL_PACKAGE_NAME_REGEX.test(dirent.name)) continue;
    if (!LEGACY_PACKAGE_NAME_REGEX.test(dirent.name)) {
      // Surface even non-conforming names (validName=false), as before.
    }
    const full = path.join(dir, dirent.name);
    const entry = await statPackage(full, dirent.name, 'legacy-flat', channel, null);
    if (entry) out.push(entry);
  }
  return out;
}

function sortByMtimeDesc(list: PackageEntry[]): PackageEntry[] {
  list.sort((a, b) => Date.parse(b.mtime) - Date.parse(a.mtime));
  return list;
}

async function readInstalledVersion(
  version: string
): Promise<InstalledVersionSummary | null> {
  const dir = installedVersionDir(version);
  try {
    const st = await fs.lstat(dir);
    if (!st.isDirectory()) return null;
  } catch {
    return null;
  }
  const archive = path.join(dir, CANONICAL_PACKAGE_FILENAME);
  let packagePath: string | null = null;
  try {
    const st = await fs.lstat(archive);
    if (st.isFile()) packagePath = archive;
  } catch {
    /* canonical archive missing — still report sidecars */
  }
  const [deployedAt, source, requestId, logPath, sha256] = await Promise.all([
    safeRead(path.join(dir, 'deployed-at.txt')),
    safeRead(path.join(dir, 'source.txt')),
    safeRead(path.join(dir, 'request-id.txt')),
    safeRead(path.join(dir, 'log-path.txt')),
    safeRead(path.join(dir, 'sha256.txt'))
  ]);
  return {
    version,
    dir,
    packagePath,
    deployedAt,
    source,
    requestId,
    logPath,
    sha256
  };
}

async function listInstalledVersions(): Promise<InstalledVersionSummary[]> {
  const out: InstalledVersionSummary[] = [];
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(UPDATE_PACKAGES_INSTALLED_DIR, {
      withFileTypes: true
    });
  } catch {
    return out;
  }
  for (const dirent of entries) {
    if (!dirent.isDirectory()) continue;
    const version = parseVersionDir(dirent.name);
    if (!version) continue;
    const summary = await readInstalledVersion(version);
    if (summary) out.push(summary);
  }
  // Sort by version desc (numeric, semver-ish).
  out.sort((a, b) => {
    const [aM, am, ap] = a.version.split('.').map((n) => parseInt(n, 10));
    const [bM, bm, bp] = b.version.split('.').map((n) => parseInt(n, 10));
    return bM - aM || bm - am || bp - ap;
  });
  return out;
}

export function buildAdminPackagesRoutes(): Router {
  const router = Router();

  // Legacy + transitional: surfaces flat-staged packages directly under
  // /opt/w3forge-update-packages/. Pre-v0.5.38 this was the only staging area; the
  // canonical dev/main channels each have their own dedicated routes below.
  router.get('/packages/staged', async (_req, res, next) => {
    try {
      const legacy = await listLegacyFlat(UPDATE_PACKAGES_DIR, 'staged-legacy');
      res.json({
        success: true,
        data: {
          root: UPDATE_PACKAGES_DIR,
          namingStandard: 'w3forge-vX.Y.Z.tar.gz (legacy) or <vX.Y.Z>/w3forge.tar.gz (canonical)',
          packages: sortByMtimeDesc(legacy)
        }
      });
    } catch (err) {
      next(err);
    }
  });

  // v0.5.32+: dev channel listing. v0.5.38 returns BOTH canonical
  // <v>/w3forge.tar.gz AND any legacy w3forge-vX.Y.Z.tar.gz files that may
  // still sit at the root of /opt/w3forge-update-packages/dev/ during transition.
  router.get('/packages/staged-dev', async (_req, res, next) => {
    try {
      const canonical = await listCanonicalChannel('dev');
      const legacy = await listLegacyFlat(UPDATE_PACKAGES_DEV_DIR, 'dev');
      res.json({
        success: true,
        data: {
          root: UPDATE_PACKAGES_DEV_DIR,
          namingStandard: '<vX.Y.Z>/w3forge.tar.gz (canonical) or legacy w3forge-vX.Y.Z.tar.gz',
          packages: sortByMtimeDesc([...canonical, ...legacy])
        }
      });
    } catch (err) {
      next(err);
    }
  });

  // v0.5.38: main channel listing (canonical only — main has no legacy flat
  // history because it is a new directory).
  router.get('/packages/staged-main', async (_req, res, next) => {
    try {
      const canonical = await listCanonicalChannel('main');
      const legacy = await listLegacyFlat(UPDATE_PACKAGES_MAIN_DIR, 'main');
      res.json({
        success: true,
        data: {
          root: UPDATE_PACKAGES_MAIN_DIR,
          namingStandard: '<vX.Y.Z>/w3forge.tar.gz (canonical)',
          packages: sortByMtimeDesc([...canonical, ...legacy])
        }
      });
    } catch (err) {
      next(err);
    }
  });

  // Installed packages. v0.5.38 returns BOTH the canonical layered layout
  // (<v>/w3forge.tar.gz) AND any pre-v0.5.38 flat archives.
  router.get('/packages/installed', async (_req, res, next) => {
    try {
      const canonical = await listCanonicalChannel('installed');
      const legacy = await listLegacyFlat(
        UPDATE_PACKAGES_INSTALLED_DIR,
        'installed'
      );
      res.json({
        success: true,
        data: {
          root: UPDATE_PACKAGES_INSTALLED_DIR,
          namingStandard: '<vX.Y.Z>/w3forge.tar.gz (canonical) or legacy w3forge-vX.Y.Z.tar.gz',
          packages: sortByMtimeDesc([...canonical, ...legacy])
        }
      });
    } catch (err) {
      next(err);
    }
  });

  // v0.5.38: installed-version summaries (one entry per canonical v* dir),
  // surfacing the sidecar metadata written by deploy on success.
  router.get('/packages/installed-versions', async (_req, res, next) => {
    try {
      const versions = await listInstalledVersions();
      res.json({
        success: true,
        data: {
          root: UPDATE_PACKAGES_INSTALLED_DIR,
          versions
        }
      });
    } catch (err) {
      next(err);
    }
  });

  // v0.5.38: read a single installed version's sidecars. The :version path
  // segment is validated against vX.Y.Z (vX.Y.Z or X.Y.Z accepted) to keep
  // the route from being driven into arbitrary fs paths.
  router.get('/packages/installed/:version', async (req, res, next) => {
    try {
      const raw = String(req.params.version || '').trim();
      const v = raw.startsWith('v') ? raw.slice(1) : raw;
      if (!/^\d+\.\d+\.\d+$/.test(v)) {
        return res.status(400).json({
          success: false,
          error: 'invalid version (expected X.Y.Z)'
        });
      }
      const summary = await readInstalledVersion(v);
      if (!summary) {
        return res.status(404).json({
          success: false,
          error: `no installed metadata for v${v}`
        });
      }
      return res.json({
        success: true,
        data: {
          ...summary,
          canonicalArchive: canonicalPackagePath('installed', v)
        }
      });
    } catch (err) {
      return next(err);
    }
  });

  return router;
}
