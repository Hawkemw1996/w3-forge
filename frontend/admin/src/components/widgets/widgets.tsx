import { consoleText } from "../../../../../shared/consoleApp";
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  Archive,
  Cpu,
  HardDrive,
  Package,
  PackageCheck,
  Tag,
  Terminal
} from 'lucide-react';
import { Card, CardBody, CardHeader } from '../ui/Card';
import { Badge, BadgeTone, statusTone } from '../ui/Badge';
import { StatusPill, StatusTone } from '../ui/StatusPill';
import { ProgressBar } from '../ui/ProgressBar';
import { MetricTile } from '../ui/MetricTile';
import { EmptyState, ErrorState, LoadingState } from '../ui/States';
import { adminGet } from '../../lib/api';
import {
  formatBytes,
  formatDuration,
  formatRelative,
  formatTimestamp
} from '../../lib/format';
import { parseLogBuffer, ParsedLogLine } from '../../lib/logParser';
import { cn } from '../../lib/utils';
import type { TileDensity } from '../../lib/tileDensity';
import type { WidgetDef } from './types';
import { AttentionRequiredWidget } from './AttentionRequiredWidget';

// =============================================================================
// v0.5.3.1 — density-aware widget props
// =============================================================================
//
// Every widget now accepts an optional `density` prop. When the dashboard
// (TileGrid) renders a tile it passes the current tile's density (compact /
// standard / expanded) so the widget can adapt its internal layout. When the
// widget is rendered outside the grid (Settings preview, tests) the prop is
// undefined and the widget falls back to its "standard" behaviour.

export interface WidgetProps {
  density?: TileDensity;
}

// =============================================================================
// v0.5.3 polish helpers — shared between Recent Logs and Disk Usage widgets.
// =============================================================================

// v0.5.10: the Recent Logs row now renders a single category badge, so the
// per-line severity helper that v0.5.9 used has been retired. Severity is
// still reflected by the category badge tone (INFO=info, WARN=warning,
// ERROR=danger) defined in RECENT_LOG_CATEGORY_TONE below.

function diskTone(pct: number | null | undefined): BadgeTone {
  if (pct == null) return 'slate';
  if (pct >= 90) return 'danger';
  if (pct >= 75) return 'warning';
  return 'success';
}

// HTTP-status tone mapper for log lines that contain a request status code.
// Mirrors the v0.5.4 LogsPage helper so the Dashboard tile reads consistently
// with the full Logs page viewer.
function httpStatusTone(code: number | undefined): BadgeTone {
  if (code == null) return 'slate';
  if (code >= 500) return 'danger';
  if (code >= 400) return 'warning';
  if (code >= 300) return 'info';
  return 'success';
}

// -----------------------------------------------------------------------------
// Shared response types (must match backend admin routes).
// -----------------------------------------------------------------------------

// v0.5.3.1: memory payload now carries both the legacy Node-process fields
// (kept for back-compat) and the new structured shape with container vs
// process memory and swap.
interface ProcessMemory {
  rssBytes: number;
  heapUsedBytes: number;
  heapTotalBytes: number;
  heapUsagePercent: number | null;
  externalBytes: number | null;
  arrayBuffersBytes: number | null;
}

interface ContainerMemorySwap {
  usedBytes: number | null;
  limitBytes: number | null;
  source: 'cgroup-v2' | 'meminfo' | 'unavailable';
}

interface ContainerMemory {
  usedBytes: number | null;
  limitBytes: number | null;
  availableBytes: number | null;
  usagePercent: number | null;
  source: 'cgroup-v2' | 'meminfo' | 'os' | 'unavailable';
  swap: ContainerMemorySwap;
}

interface MemoryStatus {
  // Back-compat (Node process).
  rssBytes: number;
  heapUsedBytes: number;
  heapTotalBytes: number;
  // v0.5.3.1 structured shape (optional so old payloads still parse).
  process?: ProcessMemory;
  container?: ContainerMemory;
}

interface SystemStatus {
  service: string;
  status: string;
  uptimeSeconds: number;
  startedAt: string;
  app: string;
  version: string;
  nodeEnv: string;
  database: { status: string; latencyMs: number | null };
  memory: MemoryStatus;
  cpu: { loadAverage: number[]; cores: number };
  /** Legacy flat list (root + folders). Kept for back-compat; prefer
   *  `diskUsage` for v0.5.5+ widgets. */
  disk: Array<{
    path: string;
    sizeBytes: number | null;
    usedBytes: number | null;
    availableBytes: number | null;
    usePercent: number | null;
    available: boolean;
  }>;
  /** v0.5.5 split disk shape. */
  diskUsage?: {
    rootVolume: {
      path: string;
      sizeBytes: number | null;
      usedBytes: number | null;
      availableBytes: number | null;
      usePercent: number | null;
      available: boolean;
    };
    folders: Array<{
      path: string;
      sizeBytes: number | null;
      status: 'ok' | 'missing' | 'unavailable';
      measuredAt: string;
    }>;
    monitoredFolders: string[];
  };
}

