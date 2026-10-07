import { consoleText, consolePattern } from "../../../../shared/consoleApp";
import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import {
  ChevronRight,
  FileText,
  Folder,
  ShieldCheck,
  Search,
  ArrowUpDown,
  Lock
} from 'lucide-react';
import { Card, CardBody, CardHeader } from '../components/ui/Card';
import { Badge, BadgeTone } from '../components/ui/Badge';
import { SectionHeader } from '../components/ui/SectionHeader';
import { EmptyState, ErrorState, LoadingState } from '../components/ui/States';
import { adminGet } from '../lib/api';
import { cn } from '../lib/utils';
import { formatBytes, formatRelative, formatTimestamp } from '../lib/format';

interface RootInfo {
  id: string;
  path: string;
  label: string;
  exists: boolean;
  // v0.5.4: backend now reports a friendly description and shallow stats.
  description?: string;
  fileCount?: number;
  lastModified?: string | null;
}

interface RootsResponse {
  roots: RootInfo[];
  forbidden: string[];
}

interface DirEntry {
  name: string;
  type: 'dir' | 'file';
  sizeBytes: number | null;
  mtime: string | null;
  previewable: boolean;
  // v0.5.4: backend marks archives explicitly so the UI can show a
  // metadata-only card instead of attempting any preview.
  archive?: boolean;
}

interface ListResponse {
  root: string;
  rootPath: string;
  relativePath: string;
  absolutePath: string;
  entries: DirEntry[];
}

interface ViewResponse {
  root: string;
  rootPath: string;
  relativePath: string;
  absolutePath: string;
  encoding: 'utf-8';
  content: string;
  truncated: boolean;
  sizeBytes: number;
}

interface RootMeta {
  friendly: string;
  purpose: string;
  relatedRoute?: string;
  relatedLabel?: string;
}

const ROOT_META: Record<string, RootMeta> = {
  // v0.5.4: new roots
  app: {
    friendly: 'Live Application',
    purpose: consoleText('/opt/w3buildcost — The Currently Running W3 BuildCost Install.')
  },
  deploy: {
    friendly: 'Deploy Staging',
    purpose: consoleText('/opt/w3buildcost-deploy — Working Copy For The Next Release.')
  },
  scripts: {
    friendly: 'Operational Scripts',
    purpose: consoleText('/opt/w3buildcost-scripts — Deploy, Backup, Restore, And Maintenance Scripts.')
  },
  'update-packages': {
    friendly: 'Staged Packages',
    purpose: consoleText('New W3 BuildCost Release Packages Waiting For Deploy.'),
    relatedRoute: '/packages',
    relatedLabel: 'Open Packages Screen'
  },
  'update-packages-installed': {
    friendly: 'Installed Packages',
    purpose: 'Archive Of Previously Deployed Packages.',
    relatedRoute: '/packages',
    relatedLabel: 'Open Packages Screen'
  },
  backups: {
    friendly: 'Local Backups',
    purpose: 'App And Database Backup Files.',
    relatedRoute: '/backups',
    relatedLabel: 'Open Backups Screen'
  },
  logs: {
    friendly: 'System Logs',
    purpose: 'Admin, Deploy, Backup, Restore, Status, And Error Logs.',
    relatedRoute: '/logs',
    relatedLabel: 'Open Logs Screen'
  },
  'cleanup-review': {
    friendly: 'Cleanup Review',
    purpose: 'Files Staged For Safe Review Before Cleanup.'
  },
  'deploy-docs': {
    friendly: 'Documentation',
    purpose: 'Release Notes, Setup Notes, And Internal Docs.'
  },
  'deploy-scripts': {
    friendly: 'Operational Scripts (Staged)',
    purpose: 'Scripts Shipped With The Currently Staged Deploy.'
  }
};

type FilterChip =
  | 'All'
  | 'Packages'
  | 'Backups'
  | 'Logs'
  | 'Scripts'
  | 'Docs'
  | 'Config'
  | 'Previewable'
  | 'Archives';

