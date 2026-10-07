import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import { LOGS_ROOT } from '../paths';

// =============================================================================
// /api/admin/logs/* — read-only log listing and tailing.
// =============================================================================
//
// v0.5.11 — Dashboard Recent Logs Rebuild.
//
// The /logs/recent endpoint is now an ALL-CATEGORIES aggregate so the
// Admin Console dashboard tile can show one combined feed of the most
// recent W3 Forge log entries without forcing the user to pick a category.
//
// Behavior:
//   - For every available category (subdir of LOGS_ROOT containing *.log/.txt
//     files), we tail the newest file up to `perCategoryLimit` lines.
//   - All tailed lines are tagged with their `source` (category name) and
//     `file` (basename) so the frontend can show category context per row.
//   - We then sort the combined buffer newest-first when a parseable ISO
//     timestamp is detected at the start of the line, and finally truncate
//     to `limit` total entries.
//   - Lines with no leading ISO timestamp are kept in safe file order and
//     interleaved at the position of their source file's most recent
//     timestamp (we use the file's mtime as a fallback ordering key).
//
// Categories are discovered by listing immediate subdirectories of LOGS_ROOT
// (e.g. /opt/logs/w3forge/{deploy,backup,restore,auth,...}). The single-category
// /logs/:category endpoint is UNCHANGED — the full Logs page still uses it.

const MAX_LINES_REQUEST = 1000;
const DEFAULT_LINES = 200;
const MAX_BYTES_TAILED = 1_000_000; // 1MB read cap per file
const CATEGORY_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;

// Per-category cap for the combined feed. We do not blindly let one chatty
// category dominate the buffer — if AUTH has 10 000 lines and DEPLOY has 5,
// the user still wants to see DEPLOY in the dashboard feed. The combined
// buffer is then sorted + truncated to the request limit.
const PER_CATEGORY_LIMIT = 200;

const TS_LEADING_RE =
  /^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?)/;

interface LogCategory {
  name: string;
  path: string;
  fileCount: number;
  latestFile: string | null;
  latestMtime: string | null;
}

