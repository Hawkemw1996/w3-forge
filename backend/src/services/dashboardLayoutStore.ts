// =============================================================================
// Dashboard Layout Store — v0.5.3
// =============================================================================
//
// Persists the admin dashboard tile layout to a JSON file on disk so a user's
// tile arrangement survives service restarts and (importantly) survives
// /opt/w3forge-scripts/deploy-w3forge.sh, which rsyncs /opt/w3forge-deploy/ to
// /opt/w3forge/ with --delete. Anything inside /opt/w3forge that is not in the
// repo will be wiped on every deploy, so the layout file MUST live outside
// the runtime app directory.
//
// Default storage location: /opt/w3forge-data/dashboard-layout.json
//   - Sibling of /opt/w3forge, not inside it → survives rsync --delete.
//   - Overridable with W3_DATA_DIR.
//
// Storage contract:
//   - File is the source of truth.
//   - A short-lived in-memory cache speeds up the common GET path; the cache
//     is invalidated on every PUT/reset and on file-read errors.
//   - If the file is missing → returns the built-in default and does NOT
//     write anything (a default GET should not create a file).
//   - If the file is present but invalid/corrupt → logs a warning, falls
//     back to default, and leaves the bad file in place (do not silently
//     overwrite operator data; a future restore tool can recover it).
//   - Writes are atomic: write to a *.tmp file, fsync, rename over target.
//
// Schema (PersistedLayoutV1):
//   {
//     "version":  "0.5.3",
//     "schema":   1,
//     "updated_at": "ISO timestamp",
//     "layouts":  { "lg": [...], "md": [...], "sm": [...], "xs": [...] },
//     "hidden_tiles": [ "<tile-id>", ... ]
//   }
//
// Tile item shape inside each breakpoint array (matches react-grid-layout):
//   { "i": "<tile-id>", "x": 0, "y": 0, "w": 4, "h": 3 }

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { env } from '../config/env';

export interface LayoutItem {
  i: string;
  x: number;
  y: number;
  w: number;
  h: number;
  // v0.5.3.1: optional per-tile min/max constraints (react-grid-layout native).
  // Persisted so reloading the page applies the same resize floor / ceiling.
  minW?: number;
  minH?: number;
  maxW?: number;
  maxH?: number;
}

export type BreakpointKey = 'lg' | 'md' | 'sm' | 'xs';

export interface PersistedLayoutV1 {
  version: string;
  schema: 1;
  updated_at: string;
  layouts: Record<BreakpointKey, LayoutItem[]>;
  hidden_tiles: string[];
}

// -----------------------------------------------------------------------------
// Storage path resolution
// -----------------------------------------------------------------------------

// A3 — DATA_DIR now sourced from env.dataDir (which reads W3_DATA_DIR) so
// all runtime configuration flows through the centralized env contract.
const DATA_DIR = env.dataDir;
const LAYOUT_FILE = path.join(DATA_DIR, 'dashboard-layout.json');

export function dashboardLayoutFilePath(): string {
  return LAYOUT_FILE;
}

// -----------------------------------------------------------------------------
// Built-in default layout
// -----------------------------------------------------------------------------
//
// Tile IDs MUST match keys in frontend/admin/src/components/widgets/widgets.tsx.
// Default layout matches the v0.5.3 spec recommendation:
//   Row 1: System Health · Version · Attention Required
//   Row 2: Memory / CPU · Recent Logs (wider)
//   Row 3: Disk Usage · Staged Packages · Installed Packages
//   Row 4: Backup Summary (optional, narrow)
//
// 12-column grid on lg. Tile heights are in row units (rowHeight is set in
// the frontend; one row ~= 60-80px so h=3 ~= 200px).

const DEFAULT_LG: LayoutItem[] = [
  { i: 'system-health', x: 0, y: 0, w: 4, h: 3 },
  { i: 'version', x: 4, y: 0, w: 4, h: 3 },
  { i: 'attention', x: 8, y: 0, w: 4, h: 3 },
  { i: 'memory-cpu', x: 0, y: 3, w: 4, h: 4 },
  { i: 'recent-logs', x: 4, y: 3, w: 8, h: 4 },
  { i: 'disk-usage', x: 0, y: 7, w: 4, h: 4 },
  { i: 'staged-packages', x: 4, y: 7, w: 4, h: 4 },
  { i: 'installed-packages', x: 8, y: 7, w: 4, h: 4 },
  { i: 'backup-summary', x: 0, y: 11, w: 6, h: 4 }
];

const DEFAULT_MD: LayoutItem[] = [
  { i: 'system-health', x: 0, y: 0, w: 5, h: 3 },
  { i: 'version', x: 5, y: 0, w: 5, h: 3 },
  { i: 'attention', x: 0, y: 3, w: 10, h: 3 },
  { i: 'memory-cpu', x: 0, y: 6, w: 5, h: 4 },
  { i: 'recent-logs', x: 5, y: 6, w: 5, h: 4 },
  { i: 'disk-usage', x: 0, y: 10, w: 5, h: 4 },
  { i: 'staged-packages', x: 5, y: 10, w: 5, h: 4 },
  { i: 'installed-packages', x: 0, y: 14, w: 5, h: 4 },
  { i: 'backup-summary', x: 5, y: 14, w: 5, h: 4 }
];