const FILTER_CHIPS: FilterChip[] = [
  'All',
  'Packages',
  'Backups',
  'Logs',
  'Scripts',
  'Docs',
  'Config',
  'Previewable',
  'Archives'
];

// Keep this list in sync with backend filesRoutes.ts PREVIEW_EXT.
const PREVIEW_EXTS = [
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
];
const ARCHIVE_EXTS = ['.tar.gz', '.tar.bz2', '.tar.xz', '.tgz', '.zip', '.tar', '.gz'];

type SortKey = 'name' | 'size' | 'modified' | 'type';

function extOf(name: string): string {
  if (name.endsWith('.tar.gz')) return '.tar.gz';
  const idx = name.lastIndexOf('.');
  return idx >= 0 ? name.slice(idx).toLowerCase() : '';
}

function isArchive(name: string): boolean {
  return ARCHIVE_EXTS.some((e) => name.endsWith(e));
}

function isPreviewable(name: string): boolean {
  return PREVIEW_EXTS.some((e) => name.endsWith(e));
}

function fileBadges(name: string, rootId: string | null): Array<{ label: string; tone: BadgeTone }> {
  const out: Array<{ label: string; tone: BadgeTone }> = [];
  if (isArchive(name)) out.push({ label: 'Archive', tone: 'slate' });
  if (isArchive(name) && new RegExp(consolePattern("^w3buildcost-v\\d+\\.\\d+\\.\\d+\\.tar\\.gz$"), "").test(name))
    out.push({ label: 'Canonical Package', tone: 'gold' });
  if (rootId === 'update-packages-installed' && isArchive(name))
    out.push({ label: 'Installed', tone: 'success' });
  if (name.endsWith('.sql'))
    out.push({ label: 'SQL', tone: 'purple' });
  if (rootId === 'backups' && (name.endsWith('.tar.gz') || name.endsWith('.sql')))
    out.push({ label: 'Backup', tone: 'purple' });
  if (name.endsWith('.log'))
    out.push({ label: 'Log', tone: 'info' });
  if (name.endsWith('.sh'))
    out.push({ label: 'Script', tone: 'gold' });
  if (rootId === 'deploy-scripts')
    out.push({ label: 'Operational', tone: 'gold' });
  if (isPreviewable(name)) out.push({ label: 'Previewable', tone: 'teal' });
  else if (!isPreviewable(name) && !name.endsWith('/'))
    out.push({ label: 'Not Previewable', tone: 'slate' });
  return out;
}

function chipMatches(chip: FilterChip, name: string, rootId: string | null): boolean {
  if (chip === 'All') return true;
  if (chip === 'Previewable') return isPreviewable(name);
  if (chip === 'Archives') return isArchive(name);
  if (chip === 'Packages')
    return isArchive(name) && (rootId === 'update-packages' || rootId === 'update-packages-installed');
  if (chip === 'Backups')
    return rootId === 'backups' && (name.endsWith('.tar.gz') || name.endsWith('.sql'));
  if (chip === 'Logs') return name.endsWith('.log');
  if (chip === 'Scripts') return name.endsWith('.sh');
  if (chip === 'Docs') return name.endsWith('.md') || name.endsWith('.txt');
  if (chip === 'Config') return name.endsWith('.json') || name.endsWith('.yml') || name.endsWith('.yaml');
  return true;
}

function previewKind(name: string): 'log' | 'json' | 'md' | 'sh' | 'sql' | 'txt' | 'archive' | 'unknown' {
  if (name.endsWith('.log')) return 'log';
  if (name.endsWith('.json')) return 'json';
  if (name.endsWith('.md')) return 'md';
  if (name.endsWith('.sh')) return 'sh';
  if (name.endsWith('.sql')) return 'sql';
  if (name.endsWith('.txt')) return 'txt';
  if (isArchive(name)) return 'archive';
  return 'unknown';
}

function useDebounced<T>(value: T, ms = 200): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}

