import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import { NEVER_EXPOSE } from '../paths';
import {
  getAppFileBrowserRoot,
  getAppFileBrowserRoots,
  getAppFileBrowserRegistryMeta,
  type AppFileBrowserRoot
} from '../fileBrowser/appFileBrowserRegistry';

// =============================================================================
// /api/admin/files/* — READ-ONLY file browser.
// =============================================================================
//
// v0.5.4 expansion:
//
//   - Added approved roots: /opt/w3forge (app), /opt/w3forge-deploy (deploy),
//     /opt/w3forge-scripts (scripts).
//   - Expanded preview extensions: .yml, .yaml, .conf, .service, .env.example.
//   - /files/roots now returns file count + last-modified timestamp per root.
//   - .tar.gz / .tgz / .zip are explicitly NEVER previewable as text. They
//     show up in /files/list with metadata only and `previewable: false`.
//
// v0.6.3 migration:
//
//   - The legacy `ROOTS` table and `getRoot(id)` helper were replaced by
//     `getAppFileBrowserRoots()` / `getAppFileBrowserRoot(id)` in
//     `backend/src/admin/fileBrowser/appFileBrowserRegistry.ts`. Every root
//     id, label, description, and absolute path is preserved. Each root row
//     now additively carries `app_id` and `root_source`, and the top-level
//     /files/roots response additively carries `app_id`, `app_name`,
//     `registry_source`, `config_driven`, and `registry_migration_status`.
//   - `resolveInsideRoot()` is unchanged: traversal checks, realpath
//     enforcement, dotfile hiding, and absolute-path rejection all behave
//     exactly as they did pre-v0.6.3.
//
// Per v0.5.0 plan and v0.5.4 spec, these endpoints remain READ-ONLY:
//
//   - list approved roots
//   - list directories within those roots
//   - show file metadata (name, size, mtime, type, archive flag)
//   - safe text preview for an explicit allow-list of text extensions
//   - NO uploads, NO deletes, NO edits, NO renames, NO arbitrary path browsing
//
// Approved roots are a fixed allowlist defined below. Each request must
// reference a root by its short id; the server then resolves the path with
// fs.realpath and ENFORCES that the resolved path is a descendant of the
// resolved root path. Symlinks that escape the root are rejected. Hidden
// files starting with '.' are not enumerated to avoid accidentally leaking
// .env or other secret-like files even if one were placed inside an
// approved root.

// Files we will preview as plain UTF-8 text. Anything else is metadata-only.
const PREVIEW_EXT = new Set([
  '.md',
  '.txt',
  '.log',
  '.json',
  '.sh',
  '.sql',
  '.yml',
  '.yaml',
  '.conf',
  '.service'
]);

// Special-case filenames that should be previewable even though their
// extension is empty / not in PREVIEW_EXT (e.g. ".env.example" — the
// extension parses to ".example" which we don't want to allow blindly).
const PREVIEW_FILENAMES = new Set(['.env.example', 'env.example']);

// Files we will NEVER preview as text — archives and binary blobs. These
// remain visible in /files/list but with previewable=false and an explicit
// `archive: true` flag so the UI can show a metadata-only card.
const ARCHIVE_EXT = new Set(['.gz', '.tgz', '.zip', '.tar', '.bz2', '.xz']);
const ARCHIVE_DOUBLE_EXT = ['.tar.gz', '.tar.bz2', '.tar.xz']; // checked on full name

const PREVIEW_MAX_BYTES = 256 * 1024; // 256 KiB hard cap on preview size

// v0.6.3: `RootDef` is now sourced from the app-aware file browser registry.
// The route layer treats `AppFileBrowserRoot` as a `RootDef`-compatible
// structural type — every legacy field (id, path, label, description) is
// preserved verbatim. The two new fields (`app_id`, `root_source`) are
// additive and never consulted by the security checks below.
type RootDef = AppFileBrowserRoot;

function getRoot(id: unknown): RootDef | null {
  return getAppFileBrowserRoot(id);
}

/**
 * Detect whether a filename is an archive that must NEVER be previewed as text.
 * Handles both single-extension (.zip) and double-extension (.tar.gz) cases.
 */
function isArchiveName(name: string): boolean {
  const lower = name.toLowerCase();
  for (const dbl of ARCHIVE_DOUBLE_EXT) {
    if (lower.endsWith(dbl)) return true;
  }
  const ext = path.extname(lower);
  return ARCHIVE_EXT.has(ext);
}

/**
 * Decide if a file is safe to preview as UTF-8 text. Archives are always
 * blocked. Files in the explicit PREVIEW_FILENAMES allow-list pass even
 * without a matching extension.
 */
