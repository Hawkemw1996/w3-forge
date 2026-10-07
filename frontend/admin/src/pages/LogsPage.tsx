import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { PauseCircle, PlayCircle, RefreshCw, Search } from 'lucide-react';
import { Card, CardBody, CardHeader } from '../components/ui/Card';
import { Badge, BadgeTone } from '../components/ui/Badge';
import { SectionHeader } from '../components/ui/SectionHeader';
import { EmptyState, ErrorState, LoadingState } from '../components/ui/States';
import { LogViewerPanel } from '../components/operations/LogViewerPanel';
import { adminGet } from '../lib/api';
import { cn } from '../lib/utils';
import { formatTimestamp } from '../lib/format';
import { parseLogBuffer, ParsedLogLine } from '../components/operations/logParser';

interface LogsListResp { root: string; files: string[] }
interface LogTail { file: string; size: number; bytesReturned: number; content: string }

// Canonical Core / BuildCost log presentation with Forge's explicit file-tail adapter.
// Files are alphabetical; no newest-file or category metadata is inferred.
// Max rendered lines — keeps DOM size bounded without virtualization.
const MAX_RENDERED = 1000;

// Shared polling cadence: 2 seconds while following, 8 seconds while paused.
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
    queryKey: ['logs'],
    queryFn: () => adminGet<LogsListResp>('/logs'),
    refetchInterval: 60_000
  });

  const [active, setActive] = useState<string | null>(null);
  const [filterChips, setFilterChips] = useState<Set<LogCategoryKind>>(new Set());
  const [searchRaw, setSearchRaw] = useState('');
  const search = useDebounced(searchRaw, 200);

  // Live follow refreshes the existing bounded-tail endpoint and scrolls new output.
  const [followLive, setFollowLive] = useState(false);
  const viewerRef = useRef<HTMLDivElement | null>(null);

  const files = categoriesQ.data?.files;
  const effectiveCategory = active && files?.includes(active) ? active : files?.[0] ?? null;

  // Changing files pauses live follow until the operator enables it again.
  useEffect(() => {
    setFollowLive(false);
  }, [effectiveCategory]);

  const tailQ = useQuery({
    enabled: Boolean(effectiveCategory),
    queryKey: ['logs', 'tail', effectiveCategory],
    queryFn: () =>
      adminGet<LogTail>(
        `/logs/tail?file=${encodeURIComponent(effectiveCategory!)}`
      ),
    refetchInterval: followLive ? FOLLOW_LIVE_INTERVAL_MS : IDLE_REFETCH_INTERVAL_MS
  });

  const parsed = useMemo<ParsedLogLine[]>(() => {
    if (!tailQ.data || !effectiveCategory) return [];
    return parseLogBuffer(
      tailQ.data.content.split(/\r?\n/).filter((line) => line.length > 0),
      { selectedCategory: 'SYSTEM' }
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
        subtitle={`${categoriesQ.data?.root ?? 'Forge logs'} · last 256 KB of the selected log file.`}
        actions={
          <div className="flex max-w-[calc(100vw-5rem)] flex-wrap items-center gap-2">
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
                aria-label="Search log lines"
                className="input pl-7"
                style={{ minWidth: 180 }}
              />
            </div>
            <button
              type="button"
              className="btn"
              onClick={() => {
                void categoriesQ.refetch();
                if (effectiveCategory) void tailQ.refetch();
              }}
              title="Refresh"
              disabled={categoriesQ.isFetching || tailQ.isFetching}
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
                  : 'Follow Live — Tail The Selected File Every 2s And Auto-Scroll To The Bottom'
              }
              aria-pressed={followLive}
            >
              {followLive ? <PauseCircle size={13} /> : <PlayCircle size={13} />}
              {followLive ? 'Following Live' : 'Follow Live'}
            </button>
          </div>
        }
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[260px_minmax(0,1fr)]">
        <Card>
          <CardHeader title="Log Files" subtitle={categoriesQ.data?.root ?? 'Forge logs'}
            right={files ? <Badge tone="slate">{files.length}</Badge> : undefined} />
          <CardBody className="!p-2">
            {categoriesQ.isLoading ? (
              <LoadingState />
            ) : categoriesQ.error ? (
              <ErrorState error={categoriesQ.error} />
            ) : !categoriesQ.data || categoriesQ.data.files.length === 0 ? (
              <EmptyState>No Log Files.</EmptyState>
            ) : (
              <ul className="space-y-0.5">
                {categoriesQ.data.files.map((file) => (
                  <li key={file}>
                    <button
                      type="button"
                      onClick={() => setActive(file)}
                      aria-pressed={effectiveCategory === file}
                      title={file}
                      className={cn(
                        'flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm transition border-l-[3px]',
                        effectiveCategory === file
                          ? 'text-[var(--w3-text)]'
                          : 'text-[var(--w3-text-muted)] hover:bg-white/[0.04] hover:text-white border-transparent'
                      )}
                      style={
                        effectiveCategory === file
                          ? {
                              background: 'rgba(217,164,65,0.10)',
                              borderLeftColor: 'var(--w3-gold-500)'
                            }
                          : { borderLeftColor: 'transparent' }
                      }
                    >
                      <span className="truncate font-mono text-xs">{file}</span>
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
                ? `Reading ${tailQ.data.file}${(tailQ.data.bytesReturned < tailQ.data.size) ? ' · Truncated By Server' : ''}`
                : 'Select A Log File.'
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
                    aria-pressed={on}
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
              <EmptyState>Choose A Log File.</EmptyState>
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
                  {tailQ.data && tailQ.data.bytesReturned < tailQ.data.size ? (
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
  const tsLabel = typeof entry.timestamp === 'string' ? formatTimestamp(entry.timestamp) : '—';
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
