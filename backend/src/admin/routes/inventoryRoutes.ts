import fs from 'node:fs/promises';
import path from 'node:path';
import { Router } from 'express';
import { ACTIVE_APP, loadApp, type ForgeAppConfig } from '../forgeConfig';
import { respond } from '../envelope';

interface Connection {
  configured: boolean; available: boolean;
  state: 'ready' | 'not_configured' | 'missing' | 'unavailable'; message: string | null;
}
interface PackageEntry {
  name: string; path: string; sizeBytes: number; mtime: string;
  validName: boolean; parsedVersion: string | null; layout: 'canonical' | 'legacy-flat';
}
interface BackupEntry {
  name: string; sizeBytes: number; mtime: string;
  parsedVersion: string | null; kind: 'archive' | 'database';
}
const MAX_SCAN = 2000;
const VERSION = /^v(\d+\.\d+\.\d+)$/;
const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function base(cfg: ForgeAppConfig, configuredPath: string | undefined) {
  const raw = configuredPath?.trim();
  const root = raw && path.isAbsolute(raw) && !raw.includes('\0') ? path.resolve(raw) : null;
  const connection: Connection = !raw
    ? { configured: false, available: false, state: 'not_configured', message: 'This app inventory needs its directory configured on the host.' }
    : !root
      ? { configured: true, available: false, state: 'unavailable', message: 'The configured inventory directory must be an absolute path.' }
      : { configured: true, available: false, state: 'missing', message: 'The configured directory is not available yet.' };
  return { app: { id: cfg.app_id, name: cfg.name }, root, connection, truncated: false };
}
function failure(error: unknown): Connection {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR'
    ? { configured: true, available: false, state: 'missing', message: 'The configured directory does not exist. Check this app’s host connection settings.' }
    : { configured: true, available: false, state: 'unavailable', message: 'The configured directory could not be read. Check host availability and access.' };
}
const ready = (): Connection => ({ configured: true, available: true, state: 'ready', message: null });
async function openInventoryDirectory(root: string) {
  // Configured roots are metadata sources, not links to another app's tree.
  // Check the root itself as well as each entry before opening the directory.
  const stat = await fs.lstat(root);
  if (stat.isSymbolicLink()) throw Object.assign(new Error('Inventory root cannot be a symbolic link.'), { code: 'ELOOP' });
  if (!stat.isDirectory()) throw Object.assign(new Error('Inventory root must be a directory.'), { code: 'ENOTDIR' });
  return fs.opendir(root);
}
async function metadata(file: string) {
  // Metadata only: never open archives, follow file links, or expose a download.
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) return null;
  return { sizeBytes: stat.size, mtime: stat.mtime.toISOString() };
}
export async function listPackages(cfg: ForgeAppConfig, kind: 'staged' | 'installed', limit = MAX_SCAN) {
  const data = { ...base(cfg, kind === 'staged' ? cfg.paths.packages_staged : cfg.paths.packages_installed), packages: [] as PackageEntry[] };
  if (!data.root) return data;
  const flat = new RegExp('^' + escapeRegex(cfg.app_id) + '-v(\\d+\\.\\d+\\.\\d+)\\.tar\\.gz$');
  try {
    const dir = await openInventoryDirectory(data.root);
    let scanned = 0;
    for await (const entry of dir) {
      if (++scanned > limit) { data.truncated = true; break; }
      if (entry.isSymbolicLink()) continue;
      let file: string, name: string, version: string | null, layout: PackageEntry['layout'];
      if (entry.isFile() && entry.name.startsWith(cfg.app_id + '-') && entry.name.endsWith('.tar.gz')) {
        file = path.join(data.root, entry.name); name = entry.name;
        version = flat.exec(name)?.[1] ?? null; layout = 'legacy-flat';
      } else if (entry.isDirectory() && VERSION.test(entry.name)) {
        // One exact canonical filename, no recursive traversal or user path input.
        name = cfg.app_id + '.tar.gz'; file = path.join(data.root, entry.name, name);
        version = VERSION.exec(entry.name)![1]; layout = 'canonical';
        const child = await fs.lstat(path.join(data.root, entry.name));
        if (!child.isDirectory() || child.isSymbolicLink()) continue;
      } else continue;
      try {
        const meta = await metadata(file);
        if (meta) data.packages.push({ name, path: file, ...meta, validName: version !== null, parsedVersion: version, layout });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    data.connection = ready();
    data.packages.sort((a, b) => b.mtime.localeCompare(a.mtime) || a.path.localeCompare(b.path));
  } catch (error) { data.connection = failure(error); data.packages = []; }
  return data;
}
export async function listBackups(cfg: ForgeAppConfig, limit = MAX_SCAN) {
  const data = { ...base(cfg, cfg.paths.backups), backups: [] as BackupEntry[], totalSizeBytes: 0 };
  if (!data.root) return data;
  const prefix = new RegExp('^' + escapeRegex(cfg.app_id) + '[-_]');
  try {
    const dir = await openInventoryDirectory(data.root);
    let scanned = 0;
    for await (const entry of dir) {
      if (++scanned > limit) { data.truncated = true; break; }
      if (!entry.isFile() || entry.isSymbolicLink() || !prefix.test(entry.name) || !/\.(?:tar\.gz|zip|sql(?:\.gz)?)$/.test(entry.name)) continue;
      try {
        const meta = await metadata(path.join(data.root, entry.name));
        if (!meta) continue;
        data.backups.push({ name: entry.name, ...meta,
          parsedVersion: /[-_]v(\d+\.\d+\.\d+)(?=[-_.]|$)/.exec(entry.name)?.[1] ?? null,
          kind: /\.sql(?:\.gz)?$/.test(entry.name) ? 'database' : 'archive' });
        data.totalSizeBytes += meta.sizeBytes;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    data.connection = ready();
    data.backups.sort((a, b) => b.mtime.localeCompare(a.mtime) || a.name.localeCompare(b.name));
  } catch (error) { data.connection = failure(error); data.backups = []; data.totalSizeBytes = 0; }
  return data;
}
export function buildInventoryRoutes(): Router {
  const router = Router();
  for (const kind of ['staged', 'installed'] as const) {
    router.get('/packages/' + kind, async (_req, res, next) => {
      try { respond.ok(res, await listPackages(loadApp(ACTIVE_APP), kind)); } catch (error) { next(error); }
    });
  }
  router.get('/backups', async (_req, res, next) => {
    try { respond.ok(res, await listBackups(loadApp(ACTIVE_APP))); } catch (error) { next(error); }
  });
  return router;
}