interface VersionInfo {
  app: string;
  version: string;
  nodeEnv: string;
  startedAt: string;
}

// v0.5.11: dashboard /logs/recent returns combined entries from ALL
// categories. Each entry now carries the originating `source` (category) and
// `file` so the dashboard can render category context per row without
// relying on heuristic classification.
interface LogEntry {
  line: string;
  source?: string;
  file?: string;
  ts?: string | null;
}

interface PackageEntry {
  name: string;
  path: string;
  sizeBytes: number;
  mtime: string;
  validName: boolean;
  parsedVersion: string | null;
}

interface BackupEntry {
  pairTimestamp: string | null;
  appArchive: { name: string; sizeBytes: number; mtime: string } | null;
  dbArchive: { name: string; sizeBytes: number; mtime: string } | null;
}

// -----------------------------------------------------------------------------
// Widget components.
// -----------------------------------------------------------------------------

function SystemHealthWidget({ density = 'standard' }: WidgetProps) {
  const q = useQuery({
    queryKey: ['admin', 'system', 'status'],
    queryFn: () => adminGet<SystemStatus>('/system/status'),
    refetchInterval: 20_000
  });
  // v0.5.3.1: column count adapts to density so labels never wrap.
  //   compact  — single column (stacked rows)
  //   standard — 2 columns
  //   expanded — 4 columns (single row of metrics on wide tiles)
  const gridCols =
    density === 'compact'
      ? 'grid-cols-1'
      : density === 'expanded'
        ? 'grid-cols-2 lg:grid-cols-4'
        : 'grid-cols-2';
  return (
    <Card>
      <CardHeader
        title={
          <span className="flex items-center gap-1.5">
            <Activity size={14} /> System Health
          </span>
        }
        right={
          q.data ? (
            <StatusPill tone={statusTone(q.data.status) as StatusTone} pulse>
              {q.data.status}
            </StatusPill>
          ) : null
        }
      />
      <CardBody>
        {q.isLoading ? (
          <LoadingState />
        ) : q.error ? (
          <ErrorState error={q.error} />
        ) : q.data ? (
          <div className={`grid gap-3 ${gridCols}`}>
            <MetricTile label="Service" value={q.data.service} />
            <MetricTile
              label="Database"
              value={
                <StatusPill tone={statusTone(q.data.database.status) as StatusTone}>
                  {q.data.database.status}
                </StatusPill>
              }
            />
            <MetricTile label="Uptime" value={formatDuration(q.data.uptimeSeconds)} />
            {density !== 'compact' ? (
              <MetricTile
                label="Started"
                value={formatRelative(q.data.startedAt)}
                hint={density === 'expanded' ? formatTimestamp(q.data.startedAt) : undefined}
              />
            ) : null}
          </div>
        ) : (
          <EmptyState>No System Data Yet.</EmptyState>
        )}
      </CardBody>
    </Card>
  );
}

function VersionWidget(_props: WidgetProps = {}) {
  const q = useQuery({
    queryKey: ['admin', 'version'],
    queryFn: () => adminGet<VersionInfo>('/version')
  });
  return (
    <Card>
      <CardHeader
        title={
          <span className="flex items-center gap-1.5">
            <Tag size={14} /> Version
          </span>
        }
        right={q.data ? <Badge tone="gold">v{q.data.version}</Badge> : null}
      />
      <CardBody>
        {q.isLoading ? (
          <LoadingState />
        ) : q.error ? (
          <ErrorState error={q.error} />
        ) : q.data ? (
          <div>
            <div className="stat-value">v{q.data.version}</div>
            <div className="mt-1 text-xs text-[var(--w3-text-muted)]">
              {q.data.app} · {q.data.nodeEnv}
            </div>
            <div className="mt-1 text-[11px] text-[var(--w3-text-dim)]">
              up since {formatTimestamp(q.data.startedAt)}
            </div>
          </div>
        ) : (
          <EmptyState>No Version Data.</EmptyState>
        )}
      </CardBody>
    </Card>
  );
}