export function FileBrowserPage() {
  const navigate = useNavigate();
  const rootsQ = useQuery({
    queryKey: ['admin', 'files', 'roots'],
    queryFn: () => adminGet<RootsResponse>('/files/roots')
  });

  const [rootId, setRootId] = useState<string | null>(null);
  const [relPath, setRelPath] = useState<string>('');
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [filterChip, setFilterChip] = useState<FilterChip>('All');
  const [searchRaw, setSearchRaw] = useState('');
  const search = useDebounced(searchRaw, 200);
  const [sortKey, setSortKey] = useState<SortKey>('name');

  useEffect(() => {
    if (!rootId && rootsQ.data?.roots[0]) {
      setRootId(rootsQ.data.roots[0].id);
    }
  }, [rootsQ.data, rootId]);

  const listQ = useQuery({
    enabled: Boolean(rootId),
    queryKey: ['admin', 'files', 'list', rootId, relPath],
    queryFn: () =>
      adminGet<ListResponse>(
        `/files/list?root=${encodeURIComponent(rootId!)}&path=${encodeURIComponent(relPath)}`
      )
  });

  // v0.5.4: NEVER request /files/view for archives, even if the user somehow
  // selected one. Archives are metadata-only by spec; the backend would 415,
  // but we want to skip the round-trip entirely.
  const viewQ = useQuery({
    enabled: Boolean(
      rootId &&
        selectedFile &&
        !isArchive(selectedFile) &&
        isPreviewable(selectedFile)
    ),
    queryKey: ['admin', 'files', 'view', rootId, selectedFile],
    queryFn: () =>
      adminGet<ViewResponse>(
        `/files/view?root=${encodeURIComponent(rootId!)}&path=${encodeURIComponent(selectedFile!)}`
      )
  });

  const crumbs = useMemo(() => relPath.split('/').filter(Boolean), [relPath]);

  function descend(name: string) {
    setSelectedFile(null);
    setRelPath((prev) => (prev ? `${prev}/${name}` : name));
  }
  function up() {
    setSelectedFile(null);
    if (!relPath) return;
    const parts = relPath.split('/').filter(Boolean);
    parts.pop();
    setRelPath(parts.join('/'));
  }
  function open(file: string) {
    const full = relPath ? `${relPath}/${file}` : file;
    setSelectedFile(full);
  }

  const filteredEntries: DirEntry[] = useMemo(() => {
    if (!listQ.data) return [];
    let xs = listQ.data.entries.slice();
    if (search.trim()) {
      const needle = search.trim().toLowerCase();
      xs = xs.filter((e) => e.name.toLowerCase().includes(needle));
    }
    xs = xs.filter((e) =>
      e.type === 'dir' ? true : chipMatches(filterChip, e.name, rootId)
    );
    xs.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      switch (sortKey) {
        case 'size':
          return (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0);
        case 'modified':
          return Date.parse(b.mtime ?? '0') - Date.parse(a.mtime ?? '0');
        case 'type':
          return extOf(a.name).localeCompare(extOf(b.name)) || a.name.localeCompare(b.name);
        case 'name':
        default:
          return a.name.localeCompare(b.name);
      }
    });
    return xs;
  }, [listQ.data, search, filterChip, rootId, sortKey]);

  const activeRoot = rootsQ.data?.roots.find((r) => r.id === rootId);
  const meta = rootId ? ROOT_META[rootId] : undefined;
  const selectedFileName = selectedFile?.split('/').pop() ?? null;
  const selectedKind = selectedFileName ? previewKind(selectedFileName) : 'unknown';

  return (
    <div className="space-y-4">
      <SectionHeader
        title="File Browser"
        subtitle={consoleText("Read-only inspector for approved W3 BuildCost paths.")}
        actions={
          <>
            <Badge tone="success">Read Only</Badge>
            <Badge tone="gold">Approved Roots Only</Badge>
            <Badge tone="warning">Internal Only</Badge>
          </>
        }
      />

      <Card>
        <CardHeader
          title={
            <span className="flex items-center gap-1.5">
              <ShieldCheck size={14} /> Safety And Access Rules
            </span>
          }
          subtitle="What this inspector can and cannot do."
        />
        <CardBody>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div>
              <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-[var(--w3-text-muted)]">
                Allowed
              </div>
              <ul className="space-y-1 text-xs text-[var(--w3-text)]">
                <li className="flex items-center gap-2">
                  <Badge tone="success">Allow</Badge>View Approved Directories
                </li>
                <li className="flex items-center gap-2">
                  <Badge tone="success">Allow</Badge>Preview Safe Text-Based Files
                </li>
                <li className="flex items-center gap-2">
                  <Badge tone="success">Allow</Badge>Inspect Package, Backup, Log, Script, And
                  Documentation Locations
                </li>
              </ul>
            </div>
            <div>
              <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-[var(--w3-text-muted)]">
                Blocked
              </div>
              <ul className="space-y-1 text-xs text-[var(--w3-text)]">
                <li className="flex items-center gap-2">
                  <Badge tone="danger">Block</Badge>Uploads
                </li>
                <li className="flex items-center gap-2">
                  <Badge tone="danger">Block</Badge>Edits
                </li>
                <li className="flex items-center gap-2">
                  <Badge tone="danger">Block</Badge>Deletes
                </li>
                <li className="flex items-center gap-2">
                  <Badge tone="danger">Block</Badge>Renames
                </li>
                <li className="flex items-center gap-2">
                  <Badge tone="danger">Block</Badge>Unapproved System Paths
                </li>
                <li className="flex items-center gap-2">
                  <Badge tone="warning">Restricted</Badge>Binary / Archive Preview
                </li>
              </ul>
            </div>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title={
            <span className="flex items-center gap-1.5">
              <ShieldCheck size={14} /> Approved Roots
            </span>
          }
          subtitle="Pick a root to list its contents."
        />
        <CardBody>
          {rootsQ.isLoading ? (
            <LoadingState />
          ) : rootsQ.error ? (
            <ErrorState error={rootsQ.error} />
          ) : rootsQ.data ? (
            <>
              <div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
                {rootsQ.data.roots.map((r) => {
                  const rm = ROOT_META[r.id];
                  return (
                    <button
                      key={r.id}
                      type="button"
                      onClick={() => {
                        setRootId(r.id);
                        setRelPath('');
                        setSelectedFile(null);
                      }}
                      className={cn(
                        'flex flex-col gap-1 rounded-md border px-3 py-2 text-left text-xs transition',
                        rootId === r.id
                          ? 'border-[var(--w3-gold-500)]'
                          : 'border-[var(--w3-border)] hover:border-[var(--w3-border-strong)]',
                        !r.exists && 'opacity-50'
                      )}
                      style={{
                        background:
                          rootId === r.id ? 'rgba(217,164,65,0.10)' : 'var(--w3-card)',
                        color: 'var(--w3-text)'
                      }}
                      title={r.path}
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-semibold">{rm?.friendly ?? r.label}</span>
                        {!r.exists ? (
                          <Badge tone="warning">Missing</Badge>
                        ) : (
                          <Badge tone="success">Ready</Badge>
                        )}
                      </div>
                      <div className="truncate font-mono text-[10px] text-[var(--w3-text-muted)]">
                        {r.path}
                      </div>
                      {rm ? (
                        <div className="text-[11px] text-[var(--w3-text-muted)]">
                          {rm.purpose}
                        </div>
                      ) : null}
                      <div className="mt-1 flex items-center justify-between text-[11px] text-[var(--w3-text-muted)]">
                        <span>
                          File Count:{' '}
                          {typeof r.fileCount === 'number' ? r.fileCount : '—'}
                        </span>
                        <span>
                          Last Modified:{' '}
                          {r.lastModified ? formatRelative(r.lastModified) : '—'}
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>
              <details className="mt-3 text-xs text-[var(--w3-text-muted)]">
                <summary className="cursor-pointer">Never-Exposed Paths</summary>
                <ul className="ml-4 mt-1 list-disc font-mono text-[11px]">
                  {rootsQ.data.forbidden.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              </details>
            </>
          ) : null}
        </CardBody>
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        <Card>
          <CardHeader
            title={
              <span className="flex items-center gap-1.5">
                <Folder size={14} /> Directory
              </span>
            }
            subtitle={
              listQ.data?.absolutePath ??
              (rootId ? meta?.friendly ?? rootId : 'Pick A Root Above.')
            }
            right={
              <div className="flex items-center gap-1">
                <span title="Read Only — Browser Cannot Modify Files.">
                  <Badge tone="warning">
                    <Lock size={10} /> Read Only
                  </Badge>
                </span>
              </div>
            }
          />
          <CardBody className="!p-0">
            <div
              className="flex flex-wrap items-center gap-1 px-3 py-2 text-xs"
              style={{ borderBottom: '1px solid var(--w3-border)' }}
            >
              <button
                type="button"
                className="btn !px-2 !py-1"
                disabled={!relPath}
                onClick={up}
              >
                ..
              </button>
              <button
                type="button"
                className="btn !px-2 !py-1"
                onClick={() => {
                  setRelPath('');
                  setSelectedFile(null);
                }}
              >
                /
              </button>
              <span className="ml-1 flex-1 truncate font-mono text-[11px] text-[var(--w3-text-muted)]">
                {crumbs.length === 0
                  ? activeRoot?.path ?? '(Root)'
                  : `${activeRoot?.path ?? ''} / ${crumbs.join(' / ')}`}
              </span>
            </div>

            <div
              className="flex flex-wrap items-center gap-2 px-3 py-2 text-xs"
              style={{ borderBottom: '1px solid var(--w3-border)' }}
            >
              <div className="relative flex-1 min-w-[140px]">
                <Search
                  size={11}
                  className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[var(--w3-text-dim)]"
                />
                <input
                  type="text"
                  value={searchRaw}
                  onChange={(e) => setSearchRaw(e.target.value)}
                  placeholder="Filter Current Folder…"
                  className="input pl-7 w-full"
                />
              </div>
              <label className="flex items-center gap-1">
                <ArrowUpDown size={11} className="text-[var(--w3-text-muted)]" />
                <select
                  value={sortKey}
                  onChange={(e) => setSortKey(e.target.value as SortKey)}
                  className="rounded-md border px-2 py-1 text-xs"
                  style={{
                    background: 'var(--w3-navy-800)',
                    borderColor: 'var(--w3-border)',
                    color: 'var(--w3-text)'
                  }}
                >
                  <option value="name">Name</option>
                  <option value="size">Size</option>
                  <option value="modified">Modified Date</option>
                  <option value="type">Type</option>
                </select>
              </label>
            </div>

            <div
              className="flex flex-wrap gap-1 px-3 py-2"
              style={{ borderBottom: '1px solid var(--w3-border)' }}
            >
              {FILTER_CHIPS.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setFilterChip(c)}
                  className={cn(
                    'badge cursor-pointer',
                    filterChip === c ? 'badge-gold' : 'badge-slate opacity-80 hover:opacity-100'
                  )}
                >
                  {c}
                </button>
              ))}
            </div>

            {!rootId ? (
              <div className="p-4">
                <EmptyState>Select A Root.</EmptyState>
              </div>
            ) : listQ.isLoading ? (
              <div className="p-4">
                <LoadingState />
              </div>
            ) : listQ.error ? (
              <div className="p-4">
                <ErrorState error={listQ.error} />
              </div>
            ) : !listQ.data || filteredEntries.length === 0 ? (
              <div className="p-4">
                <EmptyState>
                  {listQ.data && listQ.data.entries.length > 0
                    ? 'No Files Match The Current Filter.'
                    : 'Directory Is Empty — No Files To Inspect.'}
                </EmptyState>
              </div>
            ) : (
              <ul
                className="max-h-[55vh] overflow-y-auto"
                style={{ borderTop: '1px solid var(--w3-border)' }}
              >
                {filteredEntries.map((e) => {
                  const isDir = e.type === 'dir';
                  const ext = extOf(e.name).replace(/^\./, '').toUpperCase();
                  const selected = selectedFile?.endsWith('/' + e.name) || selectedFile === e.name;
                  return (
                    <li
                      key={e.name}
                      className={cn(
                        'flex items-center justify-between gap-2 px-3 py-1.5 text-sm transition',
                        'hover:bg-[var(--w3-card-hover)]'
                      )}
                      style={
                        selected ? { background: 'rgba(217,164,65,0.10)' } : undefined
                      }
                    >
                      <button
                        type="button"
                        className="flex flex-1 items-center gap-2 truncate text-left"
                        onClick={() => (isDir ? descend(e.name) : open(e.name))}
                      >
                        {isDir ? (
                          <Folder size={14} style={{ color: 'var(--w3-gold-500)' }} />
                        ) : (
                          <FileText size={14} className="text-[var(--w3-text-muted)]" />
                        )}
                        <span className="truncate font-mono text-xs">{e.name}</span>
                        {!isDir && ext ? (
                          <span
                            className="rounded px-1 text-[10px] font-mono"
                            style={{
                              background: 'var(--w3-navy-800)',
                              color: 'var(--w3-gold-400)',
                              border: '1px solid var(--w3-border)'
                            }}
                          >
                            {ext}
                          </span>
                        ) : null}
                        {!isDir
                          ? fileBadges(e.name, rootId).slice(0, 2).map((b, i) => (
                              <Badge key={i} tone={b.tone} className="shrink-0">
                                {b.label}
                              </Badge>
                            ))
                          : null}
                      </button>
                      <span className="shrink-0 text-[11px] text-[var(--w3-text-muted)]">
                        {isDir ? (
                          <ChevronRight size={12} />
                        ) : (
                          <>
                            {formatBytes(e.sizeBytes)}
                            {e.mtime ? (
                              <span className="ml-2" title={e.mtime}>
                                {formatRelative(e.mtime)}
                              </span>
                            ) : null}
                          </>
                        )}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </CardBody>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader
              title="File Details"
              subtitle={selectedFileName ?? 'Choose a file on the left.'}
            />
            <CardBody>
              {!selectedFile ? (
                <EmptyState>Select A File To View Its Details.</EmptyState>
              ) : (
                <FileDetails
                  fileName={selectedFileName!}
                  rootId={rootId}
                  listEntry={
                    listQ.data?.entries.find((e) => e.name === selectedFileName) ?? null
                  }
                  absolutePath={
                    listQ.data
                      ? `${listQ.data.absolutePath}/${selectedFileName}`
                      : '—'
                  }
                />
              )}
              {meta?.relatedRoute ? (
                <div className="mt-3">
                  <button
                    type="button"
                    className="btn"
                    onClick={() => navigate(meta.relatedRoute!)}
                  >
                    {meta.relatedLabel}
                  </button>
                </div>
              ) : null}
            </CardBody>
          </Card>

          <Card>
            <CardHeader
              title="Safe Preview"
              subtitle={selectedFile ?? 'Choose a previewable file.'}
              right={
                selectedFile ? (
                  <Badge
                    tone={
                      isArchive(selectedFile)
                        ? 'gold'
                        : isPreviewable(selectedFile)
                          ? 'success'
                          : 'gold'
                    }
                  >
                    {isArchive(selectedFile)
                      ? 'Archive — Metadata Only'
                      : isPreviewable(selectedFile)
                        ? 'Previewable'
                        : 'Metadata Only'}
                  </Badge>
                ) : null
              }
            />
            <CardBody>
              {!selectedFile ? (
                <EmptyState>
                  Allowed Preview Extensions: .md, .txt, .log, .json, .sh, .sql, .yml, .yaml, .conf, .service.
                </EmptyState>
              ) : isArchive(selectedFile) || !isPreviewable(selectedFile) ? (
                <ArchiveOrUnknownPreview kind={selectedKind} fileName={selectedFileName!} />
              ) : viewQ.isLoading ? (
                <LoadingState />
              ) : viewQ.error ? (
                <ErrorState error={viewQ.error} />
              ) : viewQ.data ? (
                <PreviewBody data={viewQ.data} kind={selectedKind} />
              ) : null}
            </CardBody>
          </Card>
        </div>
      </div>
    </div>
  );
}

function FileDetails({
  fileName,
  rootId,
  listEntry,
  absolutePath
}: {
  fileName: string;
  rootId: string | null;
  listEntry: DirEntry | null;
  absolutePath: string;
}) {
  const badges = fileBadges(fileName, rootId);
  const ext = extOf(fileName) || '(none)';
  return (
    <div className="space-y-2 text-xs">
      <div className="grid grid-cols-2 gap-2">
        <Field label="Name" value={<code className="font-mono">{fileName}</code>} />
        <Field label="Type" value={ext} />
        <Field
          label="Size"
          value={listEntry ? formatBytes(listEntry.sizeBytes) : '—'}
        />
        <Field
          label="Modified"
          value={listEntry?.mtime ? formatTimestamp(listEntry.mtime) : '—'}
        />
        <Field
          label="Location"
          value={<code className="font-mono break-all">{absolutePath}</code>}
        />
        <Field
          label="Status"
          value={<Badge tone="success">Ready</Badge>}
        />
      </div>
      {badges.length ? (
        <div className="flex flex-wrap gap-1 pt-1">
          {badges.map((b, i) => (
            <Badge key={i} tone={b.tone}>
              {b.label}
            </Badge>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-[var(--w3-text-muted)]">
        {label}
      </div>
      <div className="text-[var(--w3-text)]">{value}</div>
    </div>
  );
}

function ArchiveOrUnknownPreview({
  kind,
  fileName
}: {
  kind: ReturnType<typeof previewKind>;
  fileName: string;
}) {
  return (
    <div
      className="rounded-md p-4"
      style={{
        background: 'var(--w3-gold-bg, rgba(217,164,65,0.06))',
        border: '1px solid var(--w3-gold-400)',
        color: 'var(--w3-text)'
      }}
    >
      <div className="text-sm font-semibold" style={{ color: 'var(--w3-gold-400)' }}>
        Preview Not Available
      </div>
      <p className="mt-1 text-xs text-[var(--w3-text-muted)]">
        {kind === 'archive'
          ? 'Archive Files Cannot Be Previewed Directly.'
          : 'Binary Or Unknown File Type — Preview Is Restricted.'}
      </p>
      <p className="mt-1 text-[11px] text-[var(--w3-text-muted)]">
        This File Can Still Be Inspected As Metadata.
      </p>
      <div className="mt-3 text-[11px] font-mono text-[var(--w3-text-muted)]">
        {fileName}
      </div>
    </div>
  );
}

function PreviewBody({
  data,
  kind
}: {
  data: ViewResponse;
  kind: ReturnType<typeof previewKind>;
}) {
  let body = data.content;
  if (kind === 'json') {
    try {
      const parsed = JSON.parse(body);
      body = JSON.stringify(parsed, null, 2);
    } catch {
      // fall through to raw render
    }
  }
  return (
    <>
      <div className="mb-2 flex items-center justify-between text-[11px] text-[var(--w3-text-muted)]">
        <span>
          {formatBytes(data.sizeBytes)}
          {data.truncated ? ' · Truncated By Server For Safety' : ' · Full File'}
        </span>
        {kind === 'log' ? <Badge tone="info">Colorized</Badge> : null}
        {kind === 'md' ? <Badge tone="slate">Raw</Badge> : null}
      </div>
      <pre
        className={cn(
          'console max-h-[55vh] overflow-y-auto whitespace-pre-wrap',
          kind === 'sh' || kind === 'sql' ? 'font-mono' : ''
        )}
      >
        {body}
      </pre>
    </>
  );
}