const DEFAULT_SM: LayoutItem[] = [
  { i: 'system-health', x: 0, y: 0, w: 6, h: 3 },
  { i: 'version', x: 0, y: 3, w: 6, h: 3 },
  { i: 'attention', x: 0, y: 6, w: 6, h: 3 },
  { i: 'memory-cpu', x: 0, y: 9, w: 6, h: 4 },
  { i: 'recent-logs', x: 0, y: 13, w: 6, h: 5 },
  { i: 'disk-usage', x: 0, y: 18, w: 6, h: 4 },
  { i: 'staged-packages', x: 0, y: 22, w: 6, h: 4 },
  { i: 'installed-packages', x: 0, y: 26, w: 6, h: 4 },
  { i: 'backup-summary', x: 0, y: 30, w: 6, h: 4 }
];

const DEFAULT_XS: LayoutItem[] = [
  { i: 'system-health', x: 0, y: 0, w: 2, h: 3 },
  { i: 'version', x: 0, y: 3, w: 2, h: 3 },
  { i: 'attention', x: 0, y: 6, w: 2, h: 3 },
  { i: 'memory-cpu', x: 0, y: 9, w: 2, h: 4 },
  { i: 'recent-logs', x: 0, y: 13, w: 2, h: 5 },
  { i: 'disk-usage', x: 0, y: 18, w: 2, h: 4 },
  { i: 'staged-packages', x: 0, y: 22, w: 2, h: 4 },
  { i: 'installed-packages', x: 0, y: 26, w: 2, h: 4 },
  { i: 'backup-summary', x: 0, y: 30, w: 2, h: 4 }
];

const DEFAULT_LAYOUT_VERSION = '0.5.6';

export function defaultLayout(): PersistedLayoutV1 {
  return {
    version: DEFAULT_LAYOUT_VERSION,
    schema: 1,
    updated_at: new Date(0).toISOString(),
    layouts: {
      lg: DEFAULT_LG.map((i) => ({ ...i })),
      md: DEFAULT_MD.map((i) => ({ ...i })),
      sm: DEFAULT_SM.map((i) => ({ ...i })),
      xs: DEFAULT_XS.map((i) => ({ ...i }))
    },
    hidden_tiles: []
  };
}

// -----------------------------------------------------------------------------
// Validation
// -----------------------------------------------------------------------------

function isOptionalPositiveInt(v: unknown): boolean {
  return v === undefined || (typeof v === 'number' && Number.isFinite(v) && v >= 0);
}

function isLayoutItem(v: unknown): v is LayoutItem {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.i === 'string' &&
    o.i.length > 0 &&
    o.i.length <= 128 &&
    typeof o.x === 'number' &&
    Number.isFinite(o.x) &&
    typeof o.y === 'number' &&
    Number.isFinite(o.y) &&
    typeof o.w === 'number' &&
    Number.isFinite(o.w) &&
    o.w > 0 &&
    typeof o.h === 'number' &&
    Number.isFinite(o.h) &&
    o.h > 0 &&
    isOptionalPositiveInt(o.minW) &&
    isOptionalPositiveInt(o.minH) &&
    isOptionalPositiveInt(o.maxW) &&
    isOptionalPositiveInt(o.maxH)
  );
}

function isLayoutArray(v: unknown): v is LayoutItem[] {
  return Array.isArray(v) && v.every(isLayoutItem);
}

function isPersistedLayout(v: unknown): v is PersistedLayoutV1 {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  if (o.schema !== 1) return false;
  if (typeof o.version !== 'string') return false;
  if (typeof o.updated_at !== 'string') return false;
  if (!o.layouts || typeof o.layouts !== 'object') return false;
  const L = o.layouts as Record<string, unknown>;
  if (!isLayoutArray(L.lg) || !isLayoutArray(L.md) || !isLayoutArray(L.sm) || !isLayoutArray(L.xs)) {
    return false;
  }
  if (
    !Array.isArray(o.hidden_tiles) ||
    !(o.hidden_tiles as unknown[]).every((s) => typeof s === 'string')
  ) {
    return false;
  }
  return true;
}

// Caller-supplied PUT payloads must be sanitized: enforce shape, clamp values,
// ensure all four breakpoints exist, dedupe by tile id, etc.
export interface IncomingLayout {
  layouts?: Partial<Record<BreakpointKey, LayoutItem[]>>;
  hidden_tiles?: string[];
}

