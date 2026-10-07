import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { RefreshCw } from 'lucide-react';
import { AdminListPage } from '../components/ui/AdminListPage';
import { Badge } from '../components/ui/Badge';
import { EmptyState, ErrorState, LoadingState } from '../components/ui/States';
import { adminGet } from '../lib/api';
import { formatBytes, formatTimestamp } from '../lib/format';
import { availableInventory, inventoryData, inventoryStatus, usePackageInventory, type PackageEntry } from '../lib/inventory';

// Core / BuildCost page composition with Forge's per-app metadata adapter.
export function PackagesPage() {
  const version = useQuery({ queryKey: ['admin', 'version'], queryFn: () => adminGet<{ app: string; version: string }>('/version') });
  const staged = usePackageInventory('staged');
  const installed = usePackageInventory('installed');
  const app = inventoryData(staged)?.app || inventoryData(installed)?.app;
  const refresh = () => { void staged.refetch(); void installed.refetch(); void version.refetch(); };
  return <AdminListPage header={{ title: 'Packages', subtitle: `Read-only staged and installed-directory inventories for ${app?.name || 'W3 Forge'}.`, actions: <div className="flex max-w-[calc(100vw-3rem)] flex-wrap items-center gap-2">
    <Badge tone="warning">Read Only</Badge>{!version.isError && version.data ? <Badge tone="gold">Running: v{version.data.version}</Badge> : null}
    <button type="button" className="btn" disabled={staged.isFetching || installed.isFetching || version.isFetching} onClick={refresh}><RefreshCw size={14} /> Refresh</button>
  </div> }}
    standardCard={{ title: 'Package Naming Standard', body: <>
      <code className="rounded px-2 py-1 text-xs font-mono" style={{ background: 'var(--w3-navy-800)', border: '1px solid var(--w3-border)', color: 'var(--w3-text)' }}>vX.Y.Z/{app?.id || 'w3forge'}.tar.gz</code>
      <ul className="mt-3 list-disc space-y-1 pl-5 text-xs text-[var(--w3-text-muted)]"><li>Each app uses its own repository and package directories. Legacy flat files use <code>{app?.id || 'w3forge'}-vX.Y.Z.tar.gz</code>.</li><li>Filename and storage-layout labels describe metadata only; archive contents and installation status are not verified.</li><li>Files in the installed directory are listed as history, not proof of a successful deployment. Production changes require the owner's approval.</li></ul>
    </> }}
    currentStateCard={{ title: 'Staged Packages', right: <InventoryBadge query={staged} />, flush: true, body: <PackageInventory query={staged} emptyLabel="No staged packages found." /> }}
    historyTables={[{ title: 'Installed Packages', right: <InventoryBadge query={installed} />, flush: true, body: <PackageInventory query={installed} emptyLabel="No packages found in the installed directory." /> }]}
    detailsSlot={<div className="flex flex-wrap gap-2"><Link className="btn" to="/github">GitHub / Releases</Link><Link className="btn" to="/backups">Backups</Link><Link className="btn" to="/settings">Settings</Link></div>} />;
}
function InventoryBadge({ query }: { query: ReturnType<typeof usePackageInventory> }) {
  const status = inventoryStatus(query);
  return <Badge tone={status.tone}>{status.label}</Badge>;
}
function PackageInventory({ query, emptyLabel }: { query: ReturnType<typeof usePackageInventory>; emptyLabel: string }) {
  const data = inventoryData(query);
  const available = availableInventory(query);
  const status = inventoryStatus(query);
  if (query.isPending) return <div className="p-4"><LoadingState label="Loading package inventory…" /></div>;
  if (query.isError) return <div className="p-4 space-y-3"><ErrorState title="Package inventory unavailable" error={query.error} /><Retry query={query} /></div>;
  return <>
    <div className="p-4 space-y-2 text-xs text-[var(--w3-text-muted)]"><p>App: {data?.app.name || 'W3 Forge'}</p><p className="break-all">Directory: <code>{data?.root || 'Not configured'}</code></p>{available ? <p>{status.message}</p> : <><EmptyState>{status.message}</EmptyState><Retry query={query} /></>}</div>
    {available ? available.packages.length ? <PackageTable entries={available.packages} /> : <div className="p-4 pt-0"><EmptyState>{emptyLabel}</EmptyState></div> : null}
  </>;
}
function Retry({ query }: { query: ReturnType<typeof usePackageInventory> }) {
  return <button type="button" className="btn" disabled={query.isFetching} onClick={() => void query.refetch()}><RefreshCw size={13} /> Retry</button>;
}
function PackageTable({ entries }: { entries: PackageEntry[] }) {
  return <><div className="desktop-table overflow-x-auto"><table className="table-dark w-full"><thead><tr><th>Name</th><th>Version</th><th>Size</th><th>Modified (UTC)</th><th>Filename</th><th>Storage layout</th></tr></thead><tbody>{entries.map(entry => <tr key={entry.path}>
    <td className="font-mono text-xs break-all" title={entry.path}>{entry.name}</td><td>{entry.parsedVersion ? <Badge tone="slate">v{entry.parsedVersion}</Badge> : '—'}</td><td>{formatBytes(entry.sizeBytes)}</td><td className="text-xs text-[var(--w3-text-muted)]">{formatTimestamp(entry.mtime)}</td><td><Badge tone={entry.validName ? 'info' : 'warning'}>{entry.validName ? 'Standard name' : 'Non-Standard'}</Badge></td><td className="text-xs">{entry.layout === 'canonical' ? 'Canonical' : 'Legacy flat'}</td>
  </tr>)}</tbody></table></div><div className="mobile-cards p-3">{entries.map(entry => <div className="stack-card" key={entry.path}>
    <div className="stack-card__row"><div className="stack-card__title font-mono break-all">{entry.name}</div></div><div className="stack-card__meta"><Badge tone={entry.validName ? 'info' : 'warning'}>{entry.validName ? 'Standard name' : 'Non-Standard'}</Badge>{entry.parsedVersion ? <Badge tone="slate">v{entry.parsedVersion}</Badge> : <span>Version unknown</span>}<span>{formatBytes(entry.sizeBytes)}</span></div><p className="text-xs text-[var(--w3-text-muted)]">Modified: {formatTimestamp(entry.mtime)} UTC</p><p className="text-xs text-[var(--w3-text-muted)]">Storage layout: {entry.layout === 'canonical' ? 'Canonical' : 'Legacy flat'}</p>
  </div>)}</div></>;
}