function isPreviewable(name: string): boolean {
  if (isArchiveName(name)) return false;
  if (PREVIEW_FILENAMES.has(name)) return true;
  if (PREVIEW_FILENAMES.has(name.toLowerCase())) return true;
  const ext = path.extname(name).toLowerCase();
  return PREVIEW_EXT.has(ext);
}

async function resolveInsideRoot(
  root: RootDef,
  relPath: string
): Promise<{ absolute: string; relative: string } | null> {
  // v0.6.3: the traversal / realpath contract is unchanged. All of the
  // following checks were present pre-v0.6.3 and remain byte-for-byte
  // identical. Only the `root` argument type was widened to include the
  // additive app-config fields (app_id, root_source).
  const cleanedRel = (relPath ?? '').replace(/^[/\\]+/, '');
  if (cleanedRel.includes('\0')) return null;
  if (/(^|[/\\])\.\.($|[/\\])/.test(cleanedRel)) return null;
  // Don't allow leading drive letters or windows-style separators that could
  // bypass posix-style traversal checks on the LXC.
  if (/\\/.test(cleanedRel)) return null;
  // Hidden segments (.git, .env, dotfiles in general) are not enumerable and
  // not readable via this endpoint, EXCEPT for the explicitly-allowed
  // PREVIEW_FILENAMES leaf at the very end of the path (e.g. .env.example).
  const segments = cleanedRel.split('/').filter(Boolean);
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (!seg.startsWith('.')) continue;
    // Allow the very last segment if it's a whitelisted preview filename.
    if (i === segments.length - 1 && PREVIEW_FILENAMES.has(seg)) continue;
    return null;
  }
  let rootReal: string;
  try {
    rootReal = await fs.realpath(root.path);
  } catch {
    // Root does not exist on disk — caller can decide how to surface that.
    return null;
  }
  const joined = path.resolve(rootReal, cleanedRel);
  let realJoined: string;
  try {
    realJoined = await fs.realpath(joined);
  } catch {
    // realpath fails for files that don't exist yet — but in read-only mode
    // we never create anything, so a non-existent path is just a 404.
    return null;
  }
  const rel = path.relative(rootReal, realJoined);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const resolvedSegments = rel.split(path.sep).filter(Boolean);
  if (resolvedSegments.some((segment, index) => segment.startsWith('.')
    && !(index === resolvedSegments.length - 1 && PREVIEW_FILENAMES.has(segment)))) return null;
  return { absolute: realJoined, relative: rel };
}

/**
 * Compute file count + most recent mtime inside a root. Shallow: walks the
 * top-level entries only. Used by /files/roots to populate the dashboard
 * "X files, last modified ..." chip without recursing into the entire tree.
 */
async function rootShallowStats(rootPath: string): Promise<{
  fileCount: number;
  lastModified: string | null;
}> {
  let entries: import('node:fs').Dirent[] = [];
  try {
    entries = await fs.readdir(rootPath, { withFileTypes: true });
  } catch {
    return { fileCount: 0, lastModified: null };
  }
  let fileCount = 0;
  let latestMs = 0;
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(rootPath, e.name);
    let s: import('node:fs').Stats;
    try {
      s = await fs.stat(full);
    } catch {
      continue;
    }
    if (e.isFile()) fileCount += 1;
    const ms = s.mtime.getTime();
    if (ms > latestMs) latestMs = ms;
  }
  return {
    fileCount,
    lastModified: latestMs > 0 ? new Date(latestMs).toISOString() : null
  };
}