function sanitizeLayoutArray(arr: unknown): LayoutItem[] | null {
  if (!Array.isArray(arr)) return null;
  const seen = new Set<string>();
  const out: LayoutItem[] = [];
  for (const raw of arr) {
    if (!isLayoutItem(raw)) return null;
    if (seen.has(raw.i)) continue; // de-dupe by id
    seen.add(raw.i);
    const item: LayoutItem = {
      i: raw.i,
      x: Math.max(0, Math.floor(raw.x)),
      y: Math.max(0, Math.floor(raw.y)),
      w: Math.max(1, Math.floor(raw.w)),
      h: Math.max(1, Math.floor(raw.h))
    };
    // v0.5.3.1: preserve optional min/max constraints so they survive a save.
    if (typeof raw.minW === 'number') item.minW = Math.max(1, Math.floor(raw.minW));
    if (typeof raw.minH === 'number') item.minH = Math.max(1, Math.floor(raw.minH));
    if (typeof raw.maxW === 'number') item.maxW = Math.max(1, Math.floor(raw.maxW));
    if (typeof raw.maxH === 'number') item.maxH = Math.max(1, Math.floor(raw.maxH));
    out.push(item);
  }
  return out;
}

export function sanitizeIncoming(payload: unknown): PersistedLayoutV1 | { error: string } {
  if (!payload || typeof payload !== 'object') {
    return { error: 'Body must be a JSON object' };
  }
  const body = payload as IncomingLayout;
  const layouts = body.layouts ?? {};
  const def = defaultLayout();

  const sanitized: Record<BreakpointKey, LayoutItem[]> = {
    lg: def.layouts.lg,
    md: def.layouts.md,
    sm: def.layouts.sm,
    xs: def.layouts.xs
  };

  for (const bp of ['lg', 'md', 'sm', 'xs'] as BreakpointKey[]) {
    if (bp in layouts) {
      const cleaned = sanitizeLayoutArray(layouts[bp]);
      if (cleaned === null) {
        return { error: `Invalid layout entries for breakpoint "${bp}"` };
      }
      sanitized[bp] = cleaned;
    }
  }

  let hidden: string[] = [];
  if (body.hidden_tiles !== undefined) {
    if (
      !Array.isArray(body.hidden_tiles) ||
      !body.hidden_tiles.every((s) => typeof s === 'string')
    ) {
      return { error: 'hidden_tiles must be an array of strings' };
    }
    hidden = Array.from(new Set(body.hidden_tiles));
  }

  return {
    version: DEFAULT_LAYOUT_VERSION,
    schema: 1,
    updated_at: new Date().toISOString(),
    layouts: sanitized,
    hidden_tiles: hidden
  };
}

// -----------------------------------------------------------------------------
// File IO with in-memory cache
// -----------------------------------------------------------------------------

let cache: PersistedLayoutV1 | null = null;
let cacheLoadedFrom: 'file' | 'default' | null = null;

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

async function readFromDisk(): Promise<PersistedLayoutV1 | null> {
  try {
    const raw = await fs.readFile(LAYOUT_FILE, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!isPersistedLayout(parsed)) {
      // eslint-disable-next-line no-console
      console.warn(
        `[w3forge] Dashboard layout file is malformed at ${LAYOUT_FILE}; falling back to default. ` +
          'The bad file has been left in place for inspection.'
      );
      return null;
    }
    return parsed;
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    if (e && e.code === 'ENOENT') {
      // Missing file is normal on a fresh install.
      return null;
    }
    // eslint-disable-next-line no-console
    console.warn(
      `[w3forge] Failed to read dashboard layout from ${LAYOUT_FILE}: ${e?.message ?? err}. ` +
        'Falling back to default.'
    );
    return null;
  }
}

async function writeToDisk(layout: PersistedLayoutV1): Promise<void> {
  await ensureDir(DATA_DIR);
  const tmp = `${LAYOUT_FILE}.tmp`;
  const json = JSON.stringify(layout, null, 2);
  // open → write → fsync → close → rename for atomic replace.
  const handle = await fs.open(tmp, 'w', 0o644);
  try {
    await handle.writeFile(json, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(tmp, LAYOUT_FILE);
}

export async function getLayout(): Promise<{
  layout: PersistedLayoutV1;
  source: 'file' | 'default';
}> {
  if (cache && cacheLoadedFrom) {
    return { layout: cache, source: cacheLoadedFrom };
  }
  const fromDisk = await readFromDisk();
  if (fromDisk) {
    cache = fromDisk;
    cacheLoadedFrom = 'file';
    return { layout: cache, source: 'file' };
  }
  const def = defaultLayout();
  cache = def;
  cacheLoadedFrom = 'default';
  return { layout: cache, source: 'default' };
}

export async function saveLayout(layout: PersistedLayoutV1): Promise<PersistedLayoutV1> {
  await writeToDisk(layout);
  cache = layout;
  cacheLoadedFrom = 'file';
  return layout;
}

export async function resetLayout(): Promise<PersistedLayoutV1> {
  // Reset = delete the persisted file so a fresh GET returns the built-in
  // default (and any future default changes flow through automatically).
  try {
    await fs.unlink(LAYOUT_FILE);
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    if (e && e.code !== 'ENOENT') {
      // eslint-disable-next-line no-console
      console.warn(`[w3forge] Failed to remove ${LAYOUT_FILE}: ${e.message}`);
    }
  }
  cache = null;
  cacheLoadedFrom = null;
  const { layout } = await getLayout();
  return layout;
}

// Test/diagnostic helper — never called from production code paths.
export function _resetCacheForTests(): void {
  cache = null;
  cacheLoadedFrom = null;
}
