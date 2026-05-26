import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { respond, AdminError } from '../envelope';
import { FORGE_ROOT, resolveUnderForgeRoot } from '../forgeConfig';

// Read-only browser scoped to FORGE_ROOT. Refuses any path that escapes.
// Hidden top-level directories (e.g. .git) and credential files are denied.
const NEVER_EXPOSE = new Set(['.git', '.env']);
const NEVER_EXPOSE_PATTERN = /(^|\/)\.env(\.|$)/;

interface FileEntry {
  name: string;
  type: 'file' | 'dir';
  size: number;
  modifiedMs: number;
}

export function buildAdminFilesRoutes(): Router {
  const router = Router();

  router.get('/files', (req, res, next) => {
    try {
      const rel = (req.query.path ?? '.').toString();
      if (rel.includes('..')) {
        throw new AdminError(400, 'INVALID_PATH', 'Path may not contain ..');
      }
      const real = resolveUnderForgeRoot(rel);
      const stat = fs.statSync(real);
      if (!stat.isDirectory()) {
        throw new AdminError(400, 'NOT_A_DIRECTORY', `Not a directory: ${rel}`);
      }
      const entries: FileEntry[] = [];
      for (const dirent of fs.readdirSync(real, { withFileTypes: true })) {
        if (NEVER_EXPOSE.has(dirent.name)) continue;
        if (NEVER_EXPOSE_PATTERN.test(dirent.name)) continue;
        const full = path.join(real, dirent.name);
        const s = fs.statSync(full);
        entries.push({
          name: dirent.name,
          type: dirent.isDirectory() ? 'dir' : 'file',
          size: s.size,
          modifiedMs: s.mtimeMs
        });
      }
      entries.sort((a, b) => {
        if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      respond.ok(res, {
        forgeRoot: FORGE_ROOT,
        path: rel,
        entries
      });
    } catch (e) {
      next(e);
    }
  });

  return router;
}