// =============================================================================
// Dashboard Recent Logs categories (v0.5.11)
// =============================================================================
//
// The Dashboard Recent Logs tile is a simple, purpose-built combined-feed
// viewer. It shows the latest entries from EVERY available W3 BuildCost log
// category (AUTH, ADMIN, BACKUP, DEPLOY, SECURITY, DATABASE, SYSTEM, GITHUB,
// PACKAGE, and any others present on disk) in one merged, newest-first list.
//
// v0.5.11 removes:
//   - Dashboard filter chips (the dashboard tile is not a Logs page).
//   - The AUTH-only default that v0.5.9 / v0.5.10 produced because the
//     backend tailed only the most-recently-touched category.
//   - The nested .recent-logs-tile-body / .recent-logs-filter / chip-row
//     layout. The new layout is: card shell → header → inset wrapper that
//     adds breathing room around the dark log box → inner scroll area.
//
// The Logs page (pages/LogsPage.tsx) is unchanged. It still owns category
// selection, follow-live, and the full filtering UX. The dashboard tile is
// intentionally a single, no-knobs combined feed.

type LogCategoryKind =
  | 'INFO'
  | 'SUCCESS'
  | 'WARN'
  | 'ERROR'
  | 'DEPLOY'
  | 'BACKUP'
  | 'SECURITY'
  | 'DATABASE'
  | 'SYSTEM'
  | 'GITHUB'
  | 'PACKAGE'
  | 'AUTH';

const RECENT_LOG_CATEGORIES: LogCategoryKind[] = [
  'INFO',
  'SUCCESS',
  'WARN',
  'ERROR',
  'DEPLOY',
  'BACKUP',
  'SECURITY',
  'DATABASE',
  'SYSTEM',
  'GITHUB',
  'PACKAGE',
  'AUTH'
];

const RECENT_LOG_CATEGORY_TONE: Record<LogCategoryKind, BadgeTone> = {
  INFO: 'info',
  SUCCESS: 'success',
  WARN: 'warning',
  ERROR: 'danger',
  DEPLOY: 'gold',
  BACKUP: 'purple',
  SECURITY: 'danger',
  DATABASE: 'success',
  SYSTEM: 'slate',
  GITHUB: 'info',
  PACKAGE: 'gold',
  AUTH: 'purple'
};

function toRecentLogCategoryKind(category: string): LogCategoryKind {
  const up = (category || 'SYSTEM').toUpperCase();
  // Map common backend directory names to canonical category kinds.
  // The backend uses lowercase directory names (e.g. "deploy", "backup")
  // and the parser uses uppercase. "ADMIN" is mapped to AUTH because
  // admin audit lines are authentication-scoped in W3 BuildCost.
  if (up === 'ADMIN') return 'AUTH';
  if (up === 'RESTORE') return 'BACKUP';
  if ((RECENT_LOG_CATEGORIES as readonly string[]).includes(up))
    return up as LogCategoryKind;
  return 'SYSTEM';
}

// The shared log parser keeps the original line in `message` and ALSO extracts
// `method` / `path` / `status` into their own fields. When the row renders all
// three as badges, repeating them inside the message produces visual
// duplication (e.g. "GET /api/admin/version  200  GET /api/admin/version").
// This helper strips the leading method+path[+status] prefix from the message
// so the trailing free-form text is the only thing rendered to the right of
// the badges. Returns the original message if no prefix match is found.
function stripRequestPrefix(
  message: string,
  method?: string,
  path?: string,
  status?: number
): string {
  if (!message) return message;
  if (!method || !path) return message;
  let m = message;
  // Tolerate leading whitespace.
  m = m.replace(/^\s+/, '');
  // Strip "METHOD path" if present at the start.
  const lead = `${method} ${path}`;
  if (m.startsWith(lead)) {
    m = m.slice(lead.length).replace(/^\s+/, '');
  } else {
    return message;
  }
  // Optional status code after the path.
  if (status != null) {
    const s = String(status);
    if (m.startsWith(s)) m = m.slice(s.length).replace(/^\s+/, '');
  }
  // If nothing meaningful remains, return empty so the row shows just badges.
  return m;
}

// -----------------------------------------------------------------------------
// Recent Logs (v0.5.11) — Clean rebuild.
//
// Goals:
//   - One combined, ALL-categories feed.
//   - No filter chips, no category selection, no AUTH-only default.
//   - Outer card shell border on all four sides, uniform weight.
//   - Inner dark log viewer visibly inset from the card border by a fixed
//     padding (12-16px) on left/right/bottom, so the inner box never crowds
//     or covers the outer border.
//   - Only the inner viewport scrolls; the tile itself never scrolls.
//
// Layout contract:
//
//   <Card>                                  outer tile shell (the only border)
//     <CardHeader title right={N Lines} />  fixed: title + line-count badge
//     <CardBody className="recent-logs-body !p-0">
//       <div class="recent-logs-meta">      fixed: "All Categories · N Lines"
//       <div class="recent-logs-inset">     fixed inset wrapper (the spacing)
//         <div class="recent-logs-viewport">  dark terminal box, NOT touching
//                                             the card border. Inner border +
//                                             radius live here. overflow-y
//                                             scrolls. width = 100% of inset.
//           <log rows>
//         </div>
//       </div>
//     </CardBody>
//   </Card>
// -----------------------------------------------------------------------------

