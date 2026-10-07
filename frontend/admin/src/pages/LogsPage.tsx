import { consoleText } from "../../../../shared/consoleApp";
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download, PauseCircle, PlayCircle, RefreshCw, Search } from 'lucide-react';
import { Card, CardBody, CardHeader } from '../components/ui/Card';
import { Badge, BadgeTone } from '../components/ui/Badge';
import { SectionHeader } from '../components/ui/SectionHeader';
import { EmptyState, ErrorState, LoadingState } from '../components/ui/States';
import { LogViewerPanel } from '../components/widgets/LogViewerPanel';
import { adminGet } from '../lib/api';
import { cn } from '../lib/utils';
import { formatTimestamp } from '../lib/format';
import { parseLogBuffer, ParsedLogLine } from '../lib/logParser';

interface LogCategory {
  name: string;
  path: string;
  fileCount: number;
  latestFile: string | null;
  latestMtime: string | null;
}

interface LogTail {
  category: string;
  file: string | null;
  truncated: boolean;
  entries: Array<{ line: string }>;
}

// Max rendered lines — keeps DOM size bounded without virtualization.
const MAX_RENDERED = 1000;
const DOWNLOAD_AVAILABLE = false;

// v0.5.9 — Follow Live polling intervals (ms).
//   FOLLOW_LIVE_INTERVAL_MS  How often we re-fetch /logs/{category} while
//                            Follow Live is engaged. 2 s is fast enough to
//                            feel real-time on a quiet log file without
//                            hammering the backend (and the request is
//                            already a cheap tail-read, not a full scan).
//   IDLE_REFETCH_INTERVAL_MS Standard refetch interval when Follow Live is
//                            OFF. Matches the v0.5.6 8 s cadence so the
//                            background polling cost is unchanged when the
//                            feature isn't engaged.
const FOLLOW_LIVE_INTERVAL_MS = 2_000;
const IDLE_REFETCH_INTERVAL_MS = 8_000;

type Severity = 'INFO' | 'SUCCESS' | 'WARN' | 'ERROR' | 'DEBUG' | 'UNKNOWN';
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

const SEVERITY_TONE: Record<Severity, BadgeTone> = {
  INFO: 'info',
  SUCCESS: 'success',
  WARN: 'warning',
  ERROR: 'danger',
  DEBUG: 'slate',
  UNKNOWN: 'slate'
};