async function listCategories(): Promise<LogCategory[]> {
  try {
    const entries = await fs.readdir(LOGS_ROOT, { withFileTypes: true });
    const dirs = entries.filter((e) => e.isDirectory() && CATEGORY_RE.test(e.name));
    const out: LogCategory[] = [];
    for (const d of dirs) {
      const catDir = path.join(LOGS_ROOT, d.name);
      let files: { name: string; mtime: Date }[] = [];
      try {
        const inner = await fs.readdir(catDir, { withFileTypes: true });
        for (const f of inner) {
          if (!f.isFile()) continue;
          if (!/\.(log|txt)$/.test(f.name)) continue;
          try {
            const st = await fs.stat(path.join(catDir, f.name));
            files.push({ name: f.name, mtime: st.mtime });
          } catch {
            /* skip unreadable */
          }
        }
      } catch {
        /* unreadable category directory — still report it with 0 files */
      }
      files.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
      out.push({
        name: d.name,
        path: catDir,
        fileCount: files.length,
        latestFile: files[0]?.name ?? null,
        latestMtime: files[0]?.mtime.toISOString() ?? null
      });
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  } catch {
    return [];
  }
}

async function tailFile(filePath: string, limit: number): Promise<{
  lines: string[];
  truncated: boolean;
}> {
  const handle = await fs.open(filePath, 'r');
  try {
    const stat = await handle.stat();
    const size = stat.size;
    const readSize = Math.min(size, MAX_BYTES_TAILED);
    const buf = Buffer.alloc(readSize);
    await handle.read(buf, 0, readSize, Math.max(0, size - readSize));
    const text = buf.toString('utf8');
    const lines = text.split(/\r?\n/);
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    const truncated = size > readSize;
    const out = lines.slice(-limit);
    return { lines: out, truncated };
  } finally {
    await handle.close();
  }
}

// Pull a leading ISO timestamp off a raw log line, if any. Used to merge-sort
// the combined feed newest-first. Returns null if no timestamp prefix is
// detected so the caller can fall back to file mtime.
function extractLeadingTs(line: string): number | null {
  if (!line) return null;
  const m = line.match(TS_LEADING_RE);
  if (!m) return null;
  // Normalize "YYYY-MM-DD HH:MM:SS" (space separator) to ISO so Date.parse
  // accepts it on all runtimes.
  let iso = m[1].replace(' ', 'T').replace(',', '.');
  // If there's no zone, treat as local. Date.parse handles both.
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

export function buildAdminLogsRoutes(): Router {
  const router = Router();

  router.get('/logs/categories', async (_req, res, next) => {
    try {
      const categories = await listCategories();
      res.json({ success: true, data: { root: LOGS_ROOT, categories } });
    } catch (err) {
      next(err);
    }
  });

  // v0.5.11: /api/admin/logs/recent — combined, ALL-categories feed.
  //
  // Response shape (back-compat preserved):
  //   {
  //     success: true,
  //     data: {
  //       root: "/opt/logs/w3forge",
  //       sources: ["auth", "deploy", "backup", ...],   // categories tailed
  //       entries: [
  //         { line: "...", source: "auth", file: "auth-2026-05-22.log",
  //           ts: "2026-05-22T15:59:01Z" | null },
  //         ...
  //       ],
  //       truncated: boolean,                           // any source truncated
  //       limit: number,
  //       // category/file remain in the payload for back-compat with the
  //       // previous single-source widget contract; they describe the
  //       // MOST RECENT contributing source if any.
  //       category: string | null,
  //       file: string | null
  //     }
  //   }
  router.get('/logs/recent', async (req, res, next) => {
    try {
      const limit = clampLimit(req.query.limit);
      const cats = await listCategories();
      const sources = cats.filter((c) => c.latestFile);

      if (!sources.length) {
        return res.json({
          success: true,
          data: {
            root: LOGS_ROOT,
            sources: [],
            entries: [],
            truncated: false,
            limit,
            category: null,
            file: null
          }
        });
      }

      // Tail every category's newest file in parallel. Per-category limit is
      // intentionally generous (PER_CATEGORY_LIMIT) so the combined buffer has
      // enough headroom for newest-first sort + truncation to `limit`.
      const perCat = await Promise.all(
        sources.map(async (c) => {
          try {
            const filePath = path.join(c.path, c.latestFile!);
            const tail = await tailFile(filePath, PER_CATEGORY_LIMIT);
            const mtime = c.latestMtime ? Date.parse(c.latestMtime) : Date.now();
            return {
              category: c.name,
              file: c.latestFile!,
              mtime,
              truncated: tail.truncated,
              lines: tail.lines
            };
          } catch {
            return {
              category: c.name,
              file: c.latestFile!,
              mtime: 0,
              truncated: false,
              lines: [] as string[]
            };
          }
        })
      );

      // Build the combined buffer. For each line we record:
      //   tsForSort  — leading ISO timestamp if parseable, else file mtime
      //                offset down by the line's position so newer lines in
      //                the same file still beat older ones in safe order.
      //   ts         — the original leading ISO string (or null) for the UI.
      type Entry = {
        line: string;
        source: string;
        file: string;
        ts: string | null;
        tsForSort: number;
      };

      const combined: Entry[] = [];
      let anyTruncated = false;

      for (const c of perCat) {
        if (c.truncated) anyTruncated = true;
        const total = c.lines.length;
        for (let i = 0; i < total; i++) {
          const line = c.lines[i];
          const leading = extractLeadingTs(line);
          // If no leading timestamp, fall back to file mtime, then bias by
          // line index so the file's last line sorts as newest within that
          // file. This keeps no-timestamp logs in safe order while still
          // letting timestamped logs from other categories interleave.
          const fallback = c.mtime - (total - 1 - i);
          const tsForSort = leading ?? fallback;
          combined.push({
            line,
            source: c.category,
            file: c.file,
            ts: leading != null ? line.match(TS_LEADING_RE)![1] : null,
            tsForSort
          });
        }
      }

      // Sort newest-first.
      combined.sort((a, b) => b.tsForSort - a.tsForSort);

      // Truncate to the requested limit.
      const sliced = combined.slice(0, limit);

      // Pick a single "most recent" category for back-compat callers.
      const mostRecent =
        sources
          .filter((c) => c.latestMtime)
          .sort(
            (a, b) => Date.parse(b.latestMtime!) - Date.parse(a.latestMtime!)
          )[0] ?? null;

      res.json({
        success: true,
        data: {
          root: LOGS_ROOT,
          sources: sources.map((s) => s.name),
          entries: sliced.map((e) => ({
            line: e.line,
            source: e.source,
            file: e.file,
            ts: e.ts
          })),
          truncated: anyTruncated,
          limit,
          category: mostRecent ? mostRecent.name : null,
          file: mostRecent ? mostRecent.latestFile : null
        }
      });
    } catch (err) {
      next(err);
    }
  });

  // /api/admin/logs/:category — newest log file in the named category, tailed.
  router.get('/logs/:category', async (req, res, next) => {
    try {
      const category = req.params.category;
      if (!CATEGORY_RE.test(category)) {
        return res
          .status(400)
          .json({ success: false, error: { code: 'BAD_CATEGORY', message: 'Invalid category name' } });
      }
      const cats = await listCategories();
      const match = cats.find((c) => c.name === category);
      if (!match) {
        return res.status(404).json({
          success: false,
          error: { code: 'CATEGORY_NOT_FOUND', message: `No log category: ${category}` }
        });
      }
      if (!match.latestFile) {
        return res.json({
          success: true,
          data: { category, file: null, truncated: false, entries: [] }
        });
      }
      const limit = clampLimit(req.query.limit);
      const filePath = path.join(match.path, match.latestFile);
      const tail = await tailFile(filePath, limit);
      res.json({
        success: true,
        data: {
          category,
          file: match.latestFile,
          truncated: tail.truncated,
          entries: tail.lines.map((line) => ({ line }))
        }
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

function clampLimit(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LINES;
  return Math.min(MAX_LINES_REQUEST, Math.floor(n));
}