function RecentLogsWidget({ density = 'standard' }: WidgetProps) {
  // Density still drives how many lines we ask for from the backend.
  //   compact  — 25 lines
  //   standard — 50 lines
  //   expanded — 100 lines
  const limit = density === 'compact' ? 25 : density === 'expanded' ? 100 : 50;

  // v0.5.11: backend /logs/recent now returns a combined ALL-categories
  // feed. Each entry carries its originating `source` (category) so we can
  // render per-row context without relying on heuristic classification.
  const q = useQuery({
    queryKey: ['admin', 'logs', 'recent', 'combined', limit],
    queryFn: () =>
      adminGet<{
        root: string;
        sources: string[];
        entries: LogEntry[];
        truncated: boolean;
        limit: number;
        category: string | null;
        file: string | null;
      }>(`/logs/recent?limit=${limit}`),
    refetchInterval: 8_000
  });

  // Parse each line. We pass the line's `source` as the selectedCategory so
  // lines whose body does not self-classify still inherit their backend
  // category. The combined feed is already sorted newest-first on the
  // backend, so we render in the order received.
  const rows = useMemo<
    Array<ParsedLogLine & { source: string; file?: string }>
  >(() => {
    if (!q.data) return [];
    const out: Array<ParsedLogLine & { source: string; file?: string }> = [];
    // Group by source so parseLogBuffer can carry timestamps forward inside
    // each source's slice. Then flatten in the backend-provided order so the
    // newest-first sort is preserved.
    const bySource = new Map<string, LogEntry[]>();
    for (const e of q.data.entries) {
      const key = e.source ?? 'system';
      const arr = bySource.get(key) ?? [];
      arr.push(e);
      bySource.set(key, arr);
    }
    const parsedBySource = new Map<string, ParsedLogLine[]>();
    for (const [src, entries] of bySource) {
      const parsed = parseLogBuffer(
        entries.map((x) => x.line),
        { selectedCategory: src }
      );
      parsedBySource.set(src, parsed);
    }
    // Walk the original ordering and pop each source's parsed result.
    const cursors = new Map<string, number>();
    for (const e of q.data.entries) {
      const src = e.source ?? 'system';
      const idx = cursors.get(src) ?? 0;
      const parsed = parsedBySource.get(src)?.[idx];
      cursors.set(src, idx + 1);
      if (!parsed) continue;
      out.push({ ...parsed, source: src, file: e.file });
    }
    return out;
  }, [q.data]);

  const sourceCount = q.data?.sources.length ?? 0;
  const noEntries =
    !q.isLoading && !q.error && (!q.data || q.data.entries.length === 0);
  const displayCount = rows.length;

  return (
    <Card>
      <CardHeader
        title={
          <span className="flex items-center gap-1.5">
            <Terminal size={14} /> Recent Logs
          </span>
        }
        right={
          q.data ? (
            <Badge tone="slate">
              {displayCount} / {limit} Lines
            </Badge>
          ) : null
        }
      />
      <CardBody className="!p-0 recent-logs-body">
        {/* Fixed meta row — no chips, no filters. Just a summary. */}
        {q.data ? (
          <div className="recent-logs-meta">
            <span>All Categories</span>
            <span className="meta-sep">·</span>
            <span>
              {sourceCount} {sourceCount === 1 ? 'Source' : 'Sources'}
            </span>
            <span className="meta-sep">·</span>
            <span>{displayCount} Lines</span>
          </div>
        ) : null}

        {/* Inset wrapper: gives the dark viewport breathing room on all four
            sides. The viewport itself never touches the card border. */}
        <div className="recent-logs-inset">
          <div className="recent-logs-viewport">
            {q.isLoading ? (
              <div className="recent-logs-empty">
                <LoadingState />
              </div>
            ) : q.error ? (
              <div className="recent-logs-empty">
                <ErrorState error={q.error} />
              </div>
            ) : noEntries ? (
              <div className="recent-logs-empty">
                No Log Entries Available Yet.
              </div>
            ) : (
              <div className="recent-logs-rows">
                {rows.map((p, i) => {
                  const categoryKind = toRecentLogCategoryKind(
                    p.source || p.category
                  );
                  const ts = p.timestamp ? formatTimestamp(p.timestamp) : '—';
                  const showMethod =
                    p.method && p.path && density !== 'compact';
                  return (
                    <div key={i} className="log-row" title={p.raw}>
                      <Badge
                        tone={RECENT_LOG_CATEGORY_TONE[categoryKind]}
                        className="shrink-0"
                      >
                        {categoryKind}
                      </Badge>
                      {density !== 'compact' ? (
                        <span className="log-row-ts">{ts}</span>
                      ) : null}
                      {showMethod ? (
                        <span className="log-row-method">
                          {p.method} {p.path}
                        </span>
                      ) : null}
                      {p.status != null && density !== 'compact' ? (
                        <Badge
                          tone={httpStatusTone(p.status)}
                          className="shrink-0"
                        >
                          {p.status}
                        </Badge>
                      ) : null}
                      <span
                        className={cn(
                          'log-row-text',
                          density === 'compact' && 'truncate'
                        )}
                      >
                        {stripRequestPrefix(
                          p.message || p.raw,
                          p.method,
                          p.path,
                          p.status
                        )}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </CardBody>
    </Card>
  );
}

// Friendly labels for monitored W3 BuildCost disk paths.
const DISK_PATH_LABELS: Record<string, string> = {
  '/': 'Root Volume',
  [consoleText('/opt/w3buildcost')]: 'App Dir',
  [consoleText('/opt/w3buildcost-deploy')]: 'Deploy Staging',
  [consoleText('/opt/w3buildcost-update-packages')]: 'Update Packages',
  [consoleText('/opt/w3buildcost-update-packages/installed')]: 'Installed Packages',
  [consoleText('/opt/w3buildcost-backups')]: 'Backups',
  [consoleText('/opt/logs/w3buildcost')]: 'Logs',
  [consoleText('/opt/w3buildcost-scripts')]: 'Scripts'
};

function diskPathLabel(p: string): string {
  return DISK_PATH_LABELS[p] ?? p;
}

// v0.5.5: folder usage status label for the Disk Usage tile. We never show
// a synthetic "used %" for a folder — only the actual size or a clear
// status word so users don't confuse folder size with volume capacity.
function folderSizeLabel(
  status: 'ok' | 'missing' | 'unavailable',
  sizeBytes: number | null
): string {
  if (status === 'missing') return 'Missing';
  if (status === 'unavailable') return 'Unavailable';
  return formatBytes(sizeBytes);
}

// -----------------------------------------------------------------------------
// Disk Usage (v0.5.10) — Dashboard Visual System rewrite.
//
// Two clearly separated sections:
//   Root Volume   — inset .dash-section with label / path / values / bar.
//   Folder Usage  — vertical list of folders. Each row is .dash-folder-row
//                   (name primary, path muted, size right-aligned).
// No nested boxes, single row divider tone, consistent spacing.
// -----------------------------------------------------------------------------
function DiskUsageWidget({ density = 'standard' }: WidgetProps) {
  const q = useQuery({
    queryKey: ['admin', 'system', 'status'],
    queryFn: () => adminGet<SystemStatus>('/system/status'),
    refetchInterval: 45_000
  });

  const root = q.data?.diskUsage?.rootVolume;
  const folders = q.data?.diskUsage?.folders ?? [];
  const showFolders = density !== 'compact';
  const folderLimit = density === 'expanded' ? folders.length : 5;
  const shownFolders = folders.slice(0, folderLimit);
  const hiddenCount = Math.max(0, folders.length - shownFolders.length);

  return (
    <Card>
      <CardHeader
        title={
          <span className="flex items-center gap-1.5">
            <HardDrive size={14} /> Disk Usage
          </span>
        }
        right={
          root ? (
            <Badge tone={diskTone(root.usePercent)}>
              Root {root.usePercent == null ? '—' : `${root.usePercent}%`}
            </Badge>
          ) : null
        }
      />
      <CardBody>
        {q.isLoading ? (
          <LoadingState />
        ) : q.error ? (
          <ErrorState error={q.error} />
        ) : q.data ? (
          <div className="flex flex-col gap-4">
            {/* Root Volume — inset section with progress + key values. */}
            {root ? (
              <div className="dash-section">
                <div className="dash-section-header">
                  <span className="dash-section-label">Root Volume Usage</span>
                  <span className="font-mono text-[11px] text-[var(--w3-text-dim)]">
                    {root.path}
                  </span>
                </div>
                <div className="flex items-baseline justify-between gap-2">
                  <span className="font-mono text-[13px] text-[var(--w3-text)]">
                    {root.available
                      ? `${formatBytes(root.usedBytes)} Used / ${formatBytes(root.sizeBytes)} Total`
                      : 'Unavailable'}
                  </span>
                  <span className="font-mono text-[11px] text-[var(--w3-text-muted)]">
                    {root.available
                      ? `${formatBytes(root.availableBytes)} Available`
                      : '—'}
                  </span>
                </div>
                <div className="mt-2">
                  <ProgressBar
                    value={root.usePercent ?? 0}
                    ariaLabel="Root volume usage"
                    className="progress-track--lg"
                  />
                </div>
              </div>
            ) : null}

            {/* Folder Usage — clean vertical list, no table styling. */}
            {showFolders && shownFolders.length > 0 ? (
              <div>
                <div className="dash-section-header">
                  <span className="dash-section-label">Folder Usage</span>
                  <span className="dash-section-helper">Actual Size On Disk</span>
                </div>
                <div>
                  {shownFolders.map((f) => (
                    <div
                      key={f.path}
                      className="dash-folder-row"
                      title={f.path}
                    >
                      <div className="dash-folder-row__main">
                        <span className="dash-folder-row__name">
                          {diskPathLabel(f.path)}
                        </span>
                        <span className="dash-folder-row__path">{f.path}</span>
                      </div>
                      {f.status === 'ok' ? (
                        <span className="dash-folder-row__size">
                          {folderSizeLabel(f.status, f.sizeBytes)}
                        </span>
                      ) : (
                        <Badge
                          tone={f.status === 'missing' ? 'slate' : 'warning'}
                        >
                          {folderSizeLabel(f.status, f.sizeBytes)}
                        </Badge>
                      )}
                    </div>
                  ))}
                  {hiddenCount > 0 ? (
                    <div className="pt-2 text-[11px] text-[var(--w3-text-dim)]">
                      + {hiddenCount} More — Expand Tile To See All
                    </div>
                  ) : null}
                </div>
              </div>
            ) : null}
          </div>
        ) : (
          <EmptyState>No Disk Data.</EmptyState>
        )}
      </CardBody>
    </Card>
  );
}

// v0.5.3.1: container memory tone uses the *container* usage percent, NOT
// the Node heap percent. A 14 MB heap inside a 4 GB LXC is not a crisis.
function containerMemTone(pct: number | null | undefined): BadgeTone {
  if (pct == null) return 'slate';
  if (pct >= 90) return 'danger';
  if (pct >= 80) return 'warning';
  return 'success';
}

// -----------------------------------------------------------------------------
// Memory / CPU (v0.5.10) — Dashboard Visual System rewrite.
//
// Three clearly labeled sections inside one tile:
//   1. Container Memory  — .dash-metric with progress bar
//   2. CPU Load          — .dash-metric with progress bar + Load 1/5/15 meta
//   3. Process Memory    — two compact .dash-stat cards (RSS / Heap)
// Process memory stays visually secondary to container memory.
// -----------------------------------------------------------------------------
function MemoryCpuWidget({ density = 'standard' }: WidgetProps) {
  const q = useQuery({
    queryKey: ['admin', 'system', 'status'],
    queryFn: () => adminGet<SystemStatus>('/system/status'),
    refetchInterval: 20_000
  });

  const mem = q.data?.memory;
  const container = mem?.container;
  const proc =
    mem?.process ??
    (mem
      ? {
          rssBytes: mem.rssBytes,
          heapUsedBytes: mem.heapUsedBytes,
          heapTotalBytes: mem.heapTotalBytes,
          heapUsagePercent:
            mem.heapTotalBytes > 0
              ? Math.round((mem.heapUsedBytes / Math.max(1, mem.heapTotalBytes)) * 100)
              : null,
          externalBytes: null,
          arrayBuffersBytes: null
        }
      : null);

  const heapPct =
    proc?.heapUsagePercent ??
    (proc
      ? Math.round((proc.heapUsedBytes / Math.max(1, proc.heapTotalBytes)) * 100)
      : 0);

  const load1 = q.data?.cpu.loadAverage[0] ?? 0;
  const cores = q.data?.cpu.cores ?? 1;
  const cpuPct = Math.min(100, Math.round((load1 / Math.max(1, cores)) * 100));

  const showProcessRow = density !== 'compact';

  return (
    <Card>
      <CardHeader
        title={
          <span className="flex items-center gap-1.5">
            <Cpu size={14} /> Memory / CPU
          </span>
        }
        right={
          container && container.usagePercent != null ? (
            <Badge tone={containerMemTone(container.usagePercent)}>
              Container {container.usagePercent}%
            </Badge>
          ) : null
        }
      />
      <CardBody>
        {q.isLoading ? (
          <LoadingState />
        ) : q.error ? (
          <ErrorState error={q.error} />
        ) : q.data ? (
          <div className="flex flex-col gap-4">
            {/* Container Memory */}
            {container && container.limitBytes != null ? (
              <div className="dash-metric">
                <div className="dash-metric__head">
                  <span className="dash-metric__label">Container Memory</span>
                  <span className="dash-metric__value">
                    {formatBytes(container.usedBytes)} / {formatBytes(container.limitBytes)}{' '}
                    <span className="text-[var(--w3-text-muted)]">
                      ({container.usagePercent ?? 0}%)
                    </span>
                  </span>
                </div>
                <ProgressBar
                  value={container.usagePercent ?? 0}
                  ariaLabel="Container memory usage"
                  className="progress-track--lg"
                />
              </div>
            ) : null}

            {/* CPU Load */}
            <div className="dash-metric">
              <div className="dash-metric__head">
                <span className="dash-metric__label">CPU Load</span>
                <span className="dash-metric__value">
                  {load1.toFixed(2)} / {cores} cores{' '}
                  <span className="text-[var(--w3-text-muted)]">({cpuPct}%)</span>
                </span>
              </div>
              <ProgressBar
                value={cpuPct}
                ariaLabel="CPU load"
                className="progress-track--lg"
              />
              {density !== 'compact' ? (
                <span className="dash-metric__meta">
                  Load 1/5/15: {q.data.cpu.loadAverage.map((n) => n.toFixed(2)).join(' · ')}
                </span>
              ) : null}
            </div>

            {/* Process Memory — compact secondary stat cards. */}
            {showProcessRow && proc ? (
              <div>
                <div className="dash-section-header">
                  <span className="dash-section-label">Process Memory</span>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div className="dash-stat">
                    <span className="dash-stat__label">Process RSS</span>
                    <span className="dash-stat__value">{formatBytes(proc.rssBytes)}</span>
                  </div>
                  <div className="dash-stat">
                    <span className="dash-stat__label">Heap Used / Total</span>
                    <span className="dash-stat__value">
                      {formatBytes(proc.heapUsedBytes)} / {formatBytes(proc.heapTotalBytes)}{' '}
                      <span className="text-[var(--w3-text-muted)]">({heapPct}%)</span>
                    </span>
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        ) : (
          <EmptyState>No Process Metrics.</EmptyState>
        )}
      </CardBody>
    </Card>
  );
}

function StagedPackagesWidget({ density = 'standard' }: WidgetProps) {
  const q = useQuery({
    queryKey: ['admin', 'packages', 'staged'],
    queryFn: () => adminGet<{ root: string; packages: PackageEntry[] }>('/packages/staged'),
    refetchInterval: 45_000
  });
  return (
    <PackagesSummaryCard
      title={
        <span className="flex items-center gap-1.5">
          <Package size={14} /> Staged Packages
        </span>
      }
      subtitle={consoleText("/opt/w3buildcost-update-packages")}
      q={q}
      emptyLabel="No Staged Packages."
      density={density}
    />
  );
}

function InstalledPackagesWidget({ density = 'standard' }: WidgetProps) {
  const q = useQuery({
    queryKey: ['admin', 'packages', 'installed'],
    queryFn: () => adminGet<{ root: string; packages: PackageEntry[] }>('/packages/installed'),
    refetchInterval: 60_000
  });
  return (
    <PackagesSummaryCard
      title={
        <span className="flex items-center gap-1.5">
          <PackageCheck size={14} /> Installed Packages
        </span>
      }
      subtitle={consoleText("/opt/w3buildcost-update-packages/installed")}
      q={q}
      emptyLabel="No Installed Packages."
      density={density}
    />
  );
}

// v0.5.3: compact dashboard summary for the packages tiles. Shows total count,
// latest entry, and a small list of the 3 most recent — not the full table.
// The Packages page is the canonical full-table surface.
// v0.5.3.1: density-aware — in compact mode we only show the count badge and
// drop the totalSize / latest detail card.
function PackagesSummaryCard({
  title,
  subtitle,
  q,
  emptyLabel,
  density = 'standard'
}: {
  title: React.ReactNode;
  subtitle: string;
  q: ReturnType<typeof useQuery<{ root: string; packages: PackageEntry[] }>>;
  emptyLabel: string;
  density?: TileDensity;
}) {
  const packages = q.data?.packages ?? [];
  const latest = packages[0];
  const total = packages.length;
  const totalBytes = packages.reduce((a, p) => a + (p.sizeBytes || 0), 0);
  const showDetail = density !== 'compact';
  return (
    <Card>
      <CardHeader
        title={title}
        subtitle={subtitle}
        right={<Badge tone="slate">{total} Total</Badge>}
      />
      <CardBody>
        {q.isLoading ? (
          <LoadingState />
        ) : q.error ? (
          <ErrorState error={q.error} />
        ) : packages.length === 0 ? (
          <EmptyState>{emptyLabel}</EmptyState>
        ) : (
          <div className="space-y-3">
            {showDetail ? (
              <div className="grid grid-cols-2 gap-3">
                <MetricTile label="Count" value={total} />
                <MetricTile label="Total Size" value={formatBytes(totalBytes)} />
              </div>
            ) : (
              <MetricTile label="Count" value={total} />
            )}
            {showDetail && latest ? (
              <div className="rounded-md border border-[var(--w3-border)] bg-[var(--w3-bg-deep)] p-2 text-xs">
                <div className="truncate font-mono text-[var(--w3-text)]" title={latest.name}>
                  {latest.name}
                </div>
                <div className="mt-1 flex items-center justify-between gap-2 text-[var(--w3-text-muted)]">
                  <span className="truncate">
                    {latest.parsedVersion
                      ? `v${latest.parsedVersion}`
                      : 'No Parsed Version'}
                  </span>
                  <span className="shrink-0">
                    {formatBytes(latest.sizeBytes)} · {formatRelative(latest.mtime)}
                  </span>
                </div>
              </div>
            ) : null}
            {showDetail && packages.length > 1 ? (
              <div className="text-[11px] text-[var(--w3-text-muted)]">
                +{packages.length - 1} More — See Packages Page.
              </div>
            ) : null}
          </div>
        )}
      </CardBody>
    </Card>
  );
}

function BackupSummaryWidget({ density = 'standard' }: WidgetProps) {
  const isCompact = density === 'compact';
  const q = useQuery({
    queryKey: ['admin', 'backups'],
    queryFn: () => adminGet<{ root: string; backups: BackupEntry[] }>('/backups'),
    refetchInterval: 60_000
  });
  return (
    <Card>
      <CardHeader
        title={
          <span className="flex items-center gap-1.5">
            <Archive size={14} /> Backup Summary
          </span>
        }
        subtitle={q.data?.root}
      />
      <CardBody>
        {q.isLoading ? (
          <LoadingState />
        ) : q.error ? (
          <ErrorState error={q.error} />
        ) : !q.data || q.data.backups.length === 0 ? (
          <EmptyState>No Backups Detected.</EmptyState>
        ) : (
          <div className="space-y-2">
            {q.data.backups.slice(0, isCompact ? 2 : 5).map((b, i) => (
              <div
                key={i}
                className="rounded-md border p-2 text-xs"
                style={{ borderColor: 'var(--w3-border)' }}
              >
                <div className="font-medium text-[var(--w3-text)]">
                  {b.pairTimestamp ?? '(unpaired)'}
                </div>
                <div className="mt-1 grid grid-cols-2 gap-2 text-[var(--w3-text-muted)]">
                  <span>app: {b.appArchive ? formatBytes(b.appArchive.sizeBytes) : '—'}</span>
                  <span>db: {b.dbArchive ? formatBytes(b.dbArchive.sizeBytes) : '—'}</span>
                </div>
              </div>
            ))}
            {q.data.backups.length > 5 ? (
              <div className="text-[11px] text-[var(--w3-text-muted)]">
                +{q.data.backups.length - 5} More — See Backups Page.
              </div>
            ) : null}
          </div>
        )}
      </CardBody>
    </Card>
  );
}


// -----------------------------------------------------------------------------
// Registry. Order here drives the default dashboard order.
// Keys are stable — never rename without a layout migration.
// -----------------------------------------------------------------------------

export const WIDGETS: WidgetDef[] = [
  {
    key: 'system-health',
    label: 'System Health',
    description: 'Service status, database, and uptime.',
    defaultSpan: 1,
    component: SystemHealthWidget
  },
  {
    key: 'version',
    label: 'Version',
    description: consoleText('Current W3 BuildCost version and environment.'),
    defaultSpan: 1,
    component: VersionWidget
  },
  {
    key: 'attention',
    label: 'Attention Required',
    description: 'Live operational alerts with refresh and status-check details.',
    defaultSpan: 1,
    component: AttentionRequiredWidget
  },
  {
    key: 'recent-logs',
    label: 'Recent Logs',
    description: 'Tail of the most recent operational log entries.',
    defaultSpan: 2,
    component: RecentLogsWidget
  },
  {
    key: 'memory-cpu',
    label: 'Memory / CPU',
    description: 'Process memory footprint and host load averages.',
    defaultSpan: 1,
    component: MemoryCpuWidget
  },
  {
    key: 'disk-usage',
    label: 'Disk Usage',
    description: consoleText('Disk space for key W3 BuildCost paths.'),
    defaultSpan: 1,
    component: DiskUsageWidget
  },
  {
    key: 'staged-packages',
    label: 'Staged Packages',
    description: consoleText('Release tarballs sitting in /opt/w3buildcost-update-packages.'),
    defaultSpan: 1,
    component: StagedPackagesWidget
  },
  {
    key: 'installed-packages',
    label: 'Installed Packages',
    description: consoleText('Tarballs previously imported by deploy-w3buildcost.sh.'),
    defaultSpan: 1,
    component: InstalledPackagesWidget
  },
  {
    key: 'backup-summary',
    label: 'Backup Summary',
    description: consoleText('Most recent app+db backup pairs from /opt/w3buildcost-backups.'),
    defaultSpan: 1,
    component: BackupSummaryWidget
  }
];

export const WIDGET_KEYS = WIDGETS.map((w) => w.key);