const CATEGORY_TONE: Record<LogCategoryKind, BadgeTone> = {
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

function statusTone(code: number | undefined): BadgeTone {
  if (code == null) return 'slate';
  if (code >= 500) return 'danger';
  if (code >= 400) return 'warning';
  if (code >= 300) return 'info';
  if (code >= 200) return 'success';
  return 'slate';
}

const FILTER_KINDS: LogCategoryKind[] = [
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

function useDebounced<T>(value: T, ms = 200): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}

function toCategoryKind(category: string): LogCategoryKind {
  const up = (category || 'SYSTEM').toUpperCase();
  if ((FILTER_KINDS as readonly string[]).includes(up)) return up as LogCategoryKind;
  return 'SYSTEM';
}

function toSeverity(level: string): Severity {
  const up = (level || 'INFO').toUpperCase();
  if (up === 'ERROR' || up === 'WARN' || up === 'SUCCESS' || up === 'DEBUG' || up === 'INFO')
    return up as Severity;
  if (up === 'FATAL') return 'ERROR';
  if (up === 'WARNING') return 'WARN';
  if (up === 'OK') return 'SUCCESS';
  if (up === 'TRACE') return 'DEBUG';
  return 'UNKNOWN';
}

export function LogsPage() {
  const categoriesQ = useQuery({
    queryKey: ['admin', 'logs', 'categories'],
    queryFn: () => adminGet<{ categories: LogCategory[] }>('/logs/categories'),
    refetchInterval: 60_000
  });

  const [active, setActive] = useState<string | null>(null);
  const [filterChips, setFilterChips] = useState<Set<LogCategoryKind>>(new Set());
  const [searchRaw, setSearchRaw] = useState('');
  const search = useDebounced(searchRaw, 200);

  // v0.5.9 — Follow Live toggle. When ON, the tail query refetches every
  // FOLLOW_LIVE_INTERVAL_MS and the viewer auto-scrolls to the bottom on
  // each new render so the user can watch lines stream in. When OFF, the
  // refetch interval drops back to IDLE_REFETCH_INTERVAL_MS and the scroll
  // position is left alone.
  //
  // Implementation note: this is polling-based, not SSE / WebSocket. The
  // backend already exposes /logs/{category}?limit=N which returns the tail
  // of the newest log file for the category, so we get "live enough" updates
  // without adding a streaming endpoint, a long-lived connection, or any
  // new dependencies. If a future release adds an SSE/WS tail endpoint, the
  // Follow Live toggle is the obvious place to switch over.
  const [followLive, setFollowLive] = useState(false);
  const viewerRef = useRef<HTMLDivElement | null>(null);

  const effectiveCategory = active ?? categoriesQ.data?.categories[0]?.name ?? null;

  // v0.5.9 — Follow Live disables itself when the user switches categories so
  // the user has an explicit moment to confirm the new category is the one
  // they want to tail (and so we don't accidentally start hammering a giant
  // log file the user opened just to glance at).
  useEffect(() => {
    setFollowLive(false);
  }, [effectiveCategory]);

  const tailQ = useQuery({
    enabled: Boolean(effectiveCategory),
    queryKey: ['admin', 'logs', 'tail', effectiveCategory],
    queryFn: () =>
      adminGet<LogTail>(
        `/logs/${encodeURIComponent(effectiveCategory!)}?limit=${MAX_RENDERED}`
      ),
    refetchInterval: followLive ? FOLLOW_LIVE_INTERVAL_MS : IDLE_REFETCH_INTERVAL_MS
  });

  const parsed = useMemo<ParsedLogLine[]>(() => {
    if (!tailQ.data || !effectiveCategory) return [];
    return parseLogBuffer(
      tailQ.data.entries.map((e) => e.line),
      { selectedCategory: effectiveCategory }
    );
  }, [tailQ.data, effectiveCategory]);

  const filtered = useMemo<ParsedLogLine[]>(() => {
    let xs = parsed;
    if (filterChips.size > 0) {
      xs = xs.filter((p) => filterChips.has(toCategoryKind(p.category)));
    }
    if (search.trim()) {
      const needle = search.trim().toLowerCase();
      xs = xs.filter((p) =>
        (p.message + ' ' + p.raw + ' ' + (p.path ?? '')).toLowerCase().includes(needle)
      );
    }
    return xs.slice(-MAX_RENDERED);
  }, [parsed, filterChips, search]);

  function toggleChip(k: LogCategoryKind) {
    setFilterChips((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  }

  // v0.5.9 — Auto-scroll the viewer to the bottom on every render that
  // happens while Follow Live is ON. We scroll the inner LogViewerPanel's
  // scroll container (the only overflow-y element inside `viewerRef`). When
  // Follow Live is OFF we leave the scroll position alone so the user can
  // read history without being yanked to the bottom.
  useEffect(() => {
    if (!followLive) return;
    const root = viewerRef.current;
    if (!root) return;
    // The scrollable element is the .log-viewer-scroll inside the panel.
    // Fall back to the root if for some reason the inner element is absent.
    const scroller =
      (root.querySelector('.log-viewer-scroll') as HTMLElement | null) ?? root;
    scroller.scrollTop = scroller.scrollHeight;
  }, [followLive, filtered, tailQ.dataUpdatedAt]);

  return (
    <div className="space-y-4">
      <SectionHeader
        title="Logs"
        subtitle={consoleText("/opt/logs/w3buildcost · newest log file per category.")}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search
                size={12}
                className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[var(--w3-text-dim)]"
              />
              <input
                type="text"
                value={searchRaw}
                onChange={(e) => setSearchRaw(e.target.value)}
                placeholder="Search…"
                className="input pl-7"
                style={{ minWidth: 180 }}
              />
            </div>
            <button
              type="button"
              className="btn"
              onClick={() => tailQ.refetch()}
              title="Refresh"
              disabled={!effectiveCategory}
            >
              <RefreshCw size={13} />
              Refresh
            </button>
            <button
              type="button"
              className={cn('btn', followLive && 'btn-primary')}
              onClick={() => setFollowLive((v) => !v)}
              disabled={!effectiveCategory}
              title={
                followLive
                  ? `Following Live (Refetch Every ${Math.round(
                      FOLLOW_LIVE_INTERVAL_MS / 1000
                    )}s) — Click To Pause`
                  : 'Follow Live — Tail The Current Category Every 2s And Auto-Scroll To The Bottom'
              }
              aria-pressed={followLive}
            >
              {followLive ? <PauseCircle size={13} /> : <PlayCircle size={13} />}
              {followLive ? 'Following Live' : 'Follow Live'}
            </button>
            <span
              title={
                DOWNLOAD_AVAILABLE
                  ? 'Download Raw Log File'
                  : 'Coming Soon — Raw Log Download Lands In A Later Release.'
              }
            >
              <button type="button" className="btn" disabled={!DOWNLOAD_AVAILABLE}>
                <Download size={13} />
                Download
              </button>
            </span>
          </div>
        }
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[260px_minmax(0,1fr)]">
        <Card>
          <CardHeader title="Categories" subtitle={consoleText("/opt/logs/w3buildcost")} />
          <CardBody className="!p-2">
            {categoriesQ.isLoading ? (
              <LoadingState />
            ) : categoriesQ.error ? (
              <ErrorState error={categoriesQ.error} />
            ) : !categoriesQ.data || categoriesQ.data.categories.length === 0 ? (
              <EmptyState>No Log Directories.</EmptyState>
            ) : (
              <ul className="space-y-0.5">
                {categoriesQ.data.categories.map((c) => (
                  <li key={c.name}>
                    <button
                      type="button"
                      onClick={() => setActive(c.name)}
                      className={cn(
                        'flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm transition border-l-[3px]',
                        effectiveCategory === c.name
                          ? 'text-[var(--w3-text)]'
                          : 'text-[var(--w3-text-muted)] hover:bg-white/[0.04] hover:text-white border-transparent'
                      )}
                      style={
                        effectiveCategory === c.name
                          ? {
                              background: 'rgba(217,164,65,0.10)',
                              borderLeftColor: 'var(--w3-gold-500)'
                            }
                          : { borderLeftColor: 'transparent' }
                      }
                    >
                      <span className="font-mono text-xs">{c.name}</span>
                      <Badge tone="slate">{c.fileCount}</Badge>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title={effectiveCategory ? `Tail · ${effectiveCategory}` : 'Tail'}
            subtitle={
              tailQ.data?.file
                ? `Reading ${tailQ.data.file}${tailQ.data.truncated ? ' · Truncated By Server' : ''}`
                : 'Select A Category To Load Its Newest Log File.'
            }
            right={
              filtered.length > 0 ? (
                <Badge tone="slate">
                  {filtered.length}
                  {parsed.length !== filtered.length ? ` / ${parsed.length}` : ''} Lines
                </Badge>
              ) : null
            }
          />
          <CardBody>
            <div className="mb-2 flex flex-wrap gap-1">
              {FILTER_KINDS.map((k) => {
                const on = filterChips.has(k);
                return (
                  <button
                    key={k}
                    type="button"
                    onClick={() => toggleChip(k)}
                    className={cn(
                      'badge cursor-pointer transition',
                      on ? `badge-${CATEGORY_TONE[k]}` : 'badge-slate opacity-70 hover:opacity-100'
                    )}
                    title={on ? `Hide ${k}` : `Show Only ${k}`}
                  >
                    {k}
                  </button>
                );
              })}
              {filterChips.size > 0 ? (
                <button
                  type="button"
                  className="badge badge-slate cursor-pointer hover:opacity-100"
                  onClick={() => setFilterChips(new Set())}
                >
                  Clear
                </button>
              ) : null}
            </div>

            {!effectiveCategory ? (
              <EmptyState>Choose A Category.</EmptyState>
            ) : tailQ.isLoading ? (
              <LoadingState />
            ) : tailQ.error ? (
              <ErrorState error={tailQ.error} />
            ) : parsed.length === 0 ? (
              <EmptyState>No Log Lines Yet.</EmptyState>
            ) : filtered.length === 0 ? (
              <EmptyState>No Lines Match The Current Filter.</EmptyState>
            ) : (
              <div ref={viewerRef} className="h-[65vh] min-h-0">
                <LogViewerPanel>
                  {filtered.map((p, i) => (
                    <LogLine key={i} entry={p} />
                  ))}
                  {tailQ.data?.truncated ? (
                    <div className="mt-1 text-[11px] text-[var(--w3-text-dim)]">
                      Output Truncated By Server For Safety
                    </div>
                  ) : null}
                </LogViewerPanel>
              </div>
            )}
          </CardBody>
        </Card>
      </div>
    </div>
  );
}

function LogLine({ entry }: { entry: ParsedLogLine }) {
  const tsLabel = entry.timestamp ? formatTimestamp(entry.timestamp) : '—';
  const categoryKind = toCategoryKind(entry.category);
  const severity = toSeverity(entry.level);
  return (
    <div className="flex items-start gap-2 py-[1px]" title={entry.raw}>
      <Badge tone={CATEGORY_TONE[categoryKind]} className="shrink-0">
        {categoryKind}
      </Badge>
      <Badge tone={SEVERITY_TONE[severity]} className="shrink-0">
        {severity}
      </Badge>
      <span className="shrink-0 text-[11px] text-[var(--w3-text-dim)]">{tsLabel}</span>
      {entry.method && entry.path ? (
        <span className="shrink-0 font-mono text-[var(--w3-text-muted)]">
          {entry.method} {entry.path}
        </span>
      ) : null}
      {entry.status != null ? (
        <Badge tone={statusTone(entry.status)} className="shrink-0">
          {entry.status}
        </Badge>
      ) : null}
      <span className="log-row-text min-w-0 flex-1 break-words">
        {entry.message || entry.raw}
      </span>
    </div>
  );
}
