import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowUpDown, ChevronRight, FileText, Folder, Lock, RefreshCw, Search, ShieldCheck } from 'lucide-react';
import { Card, CardBody, CardHeader } from '../components/ui/Card';
import { Badge } from '../components/ui/Badge';
import { SectionHeader } from '../components/ui/SectionHeader';
import { LoadingState, ErrorState, EmptyState } from '../components/ui/States';
import { adminGet } from '../lib/api';
import { formatBytes, formatRelative, formatTimestamp } from '../lib/format';
import { cn } from '../lib/utils';

interface FileEntry { name: string; type: 'file' | 'dir'; size: number; modifiedMs: number }
interface FilesResp { forgeRoot: string; path: string; entries: FileEntry[] }
type SortKey = 'name' | 'size' | 'modified' | 'type';
type FilterChip = 'All' | 'Folders' | 'Files';

function timestamp(value: number): string | null {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

// Core / BuildCost file-inspector composition with Forge's single-root metadata API.
// File contents and extra roots are unavailable; the browser never requests them.
export function FileBrowserPage() {
  const [cwd, setCwd] = useState('.');
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [filterChip, setFilterChip] = useState<FilterChip>('All');
  const q = useQuery({
    queryKey: ['files', cwd],
    queryFn: () => adminGet<FilesResp>(`/files?path=${encodeURIComponent(cwd)}`)
  });
  const entries = q.data?.entries;
  const selected = entries?.find((entry) => entry.type === 'file' && entry.name === selectedName);
  const relativePath = cwd === '.' ? '' : cwd;
  const fullPath = q.data ? [q.data.forgeRoot, relativePath].filter(Boolean).join('/') : relativePath || 'Forge root';
  const breadcrumbs = useMemo(() => {
    const parts = relativePath.split('/').filter(Boolean);
    return [{ label: 'root', target: '.' }, ...parts.map((label, index) => ({ label, target: parts.slice(0, index + 1).join('/') }))];
  }, [relativePath]);
  const filteredEntries = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return (entries ?? []).filter((entry) =>
      (!needle || entry.name.toLowerCase().includes(needle)) &&
      (filterChip === 'All' || (filterChip === 'Folders' ? entry.type === 'dir' : entry.type === 'file'))
    ).sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      if (sortKey === 'size') return b.size - a.size || a.name.localeCompare(b.name);
      if (sortKey === 'modified') return b.modifiedMs - a.modifiedMs || a.name.localeCompare(b.name);
      if (sortKey === 'type') return (a.name.split('.').pop() ?? '').localeCompare(b.name.split('.').pop() ?? '') || a.name.localeCompare(b.name);
      return a.name.localeCompare(b.name);
    });
  }, [entries, search, sortKey, filterChip]);

  function navigate(path: string) {
    setSelectedName(null);
    setCwd(path || '.');
  }

  return (
    <div className="space-y-4">
      <SectionHeader title="File Browser" subtitle="Read-only inspector for approved W3 Forge paths."
        actions={<><Badge tone="gold">Approved Roots Only</Badge><Badge tone="warning">Internal Only</Badge></>} />
      <Card>
        <CardHeader title={<span className="flex items-center gap-1.5"><ShieldCheck size={14} /> Safety And Access Rules</span>}
          subtitle="What this inspector can and cannot do." />
        <CardBody>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div>
              <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-[var(--w3-text-muted)]">Allowed</div>
              <ul className="space-y-1 text-xs text-[var(--w3-text)]">
                <li className="flex items-center gap-2"><Badge tone="success">Allow</Badge>View Approved Directories</li>
                <li className="flex items-center gap-2"><Badge tone="success">Allow</Badge>Inspect File Names, Sizes, And Modified Dates</li>
              </ul>
            </div>
            <div>
              <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-[var(--w3-text-muted)]">Blocked</div>
              <ul className="space-y-1 text-xs text-[var(--w3-text)]">
                {['Uploads', 'Edits', 'Deletes', 'Renames', 'Unapproved System Paths'].map((label) => (
                  <li key={label} className="flex items-center gap-2"><Badge tone="danger">Block</Badge>{label}</li>
                ))}
                <li className="flex items-center gap-2"><Badge tone="warning">Unavailable</Badge>File Content Preview</li>
              </ul>
            </div>
          </div>
        </CardBody>
      </Card>
      <Card>
        <CardHeader title={<span className="flex items-center gap-1.5"><ShieldCheck size={14} /> Approved Roots</span>}
          subtitle="Pick a root to list its contents." />
        <CardBody>
          <div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
            <button type="button" onClick={() => navigate('.')}
              className="flex flex-col gap-1 rounded-md border border-[var(--w3-gold-500)] px-3 py-2 text-left text-xs transition"
              style={{ background: 'rgba(217,164,65,0.10)', color: 'var(--w3-text)' }} title={q.data?.forgeRoot}>
              <div className="flex items-center justify-between"><span className="font-semibold">Forge Workspace</span><Badge tone="slate">Read Only</Badge></div>
              <div className="truncate font-mono text-[10px] text-[var(--w3-text-muted)]">{q.data?.forgeRoot ?? 'Configured Forge root'}</div>
              <div className="text-[11px] text-[var(--w3-text-muted)]">Registered workspace directories and file metadata.</div>
            </button>
          </div>
          <details className="mt-3 text-xs text-[var(--w3-text-muted)]">
            <summary className="cursor-pointer">Never-Exposed Paths</summary>
            <ul className="ml-4 mt-1 list-disc font-mono text-[11px]"><li>.git</li><li>.env</li><li>Paths outside the configured Forge root</li></ul>
          </details>
        </CardBody>
      </Card>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        <Card>
          <CardHeader title={<span className="flex items-center gap-1.5"><Folder size={14} /> Directory</span>} subtitle={fullPath}
            right={<Badge tone="warning"><Lock size={10} /> Read Only</Badge>} />
          <CardBody className="!p-0">
            <div className="flex flex-wrap items-center gap-1 px-3 py-2 text-xs" style={{ borderBottom: '1px solid var(--w3-border)' }}>
              <button type="button" className="btn !px-2 !py-1" disabled={!relativePath} aria-label="Parent directory"
                onClick={() => navigate(relativePath.split('/').slice(0, -1).join('/'))}>..</button>
              <button type="button" className="btn !px-2 !py-1" onClick={() => navigate('.')} aria-label="Forge root">/</button>
              <div className="ml-1 flex min-w-0 flex-1 flex-wrap items-center gap-1 font-mono text-[11px] text-[var(--w3-text-muted)]">
                {breadcrumbs.map((crumb, index) => <span key={crumb.target} className="flex min-w-0 items-center gap-1">
                  {index > 0 ? <ChevronRight size={10} className="shrink-0" /> : null}
                  <button type="button" className="max-w-[160px] truncate hover:text-[var(--w3-text)]" title={crumb.label} onClick={() => navigate(crumb.target)}>{crumb.label}</button>
                </span>)}
              </div>
              <button type="button" className="btn !px-2 !py-1" disabled={q.isFetching} onClick={() => void q.refetch()} aria-label="Refresh directory"><RefreshCw size={12} /></button>
            </div>
            <div className="flex flex-wrap items-center gap-2 px-3 py-2 text-xs" style={{ borderBottom: '1px solid var(--w3-border)' }}>
              <div className="relative flex-1 min-w-[140px]">
                <Search size={11} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[var(--w3-text-dim)]" />
                <input type="text" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Filter Current Folder…" aria-label="Filter current folder" className="input pl-7 w-full" />
              </div>
              <label className="flex items-center gap-1"><ArrowUpDown size={11} className="text-[var(--w3-text-muted)]" />
                <select value={sortKey} onChange={(event) => setSortKey(event.target.value as SortKey)} aria-label="Sort files"
                  className="rounded-md border px-2 py-1 text-xs" style={{ background: 'var(--w3-navy-800)', borderColor: 'var(--w3-border)', color: 'var(--w3-text)' }}>
                  <option value="name">Name</option><option value="size">Size</option><option value="modified">Modified Date</option><option value="type">Type</option>
                </select>
              </label>
            </div>
            <div className="flex flex-wrap gap-1 px-3 py-2" style={{ borderBottom: '1px solid var(--w3-border)' }}>
              {(['All', 'Folders', 'Files'] as const).map((chip) => <button key={chip} type="button" onClick={() => setFilterChip(chip)} aria-pressed={filterChip === chip}
                className={cn('badge cursor-pointer', filterChip === chip ? 'badge-gold' : 'badge-slate opacity-80 hover:opacity-100')}>{chip}</button>)}
            </div>
            {q.isLoading ? <div className="p-4"><LoadingState /></div> : q.error ? <div className="p-4"><ErrorState error={q.error} /></div> : filteredEntries.length === 0 ? (
              <div className="p-4"><EmptyState>{entries?.length ? 'No Files Match The Current Filter.' : 'Directory Is Empty — No Files To Inspect.'}</EmptyState></div>
            ) : (
              <ul className="max-h-[55vh] overflow-y-auto" style={{ borderTop: '1px solid var(--w3-border)' }}>
                {filteredEntries.map((entry) => {
                  const isDir = entry.type === 'dir';
                  const extension = entry.name.includes('.') ? entry.name.split('.').pop()?.toUpperCase() : null;
                  const modified = timestamp(entry.modifiedMs);
                  return <li key={entry.name} className="flex items-center justify-between gap-2 px-3 py-1.5 text-sm transition hover:bg-[var(--w3-card-hover)]"
                    style={selectedName === entry.name ? { background: 'rgba(217,164,65,0.10)' } : undefined}>
                    <button type="button" className="flex min-w-0 flex-1 items-center gap-2 truncate text-left" title={entry.name}
                      onClick={() => isDir ? navigate([relativePath, entry.name].filter(Boolean).join('/')) : setSelectedName(entry.name)}>
                      {isDir ? <Folder size={14} className="shrink-0" style={{ color: 'var(--w3-gold-500)' }} /> : <FileText size={14} className="shrink-0 text-[var(--w3-text-muted)]" />}
                      <span className="truncate font-mono text-xs">{entry.name}</span>
                      {!isDir && extension ? <span className="rounded px-1 text-[10px] font-mono" style={{ background: 'var(--w3-navy-800)', color: 'var(--w3-gold-400)', border: '1px solid var(--w3-border)' }}>{extension}</span> : null}
                    </button>
                    <span className="shrink-0 text-[11px] text-[var(--w3-text-muted)]">{isDir ? <ChevronRight size={12} /> : <>{formatBytes(entry.size)}{modified ? <span className="ml-2" title={modified}>{formatRelative(modified)}</span> : null}</>}</span>
                  </li>;
                })}
              </ul>
            )}
          </CardBody>
        </Card>
        <div className="space-y-4">
          <Card>
            <CardHeader title="File Details" subtitle={selected?.name ?? 'Choose a file on the left.'} />
            <CardBody>
              {selected ? <dl className="space-y-2 text-xs">
                {[['Name', selected.name], ['Path', `${fullPath}/${selected.name}`], ['Size', formatBytes(selected.size)], ['Modified', formatTimestamp(timestamp(selected.modifiedMs))], ['Access', 'Read Only · Metadata Only']].map(([label, value]) => (
                  <div key={label} className="grid grid-cols-[90px_minmax(0,1fr)] gap-3"><dt className="text-[var(--w3-text-muted)]">{label}</dt><dd className="break-all font-mono text-[var(--w3-text)]">{value}</dd></div>
                ))}
              </dl> : <EmptyState>Select A File To View Its Details.</EmptyState>}
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Safe Preview" subtitle={selected?.name ?? 'File content preview'} right={<Badge tone="slate">Unavailable</Badge>} />
            <CardBody><EmptyState>Forge exposes file metadata only. File content preview is unavailable.</EmptyState></CardBody>
          </Card>
        </div>
      </div>
    </div>
  );
}