export function buildAdminFilesRoutes(): Router {
  const router = Router();

  router.get('/files/roots', async (_req, res, next) => {
    try {
      const roots = getAppFileBrowserRoots();
      const meta = getAppFileBrowserRegistryMeta();
      const out = [];
      for (const r of roots) {
        let exists = false;
        try {
          const st = await fs.stat(r.path);
          exists = st.isDirectory();
        } catch {
          exists = false;
        }
        const stats = exists
          ? await rootShallowStats(r.path)
          : { fileCount: 0, lastModified: null };
        out.push({
          id: r.id,
          path: r.path,
          label: r.label,
          description: r.description,
          exists,
          fileCount: stats.fileCount,
          lastModified: stats.lastModified,
          // v0.6.3 additive fields. Existing frontend ignores unknown keys.
          app_id: r.app_id,
          root_source: r.root_source
        });
      }
      const previewExtensionsSorted = [...PREVIEW_EXT].sort();
      res.json({
        success: true,
        data: {
          roots: out,
          forbidden: NEVER_EXPOSE,
          previewExtensions: previewExtensionsSorted,
          previewFilenames: [...PREVIEW_FILENAMES].sort(),
          archiveExtensions: [...ARCHIVE_EXT, ...ARCHIVE_DOUBLE_EXT].sort(),
          notes:
            'Read-only browser. No uploads, no edits, no deletes, no renames, no arbitrary path browsing. ' +
            'Hidden (dot) files are never enumerated or previewed (except whitelisted filenames like .env.example). ' +
            'Archives (.tar.gz, .zip, etc.) are listed with metadata only and are never decoded as text.',
          // v0.6.3 additive top-level metadata.
          app_id: meta.app_id,
          app_name: meta.app_name,
          registry_source: meta.registry_source,
          config_driven: meta.config_driven,
          registry_migration_status: meta.registry_migration_status
        }
      });
    } catch (err) {
      next(err);
    }
  });

  router.get('/files/list', async (req, res, next) => {
    try {
      const root = getRoot(req.query.root);
      if (!root) {
        return res
          .status(400)
          .json({ success: false, error: { code: 'UNKNOWN_ROOT', message: 'Unknown root' } });
      }
      const resolved = await resolveInsideRoot(root, String(req.query.path ?? ''));
      if (!resolved) {
        return res.status(404).json({
          success: false,
          error: { code: 'PATH_NOT_ALLOWED', message: 'Path not allowed or not found.' }
        });
      }
      const stat = await fs.stat(resolved.absolute);
      if (!stat.isDirectory()) {
        return res
          .status(400)
          .json({ success: false, error: { code: 'NOT_A_DIRECTORY', message: 'Not a directory' } });
      }
      const entries = await fs.readdir(resolved.absolute, { withFileTypes: true });
      const out = [];
      for (const e of entries) {
        if (e.name.startsWith('.') && !PREVIEW_FILENAMES.has(e.name)) continue;
        const full = path.join(resolved.absolute, e.name);
        let s: import('node:fs').Stats;
        try {
          s = await fs.stat(full);
        } catch {
          continue;
        }
        const archive = !e.isDirectory() && isArchiveName(e.name);
        out.push({
          name: e.name,
          type: e.isDirectory() ? 'dir' : 'file',
          sizeBytes: e.isDirectory() ? null : s.size,
          mtime: s.mtime.toISOString(),
          archive,
          previewable: !e.isDirectory() && !archive && isPreviewable(e.name)
        });
      }
      out.sort((a, b) => {
        if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      res.json({
        success: true,
        data: {
          root: root.id,
          rootPath: root.path,
          rootLabel: root.label,
          relativePath: resolved.relative,
          absolutePath: resolved.absolute,
          entries: out
        }
      });
    } catch (err) {
      next(err);
    }
  });

  router.get('/files/view', async (req, res, next) => {
    try {
      const root = getRoot(req.query.root);
      if (!root) {
        return res
          .status(400)
          .json({ success: false, error: { code: 'UNKNOWN_ROOT', message: 'Unknown root' } });
      }
      const relPath = String(req.query.path ?? '');
      if (!relPath) {
        return res.status(400).json({
          success: false,
          error: { code: 'PATH_REQUIRED', message: 'A file path is required.' }
        });
      }
      // Reject archives explicitly with a friendlier message before doing the
      // generic preview check — the UI uses this to render an "Archive,
      // metadata only" card instead of a raw 415.
      const baseName = path.basename(relPath);
      if (isArchiveName(baseName)) {
        return res.status(415).json({
          success: false,
          error: {
            code: 'ARCHIVE_NOT_PREVIEWABLE',
            message:
              'Archive files (.tar.gz, .zip, etc.) are listed with metadata only and cannot be previewed as text.'
          }
        });
      }
      if (!isPreviewable(baseName)) {
        const allowed = [...PREVIEW_EXT].sort().join(', ');
        return res.status(415).json({
          success: false,
          error: {
            code: 'PREVIEW_NOT_ALLOWED',
            message: `Preview not allowed for ${baseName}. Allowed extensions: ${allowed}.`
          }
        });
      }
      const resolved = await resolveInsideRoot(root, relPath);
      if (!resolved) {
        return res.status(404).json({
          success: false,
          error: { code: 'PATH_NOT_ALLOWED', message: 'Path not allowed or not found.' }
        });
      }
      const stat = await fs.stat(resolved.absolute);
      if (!stat.isFile()) {
        return res
          .status(400)
          .json({ success: false, error: { code: 'NOT_A_FILE', message: 'Not a file' } });
      }
      const readSize = Math.min(stat.size, PREVIEW_MAX_BYTES);
      const handle = await fs.open(resolved.absolute, 'r');
      let content = '';
      try {
        const buf = Buffer.alloc(readSize);
        await handle.read(buf, 0, readSize, 0);
        content = buf.toString('utf8');
      } finally {
        await handle.close();
      }
      res.json({
        success: true,
        data: {
          root: root.id,
          rootPath: root.path,
          relativePath: resolved.relative,
          absolutePath: resolved.absolute,
          encoding: 'utf-8',
          content,
          truncated: stat.size > readSize,
          sizeBytes: stat.size
        }
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
