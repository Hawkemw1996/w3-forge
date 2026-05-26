import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { respond, AdminError } from '../envelope';
import { FORGE_ROOT } from '../forgeConfig';

const LOGS_ROOT = path.join(FORGE_ROOT, 'logs');
const SAFE_NAME = /^[A-Za-z0-9._-]+$/;
const MAX_BYTES = 256 * 1024; // 256 KB tail

function listLogFiles(): string[] {
  if (!fs.existsSync(LOGS_ROOT)) return [];
  const out: string[] = [];
  const stack: string[] = [LOGS_ROOT];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        stack.push(full);
      } else if (e.isFile()) {
        out.push(path.relative(LOGS_ROOT, full));
      }
    }
  }
  return out.sort();
}

export function buildAdminLogsRoutes(): Router {
  const router = Router();

  router.get('/logs', (_req, res) => {
    respond.ok(res, {
      root: LOGS_ROOT,
      files: listLogFiles()
    });
  });

  router.get('/logs/tail', (req, res, next) => {
    try {
      const file = (req.query.file ?? '').toString();
      if (!file) {
        throw new AdminError(400, 'MISSING_FILE', 'file query param is required');
      }
      // Reject anything that looks like path traversal up front.
      const parts = file.split('/');
      for (const p of parts) {
        if (!SAFE_NAME.test(p)) {
          throw new AdminError(400, 'INVALID_FILE', `Invalid log path segment: ${p}`);
        }
      }
      const candidate = path.join(LOGS_ROOT, file);
      const realLogs = fs.existsSync(LOGS_ROOT) ? fs.realpathSync(LOGS_ROOT) : LOGS_ROOT;
      if (!fs.existsSync(candidate)) {
        throw new AdminError(404, 'LOG_NOT_FOUND', `Log not found: ${file}`);
      }
      const realCandidate = fs.realpathSync(candidate);
      if (
        realCandidate !== realLogs &&
        !realCandidate.startsWith(realLogs + path.sep)
      ) {
        throw new AdminError(403, 'PATH_ESCAPE', `Log path escapes logs root`);
      }
      const stat = fs.statSync(realCandidate);
      const start = Math.max(0, stat.size - MAX_BYTES);
      const fd = fs.openSync(realCandidate, 'r');
      const buf = Buffer.alloc(stat.size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      fs.closeSync(fd);
      respond.ok(res, {
        file,
        size: stat.size,
        bytesReturned: buf.length,
        content: buf.toString('utf8')
      });
    } catch (e) {
      next(e);
    }
  });

  return router;
}
